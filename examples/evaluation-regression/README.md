# Offline evaluation regression walkthrough

```powershell
pnpm example:evaluation-regression
```

Requires only the repository's installed dependencies. No Composio checkout,
credentials, network calls, or live models are involved.

```text
inventory ── evidence ─────┐
          └─ feasibility ──┴─ report
```

The baseline contains three eligible/trusted synthetic records. An unchanged
candidate reuses all four stages. A second candidate reduces the eligible set to
one record: inventory/evidence reuse, feasibility reruns, and the joined report
reruns conservatively. Both candidates name exactly that baseline.

Two independent checks target evidence and report. Each uses typed output selectors,
explicit criteria validation, a revision, and a watched implementation file.

| Scenario | Execution | Candidate evaluation | Comparison |
| --- | --- | --- | --- |
| Unchanged, minimum two | completed | passed | no_regressions |
| One eligible record, minimum two | completed | failed | regressed |
| Same candidate, stricter minimum four | completed | failed | no_regressions |

In the last case both baseline and candidate fail the report check under the *same*
new criterion. Their old verdicts are not reused. This demonstrates why absolute
evaluation and regression comparison must remain separate.

The script asserts decisions, statuses, unchanged execution-manifest bytes, equal
fingerprints for equal outputs, and verified receipt lookup. Console output shows
each comparison with actual/required counts. Full review output is written to
`.abilitybench/demo-results.json` in this example directory.

Unlike the captured Composio demo, this example retains its execution manifests,
source objects, criteria, and receipts. Repeated invocations create more immutable
history and replace only the convenience review JSON; no cleanup is automatic.
That generated directory is gitignored.

Use the existing CLI to inspect execution IDs from the review JSON:

```powershell
node dist/cli.js inspect run_<digest> --config examples/evaluation-regression/abilitybench.config.ts
```

Exact evaluation receipt lookup uses the SDK `FileEvaluationReceiptStore`, as shown
in [storage documentation](../../docs/phase-2-storage.md). There is no evaluation CLI.
Execution inspection still shows its original `evaluationStatus: "not_run"`; later
evaluation results live only in separate receipts.

This count assertion is deliberately synthetic. Fewer candidates are not inherently
worse research: the check proves a declared policy regression, not factual quality,
freshness, or statistical significance. No savings or model-quality claim is made.

The actual walkthrough runs in an isolated compiled-process CI test, including paths
with spaces and verified historical lookup. See the
[Phase 2 assessment](../../docs/phase-2-assessment.md) for remaining product gates.
