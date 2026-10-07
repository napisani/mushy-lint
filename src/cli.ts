#!/usr/bin/env bun
import { $ } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createArtifacts, reviewLedger, writeArtifact } from "./artifacts.ts";
import { planAnalysis, classifyPlan } from "./check.ts";
import { createClassification } from "./classification.ts";
import { parseConfig, type Config } from "./config.ts";
import { eligibleFiles, rankFiles, selectPlan, stratifiedFiles } from "./files.ts";
import { changedLinesSince, listFiles } from "./git.ts";
import type { Sampling } from "./model.ts";
import { createSourceParser } from "./parser.ts";
import { formatPlan, formatResult, ruleCoverage } from "./report.ts";

const USAGE = `Usage: mushy-lint <check|files|grammar> [paths...] [options]

Commands:
  check                   Plan source evidence and optionally classify it
  files                   List files admitted by Git, config, paths, and diff
  grammar                 List installed TS/TSX node and field names

Options:
  -c, --config <path>      Config file (default: mushy-lint.yaml)
  -d, --diff <ref>         Only evaluate targets whose captured evidence changed
  -f, --format <fmt>       text | json (default: text)
  -j, --concurrency <n>    Parallel classification requests (default: config value)
      --dry-run           Inspect evidence without inference or credentials
      --sample <n>        Select at most n eligible files, without a size cutoff
      --seed <text>       Reproduce a sample (otherwise generate and record a seed)
      --stratify          Prefer files covering different rules (check only)
      --credential-file <path>  Explicit dotenv file; read only apiKeyEnv
      --artifacts <path>  Write private review artifacts to a NEW directory
  -h, --help              Show this help

Exit status: 0 complete, 2 usage error or incomplete evaluation.
Scores never determine the exit status. Environment credentials take precedence.
`;

const Options = z.object({
  config: z.string().default("mushy-lint.yaml"),
  diff: z.string().optional(),
  format: z.enum(["text", "json"]).default("text"),
  concurrency: z.coerce.number().int().min(1).max(40).optional(),
  sample: z.coerce.number().int().min(1).optional(),
  seed: z.string().min(1).optional(),
  stratify: z.boolean().default(false),
  "credential-file": z.string().optional(),
  artifacts: z.string().optional(),
  "dry-run": z.boolean().default(false),
  help: z.boolean().default(false),
}).refine((options) => options.sample !== undefined || (options.seed === undefined && !options.stratify), "seed and stratify require sample");

function json<T>(value: T): string { return `${JSON.stringify(value, null, 2)}\n`; }
function errorMessage(error: Error | string): string { return error instanceof z.ZodError ? z.prettifyError(error) : String(error); }

type ScopeInput = { config: Config; cwd: string; paths: string[]; options: z.infer<typeof Options> };

async function discover(input: ScopeInput) {
  const changed = input.options.diff ? await changedLinesSince({ ref: input.options.diff, cwd: input.cwd }) : null;
  const candidates = eligibleFiles({ config: input.config, files: await listFiles({ cwd: input.cwd, paths: input.paths }), changed });
  const seed = input.options.seed ?? randomUUID();
  const files = input.options.sample === undefined || input.options.stratify
    ? candidates : rankFiles(candidates, seed).slice(0, input.options.sample).sort();
  return { changed, candidates, seed, files };
}

async function preparePlan(input: ScopeInput) {
  const scope = await discover(input);
  let files = scope.files;
  let plan = await planAnalysis({ config: input.config, cwd: input.cwd, files, changed: scope.changed });
  if (input.options.stratify && input.options.sample !== undefined) {
    files = stratifiedFiles({ plan, count: input.options.sample, seed: scope.seed });
    plan = selectPlan(plan, files);
  }
  const sampling: Sampling = input.options.sample === undefined
    ? { mode: "all", candidates: scope.candidates.length, files }
    : { mode: input.options.stratify ? "rule-stratified" : "random", seed: scope.seed, requested: input.options.sample, candidates: scope.candidates.length, files };
  return { ...plan, sampling };
}

async function grammar(format: "text" | "json"): Promise<void> {
  const parser = await createSourceParser();
  try {
    const variants = ["ts", "tsx"].map((extension) => {
      const tree = parser.parse({ file: `grammar.${extension}`, source: "", language: "typescript" });
      if (!tree) { throw new Error("Installed grammar did not parse"); }
      try {
        const language = tree.language;
        const nodes = Array.from({ length: language.nodeTypeCount }, (_, index) => ({ name: language.nodeTypeForId(index), named: language.nodeTypeIsNamed(index) }));
        const fields = Array.from({ length: language.fieldCount }, (_, index) => language.fieldNameForId(index + 1));
        return { extension, nodes, fields };
      } finally { tree.delete(); }
    });
    process.stdout.write(format === "json" ? json(variants) : variants.map((variant) =>
      `${variant.extension}\nNodes: ${variant.nodes.filter((node) => node.named).map((node) => node.name).join(", ")}\nFields: ${variant.fields.join(", ")}`).join("\n") + "\n");
  } finally { parser.dispose(); }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      config: { type: "string", short: "c" }, diff: { type: "string", short: "d" },
      format: { type: "string", short: "f" }, concurrency: { type: "string", short: "j" },
      sample: { type: "string" }, seed: { type: "string" }, stratify: { type: "boolean" },
      artifacts: { type: "string" }, "credential-file": { type: "string" },
      "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  const options = Options.parse(values);
  const [command, ...paths] = positionals;
  if (options.help || !["check", "files", "grammar"].includes(command ?? "")) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 2;
  }
  if (command === "grammar") {
    if (paths.length > 0 || Object.keys(values).some((key) => key !== "format")) { throw new Error("grammar accepts only --format"); }
    await grammar(options.format);
    return 0;
  }
  if (command === "files" && (options.stratify || options.artifacts || options["credential-file"] || options["dry-run"] || options.concurrency)) {
    throw new Error("files accepts paths, config, diff, format, sample, and seed only");
  }
  const cwd = process.cwd();
  const configText = await Bun.file(options.config).text();
  if (command === "files") {
    const scope = await discover({ cwd, config: parseConfig(configText), options, paths });
    process.stdout.write(options.format === "json" ? json({ candidates: scope.candidates.length, files: scope.files, seed: options.sample === undefined ? null : scope.seed, requested: options.sample ?? null }) : `${scope.files.join("\n")}${scope.files.length > 0 ? "\n" : ""}`);
    return 0;
  }
  return executeCheck({ cwd, configText, options, paths, argv });
}

async function executeCheck(input: { cwd: string; configText: string; options: z.infer<typeof Options>; paths: string[]; argv: string[] }): Promise<number> {
  const { cwd, configText, options, paths, argv } = input;
  const directory = options.artifacts === undefined ? undefined : resolve(options.artifacts);
  if (directory !== undefined) {
    await createArtifacts(directory);
    await writeArtifact({ directory, name: "config.yaml", content: configText });
  }
  let code = 2;
  let diagnostics = "";
  const startedAt = new Date().toISOString();
  try {
    const config = parseConfig(configText);
    if (options.concurrency !== undefined) { config.classification.concurrency = options.concurrency; }
    const plan = await preparePlan({ cwd, config, options, paths });
    if (directory !== undefined) {
      const head = await $`git rev-parse --verify HEAD`.quiet().nothrow();
      const status = await $`git status --porcelain -z`.quiet().nothrow();
      await Promise.all([
        writeArtifact({ directory, name: "run.json", content: json({ cwd, argv, binary: process.execPath, entrypoint: Bun.main, startedAt, config: { path: resolve(options.config), sha256: createHash("sha256").update(configText).digest("hex") }, git: { head: head.exitCode === 0 ? head.text().trim() : null, dirty: status.exitCode === 0 ? status.text().length > 0 : null }, sampling: plan.sampling }) }),
        writeArtifact({ directory, name: "plan.json", content: formatPlan(plan, "json") }),
        writeArtifact({ directory, name: "rules.json", content: json(plan.rules) }),
      ]);
    }
    if (options["dry-run"]) {
      process.stdout.write(formatPlan(plan, options.format));
      if (directory !== undefined) { await writeArtifact({ directory, name: "coverage.json", content: json(ruleCoverage(plan)) }); }
      code = plan.issues.length > 0 || plan.results.length > 0 ? 2 : 0;
    } else {
      const classification = createClassification({ config: config.classification, credentialFile: options["credential-file"] });
      const result = await classifyPlan({ plan, classification });
      if (directory !== undefined) {
        await Promise.all([
          writeArtifact({ directory, name: "report.json", content: formatResult(result, "json") }),
          writeArtifact({ directory, name: "review.json", content: json(reviewLedger(result)) }),
          writeArtifact({ directory, name: "coverage.json", content: json(result.coverage) }),
        ]);
      }
      process.stdout.write(formatResult(result, options.format));
      code = result.issues.length > 0 || result.summary.notEvaluated > 0 ? 2 : 0;
    }
  } catch (error) {
    diagnostics = `mushy-lint: ${errorMessage(error instanceof Error ? error : String(error))}\n`;
    process.stderr.write(diagnostics);
  } finally {
    if (directory !== undefined) {
      await Promise.all([
        writeArtifact({ directory, name: "stderr.txt", content: diagnostics }),
        writeArtifact({ directory, name: "exit-status.txt", content: `${code}\n` }),
        writeArtifact({ directory, name: "outcome.json", content: json({ startedAt, completedAt: new Date().toISOString(), exitCode: code }) }),
      ]);
    }
  }
  return code;
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  process.stderr.write(`mushy-lint: ${errorMessage(error instanceof Error ? error : String(error))}\n`);
  process.exitCode = 2;
}
