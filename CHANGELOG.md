# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project does
not yet publish versioned releases.

## Unreleased

### Changed

- Reject storage paths and watched paths that escape the workflow root through symbolic links or junctions.
- Snapshot run inputs and declared environment values; isolate stage data from callback mutations.
- Recheck reuse before artifact load and reject noncanonical persisted JSON.
- Reject stages that watch the configured artifact storage directory.
- Record a failed run when a watched path becomes invalid after planning, rather than rejecting without a run result.
- Reject array subclasses and non-enumerable array elements at the canonical JSON boundary.

### Added

- Phase 0 execution contract.
- TypeScript project scaffold and contributor workflow.
- Immutable workflow declaration with validation, cycle detection, and deterministic topological
  ordering.
- Strict canonical JSON artifacts with deterministic SHA-256 identities and integrity-checked
  decoding.
- Canonical stage fingerprints covering dependency artifacts, selected inputs, environment state,
  and exact watched-file bytes.
- Conservative single-baseline planning with stable decision reasons, branch-local invalidation,
  and component-level change explanations.
- Sequential stage execution with explicit dependency values, verified artifact reuse, runtime
  cache-miss fallback, and separate execution and evaluation statuses.
- Immutable content-addressed run manifests with tamper detection and artifact-verified baseline
  conversion.
- Atomic local filesystem persistence for artifacts and run manifests, including collision,
  corruption, and path-traversal protection.
- Public `runWorkflow` orchestration across baseline loading, planning, execution, and persistence.
- Recheck fingerprints before reuse and isolate stage inputs and dependency outputs from mutation.
- Config-based loading for a sealed TypeScript workflow module and a built package entry point.
