# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project does
not yet publish versioned releases.

## Unreleased

### Changed

- Show actual execution status separately from decisions in the Composio demo console,
  so failed reports and skipped delivery cannot be mistaken for successful executions;
  record maintainer walkthrough findings and verified Windows/Ubuntu CI for `9b447e9`.
- Promote Windows x64 and GitHub-hosted Ubuntu/Linux x64 to verified local-filesystem targets after
  both CI quality jobs passed, while keeping macOS provisional and network filesystems unsupported.
- Normalize `ENOENT` and `ENOTDIR` while classifying missing watched paths so regular-file
  ancestors produce the same `invalid_watch_target` result on Windows and POSIX systems.
- Record the Phase 1 readiness decision, external verification gates, release decisions, and
  explicit boundary against premature database, evaluation, provider, and UI work.
- Parse each CLI subcommand against its own option schema, reject duplicate scalar options, and
  emit versioned machine-readable error envelopes whenever `--json` is requested.
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

- Design-only Phase 2 deterministic evaluation contract: independent boolean checks,
  exact baseline lineage, immutable separate receipts, canonical identity, error semantics,
  verification matrix, and explicit rejection of premature caching/scoring/provider features.
- Synthetic process regression coverage for the Composio demo's five scenarios,
  duplicate-name records, loader failures, provenance, and read-only source behavior;
  an isolated review-output option and a concrete independent-review checklist.
- Offline Composio research demo with typed captured inputs, branch-and-join screening,
  immutable-baseline scenarios, dry-run delivery, provenance, and reviewable reports.
- Compiled CLI process tests for all five commands using an isolated branch-and-join project,
  paths containing spaces, read-only planning, and actual exit codes and output streams.
- Read-only GitHub Actions CI across current Ubuntu and Windows runners with Node 24, the
  project-pinned pnpm version, dependency caching, and frozen-lockfile enforcement.
- Local `abilitybench run` command with explicit JSON inputs, explicit immutable baseline
  selection, repeated manual invalidation, human explanations, and versioned JSON output.
- Exact `abilitybench inspect <run-id>` lookup with manifest integrity verification and human or
  versioned JSON output.
- Deterministic `abilitybench diff <run-a> <run-b>` comparisons with graph-evolution support,
  canonical persisted-field comparisons, and a public pure manifest-diff API.
- Bounded `abilitybench runs` discovery with integrity verification, deterministic ordering,
  truncation metadata, and no implicit baseline selection.
- Read-only `abilitybench plan` and `planWorkflowRun()` APIs that share run preparation and explain
  conservative decisions without executing stages or writing artifacts and manifests.
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
