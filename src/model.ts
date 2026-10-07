import { z } from "zod";
import type { Rule, Section, Target } from "./config.ts";

export const EvidenceState = z.record(z.string(), z.array(z.string()).readonly()).readonly();
export type EvidenceState = z.infer<typeof EvidenceState>;

export interface SourceLocation {
  file: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  startIndex: number;
  endIndex: number;
}

export type FailureReason = "parse_error" | "input_too_large" | "context_unavailable" | "extraction_failed" | "request_failed";
export interface Failure {
  reason: FailureReason;
  message: string;
}

export interface Evaluation {
  id: string;
  section: string;
  rule: string;
  target: string;
  location: SourceLocation;
  root: SourceLocation | null;
  state: EvidenceState;
  question: string;
}

export type EvaluationResult =
  | (Evaluation & { status: "evaluated"; score: number; executionId: string })
  | (Evaluation & Failure & { status: "not_evaluated" });

export interface Issue extends Failure {
  file?: string;
  section?: string;
}

export interface RuleRecord {
  section: string;
  rule: string;
  language: Section["language"];
  score: string;
  target: { kind: "comment"; name: string } | ({ kind: "query"; name: string } & Target);
  includeIf: Rule["includeIf"];
  context: Rule["context"];
  review: Rule["review"];
  files: { section: Section["files"]; ruleExcludes: string[] };
}

export interface SourceRecord {
  file: string;
  sha256: string | null;
  bytes: number | null;
  targets: number;
  exclusions: { section: string; rule: string; count: number }[];
}

export interface RuleCoverage {
  section: string;
  rule: string;
  eligible: number;
  evaluated: number;
  notEvaluated: number;
  excluded: number;
}

export type Sampling =
  | { mode: "all"; candidates: number; files: string[] }
  | { mode: "random" | "rule-stratified"; seed: string; requested: number; candidates: number; files: string[] };

export interface AnalysisPlan {
  classification: { provider: string; model: string };
  sampling: Sampling;
  rules: RuleRecord[];
  sources: SourceRecord[];
  evaluations: Evaluation[];
  results: EvaluationResult[];
  issues: Issue[];
  summary: {
    files: number;
    targets: number;
    excluded: number;
  };
}

export interface ClassificationTask {
  id: string;
  state: EvidenceState;
  question: string;
}

export type ClassificationOutcome =
  | { id: string; status: "evaluated"; score: number; executionId: string }
  | ({ id: string; status: "not_evaluated" } & Failure);

export interface ClassificationExecution {
  id: string;
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
  attempts: number;
  status: "succeeded" | "failed";
}

export interface ClassificationRun {
  outcomes: ClassificationOutcome[];
  executions: ClassificationExecution[];
}

export interface Classification {
  readonly provider: string;
  readonly model: string;
  classify(tasks: readonly ClassificationTask[], signal?: AbortSignal): Promise<ClassificationRun>;
}

export interface AnalysisReport {
  classification: AnalysisPlan["classification"];
  sampling: Sampling;
  rules: AnalysisPlan["rules"];
  sources: SourceRecord[];
  coverage: RuleCoverage[];
  results: EvaluationResult[];
  issues: Issue[];
  executions: ClassificationExecution[];
  summary: AnalysisPlan["summary"] & {
    eligible: number;
    evaluated: number;
    notEvaluated: number;
    requests: number;
    attempts: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}
