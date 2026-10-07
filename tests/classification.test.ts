import { describe, expect, test } from "bun:test";
import { createClassification, planClassification } from "../src/classification.ts";
import { ClassificationConfig } from "../src/config.ts";
import type { ClassificationBatch, ClassificationProvider } from "../src/jev.ts";
import { ProviderHttpError } from "../src/jev.ts";
import type { ClassificationTask } from "../src/model.ts";

const config = ClassificationConfig.parse({ retries: 0 });
const task = (id: string, question = "Does code work?"): ClassificationTask => ({ id, state: { code: ["work();"] }, question });

function recordingProvider(): ClassificationProvider & { batches: ClassificationBatch[] } {
  const batches: ClassificationBatch[] = [];
  return {
    name: "fixture", model: "fixture-v1", batches,
    async classify(batch) {
      batches.push(batch);
      return { model: "fixture-v1", scores: new Map([...batch.questions.keys()].map((id) => [id, 0.42])), failures: new Map(), usage: { inputTokens: 10, outputTokens: 0 } };
    },
  };
}

describe("classification", () => {
  test("batches multiple questions, deduplicates exact work, and fans answers out", async () => {
    const provider = recordingProvider();
    const run = await createClassification({ config, provider }).classify([task("a"), task("b"), task("c", "Is code async?")]);
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.questions.size).toBe(2);
    expect(run.outcomes).toHaveLength(3);
    expect(run.outcomes.every((answer) => answer.status === "evaluated" && answer.score === 0.42)).toBe(true);
    expect(run.executions).toHaveLength(1);
  });
  test("object key order is canonical but source text and list order remain significant", () => {
    const tasks: ClassificationTask[] = [
      { id: "a", state: { code: ["x"], names: ["a", "b"] }, question: "same" },
      { id: "b", state: { names: ["a", "b"], code: ["x"] }, question: "same" },
      { id: "c", state: { code: ["x "], names: ["a", "b"] }, question: "same" },
      { id: "d", state: { code: ["x"], names: ["b", "a"] }, question: "same" },
    ];
    expect(planClassification(tasks, config).batches).toHaveLength(3);
  });
  test("splits question groups without narrowing evidence", async () => {
    const provider = recordingProvider();
    const limited = ClassificationConfig.parse({ retries: 0, maxQuestions: 1 });
    const run = await createClassification({ config: limited, provider }).classify([task("a", "first"), task("b", "second")]);
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches.every((batch) => batch.state.code?.[0] === "work();")).toBe(true);
    expect(run.outcomes).toHaveLength(2);
  });
  test("oversized evidence is explicit, never truncated or sent", async () => {
    const provider = recordingProvider();
    const run = await createClassification({ config: ClassificationConfig.parse({ maxInputBytes: 256, retries: 0 }), provider }).classify([
      { id: "big", state: { code: ["x".repeat(1000)] }, question: "Does it work?" },
    ]);
    expect(provider.batches).toEqual([]);
    expect(run.outcomes).toEqual([{ id: "big", status: "not_evaluated", reason: "input_too_large", message: "Complete evidence and question exceed maxInputBytes." }]);
  });
  test("retains valid answers when another question is missing", async () => {
    const provider: ClassificationProvider = {
      name: "partial", model: "test",
      async classify() { return { model: "test", scores: new Map([["q0", 0.8]]), failures: new Map() }; },
    };
    const run = await createClassification({ config, provider }).classify([task("a", "first"), task("b", "second")]);
    expect(run.outcomes[0]).toMatchObject({ status: "evaluated", score: 0.8 });
    expect(run.outcomes[1]).toMatchObject({ status: "not_evaluated", reason: "request_failed" });
  });
  test("bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const provider: ClassificationProvider = {
      name: "fixture", model: "fixture",
      async classify(batch) {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(40);
        active--;
        return { model: "fixture", scores: new Map([...batch.questions.keys()].map((id) => [id, 0.5])), failures: new Map() };
      },
    };
    await createClassification({ config: ClassificationConfig.parse({ concurrency: 2, retries: 0 }), provider }).classify(
      Array.from({ length: 5 }, (_, index) => ({ id: String(index), state: { code: [String(index)] }, question: "same" })),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
  test("retries transient failures within the budget and records uncertain usage", async () => {
    let calls = 0;
    const provider: ClassificationProvider = {
      name: "fixture", model: "fixture",
      async classify(batch) {
        if (++calls === 1) {
          throw new ProviderHttpError(429, 0);
        }
        return { model: "fixture", scores: new Map([...batch.questions.keys()].map((id) => [id, 0.5])), failures: new Map(), usage: { inputTokens: 10, outputTokens: 0 } };
      },
    };
    const run = await createClassification({ config: ClassificationConfig.parse({ retries: 1 }), provider }).classify([task("retry")]);
    expect(calls).toBe(2);
    expect(run.executions[0]?.attempts).toBe(2);
  });
  test("does not retry non-retryable HTTP errors", async () => {
    let calls = 0;
    const provider: ClassificationProvider = {
      name: "fixture", model: "fixture",
      async classify() { calls++; throw new ProviderHttpError(401, 0); },
    };
    const run = await createClassification({ config: ClassificationConfig.parse({ retries: 2 }), provider }).classify([task("denied")]);
    expect(calls).toBe(1);
    expect(run.outcomes[0]).toMatchObject({ status: "not_evaluated", reason: "request_failed" });
  });
  test("oversized work needs no credential and provider size rejection is explicit", async () => {
    const limited = ClassificationConfig.parse({ maxInputBytes: 256, apiKeyEnv: "MUSHY_LINT_TEST_UNUSED_KEY", retries: 0 });
    const local = await createClassification({ config: limited }).classify([{ id: "huge", state: { code: ["x".repeat(1000)] }, question: "check" }]);
    expect(local.outcomes[0]).toMatchObject({ reason: "input_too_large" });
    const provider: ClassificationProvider = { name: "test", model: "test", async classify() { throw new ProviderHttpError(413, 0); } };
    const remote = await createClassification({ config, provider }).classify([task("remote")]);
    expect(remote.outcomes[0]).toMatchObject({ status: "not_evaluated", reason: "input_too_large" });
  });
  test("cancellation produces explicit outcomes without sending requests", async () => {
    const provider = recordingProvider();
    const run = await createClassification({ config, provider }).classify([task("cancelled")], AbortSignal.abort());
    expect(provider.batches).toEqual([]);
    expect(run.outcomes[0]).toMatchObject({ status: "not_evaluated", reason: "request_failed" });
  });
});
