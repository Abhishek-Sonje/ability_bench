# Controlled real-agent experiment: Step 3 plan

Status: **planning complete; execution blocked, not approved**. Audited 2026-10-16. No live requests, budget changes, source-agent changes, or capture implementation changes were made for this plan.

## Decision

Keep the $0.11 cumulative cap and $0.07268715 remaining headroom. The unmodified agent cannot currently be given a complete worst-case reservation within that headroom. Native transport also needs narrow adapter-only hardening before execution. Do not run the ordinary research CLI as a workaround: it bypasses the capture budget boundary.

This experiment would test reuse of a whole immutable research snapshot after a downstream report change. It would not test per-action replay, fresh-web equivalence, or a second independent live control.

## Audited agent and paid paths

Installed packages in the sibling `../composio-agent`: `@google/genai` 2.23.0, `@composio/core` 0.18.1, `@composio/client` 0.1.0-alpha.76. Preserve these audited versions for this experiment; upgrading requires another audit. The non-secret local configuration currently selects `gemini-3.5-flash-lite`, `MAX_RESEARCH_STEPS=10`. No credential values were inspected or recorded.

The proposed isolated experiment selects **Salesforce**, the existing target and saved-dataset position, with **two research steps**, using the existing supported configuration rather than editing the agent. Public authentication documentation is a suitable first read-only scope. Two steps deliberately allow incomplete research: unresolved access/API/MCP/GraphQL fields must remain unknown. This is not a complete Salesforce assessment. Expected actions are search then fetch, but the adaptive agent does not guarantee either; acceptance requires at least one successful official-source fetch.

Local audit anchors:

- `src/agent/gemini.ts`, `gemini-model.ts`: original SDK, prompts and JSON schemas; no explicit output-token, thinking, temperature, seed or model timeout configuration. Do not inject a smaller token ceiling and call that unchanged behavior.
- `src/agent/research-agent.ts`: up to four action decisions per step (initial plus three premature-finish corrections), one tool operation per step, then synthesis and evidence mapping.
- Each generation has at most three application transient attempts. HTTP 503 delays are 500/1,000 ms; qualifying per-minute 429 messages use the existing parsed delay, capped at 60 seconds. This is not generic Retry-After support. Actions do not retry malformed JSON. Synthesis and mapping each have two malformed-output attempts, each with the transient wrapper.
- Gemini SDK `dist/node/index.mjs`, `apiCall`: without `retryOptions`, one fetch per SDK call. Its optional five-attempt default is inactive here. No embeddings, token-count calls, uploads, batch, Google grounding, URL-context tools or explicit cache creation are configured.
- Composio client `client.mjs`: two internal retries, hence three wire attempts per operation, including connection/timeout failures and retryable HTTP responses (408/409/429/5xx or retry override header). Retry-After is honored; otherwise jittered exponential delay. Setup defaults to 60 seconds; original tool execution supplies a 30-second abort signal. Large server retry delays require an outer experiment deadline.
- `src/tools/research-tools.ts`: one session setup; only `COMPOSIO_SEARCH_WEB` and `COMPOSIO_SEARCH_FETCH_URL_CONTENT`; sandbox disabled, tracking disabled. No app-level tool retry, but later adaptive steps may try again. The constructor's optional npm version probe must stay blocked.

| Request kind | Healthy two-step expectation | Full allowed retry-path upper bound |
| --- | ---: | ---: |
| Gemini action generation | 2 | 24 |
| Gemini synthesis | 1 | 6 |
| Gemini evidence mapping | 1 | 6 |
| Composio session setup | 1 | 3 |
| Composio search/fetch combined | 2 | 6 |
| Report-only candidate: all provider requests | 0 | 0 |

The model bound is `12 * steps + 12 = 36`, not twelve or twenty-four. The ordinary ten-step configuration permits up to 132. These are conservative path bounds, not predictions of actual usage. A guard interruption may prevent reaching them; that is not successful protocol completion.

## Pricing and reservation

Official public documentation checked on the audit date:

- [Google model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): 1,048,576 input tokens and 65,536 output tokens.
- [Google standard pricing](https://ai.google.dev/gemini-api/docs/pricing): $0.30/M input, $2.50/M output including thinking, $0.03/M cached input. Reserve uncached standard paid rates, not free-tier eligibility, batching or hoped-for cache discounts. Actual valid cached usage can settle at its published rate. No Google search-grounding fee is expected because that feature is not configured.
- [Composio pricing](https://composio.dev/pricing): session creation is free; tool charges depend on plan, allowances and add-ons. The current public base overage is $0.0003/tool call, with separate Instant provider usage and grandfathered-plan terms. Neither exact search/fetch slug appears in the retrieved rate table. [Instant guidance](https://docs.composio.dev/docs/instant-tools) also requires approval of bounded prices. Account quota, applicable legacy plan, add-ons, underlying search/fetch charges and retry billing are **unverified**, not zero. Public pages differ on premium fees; do not substitute a guessed rate for account-specific confirmation.

Without an enforced lower token envelope, use the model ceilings as a deliberately loose reservation:

```text
one attempt = (1,048,576 * $0.30 + 65,536 * $2.50) / 1,000,000
            = $0.47841280
36 attempts = $17.22286080 Gemini-only worst-case reservation
total       = $17.22286080 + bounded applicable Composio costs (currently unknown)
historical exposure = $0.03731285
current cap         = $0.11000000
available headroom  = $0.07268715
```

This is **not an expected bill or a recommendation to raise the cap to $17**. The input bound is intentionally loose and successful calls release unused reservation. But one maximum-size output alone costs $0.16384, already above headroom even with zero input. No lower provider default or combined thinking/output bound has been established that makes the unchanged configuration affordable. The mock's 4,096/1,024 ceilings are not live limits. Request bytes and the agent's 12,000-character string compactor are not reliable token ceilings (object keys and scalar structure also contribute).

Retain all $0.03731285 exposure: $0.00587605 measured token-cost estimate plus $0.03143680 unknown reserved exposure. No previous failed reservation is released without usage evidence. Every underlying attempt reserves durably before dispatch; known valid usage settles even when JSON/schema validation later fails. Unknown usage retains its allowance. Concurrent and cross-process reservations share one reconciled account, including all historical live ledgers; a new experiment directory must not reset spending. Do not seed history twice or reuse the simulated mock account as a live ledger.

**Budget verdict: no-go.** A complete monetary bound is unavailable, and even the Gemini-only conservative bound fails. To retain this cap, a separately approved isolated token-limited profile and verified tool-cost envelope would be needed; that changes model configuration and requires offline compatibility checks first. Neither a cap increase nor that profile is authorized by this plan.

## Native transport safety: prerequisites, not implemented changes

The existing boundary is mock-only; its transport is not yet suitable for native fetch. Before proposing execution, implement and offline-test only these necessary adapter protections:

1. Exact HTTPS destinations: Google `/v1beta/models/gemini-3.5-flash-lite:generateContent`; Composio session setup and execution for the newly returned session ID only. Reject alternate model paths, unexpected queries, base URLs, ambient proxies and unknown operations. Bind setup body to the existing two tools, toolkit and disabled sandbox.
2. Use manual redirects and reject every 3xx without following. Scope credentials to the intended provider headers; no credentials in URLs, artifacts, logs, tool arguments or forwarded site headers. Do not send keys to redirected origins. Rotate any previously exposed credentials before a future run; never copy them into the plan.
3. Validate tool arguments before dispatch. Search must concern public Salesforce documentation; fetch must use exact approved public HTTPS origins `https://developer.salesforce.com` or `https://help.salesforce.com`, port 443, no userinfo/query/fragment, IP/private/localhost destinations or write operations. Reject rather than rewrite an unsupported action. Public URLs can still cause remote logging; read-only is not zero side effects.
4. Backend fetch redirects/subrequests occur inside Composio and cannot be enforced by the local HTTP redirect guard. Require documented/account-confirmed public-destination restrictions or explicit acceptance of this residual risk before approval. Search results are untrusted input; never expand permissions from their content.
5. Normalize Request objects completely or reject them: preserve method, headers, body and cancellation, including `Request.signal`. Bound response bytes while streaming, not after `.text()` allocates the whole body. Retain original response bytes for SDK parsing and preserve original retries.
6. Proposed outer safety bounds: 300-second dedicated-worker lifetime, 60-second transport deadline, 128 KiB request / 1 MiB response limits, sequential agent execution, no background dispatch after closure. Original tool 30-second abort still applies. These are stop guards, not promises of completion or token bounds; offline-test them and obtain approval for the final profile. Abort never implies no charge.
7. Construct clients inside the guarded scope. Block registry probes/telemetry and every non-allowlisted request. Use metadata-only failures, public-data export approval and allowed-origin validation. Do not persist raw prompts/pages/errors or assume secret-pattern scanning is universal DLP.

No engine/SDK changes are needed. A distinct live capture identity, reader/adoption provenance support and a real-account preflight are necessary example-only additions; never label a live result `mock-capture`.

## Proposed commands and configuration

There is intentionally **no runnable live command today**: `worker.mjs` supports only `mock` and `normal-cli-mock`; policy, reader and adoption reject live mode. Do not run a fictitious `live` command or alter those checks during planning.

Proposed future interface, **not implemented and not authorized to execute**:

```powershell
node examples/composio-capture/worker.mjs live ../composio-agent examples/composio-capture/.abilitybench/live-salesforce-001 --config examples/composio-capture/live-salesforce-001.json
```

The reviewed configuration must explicitly bind target `Salesforce`, model `gemini-3.5-flash-lite`, two steps, unchanged generation settings, maximum attempts 36/6/3 (model/tool/setup), exact origin/tool policy above, shared historical account, $0.11 cap and current exposure. Leave live disabled until the budget and transport blockers are resolved. Secrets are read only inside the isolated worker, never CLI arguments or configuration JSON. New evidence is exclusive-write, isolated and immutable; never overwrite source `results/`, historical experiments or site files.

After a successful approved capture and compatible live provenance support, existing offline commands are:

```powershell
pnpm.cmd build
node examples/composio-offline/run.mjs adopt ../composio-agent salesforce.json <sealed-capture-directory> examples/composio-offline/.abilitybench
node examples/composio-offline/run.mjs run <new-project> none
```

Record the returned baseline ID. Edit only `<new-project>/report-style.json` to `{"title":"Controlled Composio incremental report"}` using a reviewed patch. Do not alter capture, dataset, prompts or policies. Then:

```powershell
node examples/composio-offline/run.mjs plan <new-project> <baseline-id>
node examples/composio-offline/run.mjs run <new-project> <baseline-id>
node dist/cli.js diff <baseline-id> <candidate-id> --config <new-project>/abilitybench.config.ts
node dist/cli.js evaluate <baseline-id> <candidate-id> --config <new-project>/abilitybench.config.ts --criteria <new-project>/reviews/<baseline-id>-criteria.json
```

No `--publish`. Deny network during adoption, baseline engine execution, candidate and evaluation; verify attempted calls as well as completed calls are zero. Evaluate exit status is separate from execution status.

## Acceptance and failure criteria

Baseline capture must pass the original schemas and policies, export approval, source hash/version checks, journal reconciliation and sealed-artifact verification with no pending requests. Require a successful search and official-source fetch; result evidence URLs/supports must match actual fetched sources and original mapping rules. Unknown fields are acceptable; fabricated completion or unsupported positive claims are not. The current metadata-only journal cannot independently reproduce source factuality: validate in memory and retain approved source identity/URL/support receipts if needed, not an unreviewed raw-content export. Citation membership is not proof of semantic entailment.

The first engine run executes all nodes. Candidate expectations:

| Stage | Decision | Required explanation |
| --- | --- | --- |
| load-capture | reuse | Same snapshot/provenance/watched bytes, inputs, fingerprint and artifact hash |
| validate-result | reuse | Same dependency output and watched schema/policy fingerprint |
| assemble-dataset | execute | Non-cacheable clock-dependent builder |
| analyze | execute | Non-cacheable current-time dependency |
| render-report | execute | Changed watched style and executed dependency, conservatively invalidated |
| publish-dataset / publish-analysis / verify-site-data | execute, disabled | Non-cacheable external-state stages; publish false means no destination writes |

Verify the exact plan and recorded reasons; do not claim only the report executes. Baseline manifests/artifact hashes must remain unchanged before/after; verify source-order preservation and unchanged research facts. Compare datasets/analysis structurally allowing only their known `generatedAt` fields; render each analysis through the original renderer. Candidate Markdown must equal its original rendering with only the explicitly requested first heading replaced. Preserve the existing strict original-heading evaluation finding rather than silently relaxing it. Preserve Twenty and Otter AI historical policy failures; no new research-policy failures or unapproved body changes are acceptable.

Counts must reconcile logical calls, all wire retries, measured tokens, unknown exposure and elapsed time. Candidate must show zero Gemini calls, tool calls and session setups, with identical research snapshot bytes. Report avoided calls as the measured baseline capture calls that were not repeated; do not claim a measured fresh-control bill or fresh-world quality equivalence. Actual reused acquisition cost and retained unknown exposure must be separate.

Classify provider HTTP/quota/tool failures separately from adapter transport/privacy/schema/export failures, budget/deadline interruption, quality-evaluation findings and AbilityBench engine/fingerprint/artifact failures. A tool error caught by the agent is still a failed tool attempt, not evidence success. A completed HTTP call or returned agent object is not automatically a successful experiment.

On interruption: close dispatch, retain every reservation, drain/account bounded pending attempts, seal sanitized failed evidence, exit nonzero and do not adopt/publish a result or create a successful baseline. A later engine failure preserves its manifest and immutable capture separately. Stop after the one approved attempt; no automatic fresh experiment, live control, policy relaxation or repair to make it pass.

## Next approval required

Approve a narrow adapter-only preparation task first, including an explicit decision on token bounds versus unchanged generation settings and account-confirmed Composio pricing/remote-fetch safety. Recalculate the reservation before requesting **separate live execution approval**. Planning alone cannot establish that this experiment fits the existing cap. Core remains generic; original agent and CLI remain unchanged.
