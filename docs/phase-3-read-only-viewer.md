# Phase 3: Read-only local workflow viewer

Status: authorized after [usability-gate closure](./independent-workflow-validation.md).
This document begins the engineering/data boundary only. No viewer implementation,
frontend stack, visual direction, or extra engine capability is selected by it.

## Purpose and scope

Explain historical workflows using verified execution manifests, their recorded
baselines, stage artifacts, and explicitly selected evaluation receipts. The viewer
must not execute stages/evaluators, import project code, alter storage, or reconstruct
historical graph topology from today's workflow module.

Initial delivery is developer-local and read-only. No live Gemini, providers, replay,
SQLite, cloud, authentication service, workflow editing, run launching, baseline
promotion, automatic cleanup, publishing, or release preparation is included.

## Source-of-truth boundary

| Information | Authoritative source |
| --- | --- |
| Historical nodes and edges | Selected manifest's stage IDs and dependency IDs |
| Recorded baseline | Selected manifest's exact `baselineRunId` and hash |
| Action, status, reason, details | Persisted stage fields, shown separately |
| Changed fingerprint categories | Recorded component-hash comparison with that baseline |
| Output contents | Exact referenced artifact, verified through the SDK |
| Evaluation and regression | Exact verified receipt selected by ID |

Use `FileRunManifestStore`, `FileArtifactStore`, `FileEvaluationReceiptStore`, and
`diffRunManifests` rather than creating a parallel history verifier. Never call
`loadWorkflowConfig`, dynamically import a workflow/evaluation module, or invoke
`prepareEvaluationPair` for historical browsing. Those code-loading/preparation paths
are unnecessary and can tie old history to current implementation files.

Current manifests do not retain all original watched filenames, typed declarations,
raw environment values, source code, or stage durations. Do not invent those fields,
parse timestamps into unsupported per-stage timings, or infer current declarations
as historical truth. A primary reason is not an exhaustive explanation: compare stored
component hashes when additional influences changed.

The manifest's original `evaluationStatus: "not_run"` must not imply that no separate
receipt exists. With no receipt selected, evaluation knowledge is unknown, not failed,
passed, or proven never evaluated. Selecting a receipt does not rewrite execution status.

## Local read service

Configure one explicit storage root and workflow ID at process startup. Resolve the
root once; the browser must never supply filesystem paths, roots, project modules,
environment settings, or shell commands. Do not infer a baseline or receipt from file
ordering. No general-purpose file-read or artifact-hash endpoint is permitted.

The eventual local service binds loopback only, checks expected Host and same-origin
requests, disables cross-origin access, and rejects state-changing methods. Static
assets are local; no CDN, external font, telemetry, or provider request is necessary.
Treat local history as potentially private; avoid logging artifact bodies or callback
diagnostics. User-owned local files and callbacks are not authenticated by hashes.

The minimal read operations to implement are:

1. List verified runs for the configured workflow with the existing bounded/deterministic
   listing semantics. Sorting is display-only and never chooses a baseline.
2. Read one exact run and its recorded baseline, validate workflow identity, and return
   their stored manifests and existing diff. Null baseline remains null.
3. Read one stage output only when the verified selected manifest references it.
   Reject absent output and corrupt artifacts; do not accept an arbitrary content hash.
4. Read one exact receipt ID, verify all SDK references, and require that its workflow
   and candidate match the selected run. Return its separately stored statuses/checks.

Receipt discovery/indexing is not a prerequisite for the first viewer: exact ID lookup
is enough. A future listing needs its own bounded integrity semantics, not a hidden
"latest evaluation" pointer.

Enforce canonical ID/option syntax, path containment including existing symlinked
ancestors, bounded listing options, and versioned errors with no stacks/nested causes.
Reject invalid/corrupt data explicitly; never display it as an empty successful history.
The read service must not create a missing store, write caches, or repair bad files.

Large artifacts require a bounded preview contract before implementation. A response
cap is not proof of bounded SDK memory allocation: existing SDK artifact loading reads
whole values. Keep that limitation explicit rather than adding an unreviewed streaming
codec or claiming support for hostile/unbounded stores.

## Presentation invariants for the later UI

These are truth constraints, not a selected visual design:

- Render dependency edges from the selected historical manifest, including joins.
- Distinguish planned/final actions from actual execution statuses.
- Distinguish reused, succeeded, failed, dependency-skipped, and fail-fast-skipped stages.
- Show the exact candidate and recorded immutable baseline identities.
- Keep execution, candidate evaluation, and regression comparison independent.
- Preserve source array order. JSON object insertion order is not presentation data;
  order-sensitive content needs explicit order arrays, as the usability adapter proved.
- Explain absent outputs, no selected receipt, corruption, unavailable storage, and
  graph changes without presenting missing evidence as success.

Selecting, fitting, navigating, and inspecting a graph are in scope; graph edits,
callback execution, and external side effects are not. Detailed interaction/visual
design and frontend technology selection remain the next design step.

## Acceptance before shipping

- Use both real user-modeled Composio history and synthetic regression history.
- Verify historical graph rendering with a deliberately changed current workflow module.
  Browsing must still work without that module or current evaluator code.
- Snapshot all store bytes/directory entries before and after every read operation.
  Missing-store reads must not create directories; no callbacks may be invoked.
- Cover explicit IDs, cross-workflow/run receipt rejection, corrupt data, path escapes,
  origin/Host restrictions, forbidden methods, and output-size handling.
- Reproduce the exercise's unchanged, watched-input, env, manual-invalidation, and
  failure cases. A user must distinguish the two skip causes and equal-output reruns.
- Add browser/keyboard/responsive verification when a frontend actually exists;
  do not claim visual or accessibility completion from this document.
- Run the existing engine/CLI quality gate unchanged, plus the viewer-specific tests.

## Remaining risks

Filesystem TOCTOU races, unsigned local history, private artifact contents, large JSON
memory use, and deliberately broad reason precedence remain existing limitations.
This viewer should make them visible, not suggest it enforces purity or grades live
research. If the first implementation requires a plugin system, database, general
filesystem API, or workflow reexecution merely to display history, simplify it first.
