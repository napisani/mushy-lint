import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import type { AnalysisReport, RuleRecord, SourceLocation } from "../src/model.ts";
import { reviewLedger } from "../src/artifacts.ts";
import { formatResult } from "../src/report.ts";

const skill = await Bun.file(new URL("../.agents/skills/mushy-lint-run-review/SKILL.md", import.meta.url)).text();
let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mushy-review-skill-"));
  await $`git init -q`.cwd(cwd);
  await Bun.write(join(cwd, "bin/mushy-lint"), '#!/bin/sh\nexec "$BUN_BINARY" "$MUSHY_LINT_CLI_SOURCE" "$@"\n');
  await chmod(join(cwd, "bin/mushy-lint"), 0o755);
  await Bun.write(join(cwd, "mushy-lint.yaml"), `version: 2
classification:
  apiKeyEnv: MUSHY_REVIEW_TEST_MISSING_KEY
fileSets:
  source:
    include: ["src/**/*.ts"]
sections:
  - name: comments
    language: typescript
    files: source
    rules:
      - id: comments.reason
        target: comment
        score: Does comment explain a constraint in code?
`);
  await Bun.write(join(cwd, "src/example.ts"), "// The remote service deduplicates retries with this key.\nfunction send(key: string) { return gateway(key); }\n");
});
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

test("run-review skill frontmatter declares the runtime dependencies", () => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill);
  const metadata = z.strictObject({
    name: z.literal("mushy-lint-run-review"),
    description: z.string().min(1).max(1024).refine((text) => !/[<>]/.test(text)),
    compatibility: z.string().min(1).max(500),
  }).parse(load(frontmatter?.[1] ?? ""));
  expect(metadata.compatibility).toContain("mushy-lint on PATH");
});

test("documented capture command retains partial JSON, stderr, config, and exit status", async () => {
  const capture = /```bash\n(config=mushy-lint.yaml\n[\s\S]*?)\n```/.exec(skill)?.[1];
  if (!capture) { throw new Error("Missing CLI capture example"); }
  const process = Bun.spawn(["bash", "-e", "-c", `${capture}\nprintf '\\n%s\\n' "$review_dir"`], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: {
      ...Bun.env, PATH: `${join(cwd, "bin")}:${Bun.env.PATH ?? ""}`,
      BUN_BINARY: Bun.which("bun") ?? "bun",
      MUSHY_LINT_CLI_SOURCE: join(import.meta.dir, "../src/cli.ts"),
      MUSHY_REVIEW_TEST_MISSING_KEY: "", TMPDIR: cwd,
    },
  });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const artifacts = stdout.trim().split("\n").at(-1);
  if (!artifacts) { throw new Error("Capture command did not return artifacts"); }
  expect(await Bun.file(join(artifacts, "exit-status.txt")).text()).toBe("2\n");
  expect(await Bun.file(join(artifacts, "stderr.txt")).text()).toBe("");
  expect(await Bun.file(join(artifacts, "config.yaml")).text()).toBe(await Bun.file(join(cwd, "mushy-lint.yaml")).text());
  const report = z.object({
    rules: z.array(z.object({ section: z.string(), rule: z.string(), score: z.string() })),
    results: z.array(z.object({ status: z.literal("not_evaluated"), reason: z.literal("request_failed"), state: z.object({ code: z.array(z.string()) }) })),
    summary: z.object({ requests: z.literal(0), notEvaluated: z.literal(1) }),
  }).parse(await Bun.file(join(artifacts, "report.json")).json());
  expect(report.rules[0]?.score).toBe("Does comment explain a constraint in code?");
  expect(report.results[0]?.state.code?.[0]).toContain("gateway(key)");
});

const location: SourceLocation = {
  file: "src/example.ts", startLine: 1, endLine: 1, startColumn: 1, endColumn: 10, startIndex: 0, endIndex: 9,
};
const questions = [
  { section: "names", rule: "quality", score: "Does name accurately describe the operation performed by code?" },
  { section: "comments", rule: "quality", score: "Does comment merely restate code rather than explain a reason?" },
];
const rules = questions.map<RuleRecord>((question) => ({
  ...question, language: "typescript",
  target: question.section === "names"
    ? { kind: "query", name: "named_function", root: "code", location: "name", query: "(function_declaration name: (identifier) @name) @code" }
    : { kind: "comment", name: "comment" },
  includeIf: undefined, context: [], review: { yesMeans: question.section === "names" ? "desirable" : "undesirable", policy: [] },
  files: { section: { include: ["src/**/*.ts"], exclude: [] }, ruleExcludes: [] },
}));
const report: AnalysisReport = {
  classification: { provider: "typesafe", model: "jev-1.13" }, rules,
  sampling: { mode: "all", candidates: 2, files: ["src/example.ts", "src/broken.ts"] },
  sources: [], coverage: [],
  results: [
    { id: "evaluation-0", section: "names", rule: "quality", target: "named_function", location, root: location, state: { name: ["storeOrder"], code: ["function storeOrder(input: string) { return input.trim(); }"] }, question: questions[0]?.score ?? "", status: "evaluated", score: 0.08, executionId: "execution-0" },
    { id: "evaluation-1", section: "comments", rule: "quality", target: "comment", location, root: location, state: { comment: ["The remote service deduplicates retries with this key."], code: ["function send(key: string) { return gateway(key); }"] }, question: questions[1]?.score ?? "", status: "evaluated", score: 0.96, executionId: "execution-1" },
    { id: "evaluation-2", section: "comments", rule: "quality", target: "comment", location, root: null, state: { comment: ["No attached construct"], code: [] }, question: questions[1]?.score ?? "", status: "not_evaluated", reason: "extraction_failed", message: "Comment has no attached construct." },
  ],
  issues: [{ file: "src/broken.ts", reason: "parse_error", message: "File has syntax errors; target coverage may be incomplete." }],
  executions: [
    { id: "execution-0", provider: "typesafe", requestedModel: "jev-1.13", attempts: 1, status: "succeeded" },
    { id: "execution-1", provider: "typesafe", requestedModel: "jev-1.13", attempts: 1, status: "succeeded" },
  ],
  summary: { files: 2, targets: 3, excluded: 1, eligible: 3, evaluated: 2, notEvaluated: 1, requests: 2, attempts: 2, inputTokens: null, outputTokens: null },
};

test("review contract matches live JSON and preserves question direction and unscored failures", () => {
  const decoded = z.record(z.string(), z.unknown()).parse(JSON.parse(formatResult(report, "json")));
  const start = skill.indexOf("The top-level keys are:");
  const end = skill.indexOf("\nIn `rules`", start);
  const keys = [...skill.slice(start, end).matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1] ?? "");
  expect(keys.sort()).toEqual(Object.keys(decoded).sort());
  const wire = z.object({
    rules: z.array(z.object({ section: z.string(), rule: z.string(), score: z.string() })),
    results: z.array(z.object({ id: z.string(), section: z.string(), rule: z.string(), score: z.number().optional() }).passthrough()),
  }).parse(decoded);
  const joined = wire.results.map((result) => ({
    id: result.id, score: result.score,
    question: wire.rules.find((entry) => entry.section === result.section && entry.rule === result.rule)?.score,
  }));
  expect(joined).toEqual([
    { id: "evaluation-0", score: 0.08, question: questions[0]?.score },
    { id: "evaluation-1", score: 0.96, question: questions[1]?.score },
    { id: "evaluation-2", score: undefined, question: questions[1]?.score },
  ]);
  expect(wire.results.every((result) => Object.hasOwn(result, "question"))).toBe(true);
  expect(reviewLedger(report)).toHaveLength(report.results.length);
  expect(reviewLedger(report).every((row) => row.decision === null)).toBe(true);
  expect(Object.hasOwn(wire.results[2] ?? {}, "score")).toBe(false);
});
