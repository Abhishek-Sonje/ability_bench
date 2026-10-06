# Live Gemini validation

## Status

Live validation remains incomplete: generation returned HTTP 503 before a baseline could finish. The sanitized provider diagnostic identifies `UNAVAILABLE` due to high model demand, not an authentication or billing error. No measured token/cost savings are claimed. Model metadata lookup succeeded with the same key; a key problem was not demonstrated. Provider usage for failed requests is unknown, not zero.

Individual request logs and budget reservations stay in ignored local evidence under examples/live-gemini/.abilitybench/. They are not tracked as per-call reports. Explicit retries carry prior reservations forward under the shared $0.10 estimated ceiling; no automatic retries or model substitutions are enabled.

The adapter's offline tests pass. The full Windows quality gate passed with 198 active tests and one existing POSIX-only skip. Mocked request counts are not live evidence. No engine, cloud, replay, or UI features were added.

## Protocol and acceptance

See [the experiment contract](../examples/live-gemini/README.md) for the DAG, inputs, pricing, bounds and invocation. Run a full baseline, change only the report prompt, run an incremental candidate against that immutable baseline, then run a full changed-prompt control.

Expected calls are 5 / 2 / 5. The candidate must reuse catalog/facts/options/risks and execute report/summary. Verify unchanged baseline bytes and matching earlier fingerprints/artifacts. Report actual provider tokens, calls, tool invocations, elapsed time and estimated cost separately; do not substitute predictions for measurements.

## Interpretation limits

Gemini callbacks are stochastic and do not satisfy the engine's purity contract. This experiment uses a plan-directed capture adapter with declared immutable response snapshots. A successful result would demonstrate avoided paid calls through snapshot reuse—not native caching of arbitrary live-provider callbacks. The custom adapter adds integration overhead; this experiment does not authorize an engine redesign.

One serial sample is not a throughput or factual-quality benchmark. Provider latency and fresh control outputs may vary. Published-rate estimates are not invoices, and free-tier charges may differ. Frozen snapshots do not detect external facts changing outside the declared source boundary. The thesis remains unproven until the live protocol completes.
