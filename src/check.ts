import { Glob } from "bun";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Tree } from "web-tree-sitter";
import type { Config, Rule, Section } from "./config.ts";
import { compileFiles, matchesFiles } from "./files.ts";
import { type ChangedLines, overlaps } from "./git.ts";
import type { AnalysisPlan, AnalysisReport, Classification, ClassificationRun, Evaluation, EvaluationResult, Failure, SourceRecord } from "./model.ts";
import { ruleCoverage } from "./report.ts";
import { createSourceParser, type SourceParser } from "./parser.ts";
import { sourceLocation, TargetExtractor, type ExtractedTarget } from "./targets.ts";

interface CompiledSection {
  section: Section;
  files: ReturnType<typeof compileFiles>;
  ruleExcludes: Map<Rule, Glob[]>;
}

interface Planning {
  plan: AnalysisPlan;
  config: Config;
  extractor: TargetExtractor;
  retainedBytes: number;
}

function inScope(target: ExtractedTarget, changed: ChangedLines | null, file: string): boolean {
  const ranges = changed?.get(file);
  return !changed || (ranges !== undefined && target.evidence.some((node) =>
    overlaps(ranges, node.startPosition.row + 1, node.endPosition.row + 1)));
}

type Selection = { status: "excluded" } | { status: "included"; failure?: Failure };

function selectRule(input: { target: ExtractedTarget; rule: Rule; tree: Tree; extractor: TargetExtractor }): Selection {
  let failure = input.target.failure;
  if (input.target.root === null) {
    return { status: "included", failure: failure ?? { reason: "extraction_failed", message: "Target has no root." } };
  }
  if (!failure && input.rule.includeIf) {
    try {
      if (!input.extractor.qualifies(input.tree, input.target.root, input.rule.includeIf.query)) {
        return { status: "excluded" };
      }
    } catch (error) {
      failure = { reason: "extraction_failed", message: `includeIf: ${String(error)}` };
    }
  }
  if (!failure && input.rule.context.length > 0) {
    failure = { reason: "context_unavailable", message: `Unsupported required context: ${input.rule.context.join(", ")}` };
  }
  return { status: "included", failure };
}

function appendTarget(input: { planning: Planning; compiled: CompiledSection; targetName: string; target: ExtractedTarget; tree: Tree; file: string; source: SourceRecord }): boolean {
  const { planning, compiled, targetName, target, tree, file, source } = input;
  const { plan } = planning;
  plan.summary.targets++;
  source.targets++;
  for (const rule of compiled.section.rules.filter((item) => item.target === targetName)) {
    const selection = compiled.ruleExcludes.get(rule)?.some((glob) => glob.match(file))
      ? { status: "excluded" } as const
      : selectRule({ target, rule, tree, extractor: planning.extractor });
    if (selection.status === "excluded") {
      plan.summary.excluded++;
      const exclusion = source.exclusions.find((item) => item.section === compiled.section.name && item.rule === rule.id);
      if (exclusion) { exclusion.count++; } else { source.exclusions.push({ section: compiled.section.name, rule: rule.id, count: 1 }); }
      continue;
    }
    const evaluation: Evaluation = {
      id: `evaluation-${plan.evaluations.length + plan.results.length}`,
      section: compiled.section.name, rule: rule.id, target: targetName,
      location: target.location, root: target.root ? sourceLocation(file, target.root) : null,
      state: target.state, question: rule.score,
    };
    planning.retainedBytes += Buffer.byteLength(JSON.stringify(evaluation));
    if (planning.retainedBytes > planning.config.maxPlanBytes) {
      plan.issues.push({ reason: "input_too_large", message: "Analysis plan exceeds maxPlanBytes; remaining coverage is incomplete." });
      return false;
    }
    if (selection.failure) {
      plan.results.push({ ...evaluation, status: "not_evaluated", ...selection.failure });
    } else {
      plan.evaluations.push(evaluation);
    }
  }
  return true;
}

function appendFile(input: { planning: Planning; matching: CompiledSection[]; tree: Tree; file: string; changed: ChangedLines | null; source: SourceRecord }): boolean {
  const { planning, matching, tree, file, changed, source } = input;
  if (tree.rootNode.hasError) {
    planning.plan.issues.push({ file, reason: "parse_error", message: "File has syntax errors; target coverage may be incomplete." });
  }
  const extracted = new Map<string, ExtractedTarget[]>();
  for (const compiled of matching) {
    for (const targetName of new Set(compiled.section.rules.map((rule) => rule.target))) {
      const definition = planning.config.targets[targetName];
      const key = JSON.stringify(definition ?? "comment");
      let targets = extracted.get(key);
      try {
        targets ??= planning.extractor.extract(file, tree, definition);
        extracted.set(key, targets);
      } catch (error) {
        planning.plan.issues.push({ file, section: compiled.section.name, reason: "extraction_failed", message: `Target ${targetName}: ${String(error)}` });
        continue;
      }
      for (const target of targets) {
        if (inScope(target, changed, file) && !appendTarget({ planning, compiled, targetName, target, tree, file, source })) {
          return false;
        }
      }
    }
  }
  return true;
}

export async function planAnalysis(input: {
  config: Config;
  parser?: SourceParser;
  cwd: string;
  files: string[];
  changed?: ChangedLines | null;
}): Promise<AnalysisPlan> {
  const plan: AnalysisPlan = {
    classification: { provider: input.config.classification.provider, model: input.config.classification.model },
    sampling: { mode: "all", candidates: 0, files: [] },
    rules: input.config.sections.flatMap((section) => section.rules.map((rule) => {
      const definition = input.config.targets[rule.target];
      return {
        section: section.name, rule: rule.id, language: section.language, score: rule.score,
        target: definition ? { kind: "query" as const, name: rule.target, ...definition } : { kind: "comment" as const, name: rule.target },
        includeIf: rule.includeIf, context: rule.context, review: rule.review,
        files: { section: section.files, ruleExcludes: rule.files?.exclude ?? [] },
      };
    })),
    sources: [], evaluations: [], results: [], issues: [], summary: { files: 0, targets: 0, excluded: 0 },
  };
  const compiled = input.config.sections.map((section): CompiledSection => ({
    section,
    files: compileFiles(section.files),
    ruleExcludes: new Map(section.rules.map((rule) => [rule, (rule.files?.exclude ?? []).map((pattern) => new Glob(pattern))])),
  }));
  const retainedBytes = Buffer.byteLength(JSON.stringify(plan));
  if (retainedBytes > input.config.maxPlanBytes) {
    plan.issues.push({ reason: "input_too_large", message: "Analysis plan exceeds maxPlanBytes; coverage is incomplete." });
    return plan;
  }
  const parser = input.parser ?? await createSourceParser();
  const planning: Planning = { plan, config: input.config, extractor: new TargetExtractor(), retainedBytes };
  try {
    for (const file of [...new Set(input.files)].sort()) {
      const matching = compiled.filter((section) => matchesFiles(section.files, file));
      if (matching.length === 0 || (input.changed && !input.changed.has(file))) {
        continue;
      }
      plan.summary.files++;
      const source: SourceRecord = { file, sha256: null, bytes: null, targets: 0, exclusions: [] };
      plan.sources.push(source);
      let tree: Tree | null = null;
      const issuesBefore = plan.issues.length;
      try {
        // oxlint-disable-next-line no-await-in-loop -- source analysis has one bounded file lane
        const bytes = await Bun.file(join(input.cwd, file)).bytes();
        source.sha256 = createHash("sha256").update(bytes).digest("hex");
        source.bytes = bytes.length;
        tree = parser.parse({ file, source: Buffer.from(bytes).toString("utf8"), language: "typescript" });
        if (!tree) { throw new Error("No supported grammar parsed this file."); }
        if (!appendFile({ planning, matching, tree, file, changed: input.changed ?? null, source })) { break; }
      } catch (error) {
        plan.issues.push({ file, reason: "extraction_failed", message: String(error) });
      } finally {
        tree?.delete();
        planning.retainedBytes += Buffer.byteLength(JSON.stringify(source)) +
          Buffer.byteLength(JSON.stringify(plan.issues.slice(issuesBefore)));
      }
      if (planning.retainedBytes > input.config.maxPlanBytes) {
        plan.issues.push({ reason: "input_too_large", message: "Analysis plan exceeds maxPlanBytes; remaining coverage is incomplete." });
        break;
      }
    }
  } finally {
    planning.extractor.dispose();
    if (!input.parser) {
      parser.dispose();
    }
  }
  plan.sampling = { mode: "all", candidates: plan.sources.length, files: plan.sources.map((source) => source.file) };
  return plan;
}

function joinOutcomes(plan: AnalysisPlan, run: ClassificationRun) {
  const outcomes = new Map<string, typeof run.outcomes>();
  const expected = new Set(plan.evaluations.map((evaluation) => evaluation.id));
  const executions = new Set(run.executions.map((execution) => execution.id));
  const issues = [...plan.issues];
  for (const outcome of run.outcomes) {
    if (!expected.has(outcome.id)) {
      issues.push({ reason: "request_failed", message: `Classification returned unknown evaluation ID ${outcome.id}.` });
      continue;
    }
    const items = outcomes.get(outcome.id) ?? [];
    items.push(outcome);
    outcomes.set(outcome.id, items);
  }
  const results: EvaluationResult[] = [...plan.results];
  for (const evaluation of plan.evaluations) {
    const answers = outcomes.get(evaluation.id) ?? [];
    const answer = answers[0];
    if (answers.length !== 1 || !answer) {
      results.push({ ...evaluation, status: "not_evaluated", reason: "request_failed", message: "Classification returned missing or duplicate answers." });
    } else if (answer.status === "not_evaluated") {
      results.push({ ...evaluation, status: "not_evaluated", reason: answer.reason, message: answer.message });
    } else if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > 1 || !executions.has(answer.executionId)) {
      results.push({ ...evaluation, status: "not_evaluated", reason: "request_failed", message: "Classification returned an invalid score or execution attribution." });
    } else {
      results.push({ ...evaluation, status: "evaluated", score: answer.score, executionId: answer.executionId });
    }
  }
  results.sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.startIndex - b.location.startIndex || a.id.localeCompare(b.id));
  return { results, issues };
}

export async function classifyPlan(input: { plan: AnalysisPlan; classification: Classification; signal?: AbortSignal }): Promise<AnalysisReport> {
  const { plan } = input;
  let run: ClassificationRun;
  try {
    run = await input.classification.classify(plan.evaluations.map(({ id, state, question }) => ({ id, state, question })), input.signal);
  } catch (error) {
    run = { outcomes: plan.evaluations.map((evaluation) => ({ id: evaluation.id, status: "not_evaluated", reason: "request_failed", message: String(error) })), executions: [] };
  }
  const { results, issues } = joinOutcomes(plan, run);
  const usageKnown = run.executions.every((execution) => execution.usage !== undefined && execution.attempts === 1) &&
    (run.executions.length > 0 || plan.evaluations.length === 0 || run.outcomes.every((outcome) => outcome.status === "not_evaluated" && outcome.reason === "input_too_large"));
  return {
    classification: { provider: input.classification.provider, model: input.classification.model },
    sampling: plan.sampling, rules: plan.rules, sources: plan.sources, coverage: ruleCoverage(plan, results), results, issues, executions: run.executions,
    summary: {
      ...plan.summary,
      eligible: results.length,
      evaluated: results.filter((result) => result.status === "evaluated").length,
      notEvaluated: results.filter((result) => result.status === "not_evaluated").length,
      requests: run.executions.length,
      attempts: run.executions.reduce((sum, execution) => sum + execution.attempts, 0),
      inputTokens: usageKnown ? run.executions.reduce((sum, execution) => sum + (execution.usage?.inputTokens ?? 0), 0) : null,
      outputTokens: usageKnown ? run.executions.reduce((sum, execution) => sum + (execution.usage?.outputTokens ?? 0), 0) : null,
    },
  };
}

export async function analyze(input: Parameters<typeof planAnalysis>[0] & { classification: Classification; signal?: AbortSignal }): Promise<AnalysisReport> {
  const plan = await planAnalysis(input);
  return classifyPlan({ plan, classification: input.classification, signal: input.signal });
}
