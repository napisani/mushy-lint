import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassificationConfig, ConfigDocument, parseConfig } from "../src/config.ts";
import { planAnalysis } from "../src/check.ts";
import { EvidenceState } from "../src/model.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { ruleCoverage } from "../src/report.ts";

const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
const fullYaml = await Bun.file(new URL("../examples/full.yaml", import.meta.url)).text();
const yamlBlocks = [...readme.matchAll(/```yaml\n(version: 2\n[\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
const snippets = [...readme.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
let cwd: string;
let parser: SourceParser;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mushy-readme-"));
  await Promise.all([mkdir(join(cwd, "src")), mkdir(join(cwd, "tests/e2e"), { recursive: true })]);
  parser = await createSourceParser();
});
afterAll(async () => {
  parser.dispose();
  await rm(cwd, { recursive: true, force: true });
});

function documentedFields(heading: string): string[] {
  const start = readme.indexOf(`### ${heading}\n`);
  if (start < 0) { throw new Error(`Missing reference heading: ${heading}`); }
  const end = readme.indexOf("\n### ", start + 1);
  return [...readme.slice(start, end < 0 ? undefined : end).matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1] ?? "").sort();
}

test("README embeds valid complete configurations and the exact downloadable preset", () => {
  expect(yamlBlocks).toHaveLength(2);
  expect(yamlBlocks[1]?.trim()).toBe(fullYaml.trim());
  for (const yaml of yamlBlocks) {
    expect(parseConfig(yaml).version).toBe(2);
  }
  const full = parseConfig(fullYaml);
  expect(full.sections.flatMap((section) => section.rules)).toHaveLength(8);
  expect(full.classification).toEqual({ ...ClassificationConfig.parse({}), provider: "openrouter", model: "typesafe/jev-1.13", apiKeyEnv: "OPENROUTER_API_KEY" });
});

test("README reference and full example cover every supported configuration field", () => {
  // oxlint-disable anti-slop/no-shape-in-symbol-names -- Zod's schema-inspection API names its property shape.
  const document = ConfigDocument.shape;
  const section = document.sections.element.shape;
  const rule = section.rules.element.shape;
  const expected = [
    ["Document", Object.keys(document)],
    ["classification", Object.keys(ClassificationConfig.shape)],
    ["fileSets", Object.keys(document.fileSets.valueType.shape)],
    ["targets", Object.keys(document.targets.unwrap().valueType.shape)],
    ["conditions", Object.keys(document.conditions.unwrap().valueType.shape)],
    ["sections", Object.keys(section)],
    ["rules", Object.keys(rule)],
    ["review", Object.keys(rule.review.unwrap().shape)],
  ] satisfies [string, string[]][];
  // oxlint-enable anti-slop/no-shape-in-symbol-names
  const exampleKeys = new Set([...fullYaml.matchAll(/^\s*(?:-\s+)?(\w+):/gm)].map((match) => match[1]));
  for (const [heading, fields] of expected) {
    expect(documentedFields(heading)).toEqual(fields.sort());
    expect(fields.every((field) => exampleKeys.has(field))).toBe(true);
  }
});

test("README operational defaults match the runtime schema", () => {
  const table = readme.split("### classification\n")[1]?.split("\n### ")[0] ?? "";
  const rows = [...table.matchAll(/^\| `([^`]+)` \| [^\n]+? \| `([^`]+)` \|$/gm)];
  const defaults = ClassificationConfig.parse({});
  expect(rows).toHaveLength(Object.keys(defaults).length);
  for (const row of rows) {
    expect(Object.entries(defaults).find(([field]) => field === row[1])?.[1]?.toString()).toBe(row[2]);
  }
  const maxPlanBytes = parseConfig(yamlBlocks[0] ?? "").maxPlanBytes;
  expect(parseConfig(fullYaml).maxPlanBytes).toBe(maxPlanBytes);
  expect(readme).toContain(`| \`maxPlanBytes\` | Integer at least \`1\`; retained plan bytes | \`${maxPlanBytes}\` |`);
});

test("quick-start captured state matches real comment extraction", async () => {
  const config = parseConfig(yamlBlocks[0] ?? "");
  const source = snippets[0];
  if (source === undefined) { throw new Error("Missing quick-start source example"); }
  await Bun.write(join(cwd, "src/name.ts"), source);
  const plan = await planAnalysis({ config, parser, cwd, files: ["src/name.ts"] });
  const jsonBlock = /```json\n([\s\S]*?)\n```/.exec(readme);
  const expected = EvidenceState.parse(JSON.parse(jsonBlock?.[1] ?? "null"));
  expect(plan.issues).toEqual([]);
  expect(plan.results).toEqual([]);
  expect(plan.evaluations).toHaveLength(1);
  expect(plan.evaluations[0]?.state).toEqual(expected);
});

for (const extension of ["ts", "tsx"]) {
  test(`full README preset extracts all eight rules from actual ${extension} examples`, async () => {
    const variants = `function* enumerate() { yield 1; }
const transform = function (value: string) { return value.trim(); };
const count = () => 1;
const generate = function* () { yield 1; };
class Store {
  constructor() {}
  save() { try { store.write(); } catch { return { ok: false }; } }
  #load() { return store.read(); }
}
`;
    const source = snippets.join("\n") + "\n" + variants + (extension === "tsx" ? "\nconst Header = () => <h1>Ready</h1>;" : "");
    const files = [`src/review.${extension}`, `src/review.test.${extension}`, `tests/e2e/review.spec.${extension}`];
    await Promise.all(files.map((file) => Bun.write(join(cwd, file), source)));
    const plan = await planAnalysis({ config: parseConfig(fullYaml), parser, cwd, files });
    expect(plan.issues).toEqual([]);
    expect(plan.results).toEqual([]);
    expect(ruleCoverage(plan).every((rule) => rule.eligible > 0)).toBe(true);
    expect(ruleCoverage(plan)).toHaveLength(8);
    const naming = plan.evaluations.filter((evaluation) => evaluation.rule === "naming.describes-operation");
    expect(naming.some((evaluation) => evaluation.state.name?.[0] === "constructor")).toBe(false);
    expect(naming.some((evaluation) => evaluation.state.name?.[0] === "generate")).toBe(true);
    expect(naming.every((evaluation) => source.slice(evaluation.location.startIndex, evaluation.location.endIndex) === evaluation.state.name?.[0])).toBe(true);
    expect(plan.evaluations.filter((evaluation) => evaluation.rule === "errors.hides-failure").every((evaluation) => evaluation.state.code?.[0]?.includes("catch"))).toBe(true);
    expect(plan.evaluations.some((evaluation) => evaluation.rule === "e2e.sleeps-for-state" && evaluation.state.code?.[0]?.includes("waitForTimeout"))).toBe(true);
    expect(plan.evaluations.filter((evaluation) => evaluation.rule === "logging.omits-context").every((evaluation) => evaluation.state.code?.[0]?.includes("invoiceId"))).toBe(true);
    expect(plan.evaluations.some((evaluation) => evaluation.rule === "errors.hides-failure" && evaluation.location.file.includes(".test."))).toBe(false);
  });
}
