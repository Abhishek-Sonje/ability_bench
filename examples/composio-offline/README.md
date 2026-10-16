# Offline integration of an existing research agent

This adapter uses only AbilityBench's public SDK. It does not change the engine, add a provider dependency, call Gemini/Composio, read credentials, replay tools, or modify the sibling agent. The existing research CLI, prompts, SDK configuration, retries, and adaptive loop remain untouched. Step 2 (a guarded live capture boundary) is not implemented here.

## Start

Use the repository's supported Node version and already installed dependencies in both projects. No dependency upgrade is needed.

```powershell
pnpm build
node examples/composio-offline/run.mjs prepare ../composio-agent salesforce.json
```

`prepare` prints a unique project path. It copies one saved result, the existing dataset context, six upstream modules with native Node type erasure, and the installed Zod package into that isolated project. It never builds or writes into the original project. Node currently emits an experimental type-erasure warning; unsupported non-erasable TypeScript fails preparation rather than changing upstream code.

Replace `<project>` and run IDs below with the printed values:

```powershell
node examples/composio-offline/run.mjs run <project> none
node examples/composio-offline/run.mjs plan <project> <baseline-run-id>
node examples/composio-offline/run.mjs run <project> <baseline-run-id>
```

Every candidate explicitly selects one immutable baseline; there is no implicit latest baseline. Ordinary runs write only new local artifacts/manifests and uniquely named `reviews/` reports, plans, and evaluation criteria. They do not publish. Planning writes nothing. All generated data is ignored by git and may contain private research; do not commit or share it casually.

For the existing CLI, use `<project>/abilitybench.config.ts` and `<project>/inputs.json`. Change `refresh` in that input file to declare a new snapshot selection (it does **not** fetch fresh web data), or use the existing `--invalidate load-capture` option. The wrapper reads the same inputs but requires `--publish` explicitly to enable publication.

```powershell
node dist/cli.js inspect <candidate-run-id> --config <project>/abilitybench.config.ts
node dist/cli.js diff <baseline-run-id> <candidate-run-id> --config <project>/abilitybench.config.ts
node dist/cli.js evaluate <baseline-run-id> <candidate-run-id> --config <project>/abilitybench.config.ts --criteria <project>/reviews/<baseline-run-id>-criteria.json
```

Evaluation persists a receipt, not a new execution or site copy. The original-renderer check intentionally fails an altered heading: that is a formatting-policy regression, not evidence of worse research. Execution success, absolute evaluation failure, and baseline-relative regression are separate. View existing history with the accepted read-only viewer using workflow ID `composio-offline-coarse-v1` and `<project>/.abilitybench`; large JSON-text artifacts may exceed its preview limits.

## Declared graph and reuse

```text
load-capture -> validate-result -> assemble-dataset -> analyze -> render-report
                                      |                 |
                                      v                 v
                               publish-dataset    publish-analysis
                                      \                 /
                                       verify-site-data
```

| Stage | Cache contract / declared influences |
| --- | --- |
| load-capture | Cacheable: target/refresh typed strings, saved result/context/provenance bytes, adapter code |
| validate-result | Cacheable: explicit loaded outputs; existing result schema, support policy, full copied Zod file boundary |
| assemble-dataset | Non-cacheable: existing `createCombinedDataset` reads time; explicit validated records and watched builder/schema modules |
| analyze | Non-cacheable: original `analyzeDataset` reads time; explicit dataset and watched analysis/category/schema modules |
| render-report | Cacheable transformation: explicit analysis, original renderer modules, watched `report-style.json`; conservatively reruns when analysis executes |
| both publishers | `cache: false`; typed opt-in boolean and declared `ABILITYBENCH_SITE_OUTPUT_DIRECTORY`; disabled returns a receipt without destination access |
| verify-site-data | `cache: false`; explicit dependencies on both publisher receipts and same declared env; reads actual destination bytes only after successful opt-in copies |

All stages also watch the adapter implementation. Dependency package files are explicitly enumerated because SDK watch targets are regular files, not directories. This is a conservative example boundary, not engine auto-discovery. The stage definitions use runtime-validated `input.string` / `input.boolean` descriptors; dependency handles declare all cross-stage data flow.

**Unchanged and report-only runs:** load and validation reuse via `fingerprint_match`; dataset and analysis execute via `cache_disabled`; report executes via `dependency_executed`; publication/verification callbacks execute but return `disabled` unless explicitly opted in. A changed report-style hash remains visible in component differences even though dependency execution is the primary reason. Zero model or tool calls occur: this adapter imports no Gemini/Composio implementation.

## Compatibility without rewriting the agent

The upstream analyzer requires exactly ten apps in each of its ten canonical categories. A single-result dataset fails that existing invariant. The adapter therefore watches the saved 100-app dataset as explicit context, replaces only the selected target in its original position, and passes the full ordered record array to the original builder. Missing/duplicate target identities fail. No category rules are relaxed and no synthetic filler records are created.

Zod validation and the existing `removeUnsupportedClaims` policy are reused directly. A selected target that would be changed by the current support policy is rejected rather than silently rewritten. Older context records are preserved to match saved analysis behavior; current policy differences are reported as explicit failed evaluation findings, not hidden or repaired. Confidence re-evaluation and source authenticity cannot be reconstructed without the original observations; the adapter does not invent them. Provenance marks original acquisition time, model settings, and observation history as unavailable, not as today's configuration.

Dataset/analysis payloads are **JSON text inside normal JSON artifacts**. That small adapter choice preserves all original object insertion order, including tied distribution rows and opportunity buckets, through canonical serialization. It is not a new codec. Report bytes are compared with the original renderer; dataset/analysis values and order are compared with the original functions while aligning only their fresh `generatedAt` values in the test oracle. Production callbacks retain the original clock reads and cache-disabled contract.

Prepared upstream code is a frozen local snapshot. Updating the original checkout does not silently replace it; prepare a new project to adopt new upstream behavior. Within a project, restart the process after editing executable module files, as normal Node module caching applies. Snapshot selection is not automatic source freshness. Trusted source code, supported Node runtime, and no concurrent hostile filesystem mutation are assumptions; this adapter is not a sandbox for untrusted code.

## Publishing is optional and isolated

```powershell
node examples/composio-offline/run.mjs run <project> <baseline-run-id> --publish
```

Only this flag enables publication in the wrapper. It selects a fresh `<project>/published/site-<uuid>` directory and supplies it as the declared environment dependency. The workflow itself rejects destinations outside that immediate isolated subtree, linked/junction directories, and linked/non-regular output files. Existing source/site output directories are never eligible. SDK callers must explicitly set both the boolean and isolated env value. Ordinary plans, runs, inspections and evaluations do not copy anything to a site.

Writes are sequential and not transactional: if a later stage fails, earlier isolated copies may remain. Verification is skipped for failed dependencies; unrelated later stages can be skipped by fail-fast. Publication is for local controlled outputs, not remote delivery or protection against an adversarial process racing path checks.

## Reproduce the offline acceptance matrix

```powershell
node examples/composio-offline/verify.mjs ../composio-agent salesforce.json examples/composio-offline/.abilitybench
pnpm check
```

The verifier blocks network/provider imports and fetch, preserves evidence in a new unique project, and tests baseline, unchanged, report-only, watched capture/schema/policy changes, manual invalidation, changed snapshot selection, missing/corrupt artifacts in separate history copies, opt-in copies, missing output restoration, env changes, publication failures, rejected original/linked destinations, and schema failure. It checks baseline bytes/artifacts after every scenario and hashes original source/results files before/after. It intentionally opts into publication only inside its own isolated test tree. CI uses a small independent fixture; the separately retained real-data exercise uses actual upstream functions and schemas. See the [Step 1 results](../../docs/composio-offline-results.md).

## Applying the same approach to another TypeScript agent

The generic pattern is **snapshot -> validate -> existing deterministic transforms -> opt-in side effects**. Wrap existing exported functions; do not rewrite an adaptive agent loop into artificial static actions. One coarse capture can stand in for the whole research operation. Composio-specific filenames, schemas, policy, context requirement, and publication formats live only in this example.

Developers must declare stage dependencies, typed external inputs, implementation/helper/package files, non-secret environment influences, revisions, and the selected immutable baseline. Use explicit ordered arrays or JSON text when object insertion order affects behavior. Hidden clock reads, live web/model/tool calls, mutable external state, and delivery writes cannot safely be treated as pure cacheable functions. Snapshot reuse saves repeating known work; it does not prove the outside world is unchanged.

For example, another project's pure transform can be wrapped without changing its implementation:

```ts
import { cache, createWorkflow, defineStage, input } from "abilitybench";
import { readFile } from "node:fs/promises";
import { summarizeSavedResult } from "./existing-agent/report.js";

const saved = defineStage({
  id: "saved", dependsOn: [], inputs: { selection: input.string("/selection") },
  cache: cache.enabled({ revision: "saved-v1", files: ["workflow.ts", "capture.json"], environment: [] }),
  run: async ({ inputs }) => ({ selection: inputs.selection, text: await readFile(new URL("./capture.json", import.meta.url), "utf8") }),
});
const report = defineStage({
  id: "report", dependsOn: [saved], inputs: {},
  cache: cache.enabled({ revision: "report-v1", files: ["workflow.ts", "existing-agent/report.js"], environment: [] }),
  run: ({ dependencies }) => summarizeSavedResult(JSON.parse(dependencies.saved.text)),
});
export default createWorkflow({ id: "my-existing-agent", root: import.meta.dirname, stages: [saved, report] });
```

Resolve file reads against the declared workflow root in actual adapters (not an arbitrary working directory), and add every transitive influence of `summarizeSavedResult` to its file/env contract. If that function reads time or makes network calls, use a non-cacheable boundary or an explicit capture instead. No framework/provider registration or SDK extension is required.
