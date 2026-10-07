import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.ts";

import { CONFIG } from "./helpers.ts";

describe("config", () => {
  test("examples use score strings and provider selection", async () => {
    const config = await loadConfig(join(import.meta.dir, "../examples/code-style.yaml"));
    expect(config.classification.provider).toBe("typesafe");
    expect(config.sections[0]?.rules).toHaveLength(6);
    expect(config.sections[0]?.files.exclude).toContain("**/*.d.ts");
    const routed = await loadConfig(join(import.meta.dir, "../examples/functions.yaml"));
    expect(routed.classification.provider).toBe("openrouter");
  });
  test("defaults operational limits, not interpretation policy", () => {
    const config = parseConfig(CONFIG);
    expect(config.classification).toMatchObject({ concurrency: 8, retries: 2 });
    expect(config.sections[0]?.rules[0]?.context).toEqual([]);
  });
  test("rejects undefined targets and duplicate rule identifiers", () => {
    expect(() => parseConfig(CONFIG.replace("target: function", "target: missing"))).toThrow(/undefined target/);
    expect(() => parseConfig(CONFIG.replace("id: purpose", "id: catch"))).toThrow(/unique/);
  });
  test("rejects discarded threshold, criteria, and noul configuration", () => {
    expect(() => parseConfig(CONFIG.replace("id: catch", "id: catch\n        threshold: 0.9"))).toThrow();
    expect(() => parseConfig(CONFIG.replace("score: Does", "noul: Does"))).toThrow();
    expect(() => parseConfig(CONFIG.replace("score: Does", "criteria: {}\n        score: Does"))).toThrow();
  });
  test("rejects non-string questions, invalid concurrency, and arbitrary plugin modules", () => {
    expect(() => parseConfig(CONFIG.replace("score: Does `code` discard errors?", "score: 42"))).toThrow();
    expect(() => parseConfig(CONFIG.replace("version: 2", "version: 2\nclassification: { concurrency: 0 }"))).toThrow();
    expect(() => parseConfig(CONFIG.replace("root: code", "extractor: ./arbitrary.ts\n    root: code"))).toThrow();
  });
  test("rejects blank questions and eligibility queries without rewriting meaningful text", () => {
    expect(() => parseConfig(CONFIG.replace("score: Does `code` discard errors?", 'score: " "'))).toThrow(/question/);
    expect(() => parseConfig(CONFIG.replace("(try_statement handler: (catch_clause))", " "))).toThrow();
    const config = parseConfig(CONFIG.replace("score: Does `code` discard errors?", 'score: "  Exact question?  "'));
    expect(config.sections[0]?.rules[0]?.score).toBe("  Exact question?  ");
  });
  test("resolves shared records once without YAML aliases", () => {
    const config = parseConfig(CONFIG.replace("fileSets:", "globs:\n  generated: ['**/generated/**']\nfileSets:").replace('exclude: ["src/skip/**"]', 'exclude: ["src/skip/**"]\n    excludeGlobs: [generated]'));
    expect(config.sections[0]?.files.exclude).toEqual(["src/skip/**", "**/generated/**"]);
    expect(config.sections[0]?.rules[0]?.includeIf?.query).toContain("catch_clause");
    expect(config.targets.function?.language).toBe("typescript");
  });
  test("rejects old syntax, unknown records, and built-in target shadowing", () => {
    expect(() => parseConfig(CONFIG.replace("version: 2", "version: 1"))).toThrow();
    expect(() => parseConfig(CONFIG.replace("files: source", "files: missing"))).toThrow(/undefined file set/);
    expect(() => parseConfig(CONFIG.replace("includeIf: catches", "includeIf: missing"))).toThrow(/undefined condition/);
    expect(() => parseConfig(CONFIG.replace("function:\n", "comment:\n"))).toThrow(/reserved/);
    expect(() => parseConfig(CONFIG.replace('exclude: ["src/skip/**"]', 'excludeGlobs: [missing]'))).toThrow(/undefined globs/);
  });
  test("requires included section files and exclude-only rule file sets", () => {
    expect(() => parseConfig(CONFIG.replace('include: ["src/**/*.ts", "src/**/*.tsx"]', 'include: []'))).toThrow(/at least one/);
    expect(() => parseConfig(CONFIG.replace("id: catch", "id: catch\n        files: source"))).toThrow(/only exclude/);
    expect(() => parseConfig(CONFIG.replace("language: typescript", "language: python"))).toThrow();
  });
  test("rejects duplicate section names", () => {
    const section = CONFIG.slice(CONFIG.indexOf("  - name:"));
    expect(() => parseConfig(`${CONFIG}\n${section}`)).toThrow(/section names/);
  });
});
