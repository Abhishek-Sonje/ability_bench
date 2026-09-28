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
- Fail stages whose declared fingerprint inputs change during their callback, preventing an unsafe baseline artifact.
- Validate cache-policy combinations at workflow sealing for JavaScript callers as well as TypeScript callers.
- Expand branch-and-join invalidation tests and document the remaining Phase 0 proof gates.
- Cover graph additions, removals, and dependency rewiring against an immutable baseline.
- Normalize storage setup failures and verify interrupted or failed publication cannot expose a
  temporary file as committed content.
- Reject missing watched paths whose nearest existing ancestor is not a directory, with explicit
  invalid-target and unreadable-file regression coverage.
- Define the Phase 0 Node.js, TypeScript-loader, operating-system, and filesystem support boundary.
- Add a realistic six-stage release-readiness workflow, verify branch-local reuse, and record the
  Phase 0 technical-go/product-ergonomics-hold assessment.
- Add typed stage handles and workflow composition so direct dependency outputs are inferred
  without weakening explicit DAG declaration or runtime validation.
- Add fingerprinted typed-input descriptors and grouped cache influence declarations, making
  external input contracts and cache dependencies harder to omit or scatter.

### Added

- Local `abilitybench run` command with explicit JSON inputs, explicit immutable baseline
  selection, repeated manual invalidation, human explanations, and versioned JSON output.
- Exact `abilitybench inspect <run-id>` lookup with manifest integrity verification and human or
  versioned JSON output.
- Deterministic `abilitybench diff <run-a> <run-b>` comparisons with graph-evolution support,
  canonical persisted-field comparisons, and a public pure manifest-diff API.
- Phase 1 CLI contract documenting exit statuses and the decision to defer SQLite until query
  requirements justify it.
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
