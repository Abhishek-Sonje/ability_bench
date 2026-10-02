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
schema is exercised only in the local real-data run. CI for the new commits must still
be confirmed on both Windows and Ubuntu; prior engine commits passed that matrix.

Do not close the independent usability gate from self-authored tests or this report.
Do not start evaluation/provider integration or public release work until the relevant
design and ownership decisions in `phase-1-readiness.md` are resolved.
