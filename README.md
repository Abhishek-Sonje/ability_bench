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
- [Phase 1 local CLI](./docs/phase-1-cli.md)
- [Phase 1 readiness and external verification](./docs/phase-1-readiness.md)
- [Phase 2 evaluation contract proposal (not implemented)](./docs/phase-2-evaluation-spec.md)

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

## Local CLI

After building, run a workflow with an explicit input file:

```bash
pnpm build
node dist/cli.js run --config ./abilitybench.config.ts --inputs ./inputs.json
```

Pass `--baseline run_<digest>` to reuse from exactly that immutable run. Use `--invalidate
<stage>` one or more times for manual invalidation, or `--json` for versioned machine output.
The CLI never chooses a “latest” baseline implicitly.

Preview the same conservative decisions without executing or persisting a candidate:

```bash
node dist/cli.js plan --config ./abilitybench.config.ts --inputs ./inputs.json --baseline run_<digest>
```

Plans are predictive snapshots. A later `run` always plans again against then-current inputs,
environment values, files, and artifacts.

Inspect one stored run by its exact immutable ID:

```bash
node dist/cli.js inspect run_<digest> --config ./abilitybench.config.ts
```

Inspection verifies the stored manifest's canonical bytes and content identity before printing it.

Compare two explicitly selected immutable runs:

```bash
node dist/cli.js diff run_<old-digest> run_<new-digest> --config ./abilitybench.config.ts
```

The diff reports graph additions and removals plus every persisted field changed for shared stages.

List recent verified runs without implicitly selecting a baseline:

```bash
node dist/cli.js runs --config ./abilitybench.config.ts --limit 20
```

Listing is bounded and deterministic. Any baseline passed to `run` must still be named explicitly.

Every subcommand accepts only its documented options. With `--json`, command failures emit a
versioned `phase1-cli-error-v1` document on stderr instead of human-formatted text.

## Development

For an offline branch-and-join demo using saved research from a sibling Composio
project, see [the Composio research example](./examples/composio-research/README.md).

Requirements:

- Node.js 24.20.0 or newer within the Node 24 release line
- Corepack with pnpm 12.5.1

```bash
corepack enable
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions and quality gates.

The same `pnpm check` gate runs in CI on both Ubuntu and Windows so filesystem behavior is covered
on POSIX and Windows hosts.
