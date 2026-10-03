# Phase 2 implementation progress

The [evaluation contract](./phase-2-evaluation-spec.md) guides this work. Only the
declaration, pure comparison, read-only pair preparation, and the sequential evaluator
runner are implemented. Receipt publication and lookup are not implemented.
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
- `executeEvaluationPair()` prepares fresh inputs, evaluates both sides sequentially,
  and returns a deeply frozen in-memory result without writing anything.

Declaration validation reuses the execution engine's identifier, selector, revision,
and root-relative watched-file rules. Built-in descriptor provenance is checked;
arbitrary parser objects are rejected. Metadata is snapshotted and frozen. Checks
and aliases are sorted; normalized file aliases are deduplicated and sorted.
No files or run artifacts are read while sealing. Pair preparation then verifies
symlink/junction containment, rejects lexical or physical watched-storage aliases,
and hashes watched file states using the existing exact-byte rules.

Callbacks are retained privately and invoked only through the prepared runner. A
definition alone is not evidence that an artifact satisfies its typed selectors.
Pair preparation validates both manifests, direct lineage, completed execution,
target availability, and every required artifact before selecting inputs. Required
missing/wrong-type selections produce explicit `output_contract_failed` side records;
missing/corrupt source artifacts reject preparation outright.

Criteria and all selections are isolated and deeply frozen. Overlapping aliases and
equal/reused source artifacts do not introduce shared mutable references. Input options
and criteria are captured before asynchronous reads. Pair preparation computes the
suite hash and criteria artifact identity but never publishes the criteria artifact,
a receipt, or any other file.

The returned preparation is a read-only snapshot, not a locked execution token.
The runner freshly prepares and rechecks the full declared implementation boundary
before/after each side and before returning. Preparation does not prove that imported callback code matches
the current watched bytes or that files cannot change after it returns.

## Sequential runner behavior

Checks run in ID order, baseline first then candidate. Every requested evaluation
runs both valid sides even when source artifacts or fingerprints match. No evaluation
result cache exists. Missing/invalid typed selections record a side error without
invoking that side's callback. Callback exceptions/rejections and invalid result
shapes use separate codes and do not stop the other side or independent checks.

Every side records a canonical fingerprint, source artifact hash, invocation status,
boolean verdict or null, details, and serialized error. Contexts provide only declared
output aliases and frozen criteria. Criteria are cloned per invocation; no side label,
run metadata, or prior verdict is exposed.

Any changed/unreadable declared implementation input aborts the entire invocation
with `evaluation_inputs_changed`, including when an ordinary callback error also
occurred. Full-suite checking is deliberately more conservative than checking just
the current callback's files. A-B-A changes and undeclared ambient reads remain outside
this contract's detection capabilities.

The returned `EvaluationExecutionResult` is not an immutable stored receipt: it has
no receipt ID and no exact lookup API. Its criteria artifact hash is an identity only;
the criteria artifact is not published by this runner. Runtime metadata and atomic
receipt publication belong to the next slice. Existing run inspection still reports
its original `evaluationStatus: "not_run"`; evaluation does not rewrite execution.

```ts
const result = await executeEvaluationPair(suite, {
  baselineRunId: baseline.manifest.id,
  candidateRunId: candidate.manifest.id,
  criteria: { minimumCandidates: 1 },
});
console.log(result.evaluationStatus, result.comparisonStatus, result.summary);
```

Checks must explicitly validate any criterion field they use. An invocation with no
regressions can still fail absolute criteria. A passing candidate can have comparison
status `error` if the baseline could not be evaluated.

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
`tests/evaluation-execution.test.ts` covers invocation order, intentional regression,
ordinary-error continuation, strict results, frozen input isolation, no result reuse,
canonical fingerprints, watched-input instability, hostile error diagnostics, and
byte-identical storage before/after successful evaluations.

## Remaining slices

1. Immutable receipt publication and exact integrity-checked lookup.
2. Synthetic intentional-regression walkthrough and usability assessment.

Do not add a CLI, scoring framework, evaluator cache, provider adapter, database,
or UI as part of these slices. Independent usability and public-release ownership
gates remain open; implementation tests do not close them.
