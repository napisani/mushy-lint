import { CaptureQuantifier, Query, type Language, type Node, type Tree } from "web-tree-sitter";
import type { Target } from "./config.ts";
import { EvidenceState, type Failure, type SourceLocation } from "./model.ts";
import { commentTargets } from "./targets/comment.ts";

export interface ExtractedTarget {
  root: Node | null;
  location: SourceLocation;
  state: EvidenceState;
  evidence: Node[];
  failure?: Failure;
}

export function sourceLocation(file: string, first: Node, last = first): SourceLocation {
  return {
    file,
    startLine: first.startPosition.row + 1,
    endLine: last.endPosition.row + 1,
    startColumn: first.startPosition.column + 1,
    endColumn: last.endPosition.column + 1,
    startIndex: first.startIndex,
    endIndex: last.endIndex,
  };
}

function invalidSyntax(node: Node): boolean {
  if (node.hasError || node.isError || node.isMissing) {
    return true;
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.isError || parent.isMissing) {
      return true;
    }
  }
  return false;
}

function requiredCapture(query: Query, name: string): void {
  const index = query.captureIndexForName(name);
  if (index < 0 || !query.captureNames.includes(name)) {
    throw new Error(`missing capture @${name}`);
  }
  for (const quantifiers of query.captureQuantifiers) {
    if (quantifiers[index] !== CaptureQuantifier.One) {
      throw new Error(`@${name} must capture exactly one node in every pattern`);
    }
  }
}

export class TargetExtractor {
  private readonly queries = new Map<Language, Map<string, Query>>();

  query(tree: Tree, source: string): Query {
    let cache = this.queries.get(tree.language);
    if (!cache) {
      cache = new Map();
      this.queries.set(tree.language, cache);
    }
    let query = cache.get(source);
    if (!query) {
      query = new Query(tree.language, source);
      const propertyPredicates = [...query.assertedProperties, ...query.refutedProperties];
      if (query.predicates.some((predicates) => predicates.length > 0) || propertyPredicates.some((properties) => properties !== undefined && Object.keys(properties).length > 0)) {
        query.delete();
        throw new Error("unsupported tree-sitter predicate");
      }
      cache.set(source, query);
    }
    return query;
  }

  matches(query: Query, root: Node): ReturnType<Query["matches"]> {
    const matches = query.matches(root);
    if (query.didExceedMatchLimit()) {
      throw new Error("tree-sitter query match limit exceeded; extraction is incomplete");
    }
    return matches;
  }

  qualifies(tree: Tree, root: Node, condition: string): boolean {
    return this.matches(this.query(tree, condition), root).length > 0;
  }

  extract(file: string, tree: Tree, definition?: Target): ExtractedTarget[] {
    if (!definition) {
      return commentTargets({ file, tree }).map((target) => {
        const first = target.nodes[0];
        if (!first) {
          throw new Error("comment target has no source node");
        }
        let failure: Failure | undefined;
        if (target.parseError) {
          failure = { reason: "parse_error", message: "Comment evidence overlaps invalid syntax." };
        } else if (target.root === null) {
          failure = { reason: "extraction_failed", message: "Comment has no attached construct." };
        }
        return {
          root: target.root,
          location: sourceLocation(file, first, target.nodes[target.nodes.length - 1] ?? first),
          state: EvidenceState.parse({ comment: [target.comment], code: target.code === null ? [] : [target.code] }),
          evidence: [...target.nodes, ...(target.root ? [target.root] : [])],
          failure,
        };
      });
    }
    const query = this.query(tree, definition.query);
    requiredCapture(query, definition.root);
    requiredCapture(query, definition.location ?? definition.root);
    const instances: ExtractedTarget[] = [];
    const seen = new Set<string>();
    for (const match of this.matches(query, tree.rootNode)) {
      const roots = match.captures.filter((capture) => capture.name === definition.root);
      const locations = match.captures.filter((capture) => capture.name === (definition.location ?? definition.root));
      const root = roots[0]?.node;
      const location = locations[0]?.node;
      if (roots.length !== 1 || locations.length !== 1 || !root || !location) {
        throw new Error("root and location must each capture exactly one node");
      }
      const values = new Map(query.captureNames.map((name) => [name, new Array<string>()]));
      const ordered = [...match.captures].sort((a, b) => a.node.startIndex - b.node.startIndex || a.node.endIndex - b.node.endIndex || a.name.localeCompare(b.name));
      for (const capture of ordered) {
        values.get(capture.name)?.push(capture.node.text);
      }
      const state = EvidenceState.parse(Object.fromEntries(values));
      const identity = JSON.stringify(ordered.map(({ name, node }) => [name, node.startIndex, node.endIndex]));
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      instances.push({
        root,
        location: sourceLocation(file, location),
        state,
        evidence: ordered.map((capture) => capture.node),
        failure: ordered.some(({ node }) => invalidSyntax(node))
          ? { reason: "parse_error", message: "Captured evidence overlaps invalid syntax." }
          : undefined,
      });
    }
    return instances;
  }

  dispose(): void {
    for (const cache of this.queries.values()) {
      for (const query of cache.values()) {
        query.delete();
      }
    }
    this.queries.clear();
  }
}
