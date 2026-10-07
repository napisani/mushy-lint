import type { Node, Tree } from "web-tree-sitter";

export type CommentStyle = "line" | "block" | "doc";

/** One comment unit: a run of adjacent `//` lines or one block comment, plus the code it annotates. */
export interface CommentTarget {
  kind: "comment";
  file: string;
  startLine: number;
  endLine: number;
  style: CommentStyle;
  comment: string;
  code: string | null;
  root: Node | null;
  nodes: Node[];
  parseError: boolean;
}

// Tool directives are not prose, so no semantic rule applies to them.
const DIRECTIVE = /^\s*(eslint-|oxlint-|biome-ignore|prettier-ignore|@ts-|istanbul |c8 |\/\s*<reference)/;

interface CommentRun {
  style: CommentStyle;
  nodes: [Node, ...Node[]];
}

function styleOf(text: string): CommentStyle {
  if (text.startsWith("//")) {
    return "line";
  }
  return text.startsWith("/**") ? "doc" : "block";
}

function commentText(run: CommentRun): string {
  if (run.style === "line") {
    return run.nodes.map((n) => n.text.replace(/^\/\/\s?/, "")).join("\n");
  }
  return run.nodes[0].text
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

function isTrailing(node: Node): boolean {
  const previous = node.previousNamedSibling;
  return previous !== null && previous.type !== "comment" && previous.endPosition.row === node.startPosition.row;
}

function continuesRun(run: CommentRun, node: Node): boolean {
  const last = run.nodes[run.nodes.length - 1];
  return (
    run.style === "line" &&
    !isTrailing(run.nodes[0]) &&
    !isTrailing(node) &&
    styleOf(node.text) === "line" &&
    last !== undefined &&
    last.endPosition.row + 1 === node.startPosition.row &&
    last.nextNamedSibling?.id === node.id
  );
}

function annotatedCode(first: Node, last: Node): Node | null {
  // A trailing comment annotates the code on its own line, not whatever follows.
  const previous = first.previousNamedSibling;
  if (previous && previous.type !== "comment" && previous.endPosition.row === first.startPosition.row) {
    return previous;
  }
  let next = last.nextNamedSibling;
  while (next?.type === "comment") {
    next = next.nextNamedSibling;
  }
  return next ?? enclosingOperation(first);
}

function enclosingOperation(comment: Node): Node | null {
  // An end-of-body comment needs the enclosing operation, not an unrelated outer sibling.
  for (let parent = comment.parent; parent && parent.type !== "program"; parent = parent.parent) {
    if (parent.type === "arrow_function" || parent.type === "function_expression") {
      const call = parent.parent?.type === "arguments" ? parent.parent.parent : null;
      return call?.type === "call_expression" ? call : parent;
    }
    if (parent.type === "catch_clause" && parent.parent?.type === "try_statement") { return parent.parent; }
    if (["function_declaration", "method_definition", "class_declaration", "if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "try_statement"].includes(parent.type)) {
      return parent;
    }
    if (parent.type === "statement_block" && parent.parent?.type === "program") { return parent; }
  }
  return null;
}

function inError(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) {
    if (current.isError || current.isMissing) {
      return true;
    }
  }
  return false;
}

export function commentTargets(input: { file: string; tree: Tree }): CommentTarget[] {
  const runs: CommentRun[] = [];
  for (const node of input.tree.rootNode.descendantsOfType("comment")) {
    if (!node) {
      continue;
    }
    const current = runs[runs.length - 1];
    if (current && continuesRun(current, node)) {
      current.nodes.push(node);
    } else {
      runs.push({ style: styleOf(node.text), nodes: [node] });
    }
  }

  const targets: CommentTarget[] = [];
  for (const run of runs) {
    const comment = commentText(run);
    const first = run.nodes[0];
    const last = run.nodes[run.nodes.length - 1] ?? first;
    const code = annotatedCode(first, last);
    if (DIRECTIVE.test(comment)) {
      continue;
    }
    targets.push({
      kind: "comment",
      file: input.file,
      startLine: first.startPosition.row + 1,
      endLine: last.endPosition.row + 1,
      style: run.style,
      comment,
      code: code?.text ?? null,
      root: code,
      nodes: run.nodes,
      parseError: run.nodes.some(inError) || (code !== null && (code.hasError || inError(code))),
    });
  }
  return targets;
}
