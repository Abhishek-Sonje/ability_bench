# Budgeted live Gemini validation

This experiment uses the existing engine unchanged. No SDK provider integration, replay feature, cloud service, UI, or cost-tracking subsystem is added.

## Contract and design

Live Gemini responses are nondeterministic, even with fixed generation settings. They must **not** be presented as pure stage callbacks. This adapter first asks the engine for a plan; it captures new responses only for planned executing stages, then supplies those immutable snapshots as watched files to deterministic stage callbacks. Each snapshot includes the canonical request hash, resolved response model version and provider usage. Callbacks validate the request against explicit dependency outputs and return only the captured text. Baseline/candidate snapshots live in separate physical project roots; earlier snapshots are copied byte-for-byte, never regenerated for the candidate. Source, prompts, settings, adapter code, and relevant snapshot files are declared influences.

This tests plan-directed incremental AI orchestration with explicit response snapshots. It does not prove that arbitrary live-provider functions are pure, that the engine natively integrates providers, or that new stochastic outputs would equal reused ones. That integration gap is part of the result, not hidden behind `cache: true`.

```text
catalog (local read tool / immutable synthetic input)
  └── facts (Gemini)
       ├── options (Gemini) ──┐
       └── risks (Gemini) ────┴── report (Gemini) ── summary (Gemini)
```

One baseline has five Gemini requests and one local catalog lookup. Change only the report prompt; the incremental candidate must reuse catalog/facts/options/risks, execute report/summary, and issue exactly two Gemini requests with no catalog lookup. A full changed-prompt control issues five fresh requests and one catalog lookup, allowing measured—not projected—comparison with a full rerun. Both incremental and full control reference identical source/prompts/settings, but fresh upstream AI output may differ stochastically.

## Bounds

The 5/2/5 request counts above refer to successful captures. Transient 503 attempts are additional requests, reported and reserved separately; they never count as successful workflow-stage completion.

- Synthetic data only; no private Composio research is sent.
- User-approved model: `gemini-3.5-flash-lite`, with LOW thinking retained. [Model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) support the existing token allowances. Earlier Flash evidence remains separate and contributes exposure at its original rates.
- [Pricing checked 2026-10-13](https://ai.google.dev/gemini-api/docs/pricing): standard input $0.30/M, cached input $0.03/M, output including thinking $2.50/M, USD. These are estimates, not billing receipts; a free-tier account may incur no actual monetary charge.
- Twelve required successful captures; at most 15 total generation attempts per invocation. Only HTTP 503 is automatically retried, at most three attempts per stage, with 1s then 2s exponential backoff plus jitter. `Retry-After` seconds/date is a minimum wait; values exceeding the 30s wait bound stop instead of retrying early. No fallback models. Maximum 1,024 output/thinking tokens per request; request body capped at 2,048 UTF-8 bytes, conservative input reservation 4,096 tokens; user-approved cumulative estimated-budget ceiling $0.11. Full-protocol preflight must fit before dispatch, and every retry must leave worst-case headroom for outstanding required captures. Reserve separately per attempt; settle known usage at validated published-rate cost and release unused reservation. Unknown usage retains its full reservation; only bounded 503 recovery may continue automatically with unknown failed-attempt usage. Explicit invocations recompute exposure from all retained attempt entries using original settings/pricing. An exclusive budget lock prevents concurrent spending; stale locks fail closed. Do not remove ledgers to bypass the budget.
- At most 45 seconds per call and five minutes for the overall experiment. Budget reservations are client-side guardrails, not an independently enforceable provider invoice limit. Failed/timed-out requests may still be billed.
- Local ignored evidence includes requests, responses, usage ledger, immutable engine manifests, and measurements. It contains no API key. Local adapter metrics are separate from stage outputs/engine storage.

## Run

The completed controlled sample and all limitations are recorded in [the Lite validation results](../../docs/live-gemini-lite-results.md). Running again is another charged experiment, not a replay of that sample; retained exposure remains cumulative.

```bash
pnpm build
node examples/live-gemini/run.mjs --env-file C:/Users/HP/Desktop/Programming/WebDev/Projects/composio-agent/.env
```

Or set `GEMINI_API_KEY` in the process and omit `--env-file`. The env file is read only inside the process; neither its values nor file bytes are copied into evidence. `GEMINI_MODEL` is not an override: this experiment deliberately pins `SETTINGS.model`. See the [model comparison and reconciled accounting audit](../../docs/live-gemini-validation.md). Live execution is never part of CI; offline mocked tests verify the adapter and budget rules.

Results separately report provider failures, AbilityBench failures, adapter/guard failures, actual engine execution results, provider input/output/thinking/cached/total tokens, generation attempts/successes, local tool calls and provider tool calls (zero: no tools enabled), request duration, retry wait, end-to-end duration, known estimated spend, unknown-usage reservations, stage decisions, and immutable-baseline proof. Token/cost savings affected by unknown usage are unavailable, not inferred as zero. A single small sample is not a throughput benchmark, factual-quality evaluation, or generalized percentage-savings claim.
