import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createClassification } from "../src/classification.ts";
import { ClassificationConfig } from "../src/config.ts";
import { createHttpProvider } from "../src/jev.ts";

const RequestBody = z.object({
  model: z.string(), state: z.record(z.string(), z.array(z.string())),
  questions: z.record(z.string(), z.object({ type: z.literal("noul"), instructions: z.string() })),
});
const requests: { url: string; authorization: string | null; payload: z.infer<typeof RequestBody> }[] = [];
let mode: "normal" | "partial" | "invalid" | "unknown" | "bad-envelope" | "slow" = "normal";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = RequestBody.parse(await request.json());
    if (mode === "slow") { await Bun.sleep(30); }
    if (mode === "bad-envelope") { return Response.json({ answers: {} }); }
    const answers = new Map([...Object.keys(body.questions)].map((id) => [id, { type: "noul", noul: 0.73 }]));
    if (mode === "partial") { answers.delete("q1"); }
    if (mode === "invalid") { answers.set("q1", { type: "noul", noul: 2 }); }
    if (mode === "unknown") { answers.set("wrong", { type: "noul", noul: 0.5 }); }
    return Response.json({ model: "typesafe/jev-1.13-pinned", id: "remote-request", answers: Object.fromEntries(answers), usage: { input_tokens: 123, output_tokens: 0, cost: 0.001 } });
  },
});
afterAll(() => server.stop(true));

async function run(provider: "typesafe" | "openrouter", retries = 0, timeoutMs = 30000) {
  const config = ClassificationConfig.parse({ provider, model: "selected", retries, timeoutMs });
  const transport = createHttpProvider({
    config, apiKey: "test-key",
    async send(request) {
      const body = await request.text();
      requests.push({ url: request.url, authorization: request.headers.get("authorization"), payload: RequestBody.parse(JSON.parse(body)) });
      return fetch(server.url.toString(), { method: request.method, headers: Object.fromEntries(request.headers), body, signal: request.signal });
    },
  });
  return createClassification({ config, provider: transport }).classify([
    { id: "first", state: { code: ["work();"] }, question: "first question" },
    { id: "second", state: { code: ["work();"] }, question: "second question" },
  ]);
}

describe("provider transport contracts", () => {
  test.each(["typesafe", "openrouter"] as const)("%s uses the documented URL and native probabilities", async (provider) => {
    mode = "normal";
    const result = await run(provider);
    const request = requests[requests.length - 1];
    if (!request) { throw new Error("no request"); }
    expect(request.url).toBe(provider === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://openrouter.ai/api/v1/systemone");
    expect(request.authorization).toBe("Bearer test-key");
    expect(request.payload.model).toBe("selected");
    expect(request.payload.questions.q0).toEqual({ type: "noul", instructions: "first question" });
    expect(result.outcomes.every((answer) => answer.status === "evaluated" && answer.score === 0.73)).toBe(true);
    expect(result.executions[0]).toMatchObject({ requestedModel: "selected", returnedModel: "typesafe/jev-1.13-pinned", requestId: "remote-request", usage: { inputTokens: 123, outputTokens: 0, cost: 0.001 } });
  });
  test.each(["partial", "invalid"] as const)("valid answers survive a %s sibling", async (next) => {
    mode = next;
    const result = await run("openrouter");
    expect(result.outcomes[0]).toMatchObject({ status: "evaluated", score: 0.73 });
    expect(result.outcomes[1]).toMatchObject({ status: "not_evaluated", reason: "request_failed" });
  });
  test("malformed responses are not retried even when retries are enabled", async () => {
    mode = "bad-envelope";
    const before = requests.length;
    const result = await run("openrouter", 2);
    expect(requests.length - before).toBe(1);
    expect(result.outcomes.every((answer) => answer.status === "not_evaluated")).toBe(true);
  });
  test("request timeouts produce explicit failures", async () => {
    mode = "slow";
    const result = await run("typesafe", 0, 5);
    expect(result.outcomes.every((answer) => answer.status === "not_evaluated")).toBe(true);
    expect(result.executions[0]?.attempts).toBe(1);
  });
  test.each(["unknown", "bad-envelope"] as const)("%s responses cannot fabricate scores", async (next) => {
    mode = next;
    const result = await run("typesafe");
    expect(result.outcomes.every((answer) => answer.status === "not_evaluated")).toBe(true);
  });
});
