# Phase 0 Verification

Phase 0 is a deterministic engine prototype, not a production-ready cache. Run the full local
quality gate with `pnpm check` (lint, typecheck, build, and tests).

## Verified behavior

- A complete branch-and-join DAG is sealed before execution, validated for missing dependencies
  and cycles, and ordered deterministically.
- Stage callbacks receive direct dependency outputs and selected external inputs explicitly.
- Canonical JSON rejects unsupported values and verifies artifact bytes, codec, length, and hash.
- Fingerprints include declared dependencies, selected inputs, environment state, watched bytes,
  implementation revision, cache policy, and codec.
- A candidate names one baseline. Missing, failed, foreign, tampered, or corrupt baseline data
  cannot silently become reusable output. Sibling candidates remain anchored to the same baseline
  without borrowing each other's artifacts.
- Manual invalidation, cache-disabled and volatile stages, branch-local changes, and late artifact
  loss conservatively rerun descendants. An equal output hash does not stop propagation.
- Added and rewired stages execute against an older baseline; removed stages do not enter the new
  plan.
- Execution failure is recorded separately from evaluation status. Declared inputs changing
  during a callback fail the run before its output artifact is published.
- Local artifacts and run manifests are content-addressed and immutable. The loader supports one
  explicitly configured TypeScript workflow.

## Remaining proof work

- Exercise unreadable watched files and interrupted persistence on supported platforms. The
  existing tests cover escaped paths, junctions, missing files, corruption, and tampering.
- Validate the SDK on a realistic small developer workflow and measure declaration burden. The
  contract's usability and purity-understanding go/no-go gates cannot be proven by unit tests.
- Document the supported runtime/platform matrix beyond the current Node.js 24 development
  environment before publishing a package.

## Safety boundary

AbilityBench cannot discover undeclared imports, clock reads, network calls, or other ambient
influences. Pre/post fingerprint checks detect ordinary changes during execution, not an A-B-A
change that restores identical bytes between checks. Cacheable stages still require exhaustive
declarations and stable watched inputs; use `cache: false` or `volatile: true` when that is not
credible.
