# Live Gemini Flash-Lite validation results

Completed on 2026-10-13 with Node v24.20.0 on Windows x64. This is one controlled real-provider sample, not a generalized benchmark.

## Outcome

All three phases completed against `gemini-3.5-flash-lite`, with LOW thinking and a 1,024-token output/thinking ceiling. Exactly 12 API attempts succeeded: baseline 5, incremental 2, full control 5. No provider errors, retries, budget interruptions, adapter failures, or AbilityBench failures occurred. All response model versions matched the requested Lite model. The execution engine, DAG, prompts, dependency declarations, fingerprint algorithm, artifact checks, and acceptance criteria were unchanged; only the requested model and its published pricing profile changed.

## Execution and reuse

| Stage | Baseline | Incremental | Full control | Incremental reason |
| --- | --- | --- | --- | --- |
| catalog | Executed | Reused | Executed | fingerprint_match |
| facts | Executed | Reused | Executed | fingerprint_match |
| options | Executed | Reused | Executed | fingerprint_match |
| risks | Executed | Reused | Executed | fingerprint_match |
| report | Executed | Executed | Executed | fingerprint_changed: watchedFiles |
| summary | Executed | Executed | Executed | dependency_executed: report |

The candidate names the exact immutable baseline. All four reused stages retain identical baseline fingerprints and output artifact hashes. The original baseline manifest remained byte-identical. Initial and final execution plans agreed. A separate post-run read used the existing verified manifest/artifact stores to decode every stage output in all three phases. Checksums confirmed all four earlier Flash experiment trees remained unchanged.

Immutable run IDs:

- Baseline: `run_abf36ba372b4e89c8e162581e47367b784f460f2bb18e1feb740189daa56c83e`
- Incremental: `run_2c556eafc238b447b923c4bbcfb7505c805d103c980e24923ea83c929e3036a3`
- Full control: `run_82e1fc12203c01f92b0800c5bdf457fb71c0a7e730da5611922bafd41de06035`

Detailed local evidence is retained, ignored by Git, under `examples/live-gemini/.abilitybench/experiment-Hzaz1M/`: `results.json`, `usage-ledger.json`, `output-comparison.json`, provider request/response captures, and the three isolated workflow roots. No API credentials are included.

## Reported usage and estimated cost

| Phase | API calls | Input tokens | Output tokens | Thinking tokens | Total tokens | Estimated USD | End-to-end seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 5 | 770 | 132 | 0 | 902 | 0.0005610 | 7.498 |
| Incremental | 2 | 396 | 46 | 430 | 872 | 0.0013088 | 2.887 |
| Full control | 5 | 803 | 153 | 320 | 1,276 | 0.0014234 | 6.444 |
| Total | 12 | 1,969 | 331 | 750 | 3,050 | 0.0032932 | — |

All new requests reported usage; none has unknown exposure. Provider-cached input tokens were zero, so these avoided calls are not provider prompt-cache hits. Local catalog lookup counts were 1/0/1; provider tool calls were zero in every phase. End-to-end durations include local planning/capture/execution; request-only totals were 7.387s / 2.794s / 6.352s. No retry waits occurred.

Costs use reported tokens and [published standard Lite pricing checked 2026-10-13](https://ai.google.dev/gemini-api/docs/pricing): $0.30/M input and $2.50/M output including thinking. They are rate-based estimates, not invoices; account/free-tier charges were not inspected.

The $0.11 cumulative cap remained active. Prior retained exposure was $0.03006075. Adding new known usage gives $0.03335395 exposure, leaving $0.07664605 conservative headroom. This cumulative exposure comprises $0.00570595 known usage-based estimates across experiments and $0.027648 reservations for four earlier unknown-usage Flash failures. Those historical failures were neither counted as free nor repriced at Lite rates. New gross reservations of $0.0454656 settled to $0.0032932, releasing $0.0421724.

## Savings and output comparison

Against the full changed-prompt control, the incremental run used:

- Three fewer API calls: 60% fewer.
- 404 fewer total tokens: 31.66% fewer.
- $0.0001146 less estimated API cost: 8.05% less.
- 3.557s less end-to-end time: 55.20% less in this serial sample.
- One fewer local catalog lookup.

Call savings do not imply proportional cost savings. The incremental report used 430 thinking tokens versus 320 for the full-control report. Incremental cost was also $0.0007478 higher than the original baseline, whose report prompt was different; it was not cheaper than that original run. The changed-prompt full control is the relevant observed rerun comparison, but fresh upstream outputs and thinking consumption differ stochastically.

Incremental versus full control: only `catalog` has identical artifact bytes and text. `facts`, `options`, `risks`, `report`, and `summary` differ in both text and artifacts. Both final reports recommend Option A, but the incremental safeguard is supervisor review of daily escalations; the control proposes a weekly 5% audit of automated responses. No semantic-equivalence or factual-quality evaluator was run. Generated claims are not all source-grounded: the control's automated-response assumption and specific audit percentage are not established by the synthetic catalog. Execution completion is not a quality verdict.

## What this establishes

This sample supports the narrow execution claim: a late prompt change reused four verified earlier snapshots, avoided three new provider requests, and executed only the affected report and its descendant. The paid-rate estimate was lower than the full changed-prompt control in this sample.

The engine still consumes deterministic captured snapshots; live stochastic responses are acquired by a custom plan-directed adapter outside engine callbacks. This is not native caching of arbitrary LLM functions, tool replay, guaranteed fresh-run equivalence, or evidence that caching improves output quality. It demonstrates snapshot-based incremental orchestration and avoided calls, with measurable integration overhead. No second experiment was automatically started.
