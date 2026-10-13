# Live Gemini validation

## Status

Live validation remains incomplete: generation returned HTTP 503 before a baseline could finish. The sanitized provider diagnostic identifies `UNAVAILABLE` due to high model demand, not an authentication or billing error. No measured token/cost savings are claimed. Model metadata lookup succeeded with the same key; a key problem was not demonstrated. Provider usage for failed requests is unknown, not zero.

Individual request logs and budget reservations stay in ignored local evidence under examples/live-gemini/.abilitybench/. They are not tracked as per-call reports. Explicit retries carry reconciled exposure forward under the shared $0.10 estimated ceiling; no automatic retries or model substitutions are enabled.

The adapter's offline tests pass. The full Windows quality gate passed with 202 active tests and one existing POSIX-only skip. Mocked request counts are not live evidence. No engine, cloud, replay, or UI features were added.

## Reconciled budget and model audit

Successful responses settle their individual reservation using validated provider token counts and the recorded published rates; unused reservation is released. Requests with unknown usage retain the full conservative reservation. On explicit retry, exposure is recomputed from each ledger's attempt entries using its original settings/prices, rather than summing cumulative totals. Known usage is validated before reconciliation, including failed requests that nevertheless returned valid usage. Historical evidence is not rewritten.

The cap remains $0.10. A full-protocol preflight checks all 12 worst-case requests before dispatch. Every dispatched attempt still reserves separately and counts toward the attempt limit. Unknown usage stops that invocation; retries require another explicit invocation and cannot reset exposure. An exclusive local budget lock prevents concurrent invocations from sharing the same headroom. A stale lock fails closed: investigate the interrupted process before removing that exact lock; never clear ledgers to unlock spending.

Current aggregate retained evidence: one known-usage response costs an estimated $0.00241275; three unknown-usage failures retain $0.020736. Reconciled exposure is $0.02314875, leaving $0.07685125 conservative headroom. The unchanged protocol reserves $0.082944, so its cumulative worst-case requirement is $0.10609275. Its actual final cost and invoice charges remain unknown. These figures were calculated offline; no live requests were made during the accounting fix.

The retained `options` failure is HTTP 503 `UNAVAILABLE` with a provider message identifying high model demand. The preceding `facts` response succeeded with reported usage on the same selected model. This supports a transient service-capacity explanation rather than an invalid model/key diagnosis; it does not establish present availability for this account. Public model documentation still lists [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash). No API availability probe was made during this audit.

The validation pins `SETTINGS.model` to `gemini-3.8-flash` and uses direct REST with LOW thinking and a 1,024-token output/thinking allowance. The env file supplies a key, not a model override. Composio instead reads `GEMINI_MODEL=gemini-3.5-flash-lite`, uses the Google SDK with structured JSON output, and has application-level transient retries; its research-step budget is not this dollar guard.

[Published pricing checked 2026-10-13](https://ai.google.dev/gemini-api/docs/pricing) distinguishes Flash-Lite ($0.30/M input, $2.50/M output including thinking), optimized for cost-efficient high-volume tasks, from Flash ($0.75/M input, $3.75/M output through year-end), positioned for more complex agent workflows. With the same token allowances, a hypothetical Flash-Lite protocol reserves $0.0454656 and would fit existing headroom. Switching requires compatible settings, matching pricing, a new baseline, and an explicit experiment decision; it has not been implemented. A cap increase is required only to guarantee the unchanged Flash protocol's worst-case allowance, not demonstrated actual spending.

Offline tests cover settlement and duplicate settlement, legacy ledger reconciliation, known/unknown failures, explicit retries, preflight without dispatch, per-attempt cap enforcement, concurrent lock rejection, configured model routing, and the complete mocked 5/2/5 protocol.

## Protocol and acceptance

See [the experiment contract](../examples/live-gemini/README.md) for the DAG, inputs, pricing, bounds and invocation. Run a full baseline, change only the report prompt, run an incremental candidate against that immutable baseline, then run a full changed-prompt control.

Expected calls are 5 / 2 / 5. The candidate must reuse catalog/facts/options/risks and execute report/summary. Verify unchanged baseline bytes and matching earlier fingerprints/artifacts. Report actual provider tokens, calls, tool invocations, elapsed time and estimated cost separately; do not substitute predictions for measurements.

## Interpretation limits

Gemini callbacks are stochastic and do not satisfy the engine's purity contract. This experiment uses a plan-directed capture adapter with declared immutable response snapshots. A successful result would demonstrate avoided paid calls through snapshot reuse—not native caching of arbitrary live-provider callbacks. The custom adapter adds integration overhead; this experiment does not authorize an engine redesign.

One serial sample is not a throughput or factual-quality benchmark. Provider latency and fresh control outputs may vary. Published-rate estimates are not invoices, and free-tier charges may differ. Frozen snapshots do not detect external facts changing outside the declared source boundary. The thesis remains unproven until the live protocol completes.
