# Second independent agent: Archie offline results

Status: **passed for the coarse snapshot integration contract**, 2026-10-17. No live API calls, budget increase, core changes or changes to either source agent. [Composio is parked](./composio-live-blockers.md); [REST counting remains a separate investigation](./rest-token-counting-investigation.md).

## Selection and scope

Selected the existing `../archie` TypeScript architecture-documentation CLI (`archie-ai` 1.0.1), not a repository designed for AbilityBench. Its `init()` gathers configuration, identity/source files, a directory tree and Git history, calls `generateArchitecture()`, writes `ARCHITECTURE.md`, and updates Git-local state. This differs from Composio's web-research/adaptive-tool workflow. Archie directly imports the older `@google/generative-ai` SDK; it does not depend on Composio or AbilityBench. Both examples still use Gemini, so this is **not cross-provider empirical validation**.

Kept Archie's existing prompts, retry loop, reader functions, markdown cleanup and writer unchanged. Did not run `init()` interactively because it can overwrite user files and initialize state. Instead called its existing exported functions from an isolated type-erased copy. No CLI entry/dotenv import, hooks, state writes or SDK upgrade. The original checkout already had changes to `ARCHITECTURE.md`, `package.json` and `package-lock.json`; those were left in place.

The real exercise captured 14 source files, 18 Git-history records and the existing configuration/identity/tree through original readers. One **mocked** SDK response returned the existing `ARCHITECTURE.md`; the original generation function built its real prompt and applied its existing normalization. Byte compatibility was checked against the retained document after the original `.trim()` behavior. This does not establish that the retained document accurately describes today's working tree; provenance says so explicitly.

## What the adapter proves

The seven-node DAG uses five independent snapshot-input branches, an architecture join and opt-in publication. All definitions exist before execution. Only the existing public `dist/index.js` SDK entry is imported. Engine, codec, storage format, evaluation implementation and viewer are unchanged; no framework/provider registration exists.

The acquired output is explicitly historical and hash-bound to ordered inputs and the original generator implementation. Reading it is cacheable; obtaining mutable Git/source state, calling a stochastic model, installing a hook, and updating Git state are **not** claimed pure. Original arrays and behavior-sensitive object order survive through text-valued JSON artifacts. Source/prompt changes reject mismatched evidence instead of relabelling an old answer as fresh.

Publication remains non-cacheable and disabled by default. The verifier explicitly exercised the original writer only in the adapter's isolated `published/`, with byte-identical output. It never published into the real Archie checkout. A writer-only probe appended a comment to the isolated writer module: a watched implementation change, **not a claim of new formatting behavior**. Its temporary edits were restored.

## Recorded real-project runs

All candidates reference the same immutable baseline, `run_13b204ba51bcd245bbb8a74bf106b2fc0737796378be4a419ab43b181fe78f87`. Ignored local evidence lives under `examples/archie-offline/.abilitybench/verified/archie-ZE5R7N/`; run manifests, artifacts and evaluation receipts are retained there. The source snapshots/documents are not committed as public fixtures.

| Scenario | Five input branches | Architecture | Publish | Outcome |
| --- | --- | --- | --- | --- |
| Baseline | Execute: no baseline | Execute: verify selected acquisition | Execute, disabled | Execution completed |
| Unchanged candidate | Reuse: fingerprint match | Reuse: fingerprint match | Execute, disabled: cache disabled | Evaluation passed; no regressions |
| Isolated writer-only revision | Reuse | Reuse | Execute, disabled: cache disabled | Evaluation passed; no regressions |
| Opt-in isolated original writer | Reuse | Reuse | Execute: cache disabled | Original output bytes match |
| Changed captured source | Source branch executes: fingerprint changed; four others reuse | Executes because dependency executed; fails stale-input binding | Skipped: dependency failed | Expected safe failure, no reacquisition |
| Manual architecture invalidation | Reuse | Executes: manual invalidation, revalidates same snapshot | Execute, disabled | Completed, not fresh AI output |

Retained candidate IDs:

- Unchanged: `run_6d33e081986f71818dc9f1b66ae0eb824e0657ffeb8bd943234567f2d64c6ccc`.
- Writer revision: `run_eb8d886c5c4894d961fcf91d02e93e2e88381beb870aca8a0c9b53bb99bf26ca`.
- Isolated publication: `run_ffb3545fff4e03c23cf5e848670f6478908f25fbdd2ee3323a8754e44b4ddc47`.
- Stale source rejected: `run_39ff8e49616cf9730a2d186b0a92f7198df3440fe845cd4da0638b323373f010`.
- Manual revalidation: `run_a9cc603053f385b41005fcdd7e6f962cca5e4aa45fb18c307061ffb40c098768`.

Baseline manifest identity was checked before/after. All runs and evaluations make **zero provider calls**; acquisition made one mock call. This proves offline snapshot reuse, not newly measured avoided paid calls. Existing seven historical live experiment tree hashes still match their prior checkpoints. All Composio implementation/evidence remains untouched.

## Tests and evaluation correctness

Added 12 offline adapter tests: unchanged reuse, writer change, changed source, changed prompt, corrupt capture, manual invalidation, quality regression, evaluation-policy change, corrupt cached artifact, invalid typed controls, exact isolated publication, and publication failure.

- A deliberately missing required section yields **completed execution, failed evaluation, regressed comparison**.
- Changing evaluation policy reevaluates both retained runs: both can fail the new policy while comparison remains **no regressions**. No execution cache is used for evaluation results.
- Corrupt cache bytes are not trusted. Recovery attempts cannot overwrite an immutable object with conflicting bytes, so the run fails and dependent publication skips. No automatic object deletion/repair was added.
- Invalid publish types fail at the typed stage boundary; upstream cached results may already have reused. This is a failed execution, not a successful no-op.

The real retained document passed its original required heading order. That is a structural check only: it cannot prove source entailment, design-rationale claims, freshness, or preservation of every permanent section in an AI-generated update. No semantic quality equivalence is claimed.

Full Windows quality gate: **311 passed, one existing POSIX-only skip, 29 test files**, compiler/Biome checks successful with 15 existing informational notices. New tests use portable isolated fixtures; current Ubuntu CI for this new commit still needs confirmation. The real existing-agent exercise was local Windows, not silently substituted with a fixture-only result.

## Integration effort and developer usability

Measured scope rather than a fictional time estimate: **zero upstream edits**, six existing source modules snapshotted for acquisition, one seven-stage public-SDK declaration, a small mock import seam, command wrappers/verifier and 12 tests. No agent was rewritten into another orchestration architecture.

Useful reuse: original deterministic input reads and immutable acquired output can be selected/reused through the same SDK as Composio. Explicit dependencies, file influences, typed controls, immutable baseline selection and separate evaluation remain framework-neutral. Another TypeScript agent can import its existing exported functions directly; type erasure/module redirection is this local harness's packaging choice, not an AbilityBench requirement.

Friction actually encountered:

1. Archie has no injectable model seam and keeps prompt builders private. Mocking its SDK import was necessary to exercise the original generation function without changing it. Existing SDK/package ESM-versus-CommonJS resolution required explicit import-condition handling. The boundary is reusable; the source-loading glue is not universal.
2. Mutable filesystem/Git collection cannot honestly be declared pure. Explicit acquisition snapshots reduce integration risk but require developers to decide when to refresh; automatic repository mutation tracking is not provided.
3. The original writer is a side effect, so it runs even unchanged. A downstream edit does not make that stage cacheable. Disabled publication still has a successful execution record; users need its output flag as well as status to see that no file was written.
4. Original prompts, source selection, order, configuration and captured model identity must be declared consciously. The SDK does not discover hidden dependencies or infer an agent's safe reuse contract.
5. A custom runner currently supplies defaults and concise decisions; standard config/viewer entry wrappers were not added merely for this example. The SDK approach is verified, but first-time developer onboarding still needs independent human testing rather than agent self-certification.

**Verdict:** a genuinely reusable coarse developer-facing pattern across two unrelated application domains, with clearly bounded evidence. Not proof of arbitrary-framework compatibility, automatic instrumentation, native LLM callback caching, replay, or universally low integration cost. Keep provider acquisition outside deterministic stages and explicitly bind the resulting artifact to its inputs. Do not label the general developer-usability gate independently human-verified from this self-run exercise.

## Shortest path to a public MVP

1. Position the MVP accurately: local TypeScript DAG execution, explicit influences, immutable baselines, artifacts, evaluation and read-only inspection; external AI acquisition is an explicit snapshot boundary. Composio live billing is not a release prerequisite.
2. Have one developer unfamiliar with AbilityBench follow the two adapter guides, declare their own workflow, and explain every decision without reading engine source. Fix only blockers exposed by that exercise; do not add another provider framework or synthetic validation campaign.
3. Confirm Windows/Ubuntu CI for the new example tests; run the existing package/CLI smoke checks in a clean consumer project. Review license, public exports, documentation paths and exclusion of private snapshots/credentials from the package. This is proposed release verification, not performed publication work.
4. At the user's chosen time, approve the package/version/release checklist and publish. No cloud, editing UI, SQLite, replay, authentication, paid-provider guarantees or extra live experiments are necessary for this narrowly stated MVP.

Release remains deferred; nothing was published or pushed. Budget remains **$0.11 cap / $0.07268715 available headroom**, with all unknown exposure retained.
