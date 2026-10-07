import type { AnalysisPlan, AnalysisReport, EvaluationResult, RuleCoverage, Sampling } from "./model.ts";

export function ruleCoverage(plan: AnalysisPlan, results?: EvaluationResult[]): RuleCoverage[] {
  return plan.rules.map(({ section, rule }) => {
    const matching = (results ?? plan.results).filter((item) => item.section === section && item.rule === rule);
    const pending = results === undefined ? plan.evaluations.filter((item) => item.section === section && item.rule === rule).length : 0;
    return {
      section, rule, eligible: matching.length + pending,
      evaluated: matching.filter((item) => item.status === "evaluated").length,
      notEvaluated: matching.filter((item) => item.status === "not_evaluated").length,
      excluded: plan.sources.reduce((sum, source) => sum + source.exclusions.filter((item) => item.section === section && item.rule === rule).reduce((count, item) => count + item.count, 0), 0),
    };
  });
}

export type OutputFormat = "text" | "json";

function samplingLines(sampling: Sampling): string[] {
  return sampling.mode === "all" ? [] : [
    `sample=${sampling.mode}, ${sampling.files.length}/${sampling.candidates} candidate files, seed=${JSON.stringify(sampling.seed)}`,
  ];
}

export function formatResult(report: AnalysisReport, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
  const lines = report.results.map((result) => {
    const at = `${result.location.file}:${result.location.startLine}:${result.location.startColumn}`;
    const answer = result.status === "evaluated" ? `score=${result.score}` : `not_evaluated (${result.reason}: ${result.message})`;
    return `${at}  ${result.section}/${result.rule}  ${answer}`;
  });
  lines.unshift(...samplingLines(report.sampling));
  for (const issue of report.issues) {
    lines.push(`${issue.file ?? "run"}  ${issue.reason}: ${issue.message}`);
  }
  const tokens = report.summary.inputTokens === null ? "unknown" : String(report.summary.inputTokens);
  lines.push(`${report.summary.evaluated} evaluated, ${report.summary.notEvaluated} not evaluated, ${report.summary.excluded} excluded, ${report.issues.length} issue(s); ${report.summary.requests} classification request(s), ${tokens} input tokens`);
  return `${lines.join("\n")}\n`;
}

export function formatPlan(plan: AnalysisPlan, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({ ...plan, coverage: ruleCoverage(plan) }, null, 2)}\n`;
  }
  const lines = plan.evaluations.map((evaluation) =>
    `${evaluation.location.file}:${evaluation.location.startLine}:${evaluation.location.startColumn}  ${evaluation.section}/${evaluation.rule}`);
  lines.unshift(...samplingLines(plan.sampling));
  for (const result of plan.results) {
    if (result.status === "not_evaluated") {
      lines.push(`${result.location.file}:${result.location.startLine}  ${result.rule}  ${result.reason}: ${result.message}`);
    }
  }
  for (const issue of plan.issues) {
    lines.push(`${issue.file ?? "run"}  ${issue.reason}: ${issue.message}`);
  }
  lines.push(`${plan.evaluations.length} eligible evaluation(s), ${plan.results.length} not evaluated, ${plan.summary.excluded} excluded (dry run, nothing sent)`);
  return `${lines.join("\n")}\n`;
}
