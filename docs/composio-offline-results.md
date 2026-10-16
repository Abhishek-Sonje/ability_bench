# Existing-agent offline integration: Step 1

Status: **complete**, 2026-10-16. Ready for Step 2's mocked capture-boundary implementation, **not** live capture approval. No engine/public SDK changes, provider requests, source-agent changes, or new dependencies.

## Real project and compatibility

The separate [adapter and usage guide](../examples/composio-offline/README.md) wraps the sibling Composio research project's existing saved Salesforce result, original Zod schema/support policy, dataset builder, analyzer, and renderer. Six source modules are copied and type-erased into an isolated project; the original checkout is never built or rewritten.

An actual integration constraint changed the plan's single-record assumption: the original analyzer requires a complete assessment with ten records in each of ten categories. Rather than changing that rule, the adapter declares the existing 100-record dataset as watched context and replaces the one selected target in its original position. All other record values/order are retained. This is explicit context, not fabricated research or a broadened collection workflow.

The real-data verifier passed 17 scenarios: 15 manifests in the primary store and one each in separate missing/corrupt-artifact stores. All candidates select the exact baseline below. Baseline manifest bytes and every original baseline artifact were checked after every scenario. The original project's 180 checked source/result/package files were unchanged; its worktree remained clean and `npm run check` passed. The original live CLI was not invoked, so no new provider-availability claim is made.

Dataset and analysis values **and insertion order** match the original functions. Only fresh `generatedAt` values are aligned in the comparison oracle; production retains original clock reads with caching disabled. Original Markdown output matches byte-for-byte. JSON-text payloads inside ordinary SDK artifacts preserve order through canonical serialization without adding a codec or rewriting the renderer.

## Decisions observed

R = reused; X = successful execution; F = failed; S = skipped. P/V refers to both publication callbacks and verification; ordinary X callbacks return `disabled`, not external copies.

| Scenario | Load | Validate | Dataset | Analyze | Report | P/V |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | X | X | X | X | X | X, disabled |
| Unchanged | R | R | X | X | X | X, disabled |
| Report-only style change | R | R | X | X | X | X, disabled |
| Watched schema/policy change | R | X | X | X | X | X, disabled |
| Watched capture / refresh selection / manual invalidation | X | X | X | X | X | X, disabled |
| Missing artifact, copied history | X | X | X | X | X | X, disabled |
| Corrupt artifact, copied history | F | S | S | S | S | S |
| Explicit isolated publication / restore missing file / change env | R | R | X | X | X | X, verified |
| Dataset publication failure | R | R | X | X | S, fail-fast | Analysis copied; dataset F; verify S |
| Original/linked destination rejected | R | R | X | X | S, fail-fast | Analysis F; dataset S; verify S |
| Schema-invalid captured result | X | F | S | S | S | S |

Reasons are recorded, not inferred from equal output values:

- Reuse is `fingerprint_match`, with unchanged artifact/fingerprint identity.
- Dataset assembly and analysis use `cache_disabled` because their existing functions read time. They force conservative report reruns via `dependency_executed` even with unchanged substantive data.
- Report-only editing changes `report-style.json`'s watched-file component. The primary report reason remains `dependency_executed`; the watched change is still visible in the diff.
- Schema/policy edits change validation's watched component; capture still reuses. These probes append comments to isolated snapshot modules, so they test invalidation without pretending to test altered policy semantics. Executable edits require a new process under normal Node module caching.
- Watched captured bytes plus matching provenance and changed refresh selection produce `fingerprint_changed`; explicit invalidation uses `manual_invalidation`. Selecting a new refresh marker is not a web refresh.
- Missing artifacts produce `baseline_artifact_unavailable` and are recomputed. Corrupt content is never reused or overwritten: the collision/integrity guard fails the copied-history run. Original baseline objects were not corrupted or repaired.
- Publisher/verification stages always use `cache_disabled`. Environment component hashes change with the isolated destination. A failed dependency causes `skipped_dependency_failed`; fail-fast on another branch causes `skipped_run_stopped`. Already written isolated output is not rolled back.

Every scenario made **zero Gemini calls, zero Composio calls, and zero attempted network/provider accesses** under the verifier's fetch/import guards. The workflow imports only offline upstream functions. Ordinary run/plan/inspection/evaluation paths do not enable publication; explicit publication tests used only unique local project subdirectories. Original and junction-alias destinations were rejected.

## Execution versus evaluation

The unchanged candidate completed execution and passed original-renderer byte compatibility. The support-policy audit reported existing differences for **Twenty** (`buildability`, `unknownFields`) and **Otter AI** (`buildability`, `blocker`, `unknownFields`) in the historical context. Those are differences under today's existing policy, not proof that the original web claims are false. No raw observation history exists to establish source authenticity or reapply confidence policy faithfully.

The adapter does not silently normalize those historical records. The unchanged pair's absolute evaluation is **failed**, while regression is **no_regressions** (`unchanged_fail` for support policy, `unchanged_pass` for rendering). This does not claim a clean research-quality baseline.

The intentional report-heading change fails the original-byte criterion and is **regressed under that explicit formatting criterion**. It is expected and retained, not a research-quality or cache correctness failure. Checks are not relaxed to obtain a pass. A selected target itself failing the existing support policy remains an execution validation error rather than being silently repaired.

## Evidence and verification

Ignored real-data evidence: `examples/composio-offline/.abilitybench/integration-rwv1UF/verification.json`, its immutable histories, artifacts, provenance, and evaluation receipts. Raw saved research remains local, not committed.

- Workflow: `composio-offline-coarse-v1`.
- Baseline: `run_1f862e728cf4dc919767b84e10e9f3023e41917b9bfa587875343176edaf4633`.
- Baseline file SHA-256: `4ae524e9da376f8637d0c7b50076eeaf0946aa271bab1ee514543c94447295b4`.
- Selected saved-result SHA-256: `11a1da4958cb7c8f280f0e0ef40c149a3d6491c347bcc65b7527c5b01731b4ff`.
- Full quality gate: **230 passed, one existing POSIX-only skip, 26 test files**. Eight added offline tests use a small independent CI fixture; the real project exercise separately used the actual schema/functions and full saved assessment.
- Tests also exercise the standalone entry point and existing public CLI inspection/evaluation without enabling publication.

The earlier live experiment evidence and spending ledgers were not altered. This integration incurred no API usage or added budget exposure.

## Generic boundary and next step

Everything in `src/` and the public SDK remains framework/provider-agnostic. Only this adapter knows the Composio filenames, schema, support policy, canonical dataset constraint, and site format. Another TypeScript agent can use the same SDK to wrap exported deterministic functions around an explicit captured input, retaining its own schemas, prompts, CLI, provider client, and adaptive loop. Developers must explicitly declare inputs/dependencies/files/env and mark volatile or side-effecting operations non-cacheable; this is not automatic discovery or arbitrary agent memoization.

Step 2 can now implement and mock-test a small capture boundary around the existing `researchApp`, with per-attempt SDK usage observation, retry-aware reservation, tool accounting, redaction, and immutable acquisition provenance. The existing support findings are retained quality debt, not an engine blocker. No capture code, nested retry changes, live approval, or new synthetic experiment is included in Step 1.
