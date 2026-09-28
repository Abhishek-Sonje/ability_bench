# Phase 1: Local Run CLI

## Decision

Phase 1 begins with a thin local CLI over the verified execution engine:

    abilitybench run --inputs <file>
    abilitybench plan --inputs <file>
    abilitybench inspect <run-id>
    abilitybench diff <run-a> <run-b>
    abilitybench runs

This slice does not add SQLite. Exact lookup uses immutable manifests, while the bounded local run
listing performs a simple integrity-checked filesystem scan. That scan is intentionally O(number
of stored runs). SQLite should be introduced only when measured store size or filtering and
aggregation requirements make the scan inadequate.

LLM integration, evaluations, UI, tool replay, cost tracking, implicit baseline selection, remote
caches, and cloud features remain out of scope for this slice.

## Command contract

    abilitybench run --inputs <file> [options]

Options:

- `--config <file>`: configuration path, defaulting to `./abilitybench.config.ts`.
- `--inputs <file>`: required UTF-8 JSON file containing one object.
- `--baseline <run-id>`: one explicit immutable baseline. If omitted, all stages execute.
- `--invalidate <stage>`: exact stage ID to invalidate; the option may be repeated.
- `--json`: emit the versioned machine result instead of human-readable lines.
- `--help`: print usage without loading configuration.

There is deliberately no `--latest` option. Filesystem ordering, timestamps, or mutable pointers
must not choose a baseline implicitly.

### Plan

    abilitybench plan --inputs <file> [--baseline <run-id>] [--invalidate <stage>] [--json]

Plan uses the same canonical input snapshot, declared environment snapshot, storage containment
checks, baseline integrity and artifact verification, watched-file hashing, fingerprints, and
invalidation algorithm as `run`. It does not invoke stage functions, write artifacts, or create a
run manifest. Human output explains every stage decision; JSON output uses
`phase1-cli-plan-v1` and includes summary counts and the complete `WorkflowPlan` decisions.

A plan is predictive, not a locked execution receipt. Files, environment values, artifacts, or
inputs may change after it is printed, and a later `run` computes a fresh plan. Planning validates
canonical JSON but does not invoke stage wrappers, so typed stage-input parsing and other runtime
failures can still occur during execution. A plan must never be treated as proof that a run will
succeed.

### Inspect

    abilitybench inspect <run-id> [--config <file>] [--json]

Inspection loads exactly one immutable manifest by its content-addressed run ID. The filesystem
store verifies canonical serialization, the manifest hash, and the embedded run ID before any
output is printed. The command also rejects a manifest whose workflow ID differs from the loaded
project. It does not scan, sort, or select among runs.

Human output preserves the run's recorded status and stage-by-stage decisions. JSON output wraps
the verified manifest in the versioned `phase1-cli-inspect-v1` envelope.

### Diff

    abilitybench diff <run-a> <run-b> [--config <file>] [--json]

Diff loads exactly two explicitly named manifests through the same integrity-checked store. Both
runs must belong to the configured workflow. A successful diff exits `0` whether or not changes
exist; differences are data, not command failures.

Stages are ordered as they appear in the first run, followed by stages found only in the second
run. Each stage is classified as `added`, `removed`, `changed`, or `unchanged`. For stages present
in both runs, every persisted stage field is compared with canonical JSON semantics and changed
field names use a fixed order. This intentionally reports execution-decision changes separately
from output artifact changes instead of treating equal outputs as equal run records.

JSON output uses `phase1-run-diff-v1` and includes run identities, summary counts, changed field
names, and the before/after stage records. The command performs no run discovery, implicit
selection, or mutable indexing.

### Runs

    abilitybench runs [--config <file>] [--limit <count>] [--json]

Run discovery enumerates canonical manifest filenames, verifies every discovered manifest, filters
to the configured workflow, and sorts by `createdAt` descending with run ID ascending as the stable
tie-breaker. The default limit is `20`; accepted limits are positive integers no greater than
`1000`. Machine output uses `phase1-cli-runs-v1` and reports `totalMatched` and `truncated` so
callers can distinguish a complete result from a bounded view.

The ordering is display-only. It must never be used internally to select a baseline, and the CLI
still has no `--latest` behavior. A corrupt canonical run file fails the entire listing rather than
silently disappearing. Non-run files and interrupted temporary files are ignored.

This scan is suitable for a small developer-local store, not an unbounded history service. Before
adding richer filters, pagination, or aggregate queries, the storage strategy must be reconsidered;
that is the point at which SQLite may become the simpler design.

## Output and exit status

Human output names the run, baseline, run status, and every stage's final decision, execution
status, reason code, and non-empty details.

JSON output uses `phase1-cli-result-v1` and includes the same structured decisions plus artifact
hashes and serialized errors.

- Exit `0`: execution completed.
- Exit `1`: the workflow ran but execution failed.
- Exit `2`: usage, configuration, input, baseline-loading, or other command error.

Evaluation status remains independent and is always `not_run` until an evaluation phase exists.

## Input and security boundary

The CLI rejects invalid UTF-8, invalid JSON, and non-object top-level inputs before execution.
Run inputs then pass through the same canonical JSON validation as the SDK.

Human and JSON explanations never include raw declared environment values. JSON output contains
local storage paths and artifact identities and should be treated as developer-machine metadata,
not as a secret report.

## Verification

The command tests cover:

- first execution with no baseline
- full reuse from one explicitly selected baseline
- read-only planning with and without a baseline
- proof that planning neither creates storage nor adds or mutates run manifests
- human and versioned JSON output
- non-object input rejection
- usage errors and help without project loading
- exact run inspection in human and versioned JSON formats
- missing-run and inspect-option rejection
- exact two-run diffs, graph additions/removals, and execute-to-reuse changes
- deterministic changed-field ordering and diff arity rejection
- empty and populated bounded run listings with stable ordering and truncation metadata
- invalid listing limits and command-specific option rejection
- the built executable against the six-stage release-readiness example

The release-readiness workflow was verified through a first CLI run followed by a second run that
reused all six stages from the printed baseline ID.
