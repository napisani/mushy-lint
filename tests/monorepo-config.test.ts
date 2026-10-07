import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseConfig, type Config } from "../src/config.ts";
import { planAnalysis } from "../src/check.ts";
import { eligibleFiles } from "../src/files.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { ruleCoverage } from "../src/report.ts";

const isMonorepo = await Bun.file(new URL("../../../scripts/lib/projects.ts", import.meta.url)).exists();
const monorepoTest = test.skipIf(!isMonorepo);
let config: Config;
const fixture = await Bun.file(new URL("./fixtures/monorepo-rules.ts", import.meta.url)).text();
const labels = z.array(z.strictObject({ rule: z.string(), expectedYes: z.boolean(), codeContains: z.string() }))
  .parse(await Bun.file(new URL("./fixtures/monorepo-rule-labels.json", import.meta.url)).json());
const root = new URL("../../../", import.meta.url);
let cwd: string;
let parser: SourceParser;
beforeAll(async () => {
  if (!isMonorepo) { return; }
  config = parseConfig(await Bun.file(new URL("../../../mushy-lint.yaml", import.meta.url)).text());
  cwd = await mkdtemp(join(tmpdir(), "mushy-monorepo-config-"));
  await mkdir(join(cwd, "pub/scute/src"), { recursive: true });
  parser = await createSourceParser();
});
afterAll(async () => {
  if (!isMonorepo) { return; }
  parser.dispose();
  await rm(cwd, { recursive: true, force: true });
});

monorepoTest("monorepo config selects exactly eleven rules with local policy references", async () => {
  expect(config.classification.provider).toBe("openrouter");
  expect(config.classification.model).toBe("typesafe/jev-1.13");
  expect(config.classification.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  expect(Object.keys(config.targets).sort()).toEqual(["documented-declaration", "named-function"]);
  const rules = config.sections.flatMap((section) => section.rules);
  expect(rules.map((rule) => rule.id).sort()).toEqual([
    "comments.includes-decision-record", "comments.justifies-obvious-code", "comments.narrates-code",
    "comments.records-change-history", "comments.teaches-general-api", "diagnostics.exposes-secrets",
    "docs.describes-internals", "errors.hides-failure", "functions.duplicates-local-policy",
    "functions.mixes-unrelated-responsibilities", "naming.describes-operation",
  ]);
  for (const rule of rules) {
    expect(rule.context).toEqual([]);
    expect(rule.review.yesMeans).toBe(rule.id === "naming.describes-operation" ? "desirable" : "undesirable");
  }
  const references = new Set(rules.flatMap((rule) => rule.review.policy.map((ref) => ref.split("#")[0] ?? "")));
  expect([...references].sort()).toEqual(["AGENTS.md", "docs/code-style.md"]);
  expect(await Promise.all([...references].map((ref) => Bun.file(new URL(ref, root)).exists()))).toEqual([...references].map(() => true));
  const policyLinks = new Set(rules.flatMap((rule) => rule.review.policy).filter((ref) => ref !== "AGENTS.md"));
  expect([...policyLinks].sort()).toEqual([
    "docs/code-style.md#comments", "docs/code-style.md#diagnostics",
    "docs/code-style.md#documentation", "docs/code-style.md#duplication",
    "docs/code-style.md#failure-handling", "docs/code-style.md#naming", "docs/code-style.md#responsibilities",
  ]);
  const policy = await Bun.file(new URL("docs/code-style.md", root)).text();
  for (const heading of ["Comments", "Diagnostics", "Documentation", "Duplication", "Failure handling", "Naming", "Responsibilities"]) {
    expect(policy).toContain(`## ${heading}\n`);
  }
});

monorepoTest("discovery admits authored TypeScript projects and excludes unsupported, generated, and vendored code", () => {
  const admitted = [
    "pub/scute/src/ui.tsx", "pub/vantage-nvim/server/src/handler.ts", "pub/mushy-lint/src/check.ts",
    "pub/lint/anti-slop-deno/src/index.ts", "pub/lint/style-parity-deno/src/index.ts",
    "pub/dotfiles-nix/mods/dotfiles/karabiner/src/index.ts",
    "priv/kube-home-lab/src/namespaces/home/apps/service.ts", "scripts/mono.ts",
    "pub/scute/src/value.test.ts", "pub/scute/scripts/build-bin.ts", "scripts/bridge.mts", "scripts/bridge.cts",
  ];
  const excluded = [
    "pub/scute/dist/bundle.ts", "pub/scute/node_modules/lib/index.ts", "pub/scute/src/types.d.ts",
    "pub/mushy-lint/tests/fixtures/review.ts", "pub/vantage-nvim/tools/oxlint/index.ts",
    "priv/kube-home-lab/src/imports/cert-manager.io.ts", "priv/kube-home-lab/dist-check/main.ts",
    "pub/lint/anti-slop/src/index.ts", "pub/lint/anti-slop-effect/src/index.ts",
    "pub/proctmux/third_party/tool/index.ts", "pub/scute/.agents/skills/example/sample.ts",
    "priv/kube-home-lab/assets/vendored-skills/tool/index.ts",
    "pub/secret_inject/main.go", "pub/stackman/src/main.py", "pub/proctmux/src/main.zig",
    "pub/dotfiles-nix/flake.nix", "pub/vantage-nvim/lua/vantage/init.lua", "scripts/command.sh",
    "pub/dotfiles-nix/mods/dotfiles/agents/pi/extensions/plugin.js",
  ];
  expect(eligibleFiles({ config, files: [...admitted, ...excluded] })).toEqual(admitted.sort());
});

for (const extension of ["ts", "tsx"]) {
  monorepoTest(`selected rules capture affirmative and negative labeled ${extension} examples without classifier calls`, async () => {
    const source = fixture + (extension === "tsx" ? "\nconst Header = () => <h1>Ready</h1>;" : "");
    const file = `pub/scute/src/rules.${extension}`;
    await Bun.write(join(cwd, file), source);
    const plan = await planAnalysis({ config, parser, cwd, files: [file] });
    expect(plan.issues).toEqual([]);
    expect(plan.results).toEqual([]);
    expect(ruleCoverage(plan).every((rule) => rule.eligible > 0)).toBe(true);
    for (const coverage of ruleCoverage(plan)) {
      expect(labels.filter((label) => label.rule === coverage.rule).map((label) => label.expectedYes).sort()).toEqual([false, true]);
    }
    for (const label of labels) {
      const evaluation = plan.evaluations.find((item) => item.rule === label.rule && item.state.code?.[0]?.includes(label.codeContains));
      if (!evaluation) { throw new Error(`Missing labeled evidence: ${label.rule} / ${label.codeContains}`); }
      expect(config.sections.flatMap((section) => section.rules).find((rule) => rule.id === label.rule)?.score).toBe(evaluation.question);
      expect(evaluation.state.code?.[0]).toContain("}");
      expect(evaluation.root).not.toBeNull();
      const anchor = source.slice(evaluation.location.startIndex, evaluation.location.endIndex);
      if (label.rule.startsWith("comments.")) {
        expect(anchor.startsWith("//")).toBe(true);
      } else if (label.rule === "docs.describes-internals") {
        expect(anchor.startsWith("/**")).toBe(true);
        expect(evaluation.state.comment?.[0]).toBe(anchor);
        expect(evaluation.state.code?.[0]?.startsWith("export function")).toBe(true);
      } else {
        expect(evaluation.state.name?.[0]).toBe(anchor);
      }
    }
  });
}

monorepoTest("function rules exclude test harnesses but keep authored scripts and nested callables", async () => {
  const source = `function* sequence() { yield 1; }
const arrowHelper = (value: string) => value.trim();
const expressionHelper = function (value: string) { return value.trim(); };
const generatorHelper = function* () { yield 1; };
const parent = () => { const child = () => 1; return child(); };
class Helpers { constructor() {} format() { return 1; } #privateHelper() { return 2; } }
`;
  const files = ["pub/scute/src/variants.ts", "pub/scute/src/variants.test.ts", "pub/scute/src/variants.spec.ts", "pub/scute/src/variants.stories.ts", "pub/scute/tests/variants.ts", "pub/scute/evals/variants.ts", "pub/scute/examples/variants.ts", "scripts/variants.ts"];
  await Promise.all(files.map((file) => Bun.write(join(cwd, file), source)));
  const plan = await planAnalysis({ config, parser, cwd, files });
  expect(plan.issues).toEqual([]);
  const named = plan.evaluations.filter((item) => item.rule === "naming.describes-operation");
  expect([...new Set(named.map((item) => item.location.file))].sort()).toEqual(["pub/scute/src/variants.ts", "scripts/variants.ts"]);
  expect(named.some((item) => item.state.name?.[0] === "constructor")).toBe(false);
  for (const name of ["sequence", "arrowHelper", "expressionHelper", "generatorHelper", "parent", "child", "format", "#privateHelper"]) {
    expect(named.some((item) => item.state.name?.[0] === name)).toBe(true);
  }
  expect(plan.evaluations.some((item) => item.state.name?.[0] === "parent" && item.state.code?.[0]?.includes("const child"))).toBe(true);
  expect(ruleCoverage(plan).filter((rule) => rule.section === "source-functions").every((rule) => rule.excluded > 0)).toBe(true);
});

monorepoTest("failure and diagnostics gates preserve complete functions, including nested evidence", async () => {
  const source = `
function plain(value: string) { return value.trim(); }
function recovered(raw: string) { try { return JSON.parse(raw); } catch { return null; } }
const rejected = () => Promise.reject("unavailable").catch(() => null);
const settled = () => Promise.resolve(1).then(value => value, () => null);
function logged() { console.warn("Unavailable", { apiKey: process.env.OPENROUTER_API_KEY }); }
const diagnostic = () => new Error("Unavailable");
function raised(cause: Error) { throw cause; }
function outer() {
  const inner = () => { try { return JSON.parse("{}"); } catch { return null; } };
  return inner;
}
`;
  const file = "pub/scute/src/gates.ts";
  await Bun.write(join(cwd, file), source);
  const plan = await planAnalysis({ config, parser, cwd, files: [file] });
  expect(plan.issues).toEqual([]);
  expect(plan.results).toEqual([]);
  const failures = plan.evaluations.filter((item) => item.rule === "errors.hides-failure");
  const diagnostics = plan.evaluations.filter((item) => item.rule === "diagnostics.exposes-secrets");
  expect(failures.map((item) => item.state.name?.[0]).sort()).toEqual(["inner", "outer", "recovered", "rejected", "settled"]);
  expect(diagnostics.map((item) => item.state.name?.[0]).sort()).toEqual(["diagnostic", "logged", "raised"]);
  const enclosing = failures.find((item) => item.state.name?.[0] === "outer");
  expect(enclosing?.state.code?.[0]).toContain("return inner;");
  expect(enclosing?.state.handler).toBeUndefined();
  expect(diagnostics.find((item) => item.state.name?.[0] === "logged")?.state.method).toBeUndefined();
  expect(ruleCoverage(plan).filter((rule) => ["errors.hides-failure", "diagnostics.exposes-secrets"].includes(rule.rule)).every((rule) => rule.excluded > 0)).toBe(true);
});
