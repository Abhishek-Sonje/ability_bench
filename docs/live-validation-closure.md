# Live validation milestone closure

Closed by user direction on 2026-10-16. The original source-grounding limitations are accepted as documented limitations of this execution validation, not waived quality failures or evidence of output equivalence.

## Preserved result

The [2026-10-13 Flash-Lite experiment](./live-gemini-lite-results.md) completed baseline/incremental/full control with 5/2/5 successful API captures and no provider, engine, adapter, or budget failure. The candidate reused four earlier stages with identical baseline fingerprints/artifacts and executed report plus summary. The immutable baseline and earlier Flash evidence were preserved.

Observed incremental versus changed-prompt full control: three fewer requests (60%), 8.05% less published-rate estimated API cost, and 55.20% less end-to-end time in one serial sample. New known-usage estimated cost across all three phases was $0.0032932. Historical unknown-usage reservations remain held. These are reported-token rate estimates, not invoices or generalized savings guarantees.

## Explicit limitations

- A custom adapter acquires stochastic responses before deterministic snapshot-consuming callbacks. This is not native caching of arbitrary LLM functions or tool replay.
- Only the catalog output matched across incremental and full control. Both final reports selected A but proposed different review policies; operational semantic equivalence and factual quality were not established.
- The first observed divergence was differently worded `facts` responses to identical recorded requests. Downstream effects of changed dependency text versus fresh sampling cannot be isolated from this sample.
- The original facts stage discarded option descriptions/prices. Options and risks saw only those lossy facts; unsupported review/capacity assertions entered there and propagated. The full-control report additionally assumed automated responses absent from the source.
- Incremental report/summary were freshly captured against the changed prompt, not stale report artifacts. Preserving an earlier unsupported upstream assertion is a grounding limitation, not evidence of invalid cache reuse.
- Cache correctness and quality are separate. The evidence supports verified snapshot reuse and avoided calls, not fresh-run equivalence or improved agent quality.

## Evidence boundary and next work

The five retained experiment directories, original requests/responses, snapshots, manifests, ledgers, comparisons, and measured-results document remain historical evidence. They are not upgraded to the revised contract, repriced, normalized, or overwritten. Three historical completed manifests and their 18 stage artifacts were verified through the existing read-only stores during closure.

The next change is confined to the [source-grounded v2 example](./live-gemini-grounding-v2.md), its tests, and documentation. It has its own workflow identity and requires a fresh baseline. No engine changes or additional live requests are part of this closure. No quality/evaluation receipt has been retroactively attached to the original sample.
