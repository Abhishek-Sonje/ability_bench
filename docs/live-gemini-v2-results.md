# Controlled V2 live validation outcome

2026-10-16, Gemini 3.5 Flash-Lite, existing cumulative $0.11 cap. One fresh experiment was attempted; no second experiment was started and no implementation/check was changed to obtain a pass.

## Preflight

- Public [standard pricing](https://ai.google.dev/gemini-api/docs/pricing) was rechecked: $0.30/M input, $2.50/M output including thinking, $0.03/M cached input. It matched the unchanged configured rates.
- [Model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [LOW thinking support](https://ai.google.dev/gemini-api/docs/generate-content/thinking) support the existing 4,096-input-token reservation and 1,024 output/thinking-token allowance. The input reservation is conservative accounting, not a preflight tokenizer result. No extra countTokens call was made.
- Exact initial request: 645 UTF-8 bytes. Source-valid offline representative requests for downstream stages: 894-1,237 bytes, below the 2,048-byte guard. Future generated dependency lengths were unknown; every real request remained subject to the same pre-dispatch size check. No claim was made that all possible generated wording would fit.
- Retained exposure $0.03335395; available headroom $0.07664605. Twelve worst-case calls reserve $0.0454656; all 15 permitted attempts reserve $0.056832. Including retained exposure, the latter totals $0.09018595, leaving $0.01981405 under the cap.
- Offline quality gate: 212 active tests passed, one existing POSIX-only skip. Repository implementation was clean before execution.

## Phase results

| Phase | Outcome | Reuse/execution evidence |
| --- | --- | --- |
| Baseline | Stopped at first facts capture | No engine execution or completed manifest |
| Incremental | Not started | No reuse/rerun result |
| Full control | Not started | No comparison result |

The source catalog validation passed. Gemini returned HTTP 200, finishReason STOP, and the requested resolved model version, but wrapped its facts object in a Markdown json code fence. The strict facts parser rejected that complete response as not JSON. The attempt was recorded as failed, the accepted snapshot remained the original `{}` placeholder, and no completed workflow stage or baseline was claimed.

Read-only diagnosis confirmed that the object *inside* the fence exactly matches the required source facts: budget 70, team size 3, daily tickets 40, required human-review option B. This diagnostic extraction did not alter or accept the response and did not change the failed experiment outcome. No unsupported fact was observed in that inner object; options, risks, reports, and summaries were not generated, so their grounding/consistency and regression outcomes are untested.

## Root cause

This was a provider-output/adapter format-contract mismatch, not provider unavailability, an API-key failure, budget exhaustion, or an observed AbilityBench correctness failure. The request asked for JSON in prose but supplied no provider-native JSON output format or response schema; generationConfig contained only maxOutputTokens and LOW thinking. Prompt-only JSON instructions did not enforce the transport contract. The deterministic grounding gate correctly refused to accept Markdown as strict JSON.

Provider failures: none. AbilityBench failures: none; its executor never started. Final stop origin: `grounding_validation`. No retry was attempted because HTTP 200 format/quality failures are intentionally not eligible for automatic 503 retries. Request size, reported token usage, cost, timeout, and cap checks did not cause the stop.

## Actual usage and accounting

| API attempts | Accepted captures | Input | Output | Thinking | Cached input | Total tokens | Estimated USD |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 117 | 54 | 0 | 0 | 171 | 0.0001701 |

All usage for this attempt was reported, including the rejected output; new unknown exposure is zero. Costs use published standard rates, not a billing invoice or proof of a monetary charge on a free-tier account. The failed capture's $0.0037888 reservation settled to $0.0001701, releasing $0.0036187. Cumulative exposure is $0.03352405, including unchanged $0.027648 historical unknown-usage reservations; remaining conservative headroom is $0.07647595.

The request took 4.438 seconds. The command process was observed at 4.784 seconds including setup; no complete baseline-phase or engine execution timing was produced. No provider tool calls were configured.

## Evidence and conclusion

Local ignored evidence: `examples/live-gemini/.abilitybench/experiment-4s9fDE/`, containing results.json, usage-ledger.json, the exact provider request/response, and the isolated V2 baseline preparation. All five previous experiment trees were checksummed before and after and are byte-identical. No prior snapshot, manifest, result, ledger, prompt, or pricing record was overwritten.

V2 does **not** yet demonstrate successful incremental execution without quality regressions. The experiment supports only that source data reached the first request, accounting reconciled known usage, and the strict gate stopped a malformed transport response without false completion. The earlier V1 live result remains closed and is not replaced by this failure. Output equivalence and final-report grounding cannot be assessed because neither candidate nor control ran.

## Recommended Composio integration sequence — not implemented

1. Align the provider response-format contract offline before another paid validation. Composio's existing `src/agent/gemini-model.ts` already requests JSON with a response schema. Use the provider's version-compatible [structured-output configuration](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) for the strict facts contract while retaining local field/value validation. Do not silently strip fences from this historical response or relax its outcome. A future request-format revision must be fingerprinted and use a fresh baseline.
2. Build an offline integration around one saved Composio application's real evidence. Preserve source URLs, source excerpts/bytes or hashes, and capture times; feed the complete relevant evidence explicitly to normalization, claim checks, and report stages. Test contradictions, missing citations, malformed JSON, and source changes deterministically.
3. Declare a small static DAG around those coarse stages. `researchApp()` selects search/fetch actions dynamically, so its individual future tool calls cannot honestly be predeclared as fixed DAG nodes. Treat bounded research acquisition as an explicit non-cacheable boundary or plan-directed external capture, then cache only deterministic snapshot consumers. Do not add tool replay or call live network/tool functions pure.
4. After offline contracts pass, obtain approval and a separate cost estimate for one bounded real-agent experiment. Count all internal SDK retries, model subcalls, Composio tool operations, and unknown failures against its budget; the toy example's 12-call reservation is not a budget estimate for dynamic research. Freeze the evidence snapshot for a late report-prompt candidate, compare with a full control, and assess source-grounded quality separately from execution reuse. Explicit refreshes must reacquire evidence rather than imply reused snapshots reflect the current web.

No adapter fix, Composio modification, further live call, engine feature, or relaxed validation criterion is included in this outcome.
