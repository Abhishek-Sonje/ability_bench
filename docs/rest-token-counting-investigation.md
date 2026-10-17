# Complete-request REST token counting: separate investigation

Status: **supported request shape identified; maximum-charge guarantee unresolved**, 2026-10-17. Documentation/source inspection and offline SDK probes only. No live counting/generation, credential loading, provider migration, SDK upgrade or transport implementation is part of this investigation. It is independent of the parked Composio integration.

## Established facts

The [REST reference](https://ai.google.dev/api/tokens) supports `generateContentRequest` as the complete counting input, rather than only `contents`. That describes a viable transport shape, not a guarantee that the count is a maximum of every subsequently billed input token. Its example itself reports a content-only count of 10 versus generation input of 11.

Installed `@google/genai` 2.23.0 evidence:

- `dist/node/index.mjs`, `countTokensParametersToMldev`: serializes model into the route and content into the body. It does not serialize an arbitrary top-level `generateContentRequest` argument.
- `countTokensConfigToMldev`: rejects `generationConfig`, `systemInstruction` and tools in Developer API mode. Therefore counting just `contents` through this method does not establish coverage of our structured-output schema.
- `dist/tokenizer/node.mjs`, model mapping/getTokenizerName: the local tokenizer exists but does not support `gemini-3.5-flash-lite`. It must not be aliased to another model. Its accumulator checks `generationConfig.responseSchema`, not the exact `responseJsonSchema` field used here; schema serialization is not proven equivalent.
- An offline wire probe confirmed both omission/rejection behavior, with native fetch disabled and fake credentials. No probe result was a provider token count.

## Smallest proposed follow-up, not implemented

Given the actual SDK-generated body `G` for the intended generation, count through the exact pinned model endpoint using only this body form:

```json
{
  "generateContentRequest": {
    "model": "models/gemini-3.5-flash-lite",
    "contents": "<exact G.contents object/array, not a JSON string>",
    "generationConfig": "<exact G.generationConfig object, including responseJsonSchema>"
  }
}
```

This is schematic: the placeholders must be replaced with the original JSON values. Do not also send outer `contents`, change the output schema, silently switch to `responseSchema`, or count a manually simplified prompt. Include any newly supported steering field or reject the request. Preserve original order/contents for generation and bind the count to the model plus complete serialized-body identity. Keep API credentials only in provider headers, outside persisted request identities.

An adapter-only investigation could first offline-test exact serialization, count/generate binding, malformed/missing counts, limits, timeouts, changed request bytes, retry counts and no generation after a failed count. A future approved live protocol would bound counting separately (at most eight unique full-request counts, one HTTP attempt each, no hidden retries), record its account usage and compare returned counts with billed prompt usage. That is a diagnostic protocol, not authorization to send it now.

The [billing FAQ](https://ai.google.dev/gemini-api/docs/billing) calls `GetTokens` unbilled and inference-quota-exempt. Do not infer account-specific eligibility, count-endpoint rate limits or complete-schema coverage solely from that name. Confirm applicability to this exact REST request form. Missing metadata or an error must stop generation, not trigger a content-only fallback.

## Evidence needed to close the bound

Require an official relationship such as `billedPromptTokens <= completeCount + documentedMaximumOverhead`, with an explicit finite overhead for the exact model, schema and request type. If only observed samples agree, report empirical agreement, not a preventive spending guarantee. An arbitrary safety margin or a doubled count is not a documented maximum. Confirm that model aliases/version changes do not invalidate the relationship and fail closed on an incompatible version.

No count-based gate eliminates provider availability failures, schema truncation, downstream quality regressions or unknown third-party charges. Keep this research separate from AbilityBench's generic execution engine and from its cache fingerprints.
