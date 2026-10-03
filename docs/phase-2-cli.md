# Evaluation CLI contract

Status: implemented, with built-process regression coverage. This is a bounded extension of the existing
[local CLI](./phase-1-cli.md), not a new execution or evaluation engine.

## Scope

Add exactly two commands:

```text
abilitybench evaluate <baseline-run-id> <candidate-run-id> --criteria <file> [--config <file>] [--json]
abilitybench evaluation <evaluation-id> [--config <file>] [--json]
```

`evaluate` calls the existing `evaluateRunPair()` SDK path and publishes one separate
immutable receipt. `evaluation` calls `FileEvaluationReceiptStore.get()` for exact,
verified historical lookup. Neither command runs workflow stages, changes execution
manifests, promotes a baseline, discovers runs, or reuses evaluator results.
No receipt listing, evaluator cache, scoring, providers, UI, database, or new dependency
is included. Existing commands and their exit codes remain unchanged.

## Configuration and loading

The existing config default-export retains `workflow` and optional `storageDir` and
gains one optional `evaluation` module path:

```ts
export default {
  workflow: "./workflow.ts",
  storageDir: ".abilitybench",
  evaluation: "./evaluation.ts",
};
```

The evaluation module must default-export one suite created by
`createEvaluationSuite()`. No factory, named-export lookup, arbitrary structural
lookalike, suite registry, or auto-discovery is supported. The suite must have the
configured workflow ID and a root resolving to the config directory. Internal SDK
provenance validation must be reused, not approximated with shape checks.

Resolve the evaluation path relative to the config directory, using the existing
lexical and physical containment rules. Reject an empty/non-string supplied setting,
missing module, escaping path, wrong export, root mismatch, or workflow mismatch.
Use explicit configuration codes `evaluation_not_configured`, `evaluation_not_found`,
and `invalid_evaluation_export`; reuse `invalid_config` and `path_escaped` where applicable.

Only `evaluate` requires or imports the evaluation module. Old configs remain valid;
old commands and `evaluation` must work without current evaluator code. These commands
still load the configured workflow under the existing project-loading convention.
Consequently historical lookup does not require the old evaluator implementation but
does require a loadable project config/workflow; it is not standalone archive tooling.

Config and workflow modules are trusted executable code. Importing them can have
side effects; “read-only” describes AbilityBench storage operations, not a sandbox.
Use one fresh CLI process per invocation, with the existing Node/TypeScript loading
rules. No import-cache busting or watch daemon is introduced.

## Parsing and criteria

Require exactly two positional IDs for `evaluate`, and one for `evaluation`. Reject
unknown options and duplicate scalar options, including `--json`. Both commands accept
only their documented options. Neither accepts `--baseline`, `--inputs`, `--invalidate`,
`--latest`, or `--limit`. Preserve help-without-project-loading behavior.

Require `--criteria`, even for `{}`; no hidden default criteria. Resolve its file
relative to invocation cwd, not the config directory. Before invoking any evaluator,
read it once as fatal UTF-8, parse JSON, require a top-level object, and validate/snapshot
it using existing canonical JSON rules. Do not allow inline expressions, environment
substitution, stdin, comments, or evaluator-specific CLI options. JSON parsing retains
the existing parser's duplicate-key last-value behavior; do not claim stricter parsing.

File errors use `criteria_read_failed`, `criteria_invalid_json`, or
`criteria_not_object`; canonical validation uses the existing `invalid_criteria` code.
Each check remains responsible for validating criterion fields it consumes.

## Evaluation and publication

Pass both explicit IDs, snapshotted criteria, and the configured storage directory
to `evaluateRunPair()`. The existing SDK verifies distinct completed runs, configured
workflow identity, direct immutable baseline lineage, artifacts, declared implementation
inputs, typed selections, and publication integrity. Do not implement a second verifier.

Checks run fresh in SDK order, baseline first. Ordinary check exceptions, malformed
results, and output-selection errors become side errors in a published receipt.
Changed/unreadable declared implementation inputs abort the invocation without a receipt.
Preparation, storage, and publication failures are command errors, not evaluation verdicts.
Do not print an in-memory result as a persisted success when publication fails.
An interrupted/failed publication can leave an unreferenced criteria artifact; this
slice adds neither rollback deletion nor garbage collection.

## Output and exit status

Successful publication emits one result to stdout, including error-bearing receipts.
Human output shows receipt ID, workflow/suite IDs, both run IDs and their completed
execution statuses, candidate evaluation status, comparison status, summary counts,
and each check's two verdicts, comparison, and side error code/message if present.
Never collapse these into one “success” label.

`--json` emits one document with no progress lines:

```text
{ schemaVersion: "phase2-cli-evaluate-v1", receipt: EvaluationReceipt }
{ schemaVersion: "phase2-cli-evaluation-v1", receipt: EvaluationReceipt }
```

Receipts already contain source identities and strict status fields; the envelope must
not duplicate or rename their semantics. Execution remains completed in the source
manifests and their original `evaluationStatus: "not_run"` is unchanged.

For `evaluate`, apply this exit precedence after publication:

| Condition | Exit |
| --- | --- |
| Candidate evaluation or pair comparison is `error` | 3 |
| Candidate evaluation is `failed` or comparison is `regressed` | 1 |
| Candidate evaluation is `passed` and comparison is `no_regressions` | 0 |
| No result: usage, config, criteria, preparation, instability, or publication failure | 2 |

Thus both sides failing absolute criteria still exits 1 despite `no_regressions`.
A passing candidate with an unevaluable baseline exits 3. These are CI policy defaults;
this slice adds no configurable failure mode.

`evaluation` returns 0 for any successfully verified receipt, regardless of its recorded
verdict. Missing lookup uses `evaluation_not_found`; corrupt references and receipts
retain SDK codes. Lookup failures exit 2. It invokes no callbacks, checks no current
evaluator files, and does not create storage or mutate any stored bytes.

Command failures emit no normal result. Human failures go to stderr. In JSON mode reuse
the existing `phase1-cli-error-v1` stderr envelope and error normalization; the name
identifies its schema lineage, not a ban on new commands. Do not silently change it for
existing scripts. No stacks or nested causes are emitted. Receipt errors are data in
stdout, not additional command-error documents on stderr.

JSON receipts include callback details/diagnostics and local identities; criteria are
stored as artifacts. This is local developer data, not a redacted or secret-safe report.
Failure to deliver stdout after publication does not undo a committed receipt; receipt
storage, not console output, is the durable result.

## Implementation slices and verification

1. Extend config loading with lazy evaluation loading and provenance checks. Test old
   configs, malformed settings/exports, ID/root mismatch, containment, and paths with spaces.
2. Add command-specific parsing, criteria loading, SDK delegation, formatters, and exit
   mapping. Unit-test every status combination and strict option/arity behavior.
3. Add built-process tests using the existing branch-and-join evaluation example. Cover
   passing pair, regression, both-fail/no-regression, candidate and baseline side errors,
   exact lookup, absent/corrupt receipts, and lookup with no evaluation module configured.
4. Verify source manifest bytes remain unchanged after evaluation; lookup leaves all
   storage bytes/directory entries unchanged and never calls evaluators. Missing-store
   lookup must not create directories. Verify repeated evaluation invokes checks again.
5. Exercise malformed criteria, wrong lineage, failed execution, artifact corruption,
   watched-input instability, and publication failure. Assert actual process exit status,
   stdout/stderr separation, one JSON document, and absence of a published success result.
6. Run the existing full quality gate and Windows/Ubuntu CI. Document executable examples
   only after commands exist. Commit each coherent tested slice; do not change dependencies.

## Design challenge and remaining risks

A standalone script already handles these two SDK operations. The CLI earns its place
only by reducing repeated configuration and providing a consistent CI/inspection contract.
Do not introduce a general plugin system to avoid two straightforward command handlers.

The third nonzero code is intentional: assertion failure, invalid command, and evaluator
error need different diagnostics. CI systems that only distinguish zero/nonzero still work.
Inspection intentionally does not apply CI policy to a historical receipt.

Lazy evaluation loading is the main correctness boundary. Importing callbacks during
historical lookup would make old receipts depend on changed or missing code and is
unacceptable. Existing workflow loading remains a limitation; a future archive command
would require a separate explicit root/storage contract rather than another hidden fallback.

Purity is unenforced; watched hashes cannot detect A-B-A changes or stale imported code.
Receipts are corruption-checked, not authenticated. Very large artifacts/criteria can
exhaust memory; hostile callbacks can hang because no sandbox or timeout is added.
These remain SDK limitations, not problems a CLI wrapper solves. Independent usability
and public-release ownership gates remain open.
