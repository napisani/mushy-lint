import { afterAll, beforeAll, expect, test } from "bun:test";
import { load } from "js-yaml";
import { z } from "zod";
import { ClassificationConfig, ConfigDocument, parseConfig } from "../src/config.ts";
import { CONFIG } from "./helpers.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { TargetExtractor } from "../src/targets.ts";

const skill = await Bun.file(new URL("../.agents/skills/mushy-lint-rule-config/SKILL.md", import.meta.url)).text();
const examples = [...skill.matchAll(/```yaml\n(version: 2\n[\s\S]*?)\n```/g)].map((match) => parseConfig(match[1] ?? ""));
let parser: SourceParser;
beforeAll(async () => { parser = await createSourceParser(); });
afterAll(() => parser.dispose());

function documentedFields(heading: string): string[] {
  const start = skill.indexOf(`### ${heading}\n`);
  if (start < 0) { throw new Error(`Missing schema heading: ${heading}`); }
  const end = skill.indexOf("\n### ", start + 1);
  return [...skill.slice(start, end < 0 ? undefined : end).matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1] ?? "");
}

test("rule-config skill has valid portable frontmatter and three complete examples", () => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill);
  const metadata = z.strictObject({
    name: z.literal("mushy-lint-rule-config"),
    description: z.string().min(1).max(1024).refine((text) => !/[<>]/.test(text)),
  }).parse(load(frontmatter?.[1] ?? ""));
  expect(metadata.name).toBe("mushy-lint-rule-config");
  expect(examples).toHaveLength(3);
});

test("skill schema tables enumerate every supported configuration key", () => {
  // oxlint-disable anti-slop/no-shape-in-symbol-names -- Zod's public schema-inspection API names its property shape.
  const document = ConfigDocument.shape;
  const section = document.sections.element.shape;
  const rule = section.rules.element.shape;
  expect(documentedFields("Document").sort()).toEqual(Object.keys(document).sort());
  expect(documentedFields("`classification`").sort()).toEqual(Object.keys(ClassificationConfig.shape).sort());
  expect(documentedFields("Each `sections[]` object").sort()).toEqual(Object.keys(section).sort());
  expect(documentedFields("Each `fileSets.<name>` record").sort()).toEqual(Object.keys(document.fileSets.valueType.shape).sort());
  expect(documentedFields("Each `targets.<name>` record").sort()).toEqual(Object.keys(document.targets.unwrap().valueType.shape).sort());
  expect(documentedFields("Each `conditions.<name>` record").sort()).toEqual(Object.keys(document.conditions.unwrap().valueType.shape).sort());
  expect(documentedFields("Each `rules[]` object").sort()).toEqual(Object.keys(rule).sort());
  expect(documentedFields("Rule `review`").sort()).toEqual(Object.keys(rule.review.unwrap().shape).sort());
  // oxlint-enable anti-slop/no-shape-in-symbol-names
});

test("skill classification and plan defaults match the runtime schema", () => {
  const start = skill.indexOf("### `classification`\n");
  const end = skill.indexOf("\n### ", start + 1);
  const defaults = ClassificationConfig.parse({});
  const rows = [...skill.slice(start, end).matchAll(/^\| `([^`]+)` \| [^\n]+? \| `([^`]+)` \|$/gm)];
  expect(rows).toHaveLength(Object.keys(defaults).length);
  for (const row of rows) {
    const key = row[1];
    const value = row[2];
    expect(Object.entries(defaults).find(([field]) => field === key)?.[1]?.toString()).toBe(value);
  }
  const config = parseConfig(CONFIG);
  expect(skill).toContain(`\`maxPlanBytes\` | Integer at least \`1\` | \`${config.maxPlanBytes}\``);
});

const callables = `export function discard() { try { load(); } catch { return []; } }
export function communicate() { try { load(); } catch (error) { throw error; } }
const outer = () => { const inner = () => { try { load(); } catch {} }; return inner(); };
const ungated = () => 1;
const expression = function () { try { load(); } catch { return false; } };
class Store { load() { try { read(); } catch { return null; } } }
`;
const comments = `// Return the trimmed value.
function normalize(value: string) { return value.trim(); }
// The remote client retries this operation after a timeout.
function retry() { return send(); }
const increment = (value: number) => value + 1; // Increment the value.
// @ts-expect-error
const invalid: number = "text";
`;

for (const extension of ["ts", "tsx"]) {
  test(`skill query and comment examples extract complete ${extension} evidence with documented eligibility`, () => {
    for (const config of examples) {
      const section = config.sections[0];
      const rule = section?.rules[0];
      if (!section || !rule) { throw new Error("Example needs a section and rule"); }
      const source = rule.target === "comment" ? comments : callables;
      const file = `src/fixture.${extension}`;
      const tree = parser.parse({ file, source: source + (extension === "tsx" ? "const view = <section>Ready</section>;" : ""), language: "typescript" });
      if (!tree) { throw new Error("Fixture did not parse"); }
      const extractor = new TargetExtractor();
      try {
        expect(tree.rootNode.hasError).toBe(false);
        const targets = extractor.extract(file, tree, config.targets[rule.target]);
        expect(targets.every((target) => target.failure === undefined)).toBe(true);
        if (rule.target === "function") {
          expect(targets).toHaveLength(7);
          const eligible = targets.filter((target) => target.root !== null && rule.includeIf !== undefined && extractor.qualifies(tree, target.root, rule.includeIf.query));
          expect(eligible).toHaveLength(6);
          expect(eligible.some((target) => target.state.code?.[0]?.startsWith("() => { const inner"))).toBe(true);
          expect(eligible.every((target) => Object.keys(target.state).join() === "code")).toBe(true);
          expect(targets.find((target) => target.state.code?.[0] === "() => 1")?.state.code).toEqual(["() => 1"]);
        } else if (rule.target === "named_function") {
          expect(targets).toHaveLength(2);
          for (const target of targets) {
            const name = target.state.name?.[0];
            if (name === undefined) { throw new Error("Named function needs a name capture"); }
            expect(source.slice(target.location.startIndex, target.location.endIndex)).toBe(name);
            expect(target.state.code?.[0]).toContain("catch");
            expect(target.location.startIndex).toBeGreaterThan(target.root?.startIndex ?? -1);
          }
        } else {
          expect(targets).toHaveLength(3);
          expect(targets[0]?.state).toEqual({ comment: ["Return the trimmed value."], code: ["function normalize(value: string) { return value.trim(); }"] });
          expect(targets[2]?.state.code).toEqual(["const increment = (value: number) => value + 1;"]);
          expect(targets.every((target) => !target.state.comment?.[0]?.startsWith("@ts-"))).toBe(true);
        }
      } finally {
        extractor.dispose();
        tree.delete();
      }
    }
  });
}
