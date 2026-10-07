import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { reviewLedger } from "../src/artifacts.ts";
import { classifyPlan, planAnalysis } from "../src/check.ts";
import { parseConfig } from "../src/config.ts";
import type { Classification } from "../src/model.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";

const labels = z.object({ examples: z.array(z.object({ id: z.string(), line: z.number(), rule: z.string(), expectedYes: z.boolean(), expectedEligible: z.boolean(), expectedDecision: z.enum(["address", "leave"]), reason: z.string() })) }).parse(await Bun.file(new URL("./fixtures/review-labels.json", import.meta.url)).json());
let parser: SourceParser;
beforeAll(async () => { parser = await createSourceParser(); });
afterAll(() => parser.dispose());
const config = parseConfig(`version: 2
fileSets:
  fixtures:
    include: ['review.ts']
targets:
  test:
    language: typescript
    root: code
    location: title
    query: |
      ((call_expression
        function: (identifier) @callee
        arguments: (arguments (string) @title (arrow_function))) @code
        (#eq? @callee "test"))
sections:
  - name: review
    language: typescript
    files: fixtures
    rules:
      - id: tests.title-describes-check
        target: test
        score: Does the test title describe what the assertions verify?
        review:
          yesMeans: desirable
      - id: comments.narrates-code
        target: comment
        score: Does comment merely narrate code?
        review:
          yesMeans: undesirable
`);

test("labeled regression examples have real complete extraction and anchors", async () => {
  const plan = await planAnalysis({ config, parser, cwd: new URL("./fixtures", import.meta.url).pathname, files: ["review.ts"] });
  expect(plan.results).toEqual([]);
  expect(plan.issues).toEqual([]);
  expect(plan.evaluations).toHaveLength(labels.examples.length);
  for (const label of labels.examples) {
    const evaluation = plan.evaluations.find((item) => item.rule === label.rule && item.location.startLine === label.line);
    expect(evaluation !== undefined).toBe(label.expectedEligible);
    expect(evaluation?.state.code?.[0]).toContain(label.rule.startsWith("comments") ? "client.wait().catch" : "expect");
  }
  const classifier: Classification = {
    provider: "fixture", model: "fixture",
    async classify(tasks) {
      return { outcomes: tasks.map((task) => ({ id: task.id, status: "evaluated", score: 0.89, executionId: "fixture" })), executions: [{ id: "fixture", provider: "fixture", requestedModel: "fixture", attempts: 1, status: "succeeded" }] };
    },
  };
  const report = await classifyPlan({ plan, classification: classifier });
  const ledger = reviewLedger(report);
  expect(ledger).toHaveLength(3);
  expect(ledger.every((row) => row.decision === null)).toBe(true);
  expect(ledger.every((row) => "score" in row.assessment && row.assessment.score === 0.89)).toBe(true);
  expect(labels.examples[0]).toMatchObject({ expectedYes: false, expectedDecision: "address" });
});

test("object equality cannot establish the key-order property in a test title", () => {
  const expected = { first: 1, second: 2 };
  const actual = { second: 2, first: 1 };
  expect(actual).toEqual(expected);
  expect(Object.keys(actual)).not.toEqual(Object.keys(expected));
});
