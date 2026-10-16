# Final planned synthetic V2 attempt

Date: 2026-10-16. Status: **incomplete; synthetic validation attempts closed**. No automatic retry, replacement experiment, adapter patch, or engine change followed this result.

## Outcome

Configuration `source-grounded-v2-json-v1`, model `gemini-3.5-flash-lite`, cumulative cap $0.11. The fresh experiment was `experiment-4f9pIm`; no immutable execution baseline was published because capture failed first.

| Phase | Result | Captures | Engine stage reuse/execution |
| --- | --- | --- | --- |
| Baseline | Stopped at first facts request, HTTP 400 | 0 of 5 | No engine run published; no stage completion or reuse asserted |
| Incremental | Not started | 0 of 2 | Not executed |
| Full control | Not started | 0 of 5 | Not executed |

The declared graph remained catalog -> facts; catalog/facts -> options and risks; catalog/options/risks -> report; catalog/report -> summary. Only the report prompt would have changed for the candidate. Those planned decisions are not observed execution evidence.

## Root cause and accountability

The provider rejected the first request with `400 INVALID_ARGUMENT` at `generation_config.response_format.text.mime_type`: the adapter sent `"application/json"`, but this wire field is an enum. The [REST reference](https://ai.google.dev/api/generate-content) defines `TextResponseFormat.mimeType` using `APPLICATION_JSON` and `TEXT_PLAIN`. The prior implementation followed a guide example's MIME string rather than resolving its conflict with the enum reference. Offline mocks accepted the constructed request and therefore did not establish real endpoint compatibility. The previous readiness assessment overstated that compatibility.

This is an **adapter request-configuration defect**, surfaced as an HTTP provider rejection, not provider unavailability, an API-key diagnosis, model-generated bad JSON, or an AbilityBench engine failure. The existing result file labels HTTP errors `provider`; that transport label must not be mistaken for ownership of this defect. `abilityBenchFailures` is empty and `executionResults` is empty. No implementation was changed to force this attempt to pass.

No facts response was generated/accepted. Strict parsing, schema/source checks, retry limits, timeouts, and budget rules stayed enabled. They were not all exercised end-to-end. HTTP 400 is not retryable under the configured policy; there were zero retries and no budget interruption. Grounding, output equivalence, correctness of reuse, and quality regression cannot be evaluated for this attempt. Absence of generated output is not a passing quality result.

## Usage and budget

| Measurement | Value |
| --- | --- |
| HTTP generation attempts / successful captures | 1 / 0 |
| Reported input/output/thinking/total tokens | Unknown; no usage metadata |
| Known-usage estimated cost in this attempt | $0, **not proof of zero billing** |
| Retained unknown-usage exposure | $0.0037888 |
| Recorded request duration | 1,593.5719 ms |
| Observed process wall time | Approximately 2.735 s; not a persisted phase benchmark |
| Provider tool calls | 0; no tools enabled |
| Completed engine runs | 0 |
| Prior cumulative accounted exposure | $0.03352405 |
| New cumulative accounted exposure | $0.03731285 |
| Remaining under $0.11 cap | $0.07268715 |

Across retained history, known estimated usage cost remains $0.00587605 and unknown exposure is now $0.0314368. Rates are the configured estimates, not billing receipts. The guard conservatively retains the full failed reservation even though a validation rejection may not be billed. No ledger was reset or reconciled without usage evidence.

## Evidence and conclusion

Ignored local evidence: `examples/live-gemini/.abilitybench/experiment-4f9pIm/results.json`, `usage-ledger.json`, and the prepared baseline inputs/configuration. The ledger retains the request hash and sanitized HTTP diagnostic; no raw failed-request payload or API key is committed. SHA-256 tree checks confirmed all six prior experiment directories unchanged. The new experiment tree is retained separately.

This attempt demonstrates fail-closed handling of an invalid request, no false stage completion, and conservative failed-request accounting. It provides **no new caching, savings, or quality-regression evidence**. The completed V1 snapshot sample and its limitations remain historical evidence, not a substitute for a successful source-grounded V2 protocol.

Synthetic validation is now closed with this blocker recorded. Next work is the [real Composio integration plan](./composio-integration-plan.md), using the agent's existing SDK and workflow rather than another synthetic REST experiment.
