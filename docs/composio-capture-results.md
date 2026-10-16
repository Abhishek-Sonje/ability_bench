# Mocked real-agent capture: Step 2 results

Status: **complete; stopped before live capture**, 2026-10-16. All model/tool responses were local mocks. The verification workers dispatched no Gemini, Composio, npm registry, or other network requests. The [synthetic milestone remains closed](./live-gemini-v2-final-results.md).

## Changes and boundary

Added `examples/composio-capture/capture.mjs`, a narrowly scoped journal/budget/transport lifecycle; `worker.mjs`, opt-in wiring to the existing research factories; and `mock-provider.mjs`, public wire fixtures. Extended the Step 1 preparer/loader/entry point to adopt verified capture packages into a fresh project. Added capture-boundary tests and a Step 1 adoption/integrity test. No core SDK/engine/provider registry, new dependency, replay, cloud, MCP feature, or source-agent implementation change.

The worker uses the original `researchApp`, Gemini SDK client and model factory, Composio tools factory, adaptive loop, prompts, schemas, retry functions, evidence mapping and confidence policy. Only transport observation, capture logging suppression, and explicit guards are opt-in additions. The ordinary CLI branch was executed from an unchanged type-erased source snapshot with mocked SDK responses and capture disabled. It produced the **same parsed result** as the captured successful run. The original project's type-check passes and worktree is clean; 180 checked original source/result/package files remained unchanged. Live CLI authentication/availability was not tested.

SDK transport behavior was inspected locally for installed `@google/genai` 2.23.0 and `@composio/core` 0.18.1. Gemini exposes the [documented fetch hook](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html); the installed Composio client captures fetch at construction. A dedicated worker is therefore intentional, not a general-purpose global patch for arbitrary applications. Existing retry configuration remains unchanged; future SDK versions fail the worker's version gate pending audit.

## Installed SDKs against mocked wire responses

These are transport attempts, **not real API usage or paid calls**. The source agent used two research steps for this bounded offline check.

| Scenario | Model attempts | Search attempts | Fetch attempts | Setup attempts | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Success | 4 | 1 | 1 | 1 | Completed/exported public fixture |
| Gemini first request 503 | 5 | 1 | 1 | 1 | Original retry recovered; failed attempt kept unknown reservation |
| Malformed synthesis | 5 | 1 | 1 | 1 | Original malformed-output retry recovered; both requests accounted |
| Malformed evidence mapping | 5 | 1 | 1 | 1 | Original mapping retry recovered |
| Premature finish/action correction | 5 | 1 | 1 | 1 | Original adaptive correction ran and was counted |
| Composio search 503 | 4 | 2 | 1 | 1 | SDK-internal retry observed below one search invocation |
| First model request timeout | 1 | 0 | 0 | 1 | Failed; no result export; unknown reservation retained |

The normal successful fixture reports 100 input and 50 output tokens per model response (zero thinking), so four responses report 600 **mock** tokens. The accounting unit fixture separately verifies cached and thinking token charges. None of these token values is actual Gemini usage or evidence for real-world savings.

Ignored local evidence includes:

- Successful final-code installed-SDK check: `examples/composio-capture/.abilitybench/committed-code-check/mock-budget/capture-81715976-ad97-4a02-b492-d7b797e0ff01/`.
- Original CLI compatibility: `examples/composio-capture/.abilitybench/normal-cli/integration-96TJKP/results/salesforce.json`.
- Successful capture used for adoption: `examples/composio-capture/.abilitybench/mock-budget/capture-4bf84261-e895-4f2b-8d5f-f63ce9a23c2d/`.
- Mapping, tool, correction and timeout checks are in their separately named ignored check directories. Earlier mocked debugging evidence is not substituted for a pass or committed as call logs.

## Accounting and safety checks

Every underlying eligible fetch receives a durable reservation before dispatch. Known validated usage settles at original configured rates and releases unused reservation only after durable settlement. Unknown/invalid usage retains its allowance. Tool/setup exposure remains explicitly unknown with configured mock allowances, not fabricated provider prices. Integer nano-USD accounting and serialized reservations enforce the configured simulated cap before each request. Retries share logical IDs but have independent attempts/reservations; opaque HMAC identities do not expose raw request/response data.

The offline tests verify success, known and unknown failures, hidden retries, malformed output, cached/thinking usage, invalid/over-envelope usage, cumulative cap enforcement, policy reset rejection, orphaned crash reservations, stale/competing locks, concurrent requests, concurrent-scope rejection, attempt/overall timeouts, late completion, unawaited work, unsafe tools, oversized requests, private-result refusal, metadata-only default, unchanged request objects, sealed-file corruption, prior-package immutability, and adoption bindings.

The default export policy stores no raw research content. Public result export is separately opt-in and validated; sensitive/unsupported exports fail rather than being rewritten into a pass. Console logs and raw error messages are not captured. This protects known credentials and default-private data, not arbitrary unknown PII in explicitly approved prose. Trusted code, dedicated worker isolation, no hostile filesystem races, and the audited SDK boundary are assumptions. Native transport redirects and real token ceilings are not validated by a mocked `Response` fixture.

The mock policy uses the historical $0.03731285 exposure as a fixed test seed under a simulated $0.11 cap. All previous live evidence/ledgers remain unchanged. **Actual additional API usage/spending/exposure from Step 2 is zero.** Actual historical headroom remains $0.07268715; mock reservations are not billed or added to the live account.

## Step 1 adoption and historical evaluation

One completed, explicitly approved public mock capture was adopted into a new isolated Step 1 project. Both baseline and candidate completed; load/validation reused, time-reading dataset/analysis stages executed, report conservatively executed, and publishing remained disabled. The copied capture manifest/result are hash-bound to provenance; modified copies fail loading. Source implementation hashes must match before adoption.

Local adopted project: `examples/composio-capture/.abilitybench/adoption-check/integration-hxhpaK/`.

- Baseline: `run_2c2e409585295ea23f3ec40cf8b1963a439b8959d525220478bc3ff8ba5271fe`.
- Candidate: `run_1a44f81314baa85221ea0abd7a9fd8b91e427d182b74bdcceb9e59a154a31e13`.
- Receipt: `eval_dae27792d5664df36fdd8b97caf7eba41d0895abd6344c7a5c7c2c6eaad0dfe7`.
- Original-renderer check: passed on both sides.
- Existing support-policy check: failed on both sides; Twenty and Otter AI remain historical differences.
- Absolute evaluation: **failed**. Comparison: **no_regressions**. No source-data repair or evaluation-rule relaxation.

## Quality gate and next decision

Full Windows quality gate: **262 passed, one existing POSIX-only skip, 27 test files**. Biome/type checks pass, with only the 15 pre-existing informational style notices. Thirty-one new capture tests plus the adoption test supplement Step 1, including actual contention between two independent worker processes. Tests use mocked models/tools; installed-SDK verification above also used local wire responses only.

We are ready to **design one budget-approved real-agent experiment**, not execute it. That design must establish real model ceilings/rates, the actual default generation settings, retry/request bounds, reviewed public source/export policy, safe native transport/cancellation, and Composio fee or quota allowances under one cumulative account. Current mock ceilings do not prove that a real run fits $0.11, and no cap increase is approved. The remaining original support-policy differences, source freshness/authenticity, stochastic quality and invoice costs remain unverified. Stop here; no live capture or further synthetic validation follows automatically.
