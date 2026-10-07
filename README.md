# AbilityBench

**Dependency-aware workflow execution with explainable reuse.**

AbilityBench is a local-first TypeScript execution engine that helps developers understand what needs to run again when a workflow changes. Declare a complete dependency graph, capture an immutable baseline, and execute a candidate that reuses valid outputs while conservatively rerunning affected stages.

Every reuse, execution, failure, and skip has a recorded explanation. A local CLI and read-only browser viewer make those decisions inspectable without changing execution history.

> Status: working developer-local prototype. The execution engine, evaluation CLI, and read-only viewer are implemented. The package is not published or production-ready. Live Gemini savings validation remains incomplete; no measured AI cost savings are claimed.

## Why it exists

Changing one step in a multi-stage workflow should not automatically require rerunning everything. But reuse is only useful if developers can trust it: hidden inputs, side effects, and unclear cache decisions can make a fast workflow incorrect.

AbilityBench makes that trade-off explicit:

- Declare dependencies and external influences before execution.
- Compare each candidate against one explicitly chosen immutable baseline.
- Reuse only when the declared contract and verified artifacts permit it.
- Explain why every stage reused, ran, failed, or was skipped.
- Evaluate output quality separately from execution success.

The longer-term motivation is cheaper iteration on agent workflows. The current engine establishes the deterministic execution foundation; arbitrary live LLM callbacks do not satisfy its purity contract.

## Example: change one branch, not the whole workflow

The included release-readiness example has independent branches and a join:

```text
inventory ----> unit-tests ----+
    |                         |
    +---------> security -----+----> summary ----> report
                              |
documentation ----------------+
```

When only the declared security signal changes:

| Stage | Candidate decision | Reason |
| --- | --- | --- |
| inventory | Reuse | Declared fingerprint and baseline artifact remain valid |
| unit-tests | Reuse | Its inputs and dependency are unchanged |
| documentation | Reuse | Independent branch is unchanged |
| security | Execute | Its selected input changed |
| summary | Execute | A direct dependency executed |
| report | Execute | A direct dependency executed |

Invalidation is intentionally conservative: descendants rerun when a dependency executes, even if it produces identical output bytes. AbilityBench prioritizes explainable correctness over maximum cache hits.

## Implemented capabilities

| Capability | Behavior |
| --- | --- |
| Declared DAG | Validates stage identities, dependencies, and cycles before execution; plans topologically |
| Typed SDK | Infers dependency outputs and validates selected external inputs at runtime |
| Explicit cache contract | Groups revision, watched files, and environment dependencies; supports disabled and volatile caching |
| Deterministic fingerprints | Canonical serialization and SHA-256 identities track declared influences |
| Immutable local history | Content-addressed manifests and artifacts; each candidate names one baseline |
| Explainable execution | Records reuse/rerun reasons and distinguishes dependency skips from fail-fast skips |
| Independent evaluation | Stores separate immutable receipts for evaluation and regression outcomes |
| Local inspection | CLI planning, inspection, comparison, and history listing |
| Read-only viewer | Historical DAG, recorded baseline, stage explanations, fingerprint comparisons, and bounded artifact previews |

## Quick start

The repository pins Node.js `>=24.20.0 <25` and pnpm `12.5.1`. See [package.json](./package.json).

```bash
corepack enable
pnpm install
pnpm build
```

Run the included deterministic example without API credentials:

```bash
node dist/cli.js run --config examples/release-readiness/abilitybench.config.ts --inputs examples/release-readiness/inputs.json
```

Copy the printed run ID. Replace `BASELINE_RUN_ID` below with that exact ID to preview and execute a candidate:

```bash
node dist/cli.js plan --config examples/release-readiness/abilitybench.config.ts --inputs examples/release-readiness/inputs.json --baseline BASELINE_RUN_ID
node dist/cli.js run --config examples/release-readiness/abilitybench.config.ts --inputs examples/release-readiness/inputs.json --baseline BASELINE_RUN_ID
```

With unchanged inputs, all stages reuse. `plan` predicts decisions without executing stages or persisting a candidate; `run` plans again against current inputs. AbilityBench never silently chooses a "latest" baseline.

See the [example walkthrough](./examples/release-readiness/README.md) for the equivalent SDK flow.

## Public SDK

Define typed stage handles first, then compose the complete workflow. Defining a stage does not execute it.

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

const report = defineStage({
  id: "report",
  dependsOn: [source],
  inputs: {},
  cache: cache.enabled({
    revision: "report-v1",
    files: ["./workflow.ts"],
    environment: [],
  }),
  run: ({ dependencies }) => ({ doubled: dependencies.source.value * 2 }),
});

const workflow = createWorkflow({
  id: "example",
  root: import.meta.dirname,
  stages: [source, report],
});

const baseline = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: null,
});

const candidate = await runWorkflow(workflow, {
  inputs: { value: 42 },
  baseline: { runId: baseline.manifest.id },
});

console.log(candidate.plan.decisions);
```

This example assumes a file named `workflow.ts`, because that file is explicitly watched. Importing `abilitybench` works inside this repository through its package exports; external installation is not yet published.

Cacheable stages must behave as pure functions of their declared dependency outputs, selected inputs, environment variables, and watched files. Outputs must satisfy the supported strict JSON artifact contract. Undeclared clock, randomness, network, or filesystem reads cannot be detected automatically. Side-effecting work should not be treated as cacheable.

## Inspect runs in the browser

After running the quick-start example:

```bash
pnpm viewer --store examples/release-readiness/.abilitybench --workflow release-readiness
```

Open `http://127.0.0.1:4310`. Select a run to see its recorded baseline and historical DAG, then click a stage for its decision, dependencies, fingerprint differences, and available artifact information.

The viewer does not execute workflows or edit history. Keep it on loopback; remote hosting is outside its security boundary. See the [viewer guide](./docs/phase-3-viewer-usage.md).

For CLI inspection, replace the run-ID placeholders with exact immutable IDs:

```bash
node dist/cli.js runs --config examples/release-readiness/abilitybench.config.ts --limit 20
node dist/cli.js inspect RUN_ID --config examples/release-readiness/abilitybench.config.ts
node dist/cli.js diff BASELINE_RUN_ID CANDIDATE_RUN_ID --config examples/release-readiness/abilitybench.config.ts
```

Use `--json` for versioned machine output or `--invalidate STAGE_ID` on a run for explicit manual invalidation. See the [CLI guide](./docs/phase-1-cli.md) for configuration conventions and complete options.

## Execution is not evaluation

A completed run can still fail a quality check. A failed absolute quality check does not automatically mean regression against a baseline.

AbilityBench keeps execution history separate from immutable evaluation receipts. Evaluation runs checks fresh against an explicitly selected pair of completed runs, without rewriting their manifests. The [evaluation walkthrough](./examples/evaluation-regression/README.md) demonstrates passing, failing, and regressing outcomes.

## Architecture and engineering decisions

```text
Workflow declarations + explicit inputs + immutable baseline
                            |
                 Validate and fingerprint
                            |
                   Plan reuse / execution
                            |
               Execute with explicit dependencies
                            |
             Immutable manifests + output artifacts
                      /                 \
             CLI / read-only viewer   Evaluation receipts
```

- **Explicit baseline lineage:** reproducible comparisons instead of a global "last run" cache.
- **Conservative invalidation:** rerun affected descendants rather than infer semantic equivalence from equal bytes.
- **Separated evaluation:** quality judgments do not mutate the execution record.
- **Filesystem storage:** inspectable local artifacts without a database or cloud service.
- **Small dependency surface:** Node.js/TypeScript engine and a plain-browser viewer, with no frontend framework or runtime package dependencies.

## Verification and current boundaries

The latest recorded full local Windows quality gate passed **198 tests**, with one existing POSIX-only skip. CI is configured for Windows and Ubuntu; previously confirmed cross-platform CI covers the engine and evaluation CLI, not a newly claimed validation of every later milestone.

The independent usability exercise used a real Composio project not designed around AbilityBench. Its workflow-modeling, decision explanations, side-effect handling, and ordering checks passed. The read-only viewer was checked against retained histories and accepted by the user. See the [independent validation](./docs/independent-workflow-validation.md) and [viewer verification](./docs/phase-3-viewer-usage.md).

The small live Gemini experiment remains unfinished due to provider `503 UNAVAILABLE` responses. Its adapter captures immutable provider responses outside deterministic engine callbacks; it is not native caching of stochastic LLM execution. No real token, latency, or cost savings are claimed. See the [live validation status](./docs/live-gemini-validation.md).

Not included: workflow editing, drag-and-drop, authentication, cloud execution, SQLite, tool replay, or production deployment. Publication and release work are deferred.

## Development

```bash
pnpm check       # Formatting/lint checks, TypeScript checks, and tests
pnpm test        # Build and run tests
pnpm build       # Build the SDK and CLI
```

Repository conventions and quality gates are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Documentation

- [Product plan](./plan.md) and [execution contract](./execution-contract.md)
- [SDK usage](./docs/phase-0-usage.md) and [storage guarantees](./docs/phase-0-storage.md)
- [Execution CLI](./docs/phase-1-cli.md) and [evaluation CLI](./docs/phase-2-cli.md)
- [Evaluation contract](./docs/phase-2-evaluation-spec.md) and [receipt storage](./docs/phase-2-storage.md)
- [Read-only viewer usage](./docs/phase-3-viewer-usage.md) and [engineering boundary](./docs/phase-3-read-only-viewer.md)
- [Offline Composio research demo](./examples/composio-research/README.md)
- [Platform support](./docs/platform-support.md) and [completion report](./docs/project-completion.md)
