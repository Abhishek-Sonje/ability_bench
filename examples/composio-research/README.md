# Captured Composio research demo

This offline demo screens saved research from the sibling `composio-agent` project.
It does not run Gemini, Composio, network requests, or delivery side effects, and
never changes that project. Its source dependencies must already be installed.

```powershell
pnpm example:composio-research
# Or, after building, supply another checkout explicitly:
node examples/composio-research/demo.mjs "C:\path\to\composio-agent"
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
and baseline immutability. Temporary engine storage is removed afterward.

Review `.abilitybench/demo-results.json` here for captured records and byte hashes,
schema hash, typed inputs, baseline report, candidate reports, full manifests,
planning explanations, and diffs. This generated file is gitignored and may
contain private research. Each invocation replaces the previous review file.

The initial local dataset contained 103 valid records, including two NotebookLM
Enterprise snapshots. This is an execution demonstration, not a research-quality
evaluation or proof that those findings remain current. Official-source counts
count evidence entries, not deduplicated URLs. No upstream tool replay is implied.
The script's assertions complement engine tests; this external dataset is not
required by CI. Independent developer review is still needed to validate usability.
