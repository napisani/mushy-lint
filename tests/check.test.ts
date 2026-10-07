import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAnalysis, classifyPlan } from "../src/check.ts";
import { createClassification } from "../src/classification.ts";
import { ClassificationConfig, parseConfig } from "../src/config.ts";
import type { ClassificationProvider } from "../src/jev.ts";
import type { Classification, ClassificationTask } from "../src/model.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { formatPlan, formatResult } from "../src/report.ts";
import { CONFIG } from "./helpers.ts";

let parser: SourceParser;
let cwd: string;
const source = `function outer() {
  return function inner() {
    try { send(); } catch { log(); }
  };
}
function plain() { return 1; }
`;

beforeAll(async () => {
  parser = await createSourceParser();
  cwd = await mkdtemp(join(tmpdir(), "mushy-analysis-"));
  await Bun.write(join(cwd, "src/a.ts"), source);
  await Bun.write(join(cwd, "src/b.ts"), source);
  await Bun.write(join(cwd, "src/skip/a.ts"), source);
});
afterAll(async () => {
  parser.dispose();
  await rm(cwd, { recursive: true, force: true });
});

function plan(text = CONFIG, files = ["src/a.ts"]) {
  return planAnalysis({ config: parseConfig(text), parser, cwd, files });
}

function fakeClassification(provider = "test"): Classification {
  return {
    provider,
    model: "test",
    async classify(tasks) {
      return {
        outcomes: tasks.map((task) => ({ id: task.id, status: "evaluated", score: 0.1, executionId: "test" })),
        executions: [{ id: "test", provider, requestedModel: "test", returnedModel: "test", attempts: 1, status: "succeeded", usage: { inputTokens: 5, outputTokens: 0 } }],
      };
    },
  };
}

describe("source analysis", () => {
  test("includes nested functions and searches their full subtrees", async () => {
    const result = await plan(CONFIG, ["src/a.ts", "src/skip/a.ts", "src/a.ts"]);
    expect(result.issues).toEqual([]);
    expect(result.evaluations.filter((evaluation) => evaluation.rule === "catch")).toHaveLength(2);
    expect(result.evaluations.filter((evaluation) => evaluation.rule === "purpose")).toHaveLength(3);
    expect(result.summary).toEqual({ files: 1, targets: 3, excluded: 1 });
    expect(result.evaluations[0]?.state.code?.[0]).toContain("function inner");
  });
  test("diff eligibility follows captured evidence rather than reporting location", async () => {
    const config = parseConfig(CONFIG.replace("root: code", "root: code\n    location: name").replace("(function_declaration) @code", "(function_declaration name: (identifier) @name) @code\n      (function_expression name: (identifier) @name) @code").replace("      (function_expression) @code\n      (arrow_function) @code\n      (method_definition) @code\n", ""));
    const result = await planAnalysis({ config, parser, cwd, files: ["src/a.ts"], changed: new Map([["src/a.ts", [{ start: 3, end: 3 }]]]) });
    expect(result.evaluations.filter((evaluation) => evaluation.rule === "catch")).toHaveLength(2);
    expect(result.evaluations[0]?.location.startLine).toBe(1);
    expect(result.evaluations[0]?.state.name).toEqual(["outer"]);
  });
  test("unavailable context blocks inference but not unrelated rules", async () => {
    const result = await plan(CONFIG.replace("id: catch", "id: catch\n        context: [candidate_types]"));
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.status === "not_evaluated" && item.reason === "context_unavailable")).toBe(true);
    expect(result.evaluations).toHaveLength(3);
  });
  test("invalid queries are issues rather than clean coverage", async () => {
    const result = await plan(CONFIG.replace("(function_declaration) @code", "(not_a_node) @code"));
    expect(result.issues[0]?.reason).toBe("extraction_failed");
    expect(result.evaluations).toEqual([]);
  });
  test("missing root in an alternative is rejected even with no matching source", async () => {
    const result = await plan(CONFIG.replace("(arrow_function) @code", "(arrow_function) @other"));
    expect(result.issues[0]?.message).toContain("every pattern");
  });
  test("deleted or unreadable files remain visible", async () => {
    const result = await plan(CONFIG, ["src/deleted.ts"]);
    expect(result.issues[0]?.file).toBe("src/deleted.ts");
  });
  test("failed-source metadata and issues also consume the plan budget", async () => {
    const empty = await plan(CONFIG, []);
    const config = parseConfig(CONFIG);
    config.maxPlanBytes = Buffer.byteLength(JSON.stringify(empty)) + 200;
    const files = Array.from({ length: 20 }, (_, index) => `src/missing-${index}.ts`);
    const result = await planAnalysis({ config, parser, cwd, files });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThan(files.length);
    expect(result.sources.every((file) => file.sha256 === null)).toBe(true);
    expect(result.issues.some((issue) => issue.reason === "input_too_large")).toBe(true);
  });
  test("plan size limit makes incomplete coverage explicit", async () => {
    const config = parseConfig(CONFIG);
    config.maxPlanBytes = 1;
    const result = await planAnalysis({ config, parser, cwd, files: ["src/a.ts"] });
    expect(result.issues[0]?.reason).toBe("input_too_large");
  });
});

describe("inference and reporting", () => {
  test("preserves raw low scores, excludes interpretation, and allows provider replay", async () => {
    const evidence = await plan();
    const first = await classifyPlan({ plan: evidence, classification: fakeClassification() });
    const second = await classifyPlan({ plan: evidence, classification: fakeClassification() });
    expect(second).toEqual(first);
    expect(first.summary).toMatchObject({ evaluated: 5, notEvaluated: 0, requests: 1, inputTokens: 5 });
    expect(first.results.every((result) => result.status === "evaluated" && result.score === 0.1)).toBe(true);
    const json = formatResult(first, "json");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("violation");
    expect(json).toContain('"question":');
    expect(first.rules[0]?.includeIf).toMatchObject({ name: "catches", query: "(try_statement handler: (catch_clause))\n" });
    expect(first.coverage).toEqual([
      { section: "ts", rule: "catch", eligible: 2, evaluated: 2, notEvaluated: 0, excluded: 1 },
      { section: "ts", rule: "purpose", eligible: 3, evaluated: 3, notEvaluated: 0, excluded: 0 },
    ]);
    expect(first.sources[0]?.sha256).toHaveLength(64);
    expect(formatPlan(evidence, "text")).toContain("dry run, nothing sent");
    const alternate = await classifyPlan({ plan: evidence, classification: fakeClassification("alternate") });
    expect(alternate.classification).toEqual({ provider: "alternate", model: "test" });
    expect(evidence.classification.provider).toBe("typesafe");
  });
  test("coalesces questions and exact evidence across distinct source locations", async () => {
    const evidence = await plan(CONFIG, ["src/a.ts", "src/b.ts"]);
    let calls = 0;
    const provider: ClassificationProvider = {
      name: "test", model: "test",
      async classify(batch) {
        calls++;
        return { model: "test", scores: new Map([...batch.questions.keys()].map((id) => [id, 0.92])), failures: new Map(), usage: { inputTokens: 10, outputTokens: 0 } };
      },
    };
    const classification = createClassification({ config: ClassificationConfig.parse({ retries: 0 }), provider });
    const result = await classifyPlan({ plan: evidence, classification });
    expect(calls).toBe(3);
    expect(result.results).toHaveLength(10);
    expect(result.summary.inputTokens).toBe(30);
    expect(new Set(result.results.map((item) => item.location.file)).size).toBe(2);
  });
  test("missing, invalid, duplicate, and unknown outcome IDs are not silently accepted", async () => {
    const evidence = await plan();
    const first = evidence.evaluations[0];
    if (!first) {
      throw new Error("fixture has no evaluations");
    }
    const classification: Classification = {
      provider: "test", model: "test",
      async classify(_tasks: readonly ClassificationTask[]) {
        return { outcomes: [
          { id: first.id, status: "evaluated", score: 2, executionId: "bad" },
          { id: first.id, status: "evaluated", score: 0.5, executionId: "bad" },
          { id: "unknown", status: "evaluated", score: 0.5, executionId: "bad" },
        ], executions: [] };
      },
    };
    const result = await classifyPlan({ plan: evidence, classification });
    expect(result.summary.notEvaluated).toBe(5);
    expect(result.issues).toHaveLength(1);
    expect(result.results.every((item) => !Object.hasOwn(item, "score"))).toBe(true);
  });
});
