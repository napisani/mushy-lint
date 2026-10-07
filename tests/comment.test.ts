import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSourceParser, type SourceParser } from "../src/parser.ts";
import { type CommentTarget, commentTargets } from "../src/targets/comment.ts";

let parser: SourceParser;
let targets: CommentTarget[];

beforeAll(async () => {
  parser = await createSourceParser();
  const file = "comments.tsx";
  const source = await Bun.file(join(import.meta.dir, "fixtures", file)).text();
  const tree = parser.parse({ file, source, language: "typescript" });
  if (!tree) {
    throw new Error("fixture did not parse");
  }
  targets = commentTargets({ file, tree });
  tree.delete();
});

afterAll(() => parser.dispose());

function targetAt(line: number): CommentTarget | undefined {
  return targets.find((t) => t.startLine === line);
}

describe("commentTargets", () => {
  test("attaches a doc comment to the declaration it documents", () => {
    const doc = targetAt(3);
    expect(doc?.style).toBe("doc");
    expect(doc?.comment).toBe("Fetches loans for the current user.\n@param userId - owner of the loans");
    expect(doc?.code).toStartWith("export async function fetchLoans");
  });

  test("groups adjacent line comments into one unit", () => {
    const run = targetAt(12);
    expect(run?.endLine).toBe(13);
    expect(run?.comment).toBe("Postgres caps bind parameters at 65535,\nso chunk the ids.");
    expect(run?.code).toStartWith("for (const id of ids)");
  });

  test("keeps separate runs apart", () => {
    expect(targetAt(8)?.comment).toBe("Loop over the loans and collect their ids");
    expect(targetAt(8)?.code).toBe("const ids: string[] = [];");
  });

  test("drops tool directives", () => {
    expect(targets.some((t) => t.comment.startsWith("eslint-disable"))).toBe(false);
  });

  test("a trailing comment annotates the code on its own line", () => {
    expect(targetAt(17)?.code).toBe("const total = ids.length;");
  });

  test("does not merge trailing comments with the next construct's comments", () => {
    const tree = parser.parse({ file: "trailing.ts", source: "const x = 1; // x reason\n// y reason\nconst y = 2;", language: "typescript" });
    if (!tree) { throw new Error("fixture did not parse"); }
    try {
      const extracted = commentTargets({ file: "trailing.ts", tree });
      expect(extracted.map((target) => [target.comment, target.code])).toEqual([
        ["x reason", "const x = 1;"], ["y reason", "const y = 2;"],
      ]);
    } finally {
      tree.delete();
    }
  });

  test("strips block comment delimiters", () => {
    expect(targetAt(23)).toMatchObject({ style: "block", comment: "runs after paint" });
  });

  test("retains invalid evidence for an explicit not-evaluated result", () => {
    expect(targets.find((t) => t.comment.includes("keeps the real client"))?.parseError).toBe(true);
  });

  test("captures whole classes, functions, if statements, and standalone blocks", () => {
    for (const construct of [
      `class Store {\n${"  method() {}\n".repeat(30)}}`,
      `function load() {\n${"  work();\n".repeat(30)}}`,
      `if (ready) {\n${"  work();\n".repeat(30)}} else { stop(); }`,
      `{\n${"  work();\n".repeat(30)}}`,
    ]) {
      const tree = parser.parse({ file: "whole.ts", source: `// reason\n${construct}`, language: "typescript" });
      if (!tree) {
        throw new Error("fixture did not parse");
      }
      try {
        expect(commentTargets({ file: "whole.ts", tree })[0]?.code).toBe(construct);
      } finally {
        tree.delete();
      }
    }
  });

  test("end-of-body comments capture the nearest complete enclosing operation", () => {
    const examples = [
      { source: "function load() { work();\n// remote operation is best effort\n}", code: "function load() { work();\n// remote operation is best effort\n}" },
      { source: "client.wait().catch(() => {\n// the optional widget may never appear\n});", code: "client.wait().catch(() => {\n// the optional widget may never appear\n})" },
      { source: "try { send(); } catch (error) {\n// optional delivery must not block saving\n}", code: "try { send(); } catch (error) {\n// optional delivery must not block saving\n}" },
      { source: "if (ready) {\n// handled by the existing subscription\n}", code: "if (ready) {\n// handled by the existing subscription\n}" },
      { source: "class Store { load() {\n// the external adapter owns persistence\n} }", code: "load() {\n// the external adapter owns persistence\n}" },
      { source: "{\n// kept empty for the debugger\n}", code: "{\n// kept empty for the debugger\n}" },
    ];
    for (const example of examples) {
      const tree = parser.parse({ file: "enclosing.ts", source: example.source, language: "typescript" });
      if (!tree) { throw new Error("fixture did not parse"); }
      try {
        const target = commentTargets({ file: "enclosing.ts", tree })[0];
        expect(target?.code).toBe(example.code);
        expect(target?.parseError).toBe(false);
      } finally { tree.delete(); }
    }
  });
  test("module-orphan comments remain explicit rather than capturing the whole module", () => {
    const tree = parser.parse({ file: "orphan.ts", source: "const unrelated = 1;\n// no attached construct", language: "typescript" });
    if (!tree) { throw new Error("fixture did not parse"); }
    try { expect(commentTargets({ file: "orphan.ts", tree })[0]?.root).toBeNull(); }
    finally { tree.delete(); }
  });
  test("handles declaration files and rejects unsupported extensions", () => {
    const declarations = parser.parse({ file: "types.d.ts", source: "declare const ready: boolean;", language: "typescript" });
    expect(declarations?.rootNode.hasError).toBe(false);
    declarations?.delete();
    expect(parser.parse({ file: "README.md", source: "", language: "typescript" })).toBeNull();
  });
});
