# Mocked research capture boundary (Step 2)

An opt-in example around the **existing** Composio research agent, not an engine feature or a new agent. No provider/framework code is added to `src/` or the public SDK. No dependencies are added. There is **no live mode** in this milestone.

Follow-up: [bounded experiment preparation](../../docs/composio-safety-preparation.md) adds `experiment-mock` and an offline `live.mjs --preflight` command. Its authorization entry remains fail-closed: token/account/provider safety bounds are not yet verified. It is not an executable live runner; ordinary mock/CLI behavior below remains unchanged.

## Run only with mocked responses

```powershell
pnpm build
node examples/composio-capture/worker.mjs mock ../composio-agent examples/composio-capture/.abilitybench success
```

The worker uses fake credentials, two research steps, and a local `Response`-returning transport. It does not read `.env`, fall back to native fetch, or send Gemini/Composio requests. The original SDKs still construct/parse requests and responses; their network responses are mocked. Installed versions are explicitly gated at Gemini SDK 2.23.0 and Composio core 0.18.1, whose transport paths were audited. Different versions require an adapter audit, not an automatic upgrade.

The source project is read-only. Its original functions are type-erased into a unique isolated project, using the same mechanism as Step 1. The worker calls the original `readConfig`, `createGeminiClient`, `createGeminiResearchModel`, `createComposioResearchTools`, and `researchApp`. Its adaptive loop, prompt construction, Zod schemas, evidence mapping, confidence policy, malformed-output retries and transient retry predicates are not rewritten. Generation token settings and retry configuration are not injected. The only model request addition is the SDK's [supported custom fetch hook](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html), which does not change the model payload.

Mock scenarios include `provider-retry`, `tool-retry`, `malformed`, `mapping-malformed`, `action-correction`, `timeout`, `unknown-usage`, `tool-failure`, and `private-result`. A failed run retains safe evidence and exits nonzero; it does not start another capture. Repeating a command is an explicit new mocked invocation. Histories sharing an output directory share one immutable mock policy and cumulative journal.

For comparison, this exercises the unmodified ordinary CLI path with local SDK responses and **without capture instrumentation**:

```powershell
node examples/composio-capture/worker.mjs normal-cli-mock ../composio-agent examples/composio-capture/.abilitybench/normal-cli
```

It runs the original entry point in an isolated copy, with its normal logs and result-writing behavior. It never writes into the original checkout. This is an offline compatibility check, not a claim about current authentication or provider availability.

## What is observed

`capture.mjs` owns a narrowly scoped capture lifecycle. `worker.mjs` is provider-specific wiring; `mock-provider.mjs` is an offline wire fixture, not an alternate research algorithm.

- Gemini's `generateContent` fetch hook observes **each underlying HTTP attempt**, including SDK retries inside a logical SDK invocation. Original provider errors flow back to the original retry predicates unchanged; only persisted diagnostics are reduced to safe categories.
- Composio's installed client snapshots fetch at construction. The dedicated worker temporarily installs the guarded fetch **before constructing that client**. Async-local call IDs distinguish setup, search, fetch, and model operations; internal retries retain their logical call ID while getting separate reservations and timings. Do not attach already-constructed Composio clients or embed this global scope in a concurrent web server.
- Model metadata includes reported input/output/thinking/cached/total tokens, estimated fixture-rate cost, resolved model version, HTTP status, request identity, response identity, and local attempt latency. JSON syntax observation is separate from HTTP success and does not replace or relax the original schema validation.
- Search/fetch transport attempts, failures (including HTTP-200 tool errors), timings, and reservations are separate from model tokens. Session setup is counted separately. The SDK's optional npm upgrade probe is blocked without dispatch; it is not an agent/tool attempt or a billed request.
- Only generate-content, existing session setup, and the two existing read-only search/fetch tool slugs are eligible. Write tools, arbitrary endpoints, file uploads, proxy calls, and unknown operations fail before dispatch. No tool/request replay exists.

Capture guards can stop a run, but they do not make the original retry loops more permissive. Instrumented runs suppress free-form agent/SDK console logging for privacy. Normal CLI behavior outside capture mode is untouched.

## Accounting contract

These are **mock fixture ceilings and allowances**, not verified live model limits or Composio prices. The numerical $0.11 cap and $0.03731285 historical seed are exercised in a separate simulated journal; mock tokens do not increase real API spend or change historical live ledgers.

For every eligible underlying request:

1. Acquire the shared budget lock and serialize concurrent reservation updates. Reject a request before dispatch if its allowance or attempt limit cannot fit.
2. Write an exclusive, fsynced `reserved` event **before dispatch**. A crash between reservation and dispatch may over-reserve; it cannot make an attempt free.
3. Observe the unchanged response. Known valid model usage settles at:

   ```text
   ((input - cached) * inputRate + cached * cachedRate
     + (output + thinking) * outputRate) / 1,000,000
   ```

   Costs/reservations are rounded upward to integer nano-USD. Release unused reservation only after the settlement event is durable. Reported usage is accounted even if HTTP fails or the original agent subsequently rejects JSON/schema/output quality.
4. Missing/invalid usage, timeouts and unknown failures retain the full allowance. Tool/setup monetary usage is unknown; their configured **mock** allowance stays reserved. Invalid or over-envelope reported usage stops further work and keeps conservative exposure; the reported values remain visible. A provider violating real reservation assumptions could exceed a client estimate—this is not an invoice enforcement mechanism.
5. Every retry, action correction, synthesis call and evidence-mapping call passes through the same boundary. The cap applies to every prefix of dispatched work, not just successful stages. This does not promise that every permitted worst-case retry sequence can complete under the cap.

Future invocations reconcile all retained journals at their original immutable policy. No policy reset, ledger deletion, or free retry is performed. Sealed files must verify before more work; unsealed/crashed reservations remain counted. A stale lock fails closed and requires inspection, not automatic removal. Separate workers sharing the same account directory cannot spend concurrently. Concurrent HTTP attempts within one capture reserve atomically.

An overall deadline and per-attempt deadline close the boundary on failure. Unawaited requests fail capture; pending work is drained/accounted before sealing. Late completion never releases reservations or modifies sealed evidence. The dedicated worker exits after finalization so SDK background retries cannot outlive the capture. Aborting is not proof that a provider never received a request, which is why unknown exposure stays reserved.

## Privacy and immutable evidence

The default capture API is **metadata-only**. It never stores raw prompts, tool queries, tool/page bodies, headers, credentials, SDK error messages, stacks, or causes. Request and response identities are per-capture HMACs with a random key that is never persisted. They correlate retries within that capture, not across experiments; they are not AbilityBench cache fingerprints and cannot reconstruct source content.

Exporting `result.json` requires an explicit public-data approval, a synchronous result validator, allowed source origins, and sensitive-value checks. The worker's approval applies only to its public mock fixture. Known credential values, credential-shaped keys, emails/private-key/bearer patterns, and URLs containing userinfo/query/fragment are rejected, not silently stripped or rewritten. Safe error categories are persisted instead of raw messages. Current worker credentials are fake, never read from the user's environment.

**This is not universal DLP.** Arbitrary private prose cannot be reliably recognized automatically. A real result export would need a reviewed public-data contract; absent that review it must remain metadata-only. Conservative URL checks can reject otherwise legitimate public links. Do not relax them silently to publish an output.

Each capture gets a unique directory under `mock-budget/`, exclusive event/result/manifest writes, file hashes and a final manifest seal. A completed HTTP response is not completion of research: completion requires the original agent to return, original validation to succeed, no outstanding requests/guard failure, and the requested export checks to pass. Failed captures have no eligible result export. `readCapture()` verifies the seal, referenced files, exact journal list and reconciled exposure. Hashes detect corruption; this is not tamper-proof storage against a hostile local administrator, nor a sandbox for untrusted source code.

## Adopt an explicitly approved mock result into Step 1

```powershell
node examples/composio-offline/run.mjs adopt ../composio-agent salesforce.json <capture-directory> examples/composio-offline/.abilitybench
```

This is a separate opt-in action, not automatic execution/publication. It verifies the complete sealed package, requires a successful explicit export and matching target/source hashes, copies the result into a **new** Step 1 project, and declares the capture manifest as a watched input. Loader checks bind the copied manifest and result to provenance. Its origin is visibly `mock-capture`, never fresh real research. Failed, private, metadata-only, corrupt, or incompatible-source captures cannot be adopted.

The existing 100-app context, schemas, ordering strategy, volatile dataset/analysis stages and opt-in publication policy remain unchanged. Twenty and Otter AI remain failed historical policy findings; importing a capture does not repair source data or change evaluation rules.

## Before any real-agent experiment

Step 2 is complete only as a mocked boundary. Next, **design** one experiment with reviewed public inputs, source origins, model configuration, exact SDK versions, cancellation/redirect behavior, real input/output/thinking ceilings, full nested retry bounds, Composio request/fee limits, and one authoritative cumulative account including historical unknown exposure. The agent currently leaves model token limits at defaults; the mock's 4,096/1,024 ceilings are not defensible live reservations. Preserving those defaults may require substantially larger allowances; changing them requires an explicit experiment decision.

No current evidence establishes that the remaining $0.07268715 under the historical $0.11 cap can fund that protocol safely. Do not enable native fetch, import mock exposure as real spending, increase the cap, or execute a live capture merely because these tests pass. Real source quality, stochastic variability, provider availability and invoice costs remain unverified. See the [Step 2 verification record](../../docs/composio-capture-results.md).
