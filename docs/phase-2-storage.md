# Evaluation receipt storage

`evaluateRunPair(suite, options)` freshly evaluates the explicit pair, publishes the
canonical criteria artifact, and writes one separate immutable receipt. It returns
only after successful publication. `executeEvaluationPair()` remains the no-write
in-memory alternative.

```ts
import { evaluateRunPair, FileEvaluationReceiptStore } from "abilitybench";
import { join } from "node:path";

const receipt = await evaluateRunPair(suite, {
  baselineRunId: baseline.manifest.id,
  candidateRunId: candidate.manifest.id,
  criteria: { minimumCandidates: 1 },
});
const store = new FileEvaluationReceiptStore(join(suite.root, ".abilitybench"));
const verified = await store.get(receipt.id);
```

The execution store must already contain both completed runs and required objects.
The optional `storageDir` resolves inside the suite root. Direct store construction
takes an explicit storage root and does not load project configuration.

## Format and publication

Receipts live at `.abilitybench/evaluations/eval_<digest>.json`; criteria use the
existing `objects/sha256/` store. Execution manifests remain unchanged.

Schema `phase2-evaluation-receipt-v1` contains the in-memory result's fields except
top-level `contractVersion`, plus `schemaVersion`, `id`, `receiptHash`, and
`runtime: { nodeVersion, platform, arch }`. The archived suite descriptor retains
its contract version.

Identity is SHA-256 over `"abilitybench/evaluation-receipt/v1\0"` and canonical body
bytes, excluding only `id` and `receiptHash`. Runtime metadata, timestamps, lineage,
summaries, and all check results are included. Matching invocation fingerprints
are not permission to reuse results and do not imply matching receipt identities.

After fresh evaluation, the publisher validates the body, publishes/deduplicates
criteria, verifies all receipt references, rechecks the current suite implementation,
and uses the existing exclusive hard-link publication protocol. Collisions never
overwrite existing content. Failed/interrupted publication cannot expose a partial
receipt; orphan criteria or ignored temporary files can remain. No garbage collection
is added. Ordinary check errors produce diagnostic receipts; preflight, instability,
and publication errors do not return a finalized receipt.

Criteria publication is intentionally deferred until safe evaluation completes.
Stability checks are not atomic filesystem snapshots and cannot detect A-B-A changes
or enforce the purity of trusted user callbacks.

## Exact verified lookup

`FileEvaluationReceiptStore.get(id)` requires an exact `eval_<64 lowercase hex>` ID.
It returns `undefined` for an absent file in an existing store. There is no listing
or implicit latest selection. Resolved receipt paths may not escape the store through
symlinks/junctions.

Lookup verifies canonical UTF-8 JSON, exact fields/enums, timestamps/runtime shape,
receipt hash/ID/filename, archived suite identity, normalized historical declarations,
comparison classifications, every summary count, exact completed source manifests,
direct baseline lineage, criteria and targeted artifact integrity, and recomputed
per-side fingerprints. Output-contract errors must agree with historical selectors.

Historical lookup reconstructs only built-in selectors; it never imports or invokes
evaluator code. Current evaluator files may change or disappear. Lookup verifies
recorded integrity and input identity, not the truth of arbitrary callback verdicts.
Missing references make verified inspection unavailable: a receipt file alone is not
a portable archive. Content addressing is not authentication against an attacker who
can rewrite data and all references.

Receipt errors use `invalid_evaluation_id` or `corrupt_receipt`; source and publication
failures retain existing persistence codes. Criteria/details/messages may contain
private information; automatic redaction is not promised.

## Verification and boundary

Integration tests cover publication, historical lookup, recomputed fingerprints and
summaries, error receipts, missing/corrupt references, noncanonical bytes, collisions,
failed-publication cleanup, final guards, and symlink/junction escapes.

No evaluation CLI, mutable index, receipt listing, SQLite, cleanup, automatic baseline
promotion, scoring, result caching, providers, or cloud functionality is included.
