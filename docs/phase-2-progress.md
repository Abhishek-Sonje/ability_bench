# Phase 2 implementation progress

The [evaluation contract](./phase-2-evaluation-spec.md) guides this work. Only the
declaration and pure comparison slice is implemented; there is no evaluation runner.
Existing execution manifests, CLI commands, and baseline eligibility are unchanged.

## Available SDK surface

- `defineCheck()` declares typed artifact selections and a callback without invoking it.
- `createEvaluationSuite()` validates and seals the full independent check set.
- `validateCheckResult()` rejects malformed/non-JSON results, snapshots their values,
  and deeply freezes accepted results.
- `compareCheckVerdicts()` classifies absolute baseline/candidate verdict pairs.
- `summarizeCheckVerdicts()` aggregates counts with explicit error precedence and
  distinct candidate-evaluation and regression-comparison statuses.

Declaration validation reuses the execution engine's identifier, selector, revision,
and root-relative watched-file rules. Built-in descriptor provenance is checked;
arbitrary parser objects are rejected. Metadata is snapshotted and frozen. Checks
and aliases are sorted; normalized file aliases are deduplicated and sorted.
No files or run artifacts are read while sealing. Symlink containment and watched
file content validation belong to future pair preparation, not declaration.

Callbacks are retained privately and cannot yet be invoked through the SDK. A
definition is not evidence that any artifact satisfies its typed selectors; future
pair preparation must perform runtime selection and validation. This slice creates
no evaluation fingerprints or receipts and performs no storage writes.

## Verification

`tests/evaluation.test.ts` covers inferred field types, no callback invocation,
sorting, metadata isolation, invalid suites/descriptors/paths, strict results,
accessors/shared-reference rejection, comparison classifications, and aggregate
error precedence. The standard quality gate also runs all existing engine, CLI,
and demo regressions. CI must confirm each new commit on Windows and Ubuntu.

## Remaining slices

1. Read-only pair preparation: exact completed-run lineage, verified artifacts,
   isolated typed selections, criteria snapshot, and implementation identity.
2. Sequential evaluator runner: side errors, continuation, stable-input checks,
   canonical fingerprints, and no evaluation-result reuse.
3. Immutable receipt publication and exact integrity-checked lookup.
4. Synthetic intentional-regression walkthrough and usability assessment.

Do not add a CLI, scoring framework, evaluator cache, provider adapter, database,
or UI as part of these slices. Independent usability and public-release ownership
gates remain open; implementation tests do not close them.
