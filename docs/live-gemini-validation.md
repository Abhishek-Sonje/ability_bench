# Live Gemini validation: first attempt

## Status

**Blocked at the first generation request; no measured savings result.** The read-only viewer milestone is separately closed by user acceptance. No engine, cloud, replay, or UI feature was added for this experiment.

The experiment adapter and offline guardrails are committed at `bc654cd`. `pnpm check` passed on Windows: 198 active tests, one existing POSIX-only skip, build, browser/Node type checks and lint. Offline tests use mocked responses; their 5/2/5 request counts are not live evidence.

## Controlled protocol

See [the experiment contract](../examples/live-gemini/README.md) for the branched/joined DAG, explicit snapshot purity boundary, bounds, pricing, and invocation. The intended protocol is a full baseline, a report-prompt-only incremental candidate against that immutable baseline, and a separate full changed-prompt control. The engine's preliminary plan authorizes which AI snapshots the adapter acquires; final engine decisions must agree with it.

Five baseline AI requests, two candidate AI requests, and five full-control AI requests are expected if all phases finish. Catalog/facts/options/risks must reuse for the candidate, and report/summary must execute. These are assertions to test, not a claimed live outcome.

The latest GA Flash model was verified using [Google's model guide](https://ai.google.dev/gemini-api/docs/latest-model), and introductory USD rates were checked using [Google's pricing](https://ai.google.dev/gemini-api/docs/pricing). Token reporting follows [the generateContent usage metadata contract](https://ai.google.dev/api/generate-content#UsageMetadata), including thinking tokens and recorded provider cache hits.

## Actual first attempt

Local evidence: `examples/live-gemini/.abilitybench/experiment-9o1PUB/usage-ledger.json` (ignored, retained).

| Measurement | Observed result |
| --- | --- |
| Model requested | `gemini-3.8-flash` |
| Generation attempts | 1 (`baseline / facts`) |
| Successful generations | 0 |
| Generation result | HTTP 503 |
| Request duration | 3,722.89 ms |
| Returned provider usage | None |
| Actual input/output/thinking tokens | Unknown, not zero |
| Actual charge / estimated consumed cost | Unknown |
| Conservative client reservation for this attempt | $0.006912 |
| Completed baseline/candidate/full-control scenarios | 0 / 0 / 0 |
| Provider tool invocations | 0 (no provider tools enabled) |
| Completed local catalog-lookup stage invocations | 0 (capture failed before engine execution) |
| Real savings | Not measurable yet |

The adapter stopped after the error, retained the failure, flagged unknown usage, and did not retry or reset its budget. No completed results file or baseline manifest was published. The ledger's measured-cost accumulator of zero covers zero successful accounted responses; it must not be interpreted as a zero-cost failed request.

One subsequent **read-only model metadata lookup**, not a generation retry, returned HTTP 200, identified `models/gemini-3.8-flash`, and listed `generateContent` as supported. This confirms metadata availability, not that generation is currently healthy. The cause of the generation 503 was not diagnosed; the provider's diagnostic body was not printed. No secret or private research was logged/transmitted as prompt content; the key was used only in the API authentication header.

## Conclusions and remaining risks

The real-usage thesis is neither proved nor disproved by a provider failure. Offline planning/immutability assertions pass, but they cannot substitute for a completed live baseline/candidate and actual usage savings. A later explicit retry must keep this failed attempt's unknown-cost reservation in the overall validation budget; it cannot silently treat it as free.

There is also a genuine integration limitation independent of availability: stochastic provider callbacks do not satisfy the engine's deterministic cacheability contract. This experiment needs a custom, two-phase capture adapter and explicit snapshots. If live execution succeeds, the claim will be **plan-directed snapshot reuse avoided paid calls**, not **arbitrary LLM functions can safely be cached as pure**. The adapter has nontrivial integration overhead; it is not a native SDK provider feature. No engine redesign is justified or authorized by this experiment alone.

One small serial sample cannot establish latency percentiles, rate-limit behavior, factual quality, or savings across arbitrary agents. Time can vary because of provider load. A full changed-prompt control generates fresh upstream responses, so its text may differ. Cost estimates use published rates, not invoice evidence; free-tier accounting may differ. Declared snapshots deliberately freeze earlier outputs and do not detect facts that changed outside the declared source boundary.

Next required result: complete the live baseline/candidate within the remaining budget, verify exact baseline lineage and unchanged bytes, compare measured calls/tokens/time/estimated cost, and report any negative or inconclusive result plainly. No further UI work is part of that step.
