import { z } from "zod";
import type { ClassificationConfig } from "./config.ts";
import type { ClassificationExecution, EvidenceState } from "./model.ts";

export interface ClassificationBatch {
  state: EvidenceState;
  questions: Map<string, { question: string; ids: string[] }>;
}

export interface ProviderResponse {
  model: string;
  scores: Map<string, number>;
  failures: Map<string, string>;
  requestId?: string;
  usage?: ClassificationExecution["usage"];
}

export interface ClassificationProvider {
  name: string;
  model: string;
  classify(batch: ClassificationBatch, signal: AbortSignal): Promise<ProviderResponse>;
}

export class ProviderHttpError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs: number) {
    super(`Classification provider returned HTTP ${status}.`);
  }
}

const Envelope = z.object({
  model: z.string().min(1),
  id: z.string().optional(),
  answers: z.record(z.string(), z.json()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative().optional(),
  }).optional(),
});
const Answer = z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) });

export function providerPayload(model: string, batch: ClassificationBatch): string {
  return JSON.stringify({
    model,
    state: batch.state,
    questions: Object.fromEntries([...batch.questions].map(([id, item]) => [id, { type: "noul", instructions: item.question }])),
  });
}

export function createHttpProvider(input: {
  config: ClassificationConfig;
  apiKey: string;
  send?: (request: Request) => Promise<Response>;
}): ClassificationProvider {
  const { config } = input;
  // OpenRouter documents the System One wire contract separately from chat completions.
  const endpoint = config.provider === "openrouter"
    ? "https://openrouter.ai/api/v1/systemone"
    : "https://api.typesafe.ai/v1/systemone";
  const send = input.send ?? ((request: Request) => fetch(request));
  return {
    name: config.provider,
    model: config.model,
    async classify(batch, signal) {
      const response = await send(new Request(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
        body: providerPayload(config.model, batch),
        signal,
      }));
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        let retryAfterMs = 0;
        if (retryAfter !== null) {
          const seconds = Number(retryAfter);
          retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        }
        await response.body?.cancel();
        throw new ProviderHttpError(response.status, Math.max(0, Math.min(60000, retryAfterMs || 0)));
      }
      const envelope = Envelope.parse(await response.json());
      const scores = new Map<string, number>();
      const failures = new Map<string, string>();
      const unexpected = Object.keys(envelope.answers).filter((id) => !batch.questions.has(id));
      if (unexpected.length > 0) {
        throw new Error("Classification response contains unknown question IDs.");
      }
      for (const id of batch.questions.keys()) {
        const parsed = Answer.safeParse(envelope.answers[id]);
        if (parsed.success) {
          scores.set(id, parsed.data.noul);
        } else {
          failures.set(id, "Provider returned a missing or invalid native probability answer.");
        }
      }
      return {
        model: envelope.model, scores, failures, requestId: envelope.id,
        usage: envelope.usage ? {
          inputTokens: envelope.usage.input_tokens,
          outputTokens: envelope.usage.output_tokens,
          cost: envelope.usage.cost,
        } : undefined,
      };
    },
  };
}
