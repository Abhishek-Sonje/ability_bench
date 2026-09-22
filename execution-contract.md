# AbilityBench Phase 0 Execution Contract

Status: proposed technical specification. This document defines behavior only; it does not authorize or prescribe implementation yet.

## 1. Phase 0 Objective

Phase 0 proves that AbilityBench can make deterministic, explainable, conservative reuse decisions over a fully declared directed acyclic graph (DAG).

It includes only:

- complete workflow declaration before execution
- graph validation and deterministic topological planning
- explicit dependency outputs
- cacheable and non-cacheable stages
- watched-file hashing
- canonical fingerprints
- strict artifact serialization
- one immutable baseline per candidate run
- conservative reuse and rerun decisions
- a machine-readable and human-readable explanation for every decision

It explicitly excludes:

- LLM or model-provider integration
- SQLite or any database
- web UI
- tool recording or replay
- token, cost, or savings accounting
- cloud, CI, remote caches, or distributed execution
- import-graph discovery
- output-equality propagation
- custom artifact codecs
- concurrent stage execution
- evaluation execution

Phase 0 may use a local filesystem object store and immutable JSON run manifests because artifact persistence and baseline replay are part of the engine proof. This is not the final storage architecture.

## 2. Core Safety Boundary

AbilityBench cannot discover every influence on arbitrary JavaScript or TypeScript code. Safe reuse therefore depends on an explicit developer contract.

A stage is reusable only if all of the following are true:

1. It is declared cacheable.
2. Its function behaves as a pure transformation of its declared dependency outputs, selected run inputs, declared environment variables, and watched-file contents.
3. It reads no undeclared mutable state.
4. It performs no required side effects.
5. Its complete implementation boundary is represented by its required `implementation` revision and watched files.
6. Its output conforms to the Phase 0 artifact format.

AbilityBench verifies fingerprints and declarations; it cannot verify purity. An incorrect dependency declaration can cause false reuse. This limitation must be visible in documentation and must never be described as automatic correctness.

When these requirements cannot be met, the stage must use `cache: false` or `volatile: true`.

## 3. Revised Execution Model

Execution has five separate steps.

### 3.1 Declare

The workflow module constructs a definition containing every stage. Calling `stage` only registers metadata and a function. It never executes user code.

Stage IDs are unique within a workflow. Dependency IDs must refer to stages in the same definition.

### 3.2 Seal and validate

`defineWorkflow(...).build()` seals the definition. No stage can be added after sealing.

Validation occurs before fingerprinting or stage execution:

- workflow and stage IDs use the supported identifier syntax
- stage IDs are unique
- every dependency exists
- a stage cannot depend on itself
- the graph contains no cycle
- input selectors are valid
- environment names are unique within a stage
- watched paths are normalized and remain inside the workflow root
- cacheable stages declare a non-empty implementation revision and at least one watched source file
- outputs use the supported codec

Any validation error aborts the run before a stage function is called.

### 3.3 Plan

The engine produces a deterministic topological order. When two stages are simultaneously ready, their stage IDs are compared by ascending Unicode code-point order. This makes plans stable across runs and machines.

For every stage, the planner records exactly one decision:

- `reuse`
- `execute`

It also records one primary reason and zero or more supporting details. Planning is performed against exactly one immutable baseline run or against no baseline.

### 3.4 Execute

Stages execute sequentially in Phase 0 according to the stored plan. A reused stage loads and validates its baseline artifact. An executed stage receives only its declared inputs through the stage context.

If a reusable artifact is missing, corrupt, undecodable, or has a hash mismatch at execution time, the engine changes that stage's decision to `execute` with reason `baseline_artifact_unavailable`. Because the Phase 0 rule is "an executed dependency invalidates its dependents," all not-yet-run descendants are replanned to execute before execution continues.

If a stage fails, its descendants become `skipped_dependency_failed`. With the only Phase 0 failure mode, `stop`, any other not-yet-started stage becomes `skipped_run_stopped`. A failed run cannot become a baseline. Continuing independent branches after a failure is deferred.

### 3.5 Finalize

Run and stage records are written as a new immutable run manifest. Existing manifests are never edited. A completed candidate can be selected explicitly as the baseline of a later run.

## 4. Public SDK Shape

This is the contract shape, not final TypeScript syntax. Type inference quality must be validated before implementation.

```ts
import { defineWorkflow, runWorkflow } from "abilitybench";

const workflow = defineWorkflow({
  id: "branching-example",
  root: import.meta.dirname,
  inputSchema: {
    dataset: "json",
    region: "json"
  }
})
  .stage({
    id: "seed",
    dependsOn: [],
    implementation: "seed-v1",
    watch: ["./workflow.ts", "./seed.ts"],
    inputs: ["/dataset"],
    env: [],
    cache: true,
    run: async ({ dependencies, inputs }) => {
      return createSeed(inputs["/dataset"]);
    }
  })
  .stage({
    id: "left",
    dependsOn: ["seed"],
    implementation: "left-v1",
    watch: ["./workflow.ts", "./left.ts"],
    inputs: ["/region"],
    env: ["LEFT_RULESET"],
    cache: true,
    run: async ({ dependencies, inputs, env }) => {
      return runLeft(dependencies.seed, inputs["/region"], env.LEFT_RULESET);
    }
  })
  .stage({
    id: "right",
    dependsOn: ["seed"],
    implementation: "right-v1",
    watch: ["./workflow.ts", "./right.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: async ({ dependencies }) => runRight(dependencies.seed)
  })
  .stage({
    id: "join",
    dependsOn: ["left", "right"],
    implementation: "join-v1",
    watch: ["./workflow.ts", "./join.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: async ({ dependencies }) => {
      return combine(dependencies.left, dependencies.right);
    }
  })
  .build();

const result = await runWorkflow(workflow, {
  inputs: { dataset, region: "in" },
  baseline: { runId: "run_001" }, // or null for a full first run
  invalidate: [],
  failureMode: "stop" // the only Phase 0 mode
});
```

Required behavioral properties:

- The workflow is fully declared and sealed before `runWorkflow` starts.
- `run` receives a `dependencies` object containing exactly the declared direct dependencies, keyed by stage ID.
- A stage does not receive a general workflow-result registry.
- `inputs` contains only values selected by the stage's JSON Pointer selectors. Phase 0 keys each
  value by its exact pointer, such as `inputs["/dataset"]`; a missing selection is omitted. This
  avoids collisions between nested selectors. Named input aliases are deferred.
- `env` contains only names declared by the stage.
- No ambient AbilityBench API exposes undeclared stage outputs.
- A stage may still access ambient Node.js state directly, but doing so violates the cacheability contract unless the stage is non-cacheable.

### 4.1 Cache policy

```ts
type StageCachePolicy =
  | { cache: true; volatile?: false }
  | { cache: false; volatile?: false }
  | { cache?: false; volatile: true };
```

- `cache: true`: eligible for reuse if every reuse rule passes.
- `cache: false`: always executes because caching is disabled by policy. Its output is still serialized so downstream stages and the run manifest have a stable artifact.
- `volatile: true`: always executes because the result is known to vary for reasons that cannot or should not be fingerprinted, such as time or randomness. It implies `cache: false` and has a distinct explanation.
- Declaring both `cache: true` and `volatile: true` is invalid.
- An executed non-cacheable or volatile stage forces every descendant to execute in Phase 0.

`cache: false` is a policy choice. `volatile: true` is a semantic warning. They intentionally produce the same invalidation behavior but different diagnostic reasons.

## 5. Workflow Loading and Configuration

Phase 0 has one explicit configuration file at the project root:

```ts
// abilitybench.config.ts
export default {
  workflow: "./workflow.ts",
  storageDir: ".abilitybench"
};
```

Conventions:

- The configuration file path is supplied explicitly to the programmatic runner or defaults to `./abilitybench.config.ts` from the current working directory.
- The workflow path is resolved relative to the configuration file.
- The workflow module must have one default export containing a built, sealed workflow definition.
- Merely importing the module must not execute a run.
- `root` defaults to the directory containing the configuration file and is resolved to an absolute, normalized path.
- Watched files and the storage directory resolve relative to `root`.
- Watched paths may not escape `root`, including through `..` or resolved symbolic links.
- Phase 0 supports exactly one workflow per configuration file. Multi-workflow discovery is deferred.
- Loader/transpiler choice and supported Node.js version must be fixed before implementation; they are not allowed to silently alter fingerprint semantics.

The programmatic API is the normative Phase 0 interface. A polished CLI is not required. A minimal test harness may load this convention to prove module loading.

## 6. Internal Data Model

Dates in persisted manifests are ISO 8601 UTC strings. IDs and enums shown below are conceptual.

```ts
type WorkflowDefinition = {
  id: string;
  root: string;
  contractVersion: "phase0-v1";
  stages: StageDefinition[];
};

type StageDefinition = {
  id: string;
  dependencyIds: string[];
  implementation: string;
  watchedPaths: string[];
  inputPointers: string[];
  environmentNames: string[];
  cachePolicy: "cacheable" | "disabled" | "volatile";
  outputCodec: "canonical-json-v1";
  run: StageFunction; // never persisted
};

type RunManifest = {
  schemaVersion: "phase0-run-v1";
  id: string;
  workflowId: string;
  baselineRunId: string | null;
  baselineManifestHash: string | null;
  createdAt: string;
  completedAt: string | null;
  executionStatus:
    | "planned"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  evaluationStatus: "not_run" | "passed" | "failed" | "error";
  stages: StageRunRecord[];
};

type StageRunRecord = {
  stageId: string;
  dependencyIds: string[];
  fingerprint: string;
  plannedDecision: "reuse" | "execute";
  finalDecision: "reuse" | "execute";
  decisionReason: DecisionReason;
  decisionDetails: Record<string, JsonValue>;
  executionStatus:
    | "pending"
    | "reused"
    | "succeeded"
    | "failed"
    | "skipped_dependency_failed"
    | "skipped_run_stopped";
  evaluationStatus: "not_run" | "passed" | "failed" | "error";
  outputArtifactHash: string | null;
  error: SerializedError | null;
};

type ArtifactEnvelope = {
  schemaVersion: "phase0-artifact-v1";
  codec: "canonical-json-v1";
  contentHash: string;
  byteLength: number;
  payload: Uint8Array;
};
```

Evaluation fields exist only to prevent execution success from being conflated with quality. Phase 0 always writes `not_run` and contains no evaluation engine.

## 7. Deterministic Inputs and Canonical Serialization

### 7.1 Supported values

Phase 0 supports only strict JSON values:

```ts
type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };
```

Objects must be plain objects with `Object.prototype` or a null prototype. Numbers must be finite. Object keys and string values must contain valid Unicode scalar values.

The following are rejected rather than coerced:

- `undefined`, functions, symbols
- `NaN`, positive infinity, negative infinity, and negative zero
- `bigint`
- `Date`, `Map`, `Set`, `RegExp`, errors, class instances, and custom prototypes
- buffers, typed arrays, array buffers, streams, and blobs
- sparse arrays
- cyclic or shared-reference object graphs
- getters, setters, and symbol-keyed properties

Rejecting these types avoids silent semantic changes after reuse. Rich and custom codecs are explicitly deferred.

### 7.2 Canonical JSON codec

`canonical-json-v1` validates the value and emits canonical UTF-8 JSON bytes using RFC 8785 JSON Canonicalization Scheme semantics, with the stricter Phase 0 rejection rules above. Object keys are ordered by the RFC's required ordering; array order is preserved; no insignificant whitespace is emitted.

The same codec is used for:

- selected run inputs
- fingerprint manifests
- stage outputs
- persisted run manifests, excluding fields explicitly identified as non-fingerprint metadata

The artifact content hash is:

```text
SHA-256("abilitybench/artifact/v1\0" || canonicalOutputBytes)
```

An artifact is decoded only after its bytes, length, codec, and hash have been verified.

### 7.3 Watched files

For each watched path, the fingerprint manifest contains:

- normalized root-relative path using `/` separators
- state: `file`, `missing`, or `invalid`
- SHA-256 of the exact file bytes when state is `file`

Directories and globs are not supported in Phase 0. Paths are deduplicated and sorted. A missing watched file is fingerprintable and therefore changes the fingerprint relative to an existing file. An unreadable file, directory, escaped path, or unsupported symbolic-link target aborts planning; it does not silently force reuse or execution.

The storage directory must not be watchable.

### 7.4 External run inputs

The run accepts one strict JSON input object. Each stage declares JSON Pointer selectors. The stage fingerprint includes a canonical object mapping each declared pointer to either:

- `{ "state": "present", "value": ... }`
- `{ "state": "missing" }`

Pointers are deduplicated and sorted. Selecting a parent and its child is allowed but discouraged because it duplicates fingerprint material. The complete selected values are passed to the function through `inputs`, keyed by their exact JSON Pointer. Missing selections are omitted.

An undeclared run input does not affect that stage. Reading it through another channel violates the cacheability contract.

### 7.5 Environment variables

Each stage declares environment variable names. Its fingerprint contains, for each sorted name:

- `{ "state": "present", "valueHash": SHA-256(UTF8(value)) }`
- `{ "state": "missing" }`

Raw values are passed to the function but are never written to the run manifest or explanation. Empty and missing values are distinct.

This prevents accidental plaintext persistence but is not strong protection for low-entropy secrets; hashes may be guessable. Phase 0 documentation must advise against treating the local manifest as a secret vault. A keyed secret-fingerprint design is deferred.

## 8. Fingerprint Formula

For stage `S`, construct this manifest after all dependency output artifact hashes are known:

```json
{
  "domain": "abilitybench/stage-fingerprint/v1",
  "contractVersion": "phase0-v1",
  "workflowId": "branching-example",
  "stageId": "join",
  "implementation": "join-v1",
  "cachePolicy": "cacheable",
  "outputCodec": "canonical-json-v1",
  "dependencies": [
    { "stageId": "left", "artifactHash": "..." },
    { "stageId": "right", "artifactHash": "..." }
  ],
  "selectedInputs": {},
  "environment": [],
  "watchedFiles": []
}
```

Arrays are sorted by stage ID, JSON Pointer, environment name, or normalized path as appropriate. The fingerprint is:

```text
SHA-256(canonical-json-v1(fingerprintManifest))
```

Timestamps, run IDs, absolute root paths, baseline IDs, machine names, and artifact storage paths are excluded.

The `implementation` string is a required developer-controlled revision, not a substitute for watched files. Cacheable stages must watch the module containing their stage function plus every local source, configuration, prompt, or data file that can change its output. The engine does not claim to prove that this list is exhaustive.

Including dependency artifact hashes makes the fingerprint describe the actual baseline snapshot consumed by the stage. Phase 0 nevertheless uses the stricter invalidation rule that any executed dependency forces execution; equal output hashes do not stop propagation.

The planner computes fingerprints immediately only for stages whose dependencies will be reused and therefore already have known artifact hashes. A stage already marked for execution because a dependency will execute does not need a fingerprint to make that decision. Its final fingerprint is computed after its dependencies finish and is recorded for use by a future candidate. Thus every completed stage has a fingerprint, but fingerprint computation is not a prerequisite for every planning decision.

## 9. Baseline Lineage Rules

1. A run specifies exactly one `baselineRunId` or `null`.
2. There is no implicit "latest" baseline in the normative Phase 0 API. This prevents directory timing or run ordering from changing behavior.
3. A run ID is content-addressed: it is derived from the SHA-256 hash of the canonical finalized manifest body, before adding its display `id` field. The expected hash is encoded in the run ID and the manifest filename. This avoids relying on a mutable run-ID index and makes replacement under the same ID detectable.
4. The baseline manifest must exist, match the hash encoded in its run ID, belong to the same workflow ID, and have `executionStatus: "completed"`.
5. Runs with `failed` or `cancelled` execution status cannot be baselines.
6. Evaluation status does not affect baseline eligibility in Phase 0 because no evaluations run.
7. Every reused artifact in a candidate must come directly from that one baseline manifest. The planner may not search older runs for a matching stage.
8. A baseline may itself contain reused artifacts. This is acceptable because its immutable manifest records their artifact hashes, but the candidate still cites only its direct baseline and that baseline manifest hash.
9. The candidate stores both the baseline run ID and the verified baseline manifest hash. Replacing a manifest under the same ID is detected.
10. The candidate never mutates the baseline or its artifacts.
11. A completed candidate is a new immutable snapshot and may be explicitly selected as a later baseline.
12. With `baseline: null`, every stage executes with reason `no_baseline`.

Because a manifest changes while a run is in progress, active runs use a separate temporary execution ID and manifest. Only a successfully finalized manifest receives a content-addressed run ID and becomes baseline-eligible. Failed and cancelled run records may be retained under non-baseline diagnostic IDs.

This creates a linear parent link per run while permitting a history tree when several candidates use the same baseline.

## 10. Conservative Invalidation Algorithm

### 10.1 Decision reasons

Phase 0 uses stable reason codes:

- `no_baseline`
- `manual_invalidation`
- `volatile_stage`
- `cache_disabled`
- `stage_missing_from_baseline`
- `baseline_stage_not_reusable`
- `dependency_executed`
- `fingerprint_changed`
- `fingerprint_match`
- `baseline_artifact_unavailable`

For `fingerprint_changed`, details list changed fingerprint components when the baseline stored component digests are available, such as `watchedFiles`, `selectedInputs`, `environment`, `implementation`, `dependencyArtifacts`, `cachePolicy`, or `codec`. Explanations never expose raw environment values.

### 10.2 Planning algorithm

Process stages in deterministic topological order:

1. If there is no baseline, execute with `no_baseline`.
2. If the stage itself was targeted by manual invalidation, execute with `manual_invalidation`. Its descendants are handled later by the dependency rule.
3. If `volatile: true`, execute with `volatile_stage`.
4. If `cache: false`, execute with `cache_disabled`.
5. If any direct dependency is planned to execute, execute with `dependency_executed`.
6. If the baseline has no record for this stage, execute with `stage_missing_from_baseline`.
7. If the baseline stage did not finish as `reused` or `succeeded`, or has no output artifact, execute with `baseline_stage_not_reusable`.
8. Compute the current fingerprint using the dependency artifact hashes that the candidate will consume.
9. If the current fingerprint differs from the baseline stage fingerprint, execute with `fingerprint_changed`.
10. Verify that the baseline artifact envelope is present and structurally valid during planning where practical. If unavailable, execute with `baseline_artifact_unavailable`.
11. Otherwise reuse with `fingerprint_match`.

The ordering above defines the primary reason. Supporting details may mention additional causes but must not change the decision.

### 10.3 Manual invalidation

`invalidate` is a list of exact stage IDs. Unknown IDs are validation errors. Each selected stage executes regardless of fingerprint, and all descendants execute through the normal dependency rule. Ancestors and unrelated branches remain eligible for reuse.

Phase 0 does not support glob patterns, tags, date-based invalidation, or "invalidate but allow equal-output propagation."

### 10.4 Changed graph behavior

- Added stage: it is absent from the baseline and executes; its descendants execute.
- Removed stage: it is absent from the current plan and remains only in historical metadata.
- Renamed stage: equivalent to removing one stage and adding another.
- Changed dependency list: dependency IDs are represented in the fingerprint inputs; the stage executes. Its descendants execute.
- Reordered dependency declarations: no semantic change because dependency entries are sorted.

### 10.5 Why equal outputs do not stop invalidation

If a stage executes for any reason, all descendants execute even if its resulting artifact hash equals the baseline artifact hash. This is intentionally more conservative and keeps planning possible before execution. Output-equality propagation is a later optimization requiring a dynamic plan.

## 11. Explanations

Every stage record must answer:

- Was it reused or executed?
- What was the primary stable reason code?
- Which baseline stage, if any, was compared?
- Which fingerprint components differed, without exposing secrets?
- Which dependency forced execution, if applicable?

Examples:

```text
left: EXECUTE
reason: fingerprint_changed
changed: watchedFiles[./left.ts]
baseline: run_001/left
```

```text
join: EXECUTE
reason: dependency_executed
dependencies: left
```

```text
right: REUSE
reason: fingerprint_match
baseline: run_001/right
artifact: sha256:...
```

Explanations are derived from stored structured data. Human-readable strings are presentation, not the source of truth.

## 12. Execution and Evaluation Status

Execution status answers whether computation completed:

- run: `planned`, `running`, `completed`, `failed`, `cancelled`
- stage: `pending`, `reused`, `succeeded`, `failed`, `skipped_dependency_failed`, `skipped_run_stopped`

Evaluation status answers whether outputs met quality assertions:

- `not_run`, `passed`, `failed`, `error`

These fields are independent. A run can complete execution and fail evaluation in a later phase. A runtime exception is never represented as an evaluation failure. Phase 0 always uses `not_run` for evaluation status.

## 13. Phase 0 Test Graph

The primary graph must include both branching and joining:

```text
             left ───┐
            /         │
seed ──────            ├── join ── report
            \         │
             right ───┘

independent
```

`seed -> left`, `seed -> right`, `left + right -> join`, and `join -> report`. `independent` has no dependencies and verifies that unrelated work remains reusable.

At least one test fixture should make `right` non-cacheable or volatile to verify branch-local execution and downstream invalidation without invalidating `left` or `independent`.

## 14. Phase 0 Test Matrix

### Graph declaration and validation

| Case | Expected result |
|---|---|
| Full branch-and-join graph | Stable topological plan; `left` and `right` tie-break by stage ID |
| Duplicate stage ID | Validation failure before execution |
| Missing dependency | Validation failure before execution |
| Self-dependency | Validation failure before execution |
| Direct cycle | Validation failure before execution |
| Multi-node cycle through a join | Validation failure with cycle path before execution |
| Stage registration after `build()` | Rejected |

### First run and baseline

| Case | Expected result |
|---|---|
| No baseline | Every stage executes with `no_baseline` |
| Unknown baseline ID | Run rejected before execution |
| Failed baseline | Run rejected before execution |
| Baseline from another workflow | Run rejected before execution |
| Baseline manifest changed under same ID | Hash mismatch; run rejected |
| Two candidates use one baseline | Both cite the same immutable baseline and never share artifacts from each other |

### Reuse and invalidation

| Case | Expected result |
|---|---|
| Nothing changed | Every cacheable stage reuses |
| `left` watched file changes | `left`, `join`, and `report` execute; `seed`, `right`, and `independent` reuse |
| `seed` watched file changes | `seed`, both branches, `join`, and `report` execute; `independent` reuses |
| `right` selected input changes | `right`, `join`, and `report` execute only |
| Undeclared input changes | No fingerprint change; test documents developer-contract boundary |
| Declared env value changes | Owning stage and descendants execute; value is absent from manifest |
| Env changes from missing to empty | Owning stage and descendants execute |
| Implementation revision changes | Owning stage and descendants execute |
| Dependency list changes | Owning stage and descendants execute |
| Manual invalidation of `left` | `left`, `join`, and `report` execute |
| Manual invalidation names unknown stage | Validation failure |
| `right` has `cache: false` | `right`, `join`, and `report` always execute; other branch may reuse |
| `right` is volatile | Same propagation with `volatile_stage` reason |
| Executed stage produces same output hash | Descendants still execute |
| Stage added | New stage and its descendants execute |
| Stage removed | Current graph ignores it; baseline remains immutable |

### Files and fingerprints

| Case | Expected result |
|---|---|
| Watched file bytes unchanged | Same component digest |
| Watched file content changes with same timestamp | Fingerprint changes |
| Watched file path order changes | Fingerprint remains equal |
| Watched file becomes missing | Fingerprint changes |
| Watched file is unreadable or outside root | Planning fails safely |
| Attempt to watch storage directory | Validation failure |
| Absolute roots differ but relative files and bytes match | Fingerprint remains equal |
| Input object key insertion order differs | Fingerprint remains equal |
| Dependency declaration order differs | Fingerprint remains equal |

### Serialization and artifacts

| Case | Expected result |
|---|---|
| Plain nested JSON output | Canonical artifact written and decoded |
| Object key order differs | Same canonical bytes and hash |
| `undefined`, `Date`, `BigInt`, `NaN`, sparse array, cycle, or class instance | Stage fails serialization; run fails |
| Negative zero | Rejected rather than normalized silently |
| Artifact bytes corrupted | Stage executes with `baseline_artifact_unavailable`; descendants execute |
| Artifact missing | Same conservative fallback |
| Codec or contract version changes | Fingerprint changes or old manifest is rejected explicitly |

### Status and explanations

| Case | Expected result |
|---|---|
| Stage throws | Stage `failed`; descendants are `skipped_dependency_failed`; other remaining stages are `skipped_run_stopped`; run `failed`; evaluation remains `not_run` |
| Successful run | Run `completed`; evaluation remains `not_run` |
| Every reuse/rerun case | Stable reason code and sufficient non-secret details |
| Dependency forces a join rerun | Explanation names the executing dependency or dependencies |

## 15. Remaining Risks and Design Challenges

### 15.1 The purity contract is enforceable only socially

This is the largest unresolved risk. Explicit declarations make behavior understandable, but a developer can forget an imported file, filesystem read, clock access, random source, network request, or global mutation. The engine will then reuse unsafely without knowing it is uncertain.

Mitigation for Phase 0 is honesty, conservative defaults, required watched source files, and easy opt-out. If real users routinely misdeclare stages, automatic import tracing or runtime dependency capture may be necessary, weakening the lightweight-tool thesis.

### 15.2 The API may require too much metadata

`implementation`, `watch`, `inputs`, `env`, dependencies, and cache policy are explicit but verbose. If maintaining these declarations is comparable to maintaining a bespoke cache, the product fails its usability goal.

Phase 0 should measure declaration burden, not only engine correctness. Convenience defaults must not be added until their safety is understood.

### 15.3 Manual implementation revisions are easy to forget

The revision is useful for semantic changes outside source bytes, but it cannot be the primary correctness mechanism. Required source watching reduces this risk without eliminating incomplete dependency boundaries.

### 15.4 Strict JSON excludes common agent artifacts

Strict JSON is appropriate for proving the engine but insufficient for buffers, files, streams, rich provider objects, and very large outputs. Custom codecs will later need stable IDs, versions, deterministic encoding requirements, and compatibility rules. Adding them too early would obscure the Phase 0 proof.

### 15.5 Environment hashes can leak low-entropy values

Plain SHA-256 prevents casual plaintext exposure but not guessing. A project-local HMAC key would improve confidentiality but would make portable cache identity and key management more complicated. Phase 0 should not claim secure secret storage.

### 15.6 Cross-machine determinism has limits

Canonical data and root-relative paths are portable, but watched source bytes may differ because of line endings or generated builds. Phase 0 hashes exact bytes intentionally. Node runtime, loader, and platform support must be pinned for reproducible tests.

### 15.7 Filesystem persistence still needs atomicity

Even without SQLite, immutable manifests and objects need atomic temporary-write-and-rename behavior, collision checks, and interrupted-run handling. This is engine plumbing, not a database feature, and must be specified before persistence code is written.

### 15.8 Sequential planning sacrifices an optimization

Propagating execution downstream before observing equal output is conservative and simple, but it can rerun more than necessary. That is acceptable for Phase 0. If savings depend heavily on stopping propagation after equal outputs, the static planner may need redesign.

### 15.9 Type-safe dependency outputs may complicate the fluent API

TypeScript inference across a growing workflow builder can become slow or produce poor errors. A simpler object-based definition may be preferable to a clever fluent API. The runtime contract must not depend on advanced type inference.

### 15.10 Non-cacheable joins can erase most savings

A volatile or non-cacheable stage invalidates all descendants. This is correct, but workflows containing volatile stages near the root may gain little from AbilityBench. Phase 0 should expose this result rather than introduce unsafe exceptions.

## 16. Phase 0 Go/No-Go Gates

Proceed beyond Phase 0 only if all of these are true:

1. Every tested decision is deterministic and has a useful explanation.
2. No invalid baseline or artifact is silently reused.
3. Branch-local changes leave unrelated branches reusable.
4. The immutable single-baseline rule is practical.
5. Strict serialization failures are understandable.
6. Declaring a realistic small workflow is materially easier than building custom caching around it.
7. Developers understand that safe reuse depends on an exhaustive dependency declaration.

If gate 6 or 7 fails, the project should pause. A correct cache engine with an unusable or misleading contract is not a viable lightweight developer tool.
