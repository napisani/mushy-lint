import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG } from "./helpers.ts";

let cwd: string;
const cli = join(import.meta.dir, "../src/cli.ts");
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mushy-cli-"));
  await $`git init -q`.cwd(cwd);
  await Bun.write(join(cwd, "rules.yaml"), CONFIG.replace("version: 2", "version: 2\nclassification:\n  provider: openrouter\n  model: typesafe/jev-1.13\n  apiKeyEnv: MUSHY_LINT_TEST_MISSING_KEY"));
  await Bun.write(join(cwd, "src/valid.ts"), "function load() { try { read(); } catch { throw new Error('failed'); } }");
  await Bun.write(join(cwd, "src/broken.ts"), "function broken( {");
  await Bun.write(join(cwd, "src/plain.ts"), "function plain() { return 1; }");
  await Bun.write(join(cwd, "src/skip/a.ts"), "function skipped() {}");
  await Bun.write(join(cwd, "src/no.js"), "function javascript() {}");
});
afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

async function run(input: { args: string[]; command?: string }) {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", cli, input.command ?? "check", "--config", "rules.yaml", "--format", "json", ...input.args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, MUSHY_LINT_TEST_MISSING_KEY: "" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}

const Coverage = z.array(z.object({ section: z.string(), rule: z.string(), eligible: z.number(), evaluated: z.number(), notEvaluated: z.number(), excluded: z.number() }));

describe("CLI", () => {
  test("dry run needs no credentials and emits source evidence and resolved rules", async () => {
    const result = await run({ args: ["--dry-run", "src/valid.ts", "--credential-file", "nonexistent.env"] });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const plan = z.object({ evaluations: z.array(z.object({ question: z.string(), state: z.object({ code: z.array(z.string()) }) })), rules: z.array(z.object({ includeIf: z.object({ name: z.string(), query: z.string() }).optional() })), classification: z.object({ provider: z.string() }), coverage: Coverage }).parse(JSON.parse(result.stdout));
    expect(plan.evaluations).toHaveLength(2);
    expect(plan.classification.provider).toBe("openrouter");
    expect(plan.evaluations[0]?.state.code?.[0]).toContain("catch");
    expect(plan.rules[0]?.includeIf?.name).toBe("catches");
    expect(plan.coverage[0]?.eligible).toBe(1);
  });
  test("incomplete parsing is explicit and exits 2", async () => {
    const result = await run({ args: ["--dry-run", "src/broken.ts"] });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"reason": "parse_error"');
  });
  test("missing credentials produce not-evaluated results rather than fabricated scores", async () => {
    const result = await run({ args: ["src/valid.ts"] });
    expect(result.code).toBe(2);
    const report = z.object({ results: z.array(z.object({ status: z.literal("not_evaluated"), reason: z.literal("request_failed"), message: z.string() })), summary: z.object({ requests: z.number(), inputTokens: z.null() }), coverage: Coverage }).parse(JSON.parse(result.stdout));
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.message).toContain("MUSHY_LINT_TEST_MISSING_KEY");
    expect(report.summary.requests).toBe(0);
    expect(report.coverage[0]?.notEvaluated).toBe(1);
  });
  test("file discovery and sampling use the same config scope as planning", async () => {
    const first = await run({ command: "files", args: ["--sample", "2", "--seed", "repeat"] });
    const second = await run({ command: "files", args: ["--sample", "2", "--seed", "repeat"] });
    expect(first).toEqual(second);
    const listed = z.object({ candidates: z.number(), files: z.array(z.string()), seed: z.string() }).parse(JSON.parse(first.stdout));
    expect(listed.candidates).toBe(3);
    expect(listed.files).toHaveLength(2);
    expect(listed.files.every((file) => file.endsWith(".ts") && !file.includes("skip"))).toBe(true);
    const checked = await run({ args: ["--dry-run", "--sample", "2", "--seed", "repeat"] });
    const plan = z.object({ sources: z.array(z.object({ file: z.string() })) }).parse(JSON.parse(checked.stdout));
    expect(plan.sources.map((source) => source.file)).toEqual(listed.files);
  });
  test("rule-stratified sampling prefers eligible coverage and preserves sample counts", async () => {
    const result = await run({ args: ["--dry-run", "--sample", "1", "--seed", "repeat", "--stratify"] });
    expect(result.code).toBe(0);
    const plan = z.object({ sources: z.array(z.object({ file: z.string() })), coverage: Coverage, summary: z.object({ files: z.number(), targets: z.number(), excluded: z.number() }) }).parse(JSON.parse(result.stdout));
    expect(plan.sources.map((source) => source.file)).toEqual(["src/valid.ts"]);
    expect(plan.summary).toEqual({ files: 1, targets: 1, excluded: 0 });
    expect(plan.coverage.every((rule) => rule.eligible === 1)).toBe(true);
  });
  test("private artifacts retain incomplete outcomes and every review row", async () => {
    const directory = join(cwd, "live-artifacts");
    const result = await run({ args: ["src/valid.ts", "--artifacts", directory, "--sample", "1", "--seed", "audit"] });
    expect(result.code).toBe(2);
    expect(await Bun.file(join(directory, "exit-status.txt")).text()).toBe("2\n");
    expect(await Bun.file(join(directory, "config.yaml")).text()).toBe(await Bun.file(join(cwd, "rules.yaml")).text());
    const review = z.array(z.object({ decision: z.null(), status: z.literal("not_evaluated"), question: z.string() })).parse(await Bun.file(join(directory, "review.json")).json());
    expect(review).toHaveLength(2);
    const metadata = z.object({ sampling: z.object({ seed: z.literal("audit"), candidates: z.literal(1), files: z.array(z.string()) }) }).parse(await Bun.file(join(directory, "run.json")).json());
    expect(metadata.sampling.files).toEqual(["src/valid.ts"]);
    const plan = z.object({ sources: z.array(z.object({ sha256: z.string().length(64), bytes: z.number() })) }).parse(await Bun.file(join(directory, "plan.json")).json());
    expect(plan.sources).toHaveLength(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "report.json"))).mode & 0o777).toBe(0o600);
    const repeated = await run({ args: ["src/valid.ts", "--artifacts", directory] });
    expect(repeated.code).toBe(2);
    expect(repeated.stderr).toContain("EEXIST");
    expect(await Bun.file(join(directory, "exit-status.txt")).text()).toBe("2\n");
  });
  test("invalid config artifacts retain diagnostics and exit status", async () => {
    await Bun.write(join(cwd, "bad.yaml"), "version: 1");
    const directory = join(cwd, "bad-artifacts");
    const result = await run({ args: ["--config", "bad.yaml", "--artifacts", directory, "--dry-run"] });
    expect(result.code).toBe(2);
    expect(await Bun.file(join(directory, "stderr.txt")).text()).toBe(result.stderr);
    expect(await Bun.file(join(directory, "exit-status.txt")).text()).toBe("2\n");
    expect(await Bun.file(join(directory, "report.json")).exists()).toBe(false);
  });
  test("missing credential files remain explicit without reading unrelated variables", async () => {
    const result = await run({ args: ["src/valid.ts", "--credential-file", "missing.env"] });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Unable to read credential file");
  });
  test("sampling flags fail rather than silently changing scope", async () => {
    const results = await Promise.all([["--seed", "unused"], ["--stratify"], ["--sample", "0"]].map((args) => run({ args })));
    for (const result of results) { expect(result.code).toBe(2); }
  });
  test("grammar inspection works without config or source checkout", async () => {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", cli, "grammar", "--format", "json"], { cwd, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(process.stdout).text();
    expect(await process.exited).toBe(0);
    const grammars = z.array(z.object({ extension: z.string(), nodes: z.array(z.object({ name: z.string().nullable(), named: z.boolean() })), fields: z.array(z.string().nullable()) })).parse(JSON.parse(text));
    expect(grammars).toHaveLength(2);
    expect(grammars[0]?.nodes.some((node) => node.name === "function_declaration")).toBe(true);
    expect(grammars[1]?.fields).toContain("body");
  });
});
