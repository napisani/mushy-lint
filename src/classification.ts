import type { ClassificationConfig } from "./config.ts";
import { classificationCredential } from "./credentials.ts";
import { createHttpProvider, providerPayload, ProviderHttpError, type ClassificationBatch, type ClassificationProvider } from "./jev.ts";
import type { Classification, ClassificationOutcome, ClassificationRun, ClassificationTask, EvidenceState } from "./model.ts";

function stateKey(state: EvidenceState): string {
  return JSON.stringify(Object.entries(state).sort(([a], [b]) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  }));
}

function failed(ids: string[], reason: "input_too_large" | "request_failed", message: string): ClassificationOutcome[] {
  return ids.map((id) => ({ id, status: "not_evaluated", reason, message }));
}

export function planClassification(tasks: readonly ClassificationTask[], config: ClassificationConfig) {
  const states = new Map<string, ClassificationBatch>();
  for (const task of tasks) {
    const key = stateKey(task.state);
    let group = states.get(key);
    if (!group) {
      group = { state: task.state, questions: new Map() };
      states.set(key, group);
    }
    const question = group.questions.get(task.question);
    if (question) {
      question.ids.push(task.id);
    } else {
      group.questions.set(task.question, { question: task.question, ids: [task.id] });
    }
  }
  const batches: ClassificationBatch[] = [];
  const outcomes: ClassificationOutcome[] = [];
  for (const group of states.values()) {
    let batch: ClassificationBatch = { state: group.state, questions: new Map() };
    for (const item of group.questions.values()) {
      const single: ClassificationBatch = { state: group.state, questions: new Map([["q0", item]]) };
      if (Buffer.byteLength(providerPayload(config.model, single)) > config.maxInputBytes) {
        outcomes.push(...failed(item.ids, "input_too_large", "Complete evidence and question exceed maxInputBytes."));
        continue;
      }
      let id = `q${batch.questions.size}`;
      const candidate = { state: batch.state, questions: new Map([...batch.questions, [id, item]]) };
      if (batch.questions.size >= config.maxQuestions || Buffer.byteLength(providerPayload(config.model, candidate)) > config.maxInputBytes) {
        batches.push(batch);
        batch = { state: group.state, questions: new Map() };
        id = "q0";
      }
      batch.questions.set(id, item);
    }
    if (batch.questions.size > 0) {
      batches.push(batch);
    }
  }
  return { batches, outcomes };
}

class RateLimiter {
  private next = 0;
  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const start = Math.max(Date.now(), this.next);
    this.next = start + this.intervalMs;
    signal?.throwIfAborted();
    const delay = start - Date.now();
    if (delay > 0) {
      await Bun.sleep(delay);
    }
    signal?.throwIfAborted();
  }
}

function retryable(error: Error | ProviderHttpError): boolean {
  if (error instanceof ProviderHttpError) {
    return [408, 429, 500, 502, 503, 524, 529].includes(error.status);
  }
  return error instanceof TypeError || (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name));
}

export function createClassification(input: {
  config: ClassificationConfig;
  provider?: ClassificationProvider;
  credentialFile?: string;
}): Classification {
  const config = { ...input.config };
  const limiter = new RateLimiter(1000 / config.requestsPerSecond);
  return {
    provider: input.provider?.name ?? config.provider,
    model: input.provider?.model ?? config.model,
    async classify(tasks, signal) {
      const effectiveConfig = { ...config, model: input.provider?.model ?? config.model };
      const planned = planClassification(tasks, effectiveConfig);
      const run: ClassificationRun = { outcomes: planned.outcomes, executions: [] };
      if (planned.batches.length === 0) {
        return run;
      }
      let selected = input.provider;
      if (!selected) {
        const env = config.apiKeyEnv ?? (config.provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY");
        try {
          const apiKey = await classificationCredential({ config, file: input.credentialFile });
          if (!apiKey) { throw new Error(`Missing classification credential: ${env}`); }
          selected = createHttpProvider({ config, apiKey });
        } catch (error) {
          const ids = planned.batches.flatMap((batch) => [...batch.questions.values()].flatMap((item) => item.ids));
          run.outcomes.push(...failed(ids, "request_failed", error instanceof Error ? error.message : "Unable to load classification credential."));
          return run;
        }
      }
      const provider = selected;
      const queue = planned.batches.entries();
      async function execute(index: number, batch: ClassificationBatch): Promise<void> {
        const executionId = `execution-${index}`;
        const execution: ClassificationRun["executions"][number] = {
          id: executionId, provider: provider.name, requestedModel: provider.model,
          attempts: 0, status: "failed",
        };
        const ids = [...batch.questions.values()].flatMap((item) => item.ids);
        for (let attempt = 0; attempt <= config.retries; attempt++) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- rate limiting applies to every retry as well as first attempts
            await limiter.wait(signal);
            execution.attempts++;
            const deadline = AbortSignal.timeout(config.timeoutMs);
            const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
            // oxlint-disable-next-line no-await-in-loop -- retries must finish before another attempt is sent
            const response = await provider.classify(batch, requestSignal);
            execution.status = "succeeded";
            execution.returnedModel = response.model;
            execution.requestId = response.requestId;
            execution.usage = response.usage;
            for (const [id, item] of batch.questions) {
              const score = response.scores.get(id);
              if (score !== undefined && Number.isFinite(score) && score >= 0 && score <= 1) {
                run.outcomes.push(...item.ids.map((evaluationId): ClassificationOutcome => ({ id: evaluationId, status: "evaluated", score, executionId })));
              } else {
                run.outcomes.push(...failed(item.ids, "request_failed", response.failures.get(id) ?? "Missing or invalid classification score."));
              }
            }
            break;
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (signal?.aborted || attempt === config.retries || !retryable(failure)) {
              const reason = failure instanceof ProviderHttpError && failure.status === 413 ? "input_too_large" : "request_failed";
              run.outcomes.push(...failed(ids, reason, failure.message));
              break;
            }
            const backoff = failure instanceof ProviderHttpError ? failure.retryAfterMs : 0;
            // oxlint-disable-next-line no-await-in-loop -- the retry budget includes serial backoff
            await Bun.sleep(Math.max(backoff, Math.min(1000 * 2 ** attempt, 10000)));
          }
        }
        if (execution.attempts > 0) {
          run.executions.push(execution);
        }
      }
      async function worker(): Promise<void> {
        for (const [index, batch] of queue) {
          // oxlint-disable-next-line no-await-in-loop -- each worker is a serial lane in the bounded pool
          await execute(index, batch);
        }
      }
      await Promise.all(Array.from({ length: Math.min(config.concurrency, planned.batches.length) }, worker));
      run.executions.sort((a, b) => a.id.localeCompare(b.id));
      return run;
    },
  };
}
