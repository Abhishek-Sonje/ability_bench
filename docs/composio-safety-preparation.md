# Bounded Composio experiment preparation

Status: **offline safeguards implemented; NOT ready for live execution**, 2026-10-16. This follows the [Step 3 audit](./composio-live-experiment-plan.md). No live requests, budget increases, new experiments against providers, or engine changes were made.

## What changed

- `examples/composio-capture/experiment-profile.mjs`: separate immutable experiment profile, full-protocol arithmetic preflight, strict outbound-body/destination/tool checks, session binding and an explicitly offline token-count oracle seam. No heuristic character/token estimate is accepted as a live bound.
- `capture.mjs`: preflight against reconciled retained exposure while holding the account lock; request-object rejection; manual redirects; bounded streaming consumption/cancellation; original response bytes returned to the SDK; experiment-only request configuration and disabled Gemini SDK retries. Existing per-attempt durable accounting, usage settlement, unknown reservations, attempt caps and failure sealing remain active.
- `worker.mjs`: opt-in `experiment-mock` mode using the unchanged agent and installed SDKs. It changes only isolated experiment settings and supplies a fake token-count oracle and fake provider responses. Normal CLI and old mock mode retain their original generation/retry behavior. All three installed SDK versions, including the underlying Composio client, are now explicitly gated.
- `live.mjs`: isolated authorization/preflight entry point. It intentionally imports no provider, reads no credentials, and refuses execution even when its authorization argument is supplied, because unresolved safety bounds cannot be enforced yet. This is a fail-closed preparation entry, **not a functioning live runner**.
- New offline tests cover policy expansion, full reservation, retained/crashed exposure, limits, hidden retries, unsafe operations, cancellation and bounded response streams. Installed SDK tests use local Responses only and skip if the separate source project is unavailable.

No dependency changes, source-agent edits, new research algorithm, core SDK/provider types or changes to schemas, prompts, confidence/evidence policies, artifact format or historical evaluation rules.

## Explicit experiment envelope

| Limit | Value |
| --- | --- |
| Target / model | Existing Salesforce target / `gemini-3.5-flash-lite` |
| Adaptive research steps | 4 |
| Model wire attempts | 8 total, including action corrections, synthesis, mapping and all retries |
| Healthy model path | 4 action generations + synthesis + evidence mapping = 6 |
| Extra model attempts | 2 shared across the whole run, not two for each step |
| Gemini internal retries | Disabled in experiment only (`attempts: 1`); unexpected second wire attempt for the same SDK call fails closed |
| Application transient/malformed retries | Original predicates unchanged, but globally bounded by the eight-attempt guard |
| Input tokens | 8,192 for the complete request; no generation without a valid complete-input bound |
| Output + thinking | Intended combined ceiling 2,048; candidateCount 1, minimal thinking; REST combined-ceiling proof remains a blocker |
| Tool requests | 12 wire attempts total: up to 4 logical operations with 3 Composio SDK attempts each |
| Setup requests | 3 wire attempts, one logical setup with 2 SDK retries |
| Request / response body | 128 KiB / 1 MiB |
| Attempt / whole-capture deadlines | 60 seconds / 300 seconds; original 30-second tool abort remains stricter |
| Publication / replay | Disabled / absent |

Four steps allow an authentication search/fetch and an access search/fetch in the original adaptive loop. This is a meaningful proposed acquisition test, not a complete five-focus product assessment. Search/fetch choices remain adaptive; sufficient fetched evidence is an acceptance check, not an assumption. Unknown fields remain unknown. Neither source content nor observations are shortened further to make this fit. The existing compactor can still produce a later request too large for this profile; that must stop safely rather than silently omit evidence.

This bounds the **permitted experiment**, not every retry path of the unmodified agent. Four steps with all original retry paths could require up to 60 model attempts; this experiment stops at eight. It may therefore fail safely before synthesis/mapping if corrections/retries consume its allowance. No claim of guaranteed completion is made.

## Exact conditional reservation

Standard rates retained from the [official pricing audit](https://ai.google.dev/gemini-api/docs/pricing): $0.30/M uncached input and $2.50/M output/thinking. No assumed prompt-cache or free-tier discount.

```text
model attempt = (8192 * 0.30 + 2048 * 2.50) / 1,000,000 = $0.00757760
8 attempts                                               $0.06062080
12 tool attempts at proposed maximum $0.0005              $0.00600000
3 session setup attempts (published free creation)        $0.00000000
complete proposed reservation                            $0.06662080

historical retained exposure                             $0.03731285
worst cumulative exposure under these assumptions         $0.10393365
unchanged cap                                            $0.11000000
headroom after reservation                               $0.00606635
```

These figures are integer nano-USD in code. The all-unknown offline test exercises all 23 wire attempts and retains the full $0.06662080. Successful usage settlements can only release unused reservations after durable recording. Failed/invalid/absent usage remains conservatively reserved. Retained/crashed journals are added before the entire-protocol preflight; it rejects if the remaining reservation cannot fit, even if a first request could fit. Expanded policy values fail before dispatch. One account lock covers preflight through finalization; concurrent requests reserve serially.

**This is conditional arithmetic, not a verified complete live-cost bound.** The proposed $0.0005 tool maximum is not an observed Composio price. Unknown backend costs cannot be converted into a safe reservation merely by naming an allowance. Actual historical exposure and available headroom remain $0.03731285 and $0.07268715; offline mock usage adds nothing to them.

## Network protections actually tested

Only exact Google model generation and Composio session/execute routes are eligible. Session setup must match the existing serialized SDK body, including the two-tool whitelist and sandbox disabled. Execution binds to the returned session ID. The original SDK defaults connection management to enabled; its management endpoints are never permitted by the transport guard. Remote enforcement of session filters remains a provider assumption, not local sandboxing.

Search accepts bounded public Salesforce documentation queries. Fetch accepts only exact public HTTPS origins `developer.salesforce.com` and `help.salesforce.com`, no credentials, query strings, fragments, private IPs or arbitrary domains. Extra tool fields/unsafe slugs are rejected rather than rewritten. Google built-in tools, uploads, multimodal inputs, additional billing configurations and alternate model paths fail closed. Cross-provider credential headers, cookies, bearer/proxy authorization and URL credentials are rejected. Credentials and raw bodies never enter evidence.

Every dispatch requests `redirect: manual`; redirects and already-redirected responses fail before SDK processing. Request objects are rejected instead of partially reconstructing them and losing their signal. Plain-request cancellation is combined with attempt and overall abort signals; already-aborted calls never dispatch. Responses are consumed through a size-bounded reader, cancelled on overflow/timeout, and reconstructed byte-for-byte for the SDK. Unlike the earlier clone/text approach, this does not accumulate an unbounded response before checking its size. Runtime transport chunk allocations are not a universal memory sandbox.

Local guards cannot constrain URLs followed inside Composio's backend. All SDK requests are guarded in a dedicated process; unknown destinations and the npm upgrade probe are blocked. This is not designed to sandbox malicious local agent code or share a server process with arbitrary concurrent work.

## Remaining blockers: do not unlock with an attestation flag

1. **Input-token bound:** Google documents [counting input tokens](https://ai.google.dev/gemini-api/docs/tokens), but the installed SDK has no audited local tokenizer for this complete request. The offline oracle returns fixture counts only. A real tokenizer or separately reviewed countTokens protocol must cover schema/other overhead, with its own request and budget treatment. Post-response usage detects an overrun too late to prevent spending; bytes/4 is not accepted.
2. **Output/thinking semantics:** request `maxOutputTokens` and combined reported usage are enforced/tested in mocks. The current [thinking guide](https://ai.google.dev/gemini-api/docs/thinking) explicitly describes a combined limit for Interactions; the [REST generation reference](https://ai.google.dev/api/generate-content) does not by itself establish the same billing envelope for this exact model and endpoint. Do not silently migrate APIs or assume the distinction away.
3. **Composio costs/account:** applicable plan, remaining quota, search/fetch provider charges, retries and add-ons need account-specific confirmation within the proposed maximum. No account API was queried. The public [pricing page](https://composio.dev/pricing) is not a per-request billing receipt.
4. **Backend network:** establish or explicitly review remote fetch redirect/private-destination restrictions; local manual redirects cover only the client-to-provider hop.
5. **Real-account integration:** the working capture account remains explicitly mock-only. A production journal must reconcile every historical live ledger and prevent double seeding/reset/concurrent independent accounts. No real-mode adoption or misleading live provenance was enabled.

The live entry point refuses all native execution while any of these remain unresolved. The profile is promising on paper, but **a meaningful single-target live experiment cannot yet be declared safe under the cap**. Do not shrink token limits further or increase the cap to hide these gaps.

## Offline verification and commands

```powershell
node examples/composio-capture/live.mjs --preflight
node examples/composio-capture/worker.mjs experiment-mock ../composio-agent <isolated-output> success
pnpm.cmd check
```

With installed SDKs and unchanged agent: success used 6 model attempts, 2 searches, 2 fetches and 1 setup; one model 503 used 7 model attempts; one tool 503 used 5 tool attempts. All completed against mocked Responses. The original normal CLI also completed with mock capture disabled in an isolated copy. No real authentication/provider availability was tested.

Quality gate: **299 tests passed, one existing POSIX-only skip, 28 test files**; Biome/compiler checks passed with the existing 15 informational notices. Source-agent worktree remains clean; 180 original source/result/package hashes and all seven historical experiment tree hashes match prior checkpoints. New local mock evidence is ignored, not committed as live evidence.

Stop here. Further preparation needs a concrete solution to the blockers above, followed by a fresh preflight and separate explicit live approval. No live runner can be unlocked by the current authorization argument.
