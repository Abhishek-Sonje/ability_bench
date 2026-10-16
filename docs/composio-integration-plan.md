# Real Composio research integration plan

Status: **Step 1 complete; Step 2 not started; live capture not approved.** See the [offline results and remaining quality findings](./composio-offline-results.md) and [adapter guide](../examples/composio-offline/README.md). Based on inspection of the sibling `composio-agent` checkout on 2026-10-16; no files there were changed. Synthetic validation is [closed with its final adapter blocker](./live-gemini-v2-final-results.md).

## Preserve the existing agent

Keep `src/index.ts` and `npm run research -- <app>` working unchanged. Reuse `researchApp`, `createGeminiResearchModel`, `createComposioResearchTools`, the Zod result schemas, evidence mapping, confidence policy, and unsupported-claim policy. The manual path uses `@google/genai` with `responseMimeType` / `responseJsonSchema`; do not transplant the failed synthetic REST configuration into it.

`researchApp` has a genuinely adaptive choose-action/search/fetch loop, then `createResult` performs synthesis and evidence mapping. Preserve that loop as one opaque live capture operation initially. Do not invent a static DAG node for every potential action, replay tools, or pretend the network callbacks are pure. `runAssessmentBatch` skips any existing schema-valid result by filename; that is not fingerprint-aware reuse. It must not silently stand in for an explicit fresh research capture.

## First deliverable: coarse integration with no research rewrite

Add a separate integration entry point, leaving the current CLI and batch behavior intact. Default to offline inspection of existing captures. A live capture is an explicit, separately budget-approved operation; it invokes the existing agent once for one target and writes an isolated, immutable capture package. Do not overwrite current `results/`, reports, site data, or prior baselines.

Declare the complete post-capture DAG before any engine execution:

```text
load-capture -> validate-result -> assemble-dataset -> analyze -> render-report
                                      |                 |
                                      v                 v
                               publish-dataset    publish-analysis
                                      \                 /
                                       verify-site-data
```

- `load-capture`: watched immutable capture/result bytes plus explicit target and provenance. A capture reference is an explicit choice to reuse historical research, not a claim that the web is unchanged.
- `validate-result`: existing Zod schema and existing evidence/reference checks; watches the schema and relevant policy modules. No invented claims are filled in to obtain a pass.
- `assemble-dataset`: use validated results in explicit target/record order, retain existing duplicate checks. Current `createCombinedDataset` reads the clock; preserve its behavior with a non-cacheable stage initially rather than quietly declaring it pure.
- `analyze`: reuse `analyzeDataset`; it also reads current time, so keep it non-cacheable initially. Consequently report and analysis publication rerun conservatively, even when substantive metrics are unchanged. Making time explicit is a later deliberate compatibility decision, not required for initial integration.
- `render-report`: existing `renderReport` with watched renderer implementation and explicit analysis output. Preserve original row, tie, and opportunity-bucket order. If artifact canonicalization changes object insertion order, use an adapter representation with explicit ordered entries and reconstruct it before rendering; verify byte-for-byte compatibility with the original renderer.
- Publication stages: `cache: false`, isolated declared output-directory env dependency, existing data formats. `verify-site-data` depends on both publications and reads destination bytes; make it non-cacheable because external destination state is mutable. Validate paths before writes and do not touch the normal site directory.

Start with one retained target result; add more target nodes only after the basic adapter is verified. **Verified upstream constraint:** the existing analyzer rejects a one-record dataset and requires the canonical 100-record assessment. Step 1 therefore declares the saved dataset as watched context and replaces only the selected target in its original position; it does not relax the analyzer or create additional research nodes. Separate execution, evaluation, and regression results using existing receipts/read-only viewer. Evaluation failure is not an execution failure. Historical context policy differences are preserved and surfaced by evaluation, not silently rewritten.

## Fingerprints and freshness

Use existing typed inputs, dependency outputs, watched files and manual invalidation; no engine changes. Declare target identity, exact model/generation settings, schemas, prompt modules, evidence policies, relevant source modules, capture hashes, and non-secret configuration. Record source URL, captured content identity, observation order, and acquisition time in provenance. Never fingerprint or store API keys or whole `.env` files. Changing credentials is not evidence that research facts changed.

An explicit refresh makes a new capture identity and reruns descendants against the one immutable baseline. A report-only change must not call Gemini or Composio. An existing baseline must never be silently replaced by the newest capture. Canonicalized storage must not reorder behavior-sensitive observations or rows. The first coarse integration can avoid repeating whole research calls for downstream edits; it does not provide per-action or per-synthesis cache reuse.

## Paid-call instrumentation and guards

Add only a small optional attempt/usage observer at the existing SDK generation boundary, where the full response is available. The current injectable `GenerateJson` seam returns only text, so wrapping it alone cannot prove token usage. Record actual `usageMetadata`, model version, elapsed time, sanitized failure category, and immutable request identity. Decorate `ResearchTools.search/fetchUrl` for attempt count/time/failures without changing tool behavior or replaying results.

Reserve before **every underlying SDK attempt**, reconcile known usage, retain unknown exposure, and gate tool/network work as well as model calls. Inspect/disable or bound SDK-internal retries so accounting cannot miss them. Preserve the current agent's explicit retry semantics unless separately approved; include malformed-output retries and action-correction attempts in the reservation. Existing nested retries mean `maxSteps=10` is not a ten-call ceiling: synthesis and mapping can each retry, and premature finish handling can request additional actions. Do not reuse the synthetic 12-call estimate or claim a bounded complete agent run without counting these paths. Carry the existing $0.03731285 exposure forward; a new real-agent cap/protocol needs an explicit preflight and approval. Composio charges/quotas are separate from Gemini token estimates and must be labelled unknown where unavailable.

## Ordered implementation and acceptance gates

1. **Offline coarse adapter:** load one existing real result; full DAG, typed inputs, watched modules, isolated outputs, immutable baseline. Verify unchanged reuse where valid, schema/policy invalidation, manual refresh identity, report-only edits, publish failure/join skip, and baseline immutability. Match existing output order and renderer bytes. No paid calls.
2. **Capture boundary:** wire the existing `researchApp` behind explicit capture mode. Mock existing model/tools to test observations, failures, retries, usage settlement, budgets, secret redaction, and capture immutability. Keep ordinary CLI tests green. Do not add a second research algorithm.
3. **One approved real run:** one target, reviewed action/token/tool limits, cumulative reservation including all retries, isolated storage. Baseline captures research once; a report-only candidate must make zero new model/tool calls, retain identical research artifact hashes, and explain every decision. Verify existing source/evidence checks separately from execution status. A fresh live control is optional and requires its own budget approval; stochastic text equality is not an acceptance condition.
4. **Only if real usage requires it:** expose the existing collection context and synthesis/mapping boundaries through small exported functions, preserving `researchApp` as a composition wrapper. This enables changing a synthesis prompt against the same declared evidence snapshot without repeating search/fetch. Preserve current prompts, policies, and outputs with tests first. It is an optional follow-up, not justification for rewriting the loop now.

Step 1 and its offline tests are complete. The next proposed task is Step 2's mocked capture boundary, not live capture, another synthetic experiment, provider migration, workflow editor, cloud feature, SQLite layer, or generic tool replay system. Do not proceed automatically from Step 1.
