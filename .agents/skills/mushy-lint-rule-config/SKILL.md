---
name: mushy-lint-rule-config
description: Inventory repository conventions, select semantic rule candidates, and create or maintain mushy-lint configurations using named targets, conditions, file sets, and globs. Covers the complete supported schema and labeled validation without requiring a mushy-lint source checkout.
---

# Mushy-lint rule configuration

Author evidence-backed rules for configuration version 2. TypeScript and TSX are supported. Older configurations are rejected; rewrite them using named records rather than retaining old inline definitions or YAML aliases.

A rule's `score` is a yes/no question. A result's numeric `score` is raw probability of yes, not a violation verdict or calibrated bug risk. Questions can describe desirable or undesirable properties. There are no thresholds or score-driven failure exits.

## Workflow and completion checks

1. Inventory the requested policy scope before choosing rules. For a whole-repository audit, enumerate root and nested `AGENTS.md`/`CLAUDE.md`, rule directories such as `.claude/rules`, user-supplied guidance, existing configuration, and deterministic lint/type/test coverage. Count symlinks once. Keep a source inventory with each file's scope and whether it was read. Use bounded batches of paths and short summaries rather than storing entire instruction collections in tool memory.
2. Build a candidate decision table before authoring YAML. Include convention, policy source, effective directory scope, example locations, evidence needed, decision, proposed rule ID, and reason. Decisions are `configured`, `deterministic`, `deferred`, or `workflow`. Account for every discovered convention, grouping repeated invariants explicitly by shared evidence requirements. A selected-rule list alone is not an exhaustive audit. State missing policy sources and unresolved conflicts.
3. For each configured candidate, choose the smallest complete target and one narrow question. Record affirmative and negative examples, expected eligibility, relevant syntax variants, and nested-scope examples. Prefer existing named records where their evidence boundaries agree.
4. Write the version-2 records and references below. Preserve unrelated user work. Record intentional changes to question meaning, evidence boundaries, scopes, or provider choices.
5. Validate extraction with the installed CLI. Inspect complete captured states, reporting anchors, per-rule coverage, and failures. Completion requires eligible examples for every configured rule, not just a successful exit or aggregate target count.
6. With authorization, classify a small labeled sample. Record the human label, model score, evidence-based review decision, provider/model, and disagreement for each example. Report extraction coverage and authenticated classification coverage separately. Untested rules remain unverified even if other rules scored well.

Return the configuration path, source inventory, candidate decisions, changed rules and records, extraction checks, labeled classification checks, and remaining gaps. This skill never treats syntactically valid configuration as proof of semantic quality.

## Suitability and evidence

Configure a rule when a repository convention depends on meaning, one narrow yes/no question expresses it, and supported local syntax supplies sufficient evidence. Use deterministic tooling for exact counts, banned syntax, naming regexes, import order, assignability, or observable test/runtime behavior. Classifier gates do not make a syntax-only convention worth paying to evaluate.

Useful boundaries include comment plus complete annotated operation, identifier plus complete named function, and complete function with catch/control flow. Defer imported semantics, cross-file ownership/type resolution, external guarantees not supplied as evidence, or unsupported languages. `.ts`, `.mts`, `.cts`, `.tsx`, and admitted declaration files are supported; `.js`, `.jsx`, Python, and Go are not.

The provider receives captured state and question. It does not automatically receive file paths, configuration, review metadata, imported definitions, or parent constructs. Capture the facts the question needs, or defer the rule. Capture values are lists of complete strings, including single captures; absent optional captures become empty lists. Queries do not truncate large constructs.

## Complete YAML schema

Objects reject unknown keys. Names and questions must be nonblank. Omit optional fields instead of using `null`. References are names, never inline objects or queries. Definitions live at document level, not inside sections. There is no interpolation, inheritance, recursive record expansion, or automatic merging between named records.

### Document

| Key | Type and constraints | Required or default |
|---|---|---|
| `version` | Literal `2` | Required |
| `classification` | Object below | Defaults applied |
| `maxPlanBytes` | Integer at least `1` | `268435456` |
| `globs` | Map of names to lists of nonblank glob patterns | `{}` |
| `fileSets` | Map of names to file-set records | Required |
| `targets` | Map of names to query-target records | `{}` |
| `conditions` | Map of names to condition records | `{}` |
| `sections` | Nonempty list of sections | Required |

The plan limit bounds retained evidence and metadata, not total process memory. Exceeding it reports incomplete coverage. Record references resolve once while loading configuration. Unknown references are errors, including unused file sets with undefined glob references.

### `classification`

| Key | Type and constraints | Default |
|---|---|---|
| `provider` | `typesafe` or `openrouter` | `typesafe` |
| `model` | Nonempty string | `jev-latest` |
| `apiKeyEnv` | Nonblank environment variable name | Omitted; provider-specific |
| `concurrency` | Integer `1..40` | `8` |
| `requestsPerSecond` | Integer `1..40` | `40` |
| `maxInputBytes` | Integer at least `256` | `64000` |
| `maxQuestions` | Integer at least `1` | `64` |
| `timeoutMs` | Positive integer | `30000` |
| `retries` | Integer `0..5` | `2` |

Use explicit provider/model pairs: TypeSafe with an available Jev model, or OpenRouter with `typesafe/jev-1.13`. Changing the provider alone does not rewrite the model. Both adapters use native System One probabilities, not chat-generated booleans or logprobs. Endpoint/header overrides and provider fallbacks are unsupported.

Credentials default to `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. `apiKeyEnv` names a variable, never a secret value. An explicit `--credential-file` reads that variable from literal dotenv data only when the environment lacks it. It does not execute shell expressions or inject other variables. Keep credentials out of YAML, artifacts, and tool output.

The request guard measures UTF-8 serialized bytes, not tokens. Questions sharing identical complete state can batch; identical state/question work can be reused without collapsing source results. Different states are not packed together. Retries may add cost. Dry-run does not enforce request-byte limits or establish provider availability.

### Each `fileSets.<name>` record

| Key | Type and constraints | Default |
|---|---|---|
| `include` | List of repository-relative glob patterns | `[]` |
| `exclude` | List of repository-relative glob patterns | `[]` |
| `includeGlobs` | List of names in `globs` | `[]` |
| `excludeGlobs` | List of names in `globs` | `[]` |

Literal patterns and referenced lists combine, deduplicating identical patterns. A section's resolved file set needs at least one include pattern. A rule's file set may only exclude; it adds exclusions to section scope. There are no implicit generated/vendor/test exclusions. Use forward-slash paths relative to the Git root.

### Each `targets.<name>` record

| Key | Type and constraints | Required or default |
|---|---|---|
| `language` | Literal `typescript` | Required |
| `root` | Nonblank capture name without `@` | Required |
| `location` | Nonblank capture name without `@` | Uses `root` |
| `query` | Nonblank tree-sitter query | Required |

`comment` is reserved for the built-in target and cannot be redefined. Every other target needs a named record. A referenced target's language must match the section.

### Each `conditions.<name>` record

| Key | Type and constraints | Required |
|---|---|---|
| `language` | Literal `typescript` | Yes |
| `query` | Nonblank tree-sitter query | Yes |

A rule's `includeIf` references one condition. Its language must match the section. Condition captures never become model state or reporting anchors.

### Each `sections[]` object

| Key | Type and constraints | Required |
|---|---|---|
| `name` | Nonblank name, unique across sections | Yes |
| `language` | Literal `typescript`, including TSX by extension | Yes |
| `files` | Name in `fileSets` | Yes |
| `rules` | Nonempty list of rules | Yes |

All matching sections apply. IDs are unique within a section, not globally. Track rules by `(section, rule)`.

### Each `rules[]` object

| Key | Type and constraints | Required or default |
|---|---|---|
| `id` | Nonblank ID, unique within its section | Required |
| `target` | Named target or built-in `comment` | Required |
| `score` | Nonblank yes/no question | Required |
| `includeIf` | Name in `conditions` | Omitted; no gate |
| `context` | List of required context-provider names | `[]` |
| `files` | Name of an exclude-only file set | Omitted |
| `review` | Review metadata below | Defaults applied |

Required nonempty `context` produces `context_unavailable`; cross-file context providers are not implemented. There are no arbitrary extractor modules, verifier hooks, criteria, severities, thresholds, state templates, Choice questions, or grade scales.

### Rule `review`

| Key | Type and constraints | Default |
|---|---|---|
| `yesMeans` | `desirable`, `undesirable`, or `neutral` | `neutral` |
| `policy` | List of policy-source references | `[]` |

Review metadata helps humans interpret questions. It is not sent as classifier evidence and never changes raw scores, question direction, eligibility, or exit status. The reasoning agent still checks the actual question and applicable policy.

## Query and comment contracts

Use `mushy-lint grammar --format json` to inspect installed TS/TSX nodes and fields, and dry-run to test a query. Read diagnostic messages rather than binaries. Declarations, expressions, arrows, and methods need explicit alternative patterns if promised by the rule.

Every pattern must capture exactly one root and location, even if it matches no current fixture. Other captures can be optional/repeated. Every query match is a separate target; exact duplicate capture-name/span matches collapse. Different matches sharing a root do not automatically aggregate.

Basic text predicates such as `#eq?`, `#match?`, and their supported negative/any variants work. Custom predicates and semantic property assertions are rejected. `#set!` does not define evidence or ownership.

Targets search all nesting depths. `includeIf` tests existence anywhere in the complete root subtree, including nested functions. An outer function can qualify because an inner function has a catch. Multiple gate matches do not multiply one target/rule evaluation. Gates do not narrow state or pick a problematic line.

The built-in comment target groups adjacent line comments, normalizes delimiters and block stars, omits tool directives, and reports the comment. Preceding prose annotates the next complete sibling; trailing prose annotates the preceding same-line sibling. At the end of a body, it captures the nearest supported enclosing operation. For a callback argument that is a call expression, this includes the call; for a catch, the complete try statement. An orphan at module level remains `extraction_failed`, not a whole-module fallback. Invalid captured syntax stays unscored. Query comment captures retain literal delimiters.

## Working configurations

### Complete-function error handling

```yaml
version: 2
classification:
  provider: openrouter
  model: typesafe/jev-1.13
fileSets:
  source:
    include: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: ["**/*.d.ts", "**/generated/**"]
targets:
  function:
    language: typescript
    root: code
    query: |
      (function_declaration) @code
      (function_expression) @code
      (arrow_function) @code
      (method_definition) @code
conditions:
  catches:
    language: typescript
    query: |
      (try_statement handler: (catch_clause))
sections:
  - name: application
    language: typescript
    files: source
    rules:
      - id: errors.discards-caught-error
        target: function
        includeIf: catches
        score: Does `code` discard a caught error without communicating failure to its caller?
        review:
          yesMeans: undesirable
```

### Name as location, complete function as evidence

```yaml
version: 2
classification:
  provider: typesafe
  model: jev-1.13
fileSets:
  source:
    include: ["src/**/*.ts", "src/**/*.tsx"]
targets:
  named_function:
    language: typescript
    root: code
    location: name
    query: |
      (function_declaration name: (identifier) @name) @code
sections:
  - name: names
    language: typescript
    files: source
    rules:
      - id: naming.describes-operation
        target: named_function
        score: Does `name` accurately describe the operation performed by `code`?
        review:
          yesMeans: desirable
```

### Shared exclusions and built-in comments

```yaml
version: 2
globs:
  generated: ["**/generated/**", "**/node_modules/**"]
fileSets:
  source:
    include: ["src/**/*.ts", "src/**/*.tsx"]
    excludeGlobs: [generated]
sections:
  - name: comments
    language: typescript
    files: source
    rules:
      - id: comments.narrates-code
        target: comment
        score: Does `comment` merely restate behavior already visible in `code`, rather than explaining a reason or constraint?
        review:
          yesMeans: undesirable
```

## Extraction and labeled classification checks

Run from the target Git root. `files` uses the same config matching as `check`; use it instead of recreating glob matching or adding undisclosed file-size cutoffs.

```bash
mushy-lint files src --config mushy-lint.yaml --format json
mushy-lint check src --config mushy-lint.yaml --dry-run --format json
mushy-lint check src --config mushy-lint.yaml --sample 5 --seed config-check --stratify --dry-run --format json
```

`--stratify` prefers files covering additional eligible rules, then fills the requested sample with seeded ordering. It parses all candidates and is not guaranteed to cover every rule within the requested file limit. Random sampling omits `--stratify`. Record the seed, candidate pool, selected files, and zero-coverage rules. An explicitly requested random sample stays random.

Dry-run includes `rules`, `sources`, `sampling`, `coverage`, `evaluations`, blocked `results`, `issues`, `classification`, and `summary`. Each rule record contains resolved targets, gate query/name, scopes, context, question, and review metadata. Each source includes its SHA-256 and byte count. Coverage lists every configured section/rule, including zeros. Eligible counts are admitted pairs, not proof of correct extraction; excluded counts are not compliance counts.

For every changed rule, keep a labeled-example table: fixture/location, expected yes/no, expected eligibility, expected captures/location, observed extraction, observed score if authorized, and source-based decision. Include TS and TSX when claimed, each target alternative, nested gates, and end-of-body/module-orphan comments where applicable. Review labeled examples before a large paid run. A stratified repository sample supplements controlled examples; it does not replace them.

An authorized live run removes `--dry-run` and can add `--credential-file <explicit-path>` and `--artifacts <new-private-directory>`. Reuse the seed and stable scope from preflight. The CLI saves the report, resolved rules, plan, source hashes, coverage, provenance, exit status, diagnostics, and an undecided review ledger. It rejects an existing artifact directory; its parent must already exist. Raw artifacts contain source and remain private.

Live results repeat `question`; numeric `score` is present only for `status: evaluated`. `not_evaluated` reasons are `parse_error`, `input_too_large`, `context_unavailable`, `extraction_failed`, and `request_failed`. File/run issues indicate potentially unknown coverage. Executions preserve provider, requested/returned model, attempts, and usage when supplied. Unknown token totals remain `null`.

Locations use one-based lines/columns, exclusive ends, and parser string offsets, not UTF-8 byte indices. They are predetermined source anchors, not model-proven bug locations. A diff selects captured evidence overlapping added/modified lines relative to the ref; it omits untracked and pure-deletion ranges. Use a separately scoped full run for deletion-only coverage.

Exit `0` means operational completion, including possibly empty scope. Exit `2` means invalid usage or incomplete evaluation. Scores never cause exit `1`. Recheck every dependent rule when a shared definition changes. Report unsupported/unverified cases rather than excluding difficult examples or silently truncating evidence.
