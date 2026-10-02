# Phase 1 Readiness

## Decision

The local execution product is ready for external validation, but it is not yet ready for a public
release.

The deterministic engine and local CLI now cover declaration, planning, execution, immutable run
inspection, exact run comparison, and bounded run discovery. GitHub-hosted Ubuntu and Windows
verification is green. The remaining product gate requires feedback from a workflow not designed
by the implementation author.

## Completed gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Full DAG declaration and validation | Pass | Cycle, missing-dependency, branch, join, and deterministic-order tests |
| Explicit typed dependencies and inputs | Pass | Compile-time dependency inference and runtime input-contract tests |
| Conservative planning and execution | Pass | Fingerprint, invalidation, artifact-loss, graph-evolution, and lineage tests |
| Read-only planning | Pass | SDK and CLI tests prove no stage invocation or storage mutation |
| Immutable local history | Pass | Canonical manifests, exact inspection, deterministic diff, and bounded listing |
| Human explanations | Pass locally | Every plan and run decision includes a stable reason and structured details |
| Machine interface | Pass locally | Versioned success and error documents with stable exit statuses |
| Windows quality gate | Pass | Local checks, built-binary smoke tests, and GitHub-hosted CI |
| Linux quality gate | Pass | GitHub-hosted Ubuntu CI, including the POSIX permission regression |
| Independent workflow ergonomics | Pending external verification | Current examples and fixtures were authored with the engine |

## External verification required

The [offline demo review](./demo-review.md) records the real captured-data exercise
and gives a short feedback checklist. Synthetic process tests now cover that demo's
branch-and-join scenarios without the external checkout. Neither replaces the
independent workflow exercise below. Confirm CI for these new commits before treating
their Windows/Ubuntu coverage as verified. Commit `9b447e9` has now passed both jobs;
the walkthrough and presentation finding are recorded in the review document.

### 1. Independent workflow exercise

Have a developer who did not implement the engine model one small real workflow containing:

- at least one branch and one join
- one selected external input
- one declared environment variable
- one watched file
- one cache-disabled or volatile stage
- one intentionally failed stage

They should perform a first run, an unchanged plan, a branch-local change, a manual invalidation,
an exact inspection, and a two-run diff. Record where declarations or explanations were confusing.

The exercise passes only if the developer can explain every reused and executed stage and can name
the ambient reads that would make a cacheable stage unsafe.

### 2. Filesystem publication environment

Run the immutable-publication tests on each filesystem intended for support. The current protocol
depends on same-filesystem hard links. Network shares, synchronized folders, and unusual mounted
filesystems are not supported merely because local NTFS and the GitHub Linux filesystem pass.

## Release decisions still needed

These are product or ownership decisions and should not be guessed in code:

- public package name and whether the package should remain private
- license and copyright ownership
- initial semantic version and compatibility promise
- supported operating systems and filesystems after matrix results
- whether a public release needs macOS coverage

Until those decisions are made, `version: 0.0.0` and `private: true` remain intentional.

## Explicitly deferred

SQLite remains unnecessary for the current small local history; `runs` is an O(number of runs)
integrity-checked scan with bounded output. Reconsider indexing when real histories show a problem
or when filtering and aggregation are specified.

Evaluations, LLM providers, UI, tool replay, cost tracking, remote caches, cloud features, automatic
baseline selection, and destructive cleanup remain outside this milestone. The evaluation model
must be specified before implementation so evaluation status does not leak into execution status.
The [Phase 2 evaluation proposal](./phase-2-evaluation-spec.md) now specifies that
future boundary; it is design-only and does not change the active implementation scope.

## Phase 1 exit rule

Phase 1 may be closed after the independent workflow exercise is recorded with no correctness
blocker. Ergonomic findings may become scoped follow-up work; unsafe reuse, unexplained decisions,
or filesystem-integrity failures are release blockers.
