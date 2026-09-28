# Phase 1: Local Run CLI

## Decision

Phase 1 begins with a thin local CLI over the verified execution engine:

    abilitybench run --inputs <file>
    abilitybench inspect <run-id>

This slice does not add SQLite. Immutable run manifests already provide correct baseline lookup,
and the CLI currently performs no cross-run search, filtering, or aggregation that justifies a
mutable index. SQLite should be introduced only when a measured query requirement appears.

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

### Inspect

    abilitybench inspect <run-id> [--config <file>] [--json]

Inspection loads exactly one immutable manifest by its content-addressed run ID. The filesystem
store verifies canonical serialization, the manifest hash, and the embedded run ID before any
output is printed. The command also rejects a manifest whose workflow ID differs from the loaded
project. It does not scan, sort, or select among runs.

Human output preserves the run's recorded status and stage-by-stage decisions. JSON output wraps
the verified manifest in the versioned `phase1-cli-inspect-v1` envelope.

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
- human and versioned JSON output
- non-object input rejection
- usage errors and help without project loading
- exact run inspection in human and versioned JSON formats
- missing-run and inspect-option rejection
- the built executable against the six-stage release-readiness example

The release-readiness workflow was verified through a first CLI run followed by a second run that
reused all six stages from the printed baseline ID.
