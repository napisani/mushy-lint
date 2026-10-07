import { load } from "js-yaml";
import { z } from "zod";

const Name = z.string().min(1).refine((text) => text.trim().length > 0, "name must not be blank");
const Patterns = z.array(Name).default([]);
const Language = z.literal("typescript");
const QueryText = z.string().min(1).refine((text) => text.trim().length > 0, "query must contain a pattern");

export const Target = z.strictObject({
  root: Name,
  location: Name.optional(),
  query: QueryText,
});
const TargetDefinition = Target.extend({ language: Language });
const Condition = z.strictObject({ language: Language, query: QueryText });
const FileSet = z.strictObject({
  include: Patterns,
  exclude: Patterns,
  includeGlobs: Patterns,
  excludeGlobs: Patterns,
});
const Review = z.strictObject({
  yesMeans: z.enum(["desirable", "undesirable", "neutral"]).default("neutral"),
  policy: Patterns,
});
const RuleDefinition = z.strictObject({
  id: Name,
  target: Name,
  score: z.string().min(1).refine((text) => text.trim().length > 0, "score must contain a question"),
  includeIf: Name.optional(),
  context: Patterns,
  files: Name.optional(),
  review: Review.prefault({}),
});
const SectionDefinition = z.strictObject({
  name: Name,
  language: Language,
  files: Name,
  rules: z.array(RuleDefinition).nonempty(),
});

export const ClassificationConfig = z.strictObject({
  provider: z.enum(["typesafe", "openrouter"]).default("typesafe"),
  model: z.string().min(1).default("jev-latest"),
  apiKeyEnv: Name.optional(),
  concurrency: z.number().int().min(1).max(40).default(8),
  requestsPerSecond: z.number().int().min(1).max(40).default(40),
  maxInputBytes: z.number().int().min(256).default(64000),
  maxQuestions: z.number().int().min(1).default(64),
  timeoutMs: z.number().int().min(1).default(30000),
  retries: z.number().int().min(0).max(5).default(2),
});

export const ConfigDocument = z.strictObject({
  version: z.literal(2),
  classification: ClassificationConfig.prefault({}),
  maxPlanBytes: z.number().int().min(1).default(256 * 1024 * 1024),
  globs: z.record(Name, z.array(Name)).default({}),
  fileSets: z.record(Name, FileSet),
  targets: z.record(Name, TargetDefinition).default({}),
  conditions: z.record(Name, Condition).default({}),
  sections: z.array(SectionDefinition).nonempty(),
}).superRefine((document, ctx) => {
  function issue(path: (string | number)[], message: string): void {
    ctx.addIssue({ code: "custom", path, message });
  }
  if (Object.hasOwn(document.targets, "comment")) {
    issue(["targets", "comment"], "comment is a reserved built-in target");
  }
  for (const [name, files] of Object.entries(document.fileSets)) {
    for (const field of ["includeGlobs", "excludeGlobs"] as const) {
      for (const [index, ref] of files[field].entries()) {
        if (!Object.hasOwn(document.globs, ref)) {
          issue(["fileSets", name, field, index], `undefined globs: ${ref}`);
        }
      }
    }
  }
  const names = new Set<string>();
  for (const [index, section] of document.sections.entries()) {
    const path = ["sections", index];
    if (names.has(section.name)) { issue([...path, "name"], "section names must be unique"); }
    names.add(section.name);
    const files = document.fileSets[section.files];
    if (!Object.hasOwn(document.fileSets, section.files) || !files) {
      issue([...path, "files"], `undefined file set: ${section.files}`);
    } else if (files.include.length === 0 && !files.includeGlobs.some((ref) => (document.globs[ref]?.length ?? 0) > 0)) {
      issue([...path, "files"], "section file set must include at least one pattern");
    }
    const ids = new Set<string>();
    function checkRule(rule: z.infer<typeof RuleDefinition>, ruleIndex: number): void {
      const rulePath = [...path, "rules", ruleIndex];
      if (ids.has(rule.id)) { issue([...rulePath, "id"], "rule ids must be unique within a section"); }
      ids.add(rule.id);
      const target = document.targets[rule.target];
      if (rule.target !== "comment" && (!Object.hasOwn(document.targets, rule.target) || !target)) {
        issue([...rulePath, "target"], `undefined target: ${rule.target}`);
      } else if (target && target.language !== section.language) {
        issue([...rulePath, "target"], "target language must match section language");
      }
      if (rule.includeIf !== undefined) {
        const condition = document.conditions[rule.includeIf];
        if (!Object.hasOwn(document.conditions, rule.includeIf) || !condition) {
          issue([...rulePath, "includeIf"], `undefined condition: ${rule.includeIf}`);
        } else if (condition.language !== section.language) {
          issue([...rulePath, "includeIf"], "condition language must match section language");
        }
      }
      if (rule.files !== undefined) {
        const exclusions = document.fileSets[rule.files];
        if (!Object.hasOwn(document.fileSets, rule.files) || !exclusions) {
          issue([...rulePath, "files"], `undefined file set: ${rule.files}`);
        } else if (exclusions.include.length > 0 || exclusions.includeGlobs.length > 0) {
          issue([...rulePath, "files"], "rule file sets may only exclude files");
        }
      }
    }
    section.rules.forEach(checkRule);
  }
});

function record<T>(entries: Record<string, T>, name: string): T {
  const value = entries[name];
  if (!Object.hasOwn(entries, name) || value === undefined) { throw new Error(`undefined record: ${name}`); }
  return value;
}

export const Config = ConfigDocument.transform((document) => {
  const fileSets = Object.fromEntries(Object.entries(document.fileSets).map(([name, files]) => [name, {
    include: [...new Set([...files.include, ...files.includeGlobs.flatMap((ref) => record(document.globs, ref))])],
    exclude: [...new Set([...files.exclude, ...files.excludeGlobs.flatMap((ref) => record(document.globs, ref))])],
  }]));
  return {
    version: document.version,
    classification: document.classification,
    maxPlanBytes: document.maxPlanBytes,
    targets: document.targets,
    sections: document.sections.map((section) => ({
      ...section,
      files: record(fileSets, section.files),
      rules: section.rules.map((rule) => ({
        ...rule,
        files: rule.files === undefined ? undefined : record(fileSets, rule.files),
        includeIf: rule.includeIf === undefined ? undefined : { name: rule.includeIf, query: record(document.conditions, rule.includeIf).query },
      })),
    })),
  };
});

export type Config = z.infer<typeof Config>;
export type Section = Config["sections"][number];
export type Rule = Section["rules"][number];
export type Target = z.infer<typeof Target>;
export type ClassificationConfig = z.infer<typeof ClassificationConfig>;

export function parseConfig(yamlText: string): Config {
  return Config.parse(load(yamlText));
}

export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await Bun.file(path).text());
}
