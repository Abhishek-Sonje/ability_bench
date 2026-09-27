# AbilityBench

AbilityBench is an experimental local-first execution engine for dependency-aware incremental
workflow runs.

The current milestone is deliberately narrow: Phase 0 proves that a fully declared DAG can reuse
valid artifacts from one immutable baseline and conservatively rerun affected stages.

## Status

Phase 0 is under active development. Its execution contract and current SDK usage are documented:

- [Product plan](./plan.md)
- [Phase 0 execution contract](./execution-contract.md)
- [Phase 0 storage guarantees](./docs/phase-0-storage.md)
- [Phase 0 usage](./docs/phase-0-usage.md)
- [Phase 0 verification and remaining gates](./docs/phase-0-verification.md)
- [Phase 0 assessment and go/no-go result](./docs/phase-0-assessment.md)
- [Platform support](./docs/platform-support.md)
- [Release-readiness example](./examples/release-readiness/README.md)

AbilityBench is not ready for production use.

## Phase 0 API

Declare every stage before running the workflow. Stage callbacks receive only their declared
direct dependencies and selected external inputs.

```ts
import { cache, createWorkflow, defineStage, input, runWorkflow } from "abilitybench";

const source = defineStage({
  id: "source",
  dependsOn: [],
  inputs: { value: input.number("/value") },
  cache: cache.enabled({
    revision: "source-v1",
    files: ["./workflow.ts"],
    environment: [],
  }),
  run: ({ inputs }) => ({ value: inputs.value }),
});

const workflow = createWorkflow({
  id: "example",
  root: import.meta.dirname,
  stages: [source],
});

const baseline = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: null,
});

const candidate = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: { runId: baseline.manifest.id },
});
```

The caller chooses one baseline explicitly. Each run is stored under the workflow root in
`.abilitybench/` by default. `candidate.plan.decisions` explains every reuse or execution.

Cacheable stages must behave as pure functions of their declared dependencies, selected inputs,
environment variables, and watched files. AbilityBench cannot detect an undeclared influence.
Typed input contracts are fingerprinted, and the grouped cache declaration makes each influence
category visible at the stage boundary.

## Development

Requirements:

- Node.js 24.20.0 or newer within the Node 24 release line
- Corepack with pnpm 12.5.1

```bash
corepack enable
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions and quality gates.
