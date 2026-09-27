# Phase 0 Verification

Phase 0 is a deterministic engine prototype, not a production-ready cache. Run the full local
quality gate with `pnpm check` (lint, typecheck, build, and tests).

## Verified behavior

- A complete branch-and-join DAG is sealed before execution, validated for missing dependencies
  and cycles, and ordered deterministically.
- Stage callbacks receive direct dependency outputs and selected external inputs explicitly.
- Typed stages infer direct dependency outputs, validate selected inputs with fingerprinted
  built-in contracts, and group revision, watched files, and environment names in one cache
  declaration.
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
- Watched directories, escaped junctions, and missing paths beneath non-directory ancestors are
  rejected. Permission-denied reads have a POSIX-specific regression.
- Execution failure is recorded separately from evaluation status. Declared inputs changing
  during a callback fail the run before its output artifact is published.
- Local artifacts and run manifests are content-addressed and immutable. The loader supports one
  explicitly configured TypeScript workflow.
- Failed immutable publication cleans its temporary file. Temporary files left by a terminated
  process are ignored and cannot be loaded as committed objects.

## Remaining proof work

- Run the conformance suite on Linux and macOS before promoting those provisional platforms to
  supported release targets.
- Validate purity understanding and declaration ergonomics with a developer unfamiliar with the
  implementation.

The local SDK exercise and declaration-burden assessment are recorded in
[Phase 0 Assessment](./phase-0-assessment.md).

## Safety boundary

AbilityBench cannot discover undeclared imports, clock reads, network calls, or other ambient
influences. Pre/post fingerprint checks detect ordinary changes during execution, not an A-B-A
change that restores identical bytes between checks. Cacheable stages still require exhaustive
declarations and stable watched inputs; use `cache: false` or `volatile: true` when that is not
credible.
