# Offline demo review

## What is proven locally

The Composio example uses real captured data but an AbilityBench-authored workflow.
It is evidence for execution correctness, not independent evidence for usability.
The source checkout is only read; no live research or delivery occurs.

The initial local run validated 103 records. The baseline and unchanged candidate
selected 22. Increasing the official-evidence minimum from one to two still selected
22, but reran evidence, summary, and report conservatively. Requiring high confidence
selected zero. Manual evidence invalidation reran that branch and its descendants;
an intentional report failure skipped delivery. Every candidate used the same baseline.

These counts describe captured data, not the current capability of any service.
Schema validation does not establish factual correctness, source freshness, or
research quality. Duplicate app names remain distinct filename-identified records.

## Review exercise

1. Read `examples/composio-research/workflow.ts`. Before viewing the results, predict
   which stages should rerun after changing the policy file or the confidence setting.
2. Run `pnpm example:composio-research` with the sibling Composio checkout available.
   Open `examples/composio-research/.abilitybench/demo-results.json` locally. It is
   gitignored and contains raw research; do not publish it without reviewing its contents.
3. Compare your prediction with each outcome's `manifest.stages`. Read both
   `decisionReason` and `decisionDetails`; inspect `executionStatus` separately.
4. Confirm why summary/report rerun after evidence reruns even when their eventual
   output is unchanged, and why cache-disabled delivery does not run after report fails.
5. Name one undeclared ambient read that would make a cacheable callback unsafe
   (for example a network response or an undeclared environment variable).

Send feedback on these three points:

- Were typed inputs and explicit dependency outputs straightforward to understand?
- Could you explain every reuse/rerun and the distinction between a planned execution
  decision and a skipped execution status?
- What was confusing, unnecessarily verbose, or missing from the review output?

If this is clear, the remaining independent-workflow gate is to model a small workflow
yourself rather than merely approve this one. Feedback may justify a simpler SDK or
presentation; no new infrastructure is needed to collect it.

## Current boundary

Synthetic CI tests execute the actual demo and assert its five scenarios, provenance,
loader failures, and source immutability without external services. The real checkout's
schema is exercised only in the local real-data run. Commit `9b447e9` passed both
[Windows and Ubuntu CI](https://github.com/Abhishek-Sonje/ability_bench/actions/runs/37056652327).
Later commits require their own CI confirmation.

Do not close the independent usability gate from self-authored tests or this report.
Do not start evaluation/provider integration or public release work until the relevant
design and ownership decisions in `phase-1-readiness.md` are resolved.

## Maintainer walkthrough findings

The implementation agent completed the walkthrough against the real checkout again.
All five scenarios matched the declared influences. File changes identify
`watchedFiles`, confidence changes identify `environment`, and the intentional failure
identifies `selectedInputs` in `decisionDetails.changedComponents`. Downstream reasons
identify the direct dependency that executed. All candidates name the same baseline.

Typed input selectors and dependency handles keep the graph readable: callbacks get
their selected inputs and named dependency outputs, rather than looking up engine
state. However, input typing cannot detect ambient reads. Adding `process.env.X`, a
network call, or a helper file without declaring its influence can still violate purity.
The SDK is a contract, not a sandbox or automatic dependency tracker.

One concrete clarity issue was fixed: the console used to show an `execute` decision
for delivery without showing that delivery was skipped after report failure. It now
prints execution status first and labels decision and reason separately. The manifest
was already correct; regression coverage now protects the console distinction too.

Remaining tradeoffs do not need infrastructure changes:

- Watching the shared workflow file intentionally invalidates every stage after code
  edits. Split stage files only when real usage justifies finer-grained reuse.
- The full JSON report is verbose because it contains provenance and integrity data.
  Console summaries are the first-line view; structured details remain available.
- Screening counts evidence entries, not unique URLs, and filename identities do not
  resolve conflicting research snapshots. Those are documented demo semantics, not
  evaluation-quality guarantees.
- The demo now copies its completed local project/store to a unique retained `history-*`
  directory before temporary cleanup. The generated report names the copied config and
  store paths, enabling exact CLI run inspection and SDK evaluation receipt lookup.
  This is local history, not upstream tool replay or a portable archive.

Assessment: no execution-correctness blocker was found in this walkthrough. This is
maintainer self-review, not independent validation, and does not close that release gate.

The follow-up offline evaluation run checked record identity/uniqueness and a declared
minimum candidate count against all completed candidates. It detected the zero-candidate
high-confidence policy case and kept intentional execution failure unevaluated. It also
verified a same-pair stricter-criteria receipt with absolute failure but no new regression.
None of these checks grades source freshness, factual correctness, or actual service capability.
