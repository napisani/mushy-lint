import { Glob } from "bun";
import { createHash } from "node:crypto";
import type { Config, Section } from "./config.ts";
import type { ChangedLines } from "./git.ts";
import type { AnalysisPlan } from "./model.ts";

export function compileFiles(files: Section["files"]) {
  return { include: files.include.map((pattern) => new Glob(pattern)), exclude: files.exclude.map((pattern) => new Glob(pattern)) };
}

export function matchesFiles(files: ReturnType<typeof compileFiles>, path: string): boolean {
  return files.include.some((glob) => glob.match(path)) && !files.exclude.some((glob) => glob.match(path));
}

export function eligibleFiles(input: { config: Config; files: string[]; changed?: ChangedLines | null }): string[] {
  const sections = input.config.sections.map((section) => compileFiles(section.files));
  return [...new Set(input.files)].sort().filter((file) =>
    /\.(ts|tsx|mts|cts)$/.test(file) && (!input.changed || input.changed.has(file)) && sections.some((section) => matchesFiles(section, file)));
}

export function rankFiles(files: string[], seed: string): string[] {
  const ranked = files.map((file) => ({ file, rank: createHash("sha256").update(seed).update("\0").update(file).digest("hex") }));
  return ranked.sort((a, b) => a.rank.localeCompare(b.rank) || a.file.localeCompare(b.file)).map(({ file }) => file);
}

export function stratifiedFiles(input: { plan: AnalysisPlan; count: number; seed: string }): string[] {
  const ranked = rankFiles(input.plan.sources.map((source) => source.file), input.seed);
  const coverage = new Map<string, Set<string>>();
  for (const evaluation of input.plan.evaluations) {
    const rules = coverage.get(evaluation.location.file) ?? new Set<string>();
    rules.add(JSON.stringify([evaluation.section, evaluation.rule]));
    coverage.set(evaluation.location.file, rules);
  }
  const uncovered = new Set(input.plan.rules.map((rule) => JSON.stringify([rule.section, rule.rule])));
  const selected = new Set<string>();
  while (selected.size < input.count && selected.size < ranked.length) {
    let best: string | undefined;
    let largest = -1;
    for (const file of ranked) {
      if (selected.has(file)) { continue; }
      const size = [...coverage.get(file) ?? []].filter((rule) => uncovered.has(rule)).length;
      if (size > largest) { best = file; largest = size; }
    }
    if (best === undefined || largest === 0) { break; }
    selected.add(best);
    for (const rule of coverage.get(best) ?? []) { uncovered.delete(rule); }
  }
  const remaining = ranked.filter((file) => !selected.has(file)).slice(0, Math.max(0, input.count - selected.size));
  return [...selected, ...remaining].sort();
}

export function selectPlan(plan: AnalysisPlan, files: string[]): AnalysisPlan {
  const selected = new Set(files);
  const sources = plan.sources.filter((source) => selected.has(source.file));
  return {
    ...plan,
    sources,
    evaluations: plan.evaluations.filter((evaluation) => selected.has(evaluation.location.file)),
    results: plan.results.filter((result) => selected.has(result.location.file)),
    issues: plan.issues.filter((issue) => issue.file === undefined || selected.has(issue.file)),
    summary: {
      files: sources.length,
      targets: sources.reduce((sum, source) => sum + source.targets, 0),
      excluded: sources.reduce((sum, source) => sum + source.exclusions.reduce((total, exclusion) => total + exclusion.count, 0), 0),
    },
  };
}
