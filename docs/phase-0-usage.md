# Phase 0 Usage

Phase 0 is a TypeScript SDK prototype. It runs local deterministic workflows and records each run
under the project's `.abilitybench/` directory. The public entry point is `runWorkflow`.

## Define a workflow

All stages must be registered before `.build()`; registering a stage never executes it.

```ts
// workflow.ts
import { defineWorkflow } from "abilitybench";

export default defineWorkflow({ id: "example", root: import.meta.dirname })
  .stage({
    id: "source",
    dependsOn: [],
    implementation: "source-v1",
    watch: ["./workflow.ts"],
    inputs: ["/value"],
    env: [],
    cache: true,
    run: ({ inputs }) => ({ value: inputs["/value"] ?? null }),
  })
  .stage({
    id: "report",
    dependsOn: ["source"],
    implementation: "report-v1",
    watch: ["./workflow.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: ({ dependencies }) => ({ source: dependencies["source"] ?? null }),
  })
  .build();
```

Each stage sees only its direct dependencies. Selected external inputs are keyed by their exact
JSON Pointer; for example, `/value` is accessed as `inputs["/value"]`. A missing selection is
omitted. Output must be strict JSON data.

## Typed stage handles

For workflows whose stages consume structured outputs, define stage handles first and compose the
sealed workflow afterward:

```ts
import { cache, createWorkflow, defineStage, input } from "abilitybench";

const source = defineStage({
  id: "source",
  dependsOn: [],
  inputs: { count: input.number("/count") },
  cache: cache.enabled({
    revision: "source-v1",
    files: ["./workflow.ts"],
    environment: [],
  }),
  run: ({ inputs }) => ({ count: inputs.count }),
});

const report = defineStage({
  id: "report",
  dependsOn: [source],
  inputs: {},
  cache: cache.enabled({
    revision: "report-v1",
    files: ["./workflow.ts"],
    environment: [],
  }),
  run: ({ dependencies }) => ({ total: dependencies.source.count }),
});

export default createWorkflow({
  id: "typed-example",
  root: import.meta.dirname,
  stages: [source, report],
});
```

`dependsOn` contains handles rather than string IDs, so TypeScript infers each direct dependency's
output. Input descriptors give selected values stable runtime validation and inferred callback
types. Built-in descriptors support JSON, booleans, numbers, strings, string arrays, and optional
values. Their contract IDs are fingerprinted, so changing a value contract invalidates reuse.

`cache.enabled` groups every cache influence category: revision, watched files, and environment
names. Its TypeScript type requires at least one watched file. `cache.disabled` and
`cache.volatile` make always-execute intent explicit while retaining revision and influence
metadata. These declarations make omissions more visible but cannot discover ambient filesystem,
network, clock, randomness, or process-state reads.

Handles carry declarations only; defining or composing them never executes stage code. Runtime
cycle, duplicate-ID, and missing-dependency validation remains the same as the fluent API.

## Load configuration

The default config filename is `abilitybench.config.ts` in the current directory. The workflow
path and storage directory are resolved relative to this file.

```ts
// abilitybench.config.ts
export default {
  workflow: "./workflow.ts",
  storageDir: ".abilitybench",
};
```

```ts
import { loadWorkflowConfig, runWorkflow } from "abilitybench";

const { workflow, storageDir } = await loadWorkflowConfig();
const baseline = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: null,
  storageDir,
});

const candidate = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: { runId: baseline.manifest.id },
  storageDir,
});

for (const stage of candidate.execution.stages) {
  console.log(stage.stageId, stage.executionStatus, stage.decisionReason);
}
```

The caller must select one completed baseline run explicitly. The candidate records that run's
content hash and can reuse artifacts only from that baseline.

Watched paths must stay within the workflow root, including when a directory is a symbolic link
or junction. A stage cannot watch files inside its run's storage directory, including a custom
`storageDir`. The engine rejects such a run before executing any stage.

## Cacheability

Mark a stage `cache: true` only when its result is determined by declared dependency outputs,
selected inputs, declared environment variables, watched files, and its implementation revision.
The stage must have no required side effects. Use `cache: false` for work that must always execute,
or `volatile: true` for results intentionally affected by time, randomness, or other changing
state. Both choices make descendants execute in Phase 0.

The engine can verify declarations and artifact integrity. It cannot discover a forgotten import,
filesystem read, network call, clock read, or global mutation. An undeclared influence can make
reuse unsafe.

## Current scope

Phase 0 has no CLI, evaluation engine, provider integration, database, UI, or tool replay. The
engine executes sequentially and conservatively reruns all descendants of an executed stage.
