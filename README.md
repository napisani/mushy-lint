# mushy-lint

![mushy-lint logo](./logo.png)

Ask semantic yes/no questions about code, with the source evidence attached.

mushy-lint extracts complete constructs with tree-sitter, asks a classification
model narrow questions, and reports its raw probability of yes. It is useful for
conventions that depend on meaning rather than syntax:

| Convention | Example question |
|---|---|
| Comments explain reasons | Does this comment merely narrate what the code already shows? |
| Names describe behavior | Does the function name describe its operation and visible side effects? |
| Failures remain visible | Does this catch turn a failure into apparent success? |
| Logs help diagnosis | Does this diagnostic omit necessary context visible in the code? |
| Tests check their advertised behavior | Does the title describe what these assertions actually verify? |
| Browser tests wait for state | Is this sleep guessing when an observable condition will be ready? |

Use ordinary linters, typecheckers, and tests for exact syntax, forbidden imports,
formatting, assignability, or runtime guarantees. mushy-lint does not resolve
imports or prove that a program is correct.

**A score is not a violation.** A high score means the model thinks the answer to
that particular question is yes. Whether yes is desirable depends on the
question. The tool never applies thresholds, inverts answers, or turns scores
into pass/fail exits. A human or reasoning agent reviews the evidence.

Currently supported: TypeScript and TSX source, query-defined targets, the built-in
comment target, and TypeSafe/OpenRouter System One classification. Configuration
version 2 is required; there is no version-1 compatibility reader.

## Contents

- [Quick start](#quick-start)
- [How a rule works](#how-a-rule-works)
- [Complete configuration example](#complete-configuration-example)
- [Rule examples and their limits](#rule-examples-and-their-limits)
- [Configuration reference](#configuration-reference)
- [Targets, captures, and conditions](#targets-captures-and-conditions)
- [CLI reference](#cli-reference)
- [Reports and incomplete coverage](#reports-and-incomplete-coverage)
- [Private review artifacts](#private-review-artifacts)
- [Providers and request limits](#providers-and-request-limits)
- [Validating your rules](#validating-your-rules)
- [Agent skills](#agent-skills)
- [Development](#development)

## Quick start

### Get the CLI

The public repository is [napisani/mushy-lint](https://github.com/napisani/mushy-lint),
mirrored from `pub/mushy-lint/` in the monorepo. The package is not published to npm.
With Bun 1.3.0 or newer and Git installed:

```bash
git clone https://github.com/napisani/mushy-lint.git
cd mushy-lint
bun install --frozen-lockfile
bun run build:bin
./dist/mushy-lint --help
export PATH="$PWD/dist:$PATH"
```

The compiled executable includes the runtime and WASM grammars. Git must still be
available. To build with Nix from the standalone checkout:

```bash
nix build . --no-link --print-out-paths
```

In a monorepo checkout, build from `pub/mushy-lint/` with Bun, or use
`nix build ./pub/mushy-lint --no-link --print-out-paths` from the monorepo root.
The printed store path contains `bin/mushy-lint`. The sibling `pub/dotfiles-nix`
flake also installs the package through Home Manager. The Nix package fetches
runtime archives by integrity hash and compiles offline. Git-backed flake sources
omit untracked files; stage new runtime files before validating that package.

### Write your first rule

In the Git root of the repository you want to review, save this as
`mushy-lint.yaml`:

```yaml
version: 2
classification:
  provider: openrouter
  model: typesafe/jev-1.13
fileSets:
  source:
    include: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: ["**/generated/**", "**/*.d.ts"]
sections:
  - name: comments
    language: typescript
    files: source
    rules:
      - id: comments.narrates-code
        target: comment
        score: Does `comment` merely restate behavior visible in `code`, rather than explain a reason or constraint?
        review:
          yesMeans: undesirable
```

Inspect the evidence before sending anything to a provider:

```bash
mushy-lint files src --format json
mushy-lint check src --dry-run --format json
```

For example, a comment above this function:

```ts
// Trim whitespace from the name.
function normalizeName(name: string) { return name.trim(); }
```

produces this captured state:

```json
{
  "comment": ["Trim whitespace from the name."],
  "code": ["function normalizeName(name: string) { return name.trim(); }"]
}
```

Nothing is classified during a dry run, and no credentials are needed. Once you
have checked the scope and agree to send the captured source to OpenRouter:

```bash
mushy-lint check src --credential-file /explicit/path/to/.env --format json
```

The file must contain the configured key name, which defaults to
`OPENROUTER_API_KEY` for OpenRouter. Alternatively, provide that variable through
your normal secret manager. Existing environment credentials take precedence.
The CLI does not source the file, execute shell expressions, import unrelated
variables, or automatically search for credentials.

## How a rule works

A rule connects three separate decisions:

1. **Target:** what complete source construct to capture.
2. **Condition:** whether that target is eligible for this rule.
3. **Question:** what semantic property to ask about the captured state.

The file set decides where to look. The reporting location decides where a reader
should start inspecting the evidence. Neither the condition nor the model chooses
that location.

For `errors.hides-failure` in the full example below:

- `function` captures the complete function as `code`.
- `catches` admits functions containing a try/catch.
- The question asks whether their complete control flow hides a failure.
- Several catches still produce one evaluation per function and rule.
- A nested function can make its enclosing function eligible. Both remain
  independent targets.

The model receives the captured state and question. It does **not** automatically
receive the file path, policy files, imported definitions, surrounding source, or
`review` metadata. Put the required local facts in captures and the applicable
semantic distinction in the question. Defer rules that need unavailable evidence.

## Complete configuration example

This runnable configuration demonstrates every supported configuration field.
Adjust the paths and policy references to your repository. The explicit
operational values are the current defaults, except for the chosen provider,
model, and credential name.

Copy [`examples/full.yaml`](examples/full.yaml), or use the following YAML. There
are no anchors, merge keys, interpolation, or inheritance. Definitions are named
records, resolved before source analysis.

```yaml
version: 2
classification:
  provider: openrouter
  model: typesafe/jev-1.13
  apiKeyEnv: OPENROUTER_API_KEY
  concurrency: 8
  requestsPerSecond: 40
  maxInputBytes: 64000
  maxQuestions: 64
  timeoutMs: 30000
  retries: 2
maxPlanBytes: 268435456

globs:
  source_code: ["src/**/*.{ts,tsx,mts,cts}"]
  test_code: ["src/**/*.{test,spec}.{ts,tsx,mts,cts}", "tests/**/*.{ts,tsx,mts,cts}"]
  generated: ["**/*.d.{ts,mts,cts}", "**/generated/**", "**/node_modules/**"]

fileSets:
  source:
    include: ["scripts/**/*.{ts,tsx,mts,cts}"]
    includeGlobs: [source_code]
    exclude: ["src/vendor/**"]
    excludeGlobs: [generated]
  tests:
    includeGlobs: [test_code]
    excludeGlobs: [generated]
  e2e:
    include: ["tests/e2e/**/*.{ts,tsx,mts,cts}"]
    excludeGlobs: [generated]
  runtime_only:
    exclude: ["**/fixtures/**"]
    excludeGlobs: [test_code]

targets:
  function:
    language: typescript
    root: code
    query: |
      (function_declaration) @code
      (generator_function_declaration) @code
      (function_expression) @code
      (generator_function) @code
      (arrow_function) @code
      (method_definition) @code
  named_function:
    language: typescript
    root: code
    location: name
    query: |
      (function_declaration name: (identifier) @name) @code
      (generator_function_declaration name: (identifier) @name) @code
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @code
      (
        (method_definition name: [(property_identifier) (private_property_identifier)] @name) @code
        (#not-eq? @name "constructor")
      )
  test_case:
    language: typescript
    root: code
    location: name
    query: |
      (
        (call_expression
          function: (identifier) @runner
          arguments: (arguments
            . [(string) (template_string)] @name
            . [(arrow_function) (function_expression)])) @code
        (#any-of? @runner "it" "test")
      )
      (
        (call_expression
          function: (member_expression
            object: (identifier) @runner
            property: (property_identifier) @modifier)
          arguments: (arguments
            . [(string) (template_string)] @name
            . [(arrow_function) (function_expression)])) @code
        (#any-of? @runner "it" "test")
        (#any-of? @modifier "only" "skip" "concurrent")
      )

conditions:
  catches:
    language: typescript
    query: |
      (try_statement handler: (catch_clause))
  operational_logs:
    language: typescript
    query: |
      (
        (call_expression
          function: (member_expression
            object: (identifier) @_logger
            property: (property_identifier) @_level))
        (#any-of? @_logger "logger" "log")
        (#any-of? @_level "info" "warn" "error")
      )
  timers:
    language: typescript
    query: |
      (
        (call_expression function: (identifier) @_timer)
        (#eq? @_timer "setTimeout")
      )
      (
        (call_expression function: (member_expression
          property: (property_identifier) @_wait))
        (#eq? @_wait "waitForTimeout")
      )

sections:
  - name: application
    language: typescript
    files: source
    rules:
      - id: comments.narrates-code
        target: comment
        score: >-
          Does `comment` merely narrate behavior already visible in `code`,
          rather than explain a non-obvious reason, constraint, or caller-facing contract?
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]
      - id: naming.describes-operation
        target: named_function
        files: runtime_only
        score: >-
          Does `name` accurately describe the operation and any important visible
          side effects of `code`? Do not infer behavior from uncaptured callees.
        review:
          yesMeans: desirable
          policy: [AGENTS.md]
      - id: functions.mixes-responsibilities
        target: named_function
        files: runtime_only
        score: >-
          Does `code` combine independent responsibilities with no shared purpose
          in the operation named by `name`? Different steps in one coherent workflow
          are not unrelated responsibilities.
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]
      - id: errors.hides-failure
        target: function
        files: runtime_only
        includeIf: catches
        context: []
        score: >-
          Does `code` turn a caught failure into apparent success without a failure
          result, diagnostic, or justified recovery visible in this construct?
          A documented optional lookup or explicit unsuccessful result is not hidden failure.
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]
      - id: logging.narrates-progress
        target: function
        files: runtime_only
        includeIf: operational_logs
        score: >-
          Does `code` log routine per-item progress at info, warn, or error level
          instead of an operational outcome or problem useful for diagnosis?
          Judge the visible log calls, not telemetry outside this construct.
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]
      - id: logging.omits-context
        target: function
        files: runtime_only
        includeIf: operational_logs
        score: >-
          Does a diagnostic in `code` omit non-sensitive operation or entity context
          already visible here and necessary to distinguish the reported event?
          An adequate operation-specific message needs no extra fields. Do not demand secrets.
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]

  - name: tests
    language: typescript
    files: tests
    rules:
      - id: tests.title-describes-check
        target: test_case
        score: >-
          Does `name` accurately describe what the visible setup and assertions in
          `code` verify, rather than an outcome they do not actually check?
        review:
          yesMeans: desirable
          policy: [AGENTS.md]

  - name: browser-tests
    language: typescript
    files: e2e
    rules:
      - id: e2e.sleeps-for-state
        target: test_case
        includeIf: timers
        score: >-
          Does `code` use a sleep to guess when an observable condition will be ready,
          rather than await that condition? A timer deliberately injecting fixture
          latency or exercising time-dependent behavior is not such a wait.
        review:
          yesMeans: undesirable
          policy: [AGENTS.md]

```

The same `operational_logs` condition serves two different questions. The
`runtime_only` file set adds exclusions to those rules without broadening their
section's scope. The test and browser-test sections intentionally overlap, so an
E2E test can receive both a title assessment and a wait assessment.

`context: []` is explicit because additional context providers are not implemented.
A nonempty context list is valid syntax but blocks the dependent rule with
`context_unavailable`; it does not fetch cross-file information.

## Rule examples and their limits

The full configuration contains eight rules. These are suggested questions, not
built-in policy: configure only conventions that actually apply to your repository.
The examples below are human-labeled illustrations, not recorded model answers.

### Comment rationale

The comment question asks about an undesirable property. Narrating an obvious
trim is different from documenting an external constraint:

```ts
// The upstream service rejects reused idempotency keys.
function submitOnce(key: string) { return client.send({ key }); }
```

A verified constraint can justify `leave` even if the model calls it redundant.
The built-in target supplies both the comment and its complete attached operation,
not just the next source line. It omits tool directives such as `@ts-expect-error`.

### Function names and responsibilities

`naming.describes-operation` asks a desirable question. For this construct, the
visible operation is trimming, not saving:

```ts
function saveCustomer(name: string) { return name.trim(); }
```

Renaming it to `normalizeName` might be warranted if that matches its real callers.
The separate responsibility rule asks an undesirable question, but a coherent
validation/persistence/notification workflow is not automatically three unrelated
responsibilities.

The `named_function` target captures declarations, generator declarations,
variable-bound arrows/function expressions/generators, and named methods.
Constructors are excluded. Its location is `name`, while its evidence includes
the complete construct. Anonymous callbacks and other syntax forms need a
different target rather than a claim of coverage they do not have.

### Failure handling

This example turns a failed write into an apparent success:

```ts
async function saveInvoice(invoice: Invoice) {
  try {
    return await store.write(invoice);
  } catch {
    return { ok: true };
  }
}
```

A documented optional lookup returning `null`, a failure result, a diagnostic, or
a justified recovery requires different reasoning. The question must not declare
every catch suspicious.

The `catches` condition is a structural prefilter, not proof of hidden failure.
The classifier still sees the entire function, including nested callables.

### Operational logging

`logging.narrates-progress` and `logging.omits-context` reuse a structural gate
for `logger` or `log` calls at info, warn, or error level. One asks whether the
log belongs in routine debug output; the other asks whether a useful diagnostic
lacks visible, non-sensitive context. For example, this diagnostic retains the
operation, entity, and caught error:

```ts
async function sendInvoice(invoice: Invoice) {
  try {
    await client.send(invoice);
  } catch (error) {
    logger.error({ invoiceId: invoice.id, error }, "Failed to send invoice");
    throw error;
  }
}
```

The example does not discover every logging wrapper. Extend the gate for your
actual logger shapes and retest the captures. It cannot assume hidden logger
bindings, external telemetry, or imported helper behavior.

### Test titles

This title advertises a property that object equality does not check:

```ts
test("preserves object key order", () => {
  expect({ second: 2, first: 1 }).toEqual({ first: 1, second: 2 });
});
```

An explicit `Object.keys(actual)` assertion is needed for the advertised order.
A high desirable-question score does not override that source evidence.

The target captures a complete test call plus its title. The sample covers
`it(...)`, `test(...)`, and their `only`, `skip`, and `concurrent` variants
with a literal string or template title and direct callback. It does not promise
coverage of `test.each(...)(...)`, imported callback bodies, or arbitrary framework
wrappers.

### Browser waits

`e2e.sleeps-for-state` distinguishes a readiness guess from a timer that
deliberately simulates latency:

```ts
test("shows the header", async () => {
  await page.waitForTimeout(500);
  await expect(page.getByRole("heading")).toBeVisible();
});
```

Review whether the readiness check can be awaited directly. Do not treat every
timer as a violation. The sample gate recognizes `setTimeout` and
`waitForTimeout`, not every custom sleep helper.

## Configuration reference

All objects reject unknown keys. Names, patterns, references, queries, and
questions must be nonblank. Omit optional fields instead of using `null`.
Names are local to their record maps; references are strings, not inline objects.
There are no default generated, vendor, or test exclusions.

### Document

| Field | Type / constraints | Required / default |
|---|---|---|
| `version` | Literal `2` | Required |
| `classification` | Provider and request options below | Defaults applied |
| `maxPlanBytes` | Integer at least `1`; retained plan bytes | `268435456` |
| `globs` | Map of names to lists of glob patterns | `{}` |
| `fileSets` | Map of names to file-set records | Required |
| `targets` | Map of names to query-target records | `{}` |
| `conditions` | Map of names to eligibility-query records | `{}` |
| `sections` | Nonempty list of sections | Required |

`maxPlanBytes` bounds retained evidence and metadata, not total process RSS.
Exceeding it makes coverage incomplete. The parser still needs memory for the
source file it is currently processing.

### classification

| Field | Type / constraints | Default |
|---|---|---|
| `provider` | `typesafe` or `openrouter` | `typesafe` |
| `model` | Nonempty model ID | `jev-latest` |
| `apiKeyEnv` | Nonblank environment variable name, never its secret value | Provider-specific |
| `concurrency` | Integer `1..40` | `8` |
| `requestsPerSecond` | Integer `1..40`; request starts, including retries | `40` |
| `maxInputBytes` | Integer at least `256`; serialized UTF-8 request bytes | `64000` |
| `maxQuestions` | Integer at least `1`; questions per request | `64` |
| `timeoutMs` | Positive integer; timeout per attempt | `30000` |
| `retries` | Integer `0..5`; additional transient-failure attempts | `2` |

Select provider and model together. Native TypeSafe uses an available Jev model,
such as `jev-latest`; OpenRouter uses `typesafe/jev-1.13`. Changing only the
provider does not rewrite the model. The default key names are `TYPESAFE_API_KEY`
and `OPENROUTER_API_KEY`, respectively.

### globs

A named glob list is an array of patterns, not a file set or another record
reference. Lists may be empty. File sets refer to these lists through
`includeGlobs` and `excludeGlobs`. Use forward slashes and paths relative to the
target Git root. Brace patterns such as `src/**/*.{ts,tsx}` are supported.

### fileSets

| Field | Type / constraints | Default |
|---|---|---|
| `include` | List of literal include patterns | `[]` |
| `exclude` | List of literal exclude patterns | `[]` |
| `includeGlobs` | List of names in `globs` | `[]` |
| `excludeGlobs` | List of names in `globs` | `[]` |

Literal and referenced patterns combine, deduplicating exact duplicates. A file
matches when at least one include matches and no exclusion matches. A section's
resolved file set must have at least one include pattern.

A rule's file set is **exclude-only**. It can further restrict section scope,
never add files to it. Unknown glob references are rejected even in unused file
sets. Records do not inherit from other file sets.

### targets

| Field | Type / constraints | Required / default |
|---|---|---|
| `language` | Literal `typescript`, also used for TSX sections | Required |
| `root` | Capture name without the `@` prefix; exactly one node per pattern | Required |
| `location` | Capture name; exactly one reporting node per pattern | Uses `root` |
| `query` | Nonblank tree-sitter S-expression query | Required |

`comment` is a reserved built-in name and cannot be redefined. All other targets
are document-level records. A referenced target's language must match its section.

### conditions

| Field | Type / constraints | Required |
|---|---|---|
| `language` | Literal `typescript` | Yes |
| `query` | Nonblank tree-sitter query, used as an existence test | Yes |

A condition's language must match its section. Its captures never become model
state or reporting anchors.

### sections

| Field | Type / constraints | Required |
|---|---|---|
| `name` | Nonblank name, unique across sections | Yes |
| `language` | Literal `typescript` | Yes |
| `files` | Name in `fileSets` with at least one resolved include | Yes |
| `rules` | Nonempty list of rules | Yes |

All matching sections apply. TypeScript/TSX grammar selection follows the file
extension: `.ts`, `.mts`, `.cts`, and `.tsx`. Declaration files can be admitted
unless your file sets exclude them. JavaScript, JSX, Python, and Go are not supported.

### rules

| Field | Type / constraints | Required / default |
|---|---|---|
| `id` | Nonblank rule ID, unique within its section | Required |
| `target` | Name in `targets` or the built-in `comment` | Required |
| `score` | Nonblank yes/no question | Required |
| `includeIf` | Name in `conditions` | No gate |
| `context` | List of required context-provider names | `[]` |
| `files` | Name of an exclude-only file set | No additional exclusions |
| `review` | Advisory question direction and policy references | Defaults applied |

Use `(section, rule)` as the rule key; IDs need not be globally unique.
There are no severities, thresholds, criteria, verifier hooks, extractor modules,
state templates, Choice questions, or ordinal grade scales.

Required context providers are reserved but not implemented. For example,
`context: [project_symbols]` yields `context_unavailable` for dependent
evaluations, not an empty symbol table or an implicit project scan.

### review

| Field | Type / constraints | Default |
|---|---|---|
| `yesMeans` | `desirable`, `undesirable`, or `neutral` | `neutral` |
| `policy` | List of policy-source references, such as `AGENTS.md` | `[]` |

This metadata helps reviewers interpret a question. `neutral` records a
descriptive property without declaring yes good or bad. Policy references are
not automatically read or sent to the model. Neither field changes scores,
evidence, eligibility, requests, or exit status.

## Targets, captures, and conditions

Tree-sitter queries select syntax; they do not resolve types or imported symbols.
Use `mushy-lint grammar --format json` to inspect installed TS/TSX node and field
names, then test queries against actual source.

### Captures define evidence

For the declaration pattern
`(function_declaration name: (identifier) @name) @code`:

- `root: code` defines the instance and the subtree searched by conditions.
- `location: name` reports the identifier rather than the entire function.
- Both captures become state fields: `name: ["saveInvoice"]` and
  `code: ["function saveInvoice(...) { ... }"]`.

Every target capture is a list of complete source strings, even for a single node.
Optional captures become empty lists when absent. Repeated captures within one
match stay in source order. Captures used only for query predicates are still
part of target state; an underscore prefix does not hide them.

Every query pattern must have exactly one root and location. Other captures may
be optional or repeated. Separate matches remain separate instances; matching
the same root is not automatic aggregation. Exact duplicate capture-name/span
matches collapse. Basic text predicates such as `#eq?`, `#match?`, and
`#any-of?` are supported; custom predicates and semantic property assertions
are rejected. `#set!` does not define state shaping or ownership.

### Conditions never narrow the target

`includeIf` searches the complete root subtree at every nesting depth. An outer
function can qualify because an inner function contains a catch. Multiple gate
matches do not multiply one target/rule evaluation. A gated-out target emits no
rule result; its exclusion is counted.

The gate does not supply evidence, change captures, or select a problem line.
Capture a complete operation when the question needs control flow, even if a
single nested node made it eligible.

### Comments attach to complete constructs

The built-in `comment` target supplies `comment` and `code` lists. It groups
adjacent line comments and normalizes comment delimiters and block stars.
Preceding prose attaches to the next complete sibling construct. Trailing prose
attaches to the preceding same-line construct.

At the end of a body, a comment can attach to the nearest supported enclosing
operation. A callback argument can include its complete call; a catch includes
its try statement. A module-orphan comment remains an explicit
`extraction_failed`, not a whole-file fallback. Attached source is never
silently truncated. Query-defined comment captures retain their literal delimiters.

Locations are fixed before classification. Lines and columns are one-based;
range ends are exclusive. Indices use parser string offsets, not UTF-8 byte
offsets. These are evidence anchors, not model-proven bug locations.

## CLI reference

Run from the target repository's Git root. With no paths, discovery considers the
repository; positional paths restrict that pool further. Git supplies tracked
and untracked non-ignored files. Duplicate paths are collapsed.

| Command | Behavior |
|---|---|
| `check [paths...]` | Plan evidence, then classify unless `--dry-run` is set |
| `files [paths...]` | List files admitted by Git, config, paths, and optional diff |
| `grammar` | List installed TS/TSX nodes and fields; no config or source required |

| Option | Purpose |
|---|---|
| `-c, --config <path>` | Configuration file; default `mushy-lint.yaml` |
| `-d, --diff <ref>` | Limit targets to captured evidence overlapping changed lines |
| `-f, --format text\|json` | Output format; default `text` |
| `-j, --concurrency <n>` | Override configured parallel requests, from 1 to 40 |
| `--dry-run` | Plan without provider calls or credential-file reads |
| `--sample <n>` | Select at most n config-admitted files, with no size cutoff |
| `--seed <text>` | Reproducible sampling seed; generated when omitted |
| `--stratify` | Prefer eligible-rule coverage over random selection |
| `--credential-file <path>` | Explicit literal dotenv source for the selected key |
| `--artifacts <path>` | Save private review artifacts in a NEW directory |
| `-h, --help` | Print usage |

`files` accepts paths, config, diff, format, sample, and seed only.
`grammar` accepts only format or help. `--seed` and `--stratify` require
`--sample`; stratification is available only for `check`.

### Diff and sampling examples

```bash
# Changed captured evidence, not only the changed line as model state.
mushy-lint check --diff main --dry-run --format json

# Random five-file sample.
mushy-lint check src --sample 5 --seed review-1 --dry-run --format json

# Coverage-oriented sample to validate the configuration.
mushy-lint check --sample 5 --seed validation-1 --stratify --dry-run --format json

# Canonical discovery and installed grammar inspection.
mushy-lint files src --sample 5 --seed review-1 --format json
mushy-lint grammar --format json
```

Random sampling ranks config-admitted file names with the seed. Reuse the same
seed and stable candidate pool for preflight and classification. A seed does not
freeze source contents or guarantee that five selected files contain targets.

Stratification parses all candidates, greedily chooses files that add eligible
rule coverage, and fills remaining slots in seeded order. It can leave rules
uncovered and reach plan limits before selecting the sample. Unselected files
are outside the review, not declared clean. Run-level planning issues remain
visible after selection.

Diff mode uses added/modified line ranges and selects overlapping captured
evidence. It does not cover untracked files or pure deletions. Use a separately
scoped full run to investigate deletion-only effects.

## Reports and incomplete coverage

Text output is compact. JSON preserves the plan/report needed for inspection:

| Field | Contents |
|---|---|
| `classification` | Requested provider and model |
| `sampling` | Mode, candidate count, selected files, and sample seed/requested count |
| `rules` | Resolved questions, targets, gates, file scopes, context, review metadata |
| `sources` | Source file SHA-256 hashes, byte counts, target and exclusion counts |
| `coverage` | Every configured rule, including zero eligible counts |
| `results` | Terminal assessed or failed evaluations with exact questions and state |
| `issues` | File/run failures when affected target coverage cannot be established |
| `executions` | Provider attempts, returned model, request ID and usage when supplied |
| `summary` | Files, targets, exclusions, evaluations, requests, attempts and token totals |

A dry-run also contains `evaluations` for planned work, but has no classification
executions or scored results. Known blocked results and issues remain present.

An evaluated result has `status: evaluated`, `score` in the inclusive range
0–1, and an execution ID. Each result retains its ID, section, rule, target,
verbatim question, captured state, root, and reporting location.

An unscored result has `status: not_evaluated`, a reason, and a message:

| Reason | Meaning |
|---|---|
| `parse_error` | Captured evidence overlaps invalid syntax |
| `input_too_large` | A state/question cannot fit a request or the provider rejects its size |
| `context_unavailable` | A required context provider is not implemented |
| `extraction_failed` | A target could not be attached or extracted |
| `request_failed` | Credentials, transport, or response validation prevented assessment |

File/run issues can also report parse, extraction, and plan-size failures.
Parsing recovery does not establish complete coverage: unrelated valid targets
may be classified while the file remains incomplete. Failed work never gets a
fabricated score or silently shortened evidence. Valid sibling answers can
survive an incomplete provider response when their IDs remain unambiguous.

Coverage's `eligible` count includes admitted target/rule pairs even if later
blocked. During dry-run, `evaluated` is zero because no provider ran. Neither
`excluded` nor zero eligible counts mean compliance.

| Exit code | Meaning |
|---|---|
| `0` | Operational completion, possibly with empty scope |
| `2` | Invalid usage, failures, or incomplete evaluation/coverage |

There is no score-driven exit 1. Keep JSON and diagnostics when the command exits
2; that output can contain useful partial work.

## Private review artifacts

Use artifacts instead of reconstructing discovery, rule registries, hashes, and
review rows in scripts. Create a private parent, then use separate NEW directories
for preflight and an authorized live run:

```bash
parent=$(mktemp -d)
mushy-lint check src --sample 5 --seed review-1 --dry-run \
  --artifacts "$parent/preflight" --format json

# Only after checking the preflight and authorizing source disclosure/cost.
mushy-lint check src --sample 5 --seed review-1 \
  --credential-file /explicit/path/to/.env \
  --artifacts "$parent/live" --format json
```

The directory is mode `0700`; its files are `0600`. The parent must exist.
Existing artifact directories are rejected, not overwritten.

| File | Purpose |
|---|---|
| `config.yaml` | Configuration snapshot |
| `run.json` | Binary/entrypoint, command, cwd, config hash, Git HEAD/dirty status, sampling |
| `plan.json` | Captured source evidence and planned evaluations |
| `rules.json` | Resolved rule registry |
| `coverage.json` | Per-rule coverage counts |
| `report.json` | Scored and unscored terminal outcomes |
| `review.json` | One undecided review row per result |
| `stderr.txt` | Captured runtime diagnostics |
| `exit-status.txt` | Actual exit code |
| `outcome.json` | Start/end times and exit status |

Dry runs do not create a scored report or review ledger. Early failures can leave
only configuration, diagnostics, and outcome. Invalid arguments or a missing
config can fail before the artifact directory exists.

Reviewers fill the ledger with `address`, `leave`, `investigate`, or `blocked`,
plus source-based reasoning. The CLI does not assign those decisions or priorities.
Artifacts contain source and must stay private. Do not upload or commit them.
Hashes and captured spans establish provenance, not a full repository snapshot.

## Providers and request limits

| Provider | Route | Default credential variable |
|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `OPENROUTER_API_KEY` |

Both adapters use native System One Noul probabilities. Public `score` is not
TypeSafe's separate ordinal Score primitive. OpenRouter's dedicated System One
route is not a chat-completion endpoint. See the
[OpenRouter integration guide](https://raw.githubusercontent.com/OpenRouterTeam/docs/main/guides/community/typesafe-sdk.mdx).
No chat-generated booleans/confidence, custom endpoints, automatic provider
fallback, or probability reconstruction is attempted.

Classification groups questions sharing identical complete evidence, splits
groups to fit request limits, and reuses identical state/question work within one
run. Separate source locations keep separate results. Source text and capture
list order are not normalized. Unrelated states are not packed together, and
nested targets are not discarded.

`maxInputBytes` counts serialized UTF-8 request bytes, not tokens. The provider
still owns its token limit. Oversized individual pairs remain unscored rather
than truncated. Dry-run does not enforce request-byte limits or establish that
an account/model is available. Retries may incur additional cost.

Usage is counted once per request, not once per result. Missing token usage,
including unknown usage from a failed attempt, leaves aggregate totals `null`
rather than pretending they are zero. There is no persistent cache.

## Validating your rules

A configuration that parses is not yet a good semantic rule set.

1. Check file discovery, complete captures, reporting anchors, and gate behavior.
2. For every rule, label positive, negative, gated-out, and relevant syntax/nesting
   examples before inspecting their scores.
3. Use a stratified repository sample to find more evidence, then explicitly fill
   any zero-coverage gaps. Honor requested random samples as random.
4. With permission, classify the labeled examples and preserve raw scores,
   provider/model, source evidence, and supported disagreements.
5. Review the results against applicable policy and actual assertions/control
   flow. Do not tune exclusions or thresholds just to make output look clean.

Report extraction coverage, authenticated classification coverage, and completed
reasoning-review coverage separately. A useful sample is not a whole-repository
compliance claim. Local transport and extraction tests do not measure live
classifier accuracy.

## Agent skills

- [mushy-lint-rule-config](.agents/skills/mushy-lint-rule-config/SKILL.md)
  inventories conventions, separates semantic rules from deterministic/deferred
  work, and authors configuration with labeled validation.
- [mushy-lint-run-review](.agents/skills/mushy-lint-run-review/SKILL.md)
  runs preflight/classification, joins questions and evidence through CLI
  artifacts, and produces source-based decisions and an action plan.

Both guides are self-contained for agents without access to this README or source.
Their behavioral evaluation scenarios live in the corresponding `evals/`
directories. Deterministic tests protect documented schemas, captures, and
regression fixtures; they do not establish behavioral skill performance.

## Development

From the package directory:

```bash
nix develop
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build:bin
```

From the monorepo root, run `make check FILTER=mushy-lint` and
`make lint FILTER=mushy-lint`. The monorepo-config integration tests run only in
a monorepo checkout; standalone package tests do not require the monorepo's
configuration or policy documents.

After changing `bun.lock`, run `bun run nix:deps` to refresh
`nix-deps.json`. Tests and Nix evaluation reject a stale manifest. The generator
supports flat, platform-neutral runtime dependencies and rejects unsupported
dependency layouts. Rebuild pinned WASM grammars with `bun run build:grammars`;
pins and licenses live under `grammars/`.

Source analysis is in `src/check.ts`, extraction in `src/targets.ts`, and
classification scheduling in `src/classification.ts`. The private System One
wire adapter is in `src/jev.ts`; `src/report.ts` formats data.
`planAnalysis` and `classifyPlan` support inspection and provider replay;
`analyze` combines them for ordinary callers. Cross-file context providers,
executable custom extractors, persistent caching, and cross-state prompt packing
remain outside the implemented scope.

## License

MIT. Vendored grammars retain their own licenses under `grammars/`.
