# Phase 2 assessment

## Decision

Technical prototype: complete and stabilized for developer-local use.
Public-release and independent-usability gate: still open.

The user reported the audit as passed. This stabilization pass verified CI rather than
performing or claiming another code audit. No independent-workflow exercise details
were supplied, so the distinct usability gate is not inferred from that report.

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
The local Windows gate passed with 180 active tests and one platform-specific skip.
Both [Windows and Ubuntu CI](https://github.com/Abhishek-Sonje/ability_bench/actions/runs/37112755199)
passed for implementation commit `23ad85d2c80ee9cf15c30647b96e8bc09485fb24`. This verifies
the implementation through that commit, not later changes or additional platforms.

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

The saved Composio integration is complete: two explicit checks grade captured record
membership/uniqueness and minimum candidate count, compare completed runs against one
baseline, and retain verified receipts. The high-confidence policy yielded zero candidates
and failed the minimum-count assertion; this is not a factual-quality judgment. The source
project remained unchanged, and a retained run was inspected through the existing CLI.

The real suite repeated count/list criteria validation in two callbacks. This is still
small enough that a schema framework is unjustified. A compact console plus retained
structured receipts is adequate for this exercise. Typed criteria descriptors remain
a possible bounded SDK improvement, not a prerequisite to claim technical functionality.
CI is confirmed. Collect independent modeling feedback before deciding whether more
API surface solves a real usability problem. A minimal evaluation CLI is a possible
next bounded slice, but needs its own command/exit-status contract before code. No
CLI implementation or new feature scope is part of this stabilization pass.

Evaluation CLI commands, scores, caches, SQLite, UI, providers, cost accounting, cloud,
automatic baseline promotion, and public packaging remain deferred. Independent
workflow modeling and release ownership decisions are not closed by this assessment.
