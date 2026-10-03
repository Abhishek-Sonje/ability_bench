# Phase 2 implementation progress

The [evaluation contract](./phase-2-evaluation-spec.md) guides this work. Only the
declaration, pure comparison, and read-only pair preparation are implemented;
there is no evaluation runner.
Existing execution manifests, CLI commands, and baseline eligibility are unchanged.

## Available SDK surface

- `defineCheck()` declares typed artifact selections and a callback without invoking it.
- `createEvaluationSuite()` validates and seals the full independent check set.
- `validateCheckResult()` rejects malformed/non-JSON results, snapshots their values,
  and deeply freezes accepted results.
- `compareCheckVerdicts()` classifies absolute baseline/candidate verdict pairs.
- `summarizeCheckVerdicts()` aggregates counts with explicit error precedence and
  distinct candidate-evaluation and regression-comparison statuses.
- `prepareEvaluationPair()` verifies an exact baseline/candidate pair and snapshots
  criteria, implementation identity, and isolated typed artifact selections.

Declaration validation reuses the execution engine's identifier, selector, revision,
and root-relative watched-file rules. Built-in descriptor provenance is checked;
arbitrary parser objects are rejected. Metadata is snapshotted and frozen. Checks
and aliases are sorted; normalized file aliases are deduplicated and sorted.
No files or run artifacts are read while sealing. Pair preparation then verifies
symlink/junction containment, rejects lexical or physical watched-storage aliases,
and hashes watched file states using the existing exact-byte rules.

Callbacks are retained privately and cannot yet be invoked through the SDK. A
definition alone is not evidence that an artifact satisfies its typed selectors.
Pair preparation validates both manifests, direct lineage, completed execution,
target availability, and every required artifact before selecting inputs. Required
missing/wrong-type selections produce explicit `output_contract_failed` side records;
missing/corrupt source artifacts reject preparation outright.

Criteria and all selections are isolated and deeply frozen. Overlapping aliases and
equal/reused source artifacts do not introduce shared mutable references. Input options
and criteria are captured before asynchronous reads. Pair preparation computes the
suite hash and criteria artifact identity but never publishes the criteria artifact,
a receipt, or any other file. Per-check invocation fingerprints remain deferred.

The returned preparation is a read-only snapshot, not a locked execution token.
A future runner must freshly prepare and recheck watched inputs before/after callbacks
and before finalization. Preparation does not prove that imported callback code matches
the current watched bytes or that files cannot change after it returns.

## Verification

`tests/evaluation.test.ts` covers inferred field types, no callback invocation,
sorting, metadata isolation, invalid suites/descriptors/paths, strict results,
accessors/shared-reference rejection, comparison classifications, and aggregate
error precedence. The standard quality gate also runs all existing engine, CLI,
and demo regressions. CI must confirm each new commit on Windows and Ubuntu.
`tests/evaluation-pair.test.ts` additionally verifies storage-byte immutability,
direct lineage, option snapshots, criteria and implementation identity, shared-output
isolation, contract errors, corrupt manifests/artifacts, no store creation, and
symlink/junction boundaries. Evaluators are never invoked by these preparation tests.

## Remaining slices

1. Sequential evaluator runner: side errors, continuation, stable-input checks,
   canonical fingerprints, and no evaluation-result reuse.
2. Immutable receipt publication and exact integrity-checked lookup.
3. Synthetic intentional-regression walkthrough and usability assessment.

Do not add a CLI, scoring framework, evaluator cache, provider adapter, database,
or UI as part of these slices. Independent usability and public-release ownership
gates remain open; implementation tests do not close them.
