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

- Synthetic data only; no private Composio research is sent.
- Model: `gemini-3.8-flash`, latest generally available Flash verified in [Google's model guide](https://ai.google.dev/gemini-api/docs/latest-model).
- [Pricing checked 2026-10-04](https://ai.google.dev/gemini-api/docs/pricing): standard input $0.75/M, cached input $0.075/M, output including thinking $3.75/M, USD. These introductory rates expire at year-end. They are estimates, not billing receipts; a free-tier account may incur no actual monetary charge.
- At most 12 generation requests; no automatic retries or fallback models. Maximum 1,024 output/thinking tokens per request; request body capped at 2,048 UTF-8 bytes, conservative input reservation 4,096 tokens; estimated-budget ceiling $0.10. Reserve worst-case estimated cost before dispatch. An unknown/ambiguous usage response stops the experiment; it is not counted as zero cost.
- At most 45 seconds per call and five minutes for the overall experiment. Budget reservations are client-side guardrails, not an independently enforceable provider invoice limit. Failed/timed-out requests may still be billed.
- Local ignored evidence includes requests, responses, usage ledger, immutable engine manifests, and measurements. It contains no API key. Local adapter metrics are separate from stage outputs/engine storage.

## Run

```bash
pnpm build
node examples/live-gemini/run.mjs --env-file C:/Users/HP/Desktop/Programming/WebDev/Projects/composio-agent/.env
```

Or set `GEMINI_API_KEY` in the process and omit `--env-file`. The env file is read only inside the process; neither its values nor file bytes are copied into evidence. Live execution is never part of CI; offline mocked tests verify the adapter and budget rules.

Results must separately report provider input/output/thinking/cached/total tokens, generation attempts/successes, local tool calls and provider tool calls (zero: no tools enabled), request duration and end-to-end duration, estimated spend, stage decisions, and immutable-baseline proof. A single small sample is not a throughput benchmark, factual-quality evaluation, or generalized percentage-savings claim.
