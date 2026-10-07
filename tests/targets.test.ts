import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Target } from "../src/config.ts";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { TargetExtractor } from "../src/targets.ts";

let parser: SourceParser;
beforeAll(async () => { parser = await createSourceParser(); });
afterAll(() => parser.dispose());

function extract(source: string, definition?: Target, condition?: string) {
  const tree = parser.parse({ file: "fixture.tsx", source, language: "typescript" });
  if (!tree) { throw new Error("fixture did not parse"); }
  const extractor = new TargetExtractor();
  try {
    return extractor.extract("fixture.tsx", tree, definition).map((target) => ({
      state: target.state, location: target.location, failure: target.failure,
      root: target.root?.text ?? null,
      qualifies: condition ? target.root !== null && extractor.qualifies(tree, target.root, condition) : true,
    }));
  } finally {
    extractor.dispose();
    tree.delete();
  }
}

describe("query-defined targets", () => {
  test("unattached comments do not fabricate an eligibility root", () => {
    const result = extract("// no construct");
    expect(result[0]).toMatchObject({ root: null, state: { comment: ["no construct"], code: [] }, failure: { reason: "extraction_failed" } });
  });
  test("repeated captures are lists within one match", () => {
    const result = extract("a + b", { root: "code", query: "(binary_expression left: (identifier) @operand right: (identifier) @operand) @code" });
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toEqual({ code: ["a + b"], operand: ["a", "b"] });
  });
  test("absent optional captures are empty lists, not missing fields", () => {
    const result = extract("function load() {}\nconst save = () => {};", {
      root: "code",
      query: "(function_declaration name: (identifier) @name) @code\n(arrow_function) @code",
    });
    expect(result[0]?.state.name).toEqual(["load"]);
    expect(result[1]?.state.name).toEqual([]);
  });
  test("separate matches remain separate instances, identical alternative matches collapse", () => {
    const result = extract("function a() {}\nfunction b() {}", { root: "code", query: "(function_declaration) @code\n(function_declaration) @code" });
    expect(result).toHaveLength(2);
  });
  test("reporting location is independent of includeIf and complete state", () => {
    const source = "function loanSummary() { try { send(); } catch { log(); } }";
    const result = extract(source, { root: "code", location: "name", query: "(function_declaration name: (identifier) @name) @code" }, "(catch_clause)");
    expect(result[0]?.qualifies).toBe(true);
    expect(result[0]?.location.startColumn).toBe(10);
    expect(result[0]?.location.endColumn).toBe(21);
    expect(result[0]?.state.code).toEqual([source]);
    expect(result[0]?.state).not.toHaveProperty("catch");
  });
  test("root can be a body and sibling evidence remains available", () => {
    const result = extract("function load() { work(); }", { root: "body", query: "(function_declaration name: (identifier) @name body: (statement_block) @body)" });
    expect(result[0]?.state).toEqual({ name: ["load"], body: ["{ work(); }"] });
    expect(result[0]?.location.startColumn).toBe(17);
  });
  test("eligibility inspects nested classes and function bodies without ownership exclusions", () => {
    const result = extract("class Store { load() { return () => { try { read(); } catch { recover(); } }; } }", { root: "class", query: "(class_declaration) @class" }, "(catch_clause)");
    expect(result[0]?.qualifies).toBe(true);
  });
  test("multiple catches do not multiply the target", () => {
    const result = extract("function load() { try { one(); } catch {} try { two(); } catch {} }", { root: "code", query: "(function_declaration) @code" }, "(catch_clause)");
    expect(result).toHaveLength(1);
    expect(result[0]?.qualifies).toBe(true);
  });
  test("a comment capture can sit outside its root", () => {
    const result = extract("// why\nclass Store {}", { root: "code", location: "comment", query: "((comment) @comment . (_) @code)" });
    expect(result[0]?.state).toEqual({ comment: ["// why"], code: ["class Store {}"] });
    expect(result[0]?.location.startLine).toBe(1);
  });
  test("repeated roots and repeated locations are rejected", () => {
    const query = "(binary_expression left: (identifier) @operand right: (identifier) @operand) @code";
    expect(() => extract("a + b", { root: "operand", query })).toThrow(/exactly one/);
    expect(() => extract("a + b", { root: "code", location: "operand", query })).toThrow(/exactly one/);
  });
  test("unsupported predicates cannot silently act as true", () => {
    expect(() => extract("function load() {}", { root: "code", query: "((function_declaration) @code (#custom? @code))" })).toThrow(/unsupported/);
    expect(() => extract("function load() {}", { root: "code", query: '((function_declaration) @code (#is? "local"))' })).toThrow(/unsupported/);
  });
  test("missing syntax is not eligible for classification", () => {
    const result = extract("function missing() {", { root: "code", query: '(MISSING "}") @code' });
    expect(result).toHaveLength(1);
    expect(result[0]?.failure?.reason).toBe("parse_error");
  });
  test("Unicode source captures remain intact", () => {
    const source = "function résumé() { return '🍎'; }";
    const result = extract(source, { root: "code", location: "name", query: "(function_declaration name: (identifier) @name) @code" });
    expect(result[0]?.state).toEqual({ code: [source], name: ["résumé"] });
  });
});
