# Source-grounded live example v2

Status: offline verified; not live validated. The [original live milestone is closed](./live-validation-closure.md), with its evidence and limitations preserved. V2 is a separate example revision, not a correction of historical outputs.

## Explicit source flow

Workflow identity: `live-gemini-source-grounded-v2`.

| Stage | Direct dependencies | Source contract |
| --- | --- | --- |
| catalog | None | Validated structured synthetic catalog |
| facts | catalog | Exact JSON extraction of budget, team size, daily tickets, and required-review option IDs |
| options | catalog, facts | Both source option prices/modes/review statuses, with consistent extracted facts |
| risks | catalog, facts | Source-informed possible risks, explicitly labelled hypotheses |
| report | catalog, options, risks | Source is directly available for recommendation checks |
| summary | catalog, report | Source-aware checks and bounded fidelity to its report |

The catalog preserves the original synthetic scenario: team of three, 40 daily tickets, $70 monthly budget, A/shared inbox/$20/manual tags, B/automated triage/$60/human review required. Review requirements for A are explicitly **unspecified**, not "none." The data is structured rather than relying on a lossy text summary to transport all source information.

All stage inputs reach the provider through declared dependency outputs. There is no hidden catalog file read inside options, risks, report, or summary. Facts remain an explicit dependency of both branches. Report and summary also declare the catalog because their grounding checks require the source.

## Deterministic gates

`examples/live-gemini/grounding.mjs` owns the example version, source fixture, revised prompts, and bounded validators. It is copied into new experiment roots and declared as a watched influence.

- Validate catalog shape, both options, finite nonnegative prices/budget, positive team/ticket counts, and explicit mode/review values.
- Require facts to be JSON with exactly the required fields and values matching the source. Missing, contradictory, or additional fact fields stop the example.
- Before options/risks capture, require both catalog and consistent facts. Missing source information stops before a provider request.
- Require options to provide A/B lines with their source monthly prices, modes, and required/unspecified review status. A changed source price is checked against the new value, not hard-coded historical prices.
- Require risks to label both entries as hypotheses and use may/could, rather than treating speculative risks as observed outcomes.
- Reject bounded known patterns: unsupported automated responses/replies, explicit no-review claims, unsupported automation for manual-tagging options, capacity sufficiency claims, and guaranteed-outcome wording.
- Preserve the 25-word options/risks/base-report, 30-word changed-report, and 20-word summary limits, measured by whitespace-delimited tokens. Facts now have a stricter structured-field contract rather than a prose word limit.
- Require the changed report's human-review safeguard to be labelled Proposed. A new policy suggestion is allowed; it is not presented as an existing source fact.
- Summary must retain the report's selected option and proposal status; it cannot introduce new numbers or daily/weekly/monthly cadence absent from its report.

Capture gates run before a response becomes an accepted snapshot; callbacks validate again when consuming snapshots. Provider usage is accounted even when grounding fails. Raw successful HTTP responses are retained for diagnosis, failed captures are not completed steps, and grounding failures are separately identified as `grounding_validation`, not provider availability failures. Quality failures are not automatically retried to obtain a pass.

These checks deliberately permit different recommendations (A or B), hypothesis wording, and proposed safeguards. They do not compare candidate text with control text or normalize outputs to make them match. The source may support both options financially without establishing their actual operating capacity.

## Fingerprints and invalidation

- The new workflow identity, stage implementation revisions, structured catalog, helper, dependency edges, and prompts require a fresh v2 baseline. Historical v1 artifacts are not eligible as a v2 baseline.
- Fingerprint construction and conservative invalidation in AbilityBench are unchanged. The additional source edges make catalog output identity an explicit influence for both branches and the report/summary checks.
- Catalog bytes change: catalog executes and all descendants conservatively execute, even if an extracted facts value would be unchanged (for example, only A's price changes).
- A stage's watched prompt file changes: that stage and descendants execute. Within the revised 5/2/5 experiment, only report.txt changes between baseline and candidate; catalog/facts/options/risks must still reuse.
- Shared adapter/grounding helper bytes change: all stages watch them, so reuse is conservatively invalidated across the graph. This includes editing shared prompt defaults in the helper. Per-stage prompt-file changes are the narrower experiment boundary.
- Snapshots remain watched inputs. Different fresh provider responses produce different snapshot and artifact identities, even when extracted facts are semantically equivalent. Facts validation does not canonicalize response text to force equality.

The sealed DAG, 5/2/5 successful-capture requirement, immutable-baseline checks, reused fingerprint/artifact assertions, budget reconciliation, cumulative $0.11 cap, retry limits, request envelope, timeouts, and failure separation remain enabled. The example's source/quality requirements are strengthened; the original measured sample is not judged retroactively against v2.

## Verification and readiness

Offline tests cover valid and missing catalog/facts inputs, contradictory source values, price changes, unsupported assumptions, hypothesis labels, word limits, proposal status, summary option/number/cadence fidelity, and accepted distinct recommendations. Missing source prevents dispatch. Generated facts failing grounding retain known usage and raw response evidence without publishing a completed run. Mocked full-protocol tests still enforce 5/2/5 captures and verified four-stage reuse; source/helper changes invalidate reuse. Mock answers are source-aware test fixtures, not live evidence.

The complete Windows quality gate passes with 212 active tests and one existing POSIX-only skip. No `src/` engine files were changed. The three historical manifests and 18 stage artifacts remain verified; existing experiment trees are unchanged during read-only verification.

Ready for another controlled validation **after explicit approval**, a fresh baseline, and confirmation of provider pricing/settings at that time. No live requests were made for this revision. Under the configured rates, retained exposure is still $0.03335395, leaving $0.07664605 headroom; 12 worst-case Lite attempts reserve $0.0454656, or $0.056832 for all 15 allowed attempts. No budget reset is involved.

Passing the bounded gates is not a general factuality or semantic-equivalence proof. Lexical rules can miss paraphrases or reject defensible wording; source grounding does not prove policy effectiveness or team capacity. A real response may stop on formatting, grounding, token envelope, provider, time, or budget guards. Such failures should remain evidence, not trigger relaxed criteria or an automatic new experiment.
