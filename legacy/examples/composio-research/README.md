# Captured Composio research demo

This offline demo screens saved research from the sibling `composio-agent` project.
It does not run Gemini, Composio, network requests, or delivery side effects, and
never changes that project. Its source dependencies must already be installed.

```powershell
pnpm example:composio-research
# Or, after building, supply another checkout explicitly:
node examples/composio-research/demo.mjs "C:\path\to\composio-agent"
# Optionally isolate the generated review and history in another directory:
node examples/composio-research/demo.mjs "C:\path\to\composio-agent" "C:\path\to\review"
```

The loader validates per-record JSON using that checkout's source Zod schema.
Aggregate filenames are excluded; schema-rejected files are recorded in the output.
Invalid JSON aborts the demo. Filenames identify records: two snapshots with the
same application name are deliberately not merged or ranked by freshness.

```text
inventory ── evidence ─────┐
          └─ feasibility ──┴─ summary ── report ── delivery
```

All six stages are declared before execution. Typed inputs contain a projection
of captured records; dependency outputs are explicit. Evidence watches a policy
file; feasibility declares an environment variable. Delivery has caching disabled
and returns a dry-run receipt only. All stage code watches `workflow.ts`, so code
edits intentionally invalidate broadly.

The runner creates one immutable baseline and independently compares five
candidates against it: unchanged inputs, policy change, environment change,
manual evidence invalidation, and an intentional report failure. It asserts
branch-local reuse, downstream conservative reruns, skipped failed dependencies,
and baseline immutability. Temporary working storage is removed afterward, but a
unique `history-*` project is copied into the review directory before cleanup.

Review `.abilitybench/demo-results.json` here for captured records and byte hashes,
schema hash, typed inputs, baseline report, candidate reports, full manifests,
planning explanations, diffs, evaluation receipts, and retained-history paths. This
generated file is gitignored and may contain private research. Each invocation replaces
the review file and retains a new `history-*` project; no history cleanup is automatic.
Output paths inside the source project (including symlink/junction aliases) are rejected.

## Deterministic policy evaluation

`evaluation.ts` declares two checks on the report artifact:

- `known-records`: candidates must use captured filenames and contain no duplicates.
- `minimum-candidates`: the report must meet an explicit nonnegative count threshold.

Completed candidates are evaluated against the one execution baseline with identical
criteria on both sides. Failed execution is explicitly left unevaluated; partial-run
evaluation is not supported. Every receipt is verified in the working store and again
from the retained copy. An extra same-pair comparison raises the threshold above the
entire captured inventory to prove that both sides can fail without a new regression.

The initial real-data evaluation had these outcomes:

| Scenario | Candidate evaluation | Comparison |
| --- | --- | --- |
| Unchanged | passed | no_regressions |
| Evidence policy change | passed | no_regressions |
| Require high confidence | failed (zero candidates) | regressed |
| Manual evidence invalidation | passed | no_regressions |
| Intentional execution failure | not_run | not evaluated |
| Same pair, stricter count threshold | failed | no_regressions |

These are policy assertions, not factual research-quality verdicts. A narrower list
can be desirable; a minimum-count failure does not prove that the agent got worse.
Membership is checked against explicit captured identities, not against live services.

For exact execution inspection, use the config under `retainedProjectRoot` in the review
JSON. For receipt lookup, construct `FileEvaluationReceiptStore` using its
`retainedStorageDir`, then call `get(receipt.id)`. The retained generated modules refer
to the local built SDK by absolute URL; this is a local review project, not a portable
archive or an automatically runnable replay of the upstream agent.

The initial local dataset contained 103 valid records, including two NotebookLM
Enterprise snapshots. This is execution and policy-evaluation evidence, not proof of
research quality or that those findings remain current. Official-source counts
count evidence entries, not deduplicated URLs. No upstream tool replay is implied.
The script's assertions complement engine tests. CI runs the actual script against
synthetic records and a small schema adapter, without the external checkout or Zod.
It verifies all five execution scenarios, policy receipts and retained lookup,
record identities, schema rejection reporting, malformed/empty dataset failures,
output-path protections, and unchanged input files. That adapter does not
test the external project's schema itself. Independent developer review is still
needed to validate usability; see [the review exercise](../../docs/demo-review.md).
