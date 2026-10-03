# Phase 2 assessment

## Decision

Technical prototype: go for another small offline integration.
Public-release and independent-usability gate: still open.

The deterministic evaluator can now compare one immutable baseline and its direct
candidate, distinguish absolute failure from regression, preserve error diagnostics,
and publish a separately verified receipt without changing execution history.
The implementation author completed the synthetic walkthrough; this is maintainer
self-review, not independent developer validation.

## Evidence

The [runnable example](../examples/evaluation-regression/README.md) combines a four-stage
branch-and-join workflow with two independent checks. Its process test launches the
actual built-SDK demo in a temporary project with spaces in its path. The walkthrough
verifies unchanged reuse, one branch-local regression, a same-pair stricter-criteria
comparison, receipt lookup, and unchanged execution manifests.

All SDK example TypeScript files now participate in the repository type-check gate.
Existing engine, CLI, storage, captured-data demo, and evaluation tests run together.
The local gate passed with 178 active tests and one platform-specific skip. Windows
and Ubuntu CI must confirm this commit before its matrix coverage is claimed.

## Usability findings

- Typed selectors make the artifact boundary explicit and avoid casting a general
  workflow-output registry. Errors identify missing/type-mismatched selected outputs.
- Separating execution, candidate verdict, and pair comparison makes the three demo
  cases understandable. Human output must show all three instead of a single "success".
- Criteria remain broad JSON and require runtime validation inside each callback.
  This is workable for two numeric thresholds but becomes repetitive for larger suites.
  Do not add a custom schema/parser framework now; revisit built-in typed criteria
  descriptors if the captured-data integration demonstrates a concrete repeated need.
- Check declarations still require six influence/identity categories. Required watched
  files and revision metadata are visible but not proof of exhaustive dependency capture.
- Strict boolean checks are enough for a policy regression. Numeric metrics, confidence
  intervals, weights, and live judges would substantially complicate the contract.
- Retained history makes SDK receipt lookup and CLI execution inspection reproducible.
  The receipt is intentionally verbose; the console provides the first-line summary.

## Challenge the current idea

For a single assertion, an ordinary test over a decoded artifact is still simpler.
The added machinery earns its place only when repeatable, versioned two-run comparison
and immutable diagnostics reduce actual developer effort. The synthetic walkthrough
proves mechanics, not that users need this product.

A nonempty/minimum-count assertion is not a quality evaluator. On real research,
reducing a candidate list can be an improvement. Misleading criteria are a product
risk even when the engine implements them perfectly. The next example must make its
policy purpose explicit and must not claim to grade factual accuracy or live services.

Purity, stale imported code, A-B-A file changes, large JSON memory use, private criteria,
and unsigned local storage remain documented limitations. No correctness blocker was
found in the exercised paths; that is not a guarantee for arbitrary callbacks/filesystems.

## Next bounded work

Apply a small deterministic suite to the saved Composio research screening outputs,
without live providers or changes to the source project. Keep one explicit baseline,
show policy changes separately from execution changes, and retain enough history for
verified receipt lookup. Assess whether typed criteria or a compact receipt presentation
is actually needed before proposing either.

Evaluation CLI commands, scores, caches, SQLite, UI, providers, cost accounting, cloud,
automatic baseline promotion, and public packaging remain deferred. Independent
workflow modeling and release ownership decisions are not closed by this assessment.
