# Live Gemini validation

## Status

Live validation remains incomplete: generation returned HTTP 503 before a baseline could finish. The sanitized provider diagnostic identifies `UNAVAILABLE` due to high model demand, not an authentication or billing error. No measured token/cost savings are claimed. Model metadata lookup succeeded with the same key; a key problem was not demonstrated. Provider usage for failed requests is unknown, not zero.

Individual request logs and budget reservations stay in ignored local evidence under examples/live-gemini/.abilitybench/. They are not tracked as per-call reports. Explicit invocations carry reconciled exposure forward under the shared $0.10 estimated ceiling. Bounded HTTP 503 retries are supported within an invocation; no model substitutions are enabled.

The adapter's offline tests pass. The full Windows quality gate passed with 207 active tests and one existing POSIX-only skip. Mocked request counts are not live evidence. No engine, cloud, replay, or UI features were added.

## Reconciled budget and model audit

Successful responses settle their individual reservation using validated provider token counts and the recorded published rates; unused reservation is released. Requests with unknown usage retain the full conservative reservation. On explicit retry, exposure is recomputed from each ledger's attempt entries using its original settings/prices, rather than summing cumulative totals. Known usage is validated before reconciliation, including failed requests that nevertheless returned valid usage. Historical evidence is not rewritten.

The cap remains $0.10. A full-protocol preflight checks all 12 required successful requests before dispatch. Every attempt reserves separately, including automatic 503 retries, and counts toward the 15-attempt total limit. Unknown usage stops the invocation except for specifically bounded 503 recovery, where the failed attempt's full reservation remains held. Every retry must leave worst-case headroom for all outstanding required captures. An exclusive local budget lock prevents concurrent invocations from sharing the same headroom. A stale lock fails closed: investigate the interrupted process before removing that exact lock; never clear ledgers to unlock spending.

Current aggregate retained evidence: one known-usage response costs an estimated $0.00241275; three unknown-usage failures retain $0.020736. Reconciled exposure is $0.02314875, leaving $0.07685125 conservative headroom. The unchanged protocol reserves $0.082944, so its cumulative worst-case requirement is $0.10609275. Its actual final cost and invoice charges remain unknown. These figures were calculated offline; no live requests were made during the accounting fix.

The retained `options` failure is HTTP 503 `UNAVAILABLE` with a provider message identifying high model demand. The preceding `facts` response succeeded with reported usage on the same selected model. This supports a transient service-capacity explanation rather than an invalid model/key diagnosis; it does not establish present availability for this account. Public model documentation still lists [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash). No API availability probe was made during this audit.

The validation pins `SETTINGS.model` to `gemini-3.8-flash` and uses direct REST with LOW thinking and a 1,024-token output/thinking allowance. The env file supplies a key, not a model override. Composio instead reads `GEMINI_MODEL=gemini-3.5-flash-lite`, uses the Google SDK with structured JSON output, and has application-level transient retries; its research-step budget is not this dollar guard.

[Published pricing checked 2026-10-13](https://ai.google.dev/gemini-api/docs/pricing) distinguishes Flash-Lite ($0.30/M input, $2.50/M output including thinking), optimized for cost-efficient high-volume tasks, from Flash ($0.75/M input, $3.75/M output through year-end), positioned for more complex agent workflows. With the same token allowances, a hypothetical Flash-Lite protocol reserves $0.0454656 and would fit existing headroom. Switching requires compatible settings, matching pricing, a new baseline, and an explicit experiment decision; it has not been implemented. A cap increase is required only to guarantee the unchanged Flash protocol's worst-case allowance, not demonstrated actual spending.

Offline tests cover settlement and duplicate settlement, legacy ledger reconciliation, known/unknown failures, explicit retries, preflight without dispatch, per-attempt cap enforcement, concurrent lock rejection, configured model routing, and the complete mocked 5/2/5 protocol.

## Protocol and acceptance

See [the experiment contract](../examples/live-gemini/README.md) for the DAG, inputs, pricing, bounds and invocation. Run a full baseline, change only the report prompt, run an incremental candidate against that immutable baseline, then run a full changed-prompt control.

Expected successful captures are 5 / 2 / 5, plus separately reported bounded retry attempts. The candidate must reuse catalog/facts/options/risks and execute report/summary. Verify unchanged baseline bytes and matching earlier fingerprints/artifacts. Report actual provider tokens, calls, tool invocations, elapsed time and estimated cost separately; do not substitute predictions for measurements.

## Bounded retries and failure reporting

Only HTTP 503 is automatically retried: at most three attempts per stage, 15 overall, with 1s then 2s exponential backoff plus 0-250ms jitter. `Retry-After` delta seconds and HTTP dates are minimum waits. A value over the 30s wait bound causes a stop rather than an early retry. The five-minute deadline, per-call timeout, remaining protocol headroom, and cumulative cap still apply. Authentication errors, 429 responses, ambiguous successful-response usage, malformed output, and network timeouts are not automatically retried.

Reports distinguish `providerFailures`, `abilityBenchFailures`, and `adapterOrGuardFailures`, with a separate final stop origin. Recovered provider failures remain visible. A failed capture attempt is never marked completed, and a capture-phase failure does not publish a completed engine run. Only actual engine results populate `executionResults`. A successful experiment can still have incomplete billing information: unknown attempts remain reserved, known costs are labelled, and affected token/cost savings are reported unavailable instead of treating failures as free. Retry wait time is separate from request time and included in end-to-end time.

Offline verification of a hypothetical $0.11 cumulative cap: retained exposure $0.02314875 plus 12 worst-case calls $0.082944 equals $0.10609275, leaving $0.00390725. Thus the no-retry protocol fits, but one extra full reservation does not fit until successful requests release enough headroom. The guard stops rather than compromising outstanding protocol reservations. Reserving all 15 allowed attempts at their maximum would require $0.12682875. Budget safety is not guaranteed provider availability or completion, and published-rate reservations are not an enforceable invoice cap. The production default remains $0.10 pending explicit approval; no live requests were made during verification.

## Interpretation limits

Gemini callbacks are stochastic and do not satisfy the engine's purity contract. This experiment uses a plan-directed capture adapter with declared immutable response snapshots. A successful result would demonstrate avoided paid calls through snapshot reuse—not native caching of arbitrary live-provider callbacks. The custom adapter adds integration overhead; this experiment does not authorize an engine redesign.

One serial sample is not a throughput or factual-quality benchmark. Provider latency and fresh control outputs may vary. Published-rate estimates are not invoices, and free-tier charges may differ. Frozen snapshots do not detect external facts changing outside the declared source boundary. The thesis remains unproven until the live protocol completes.
