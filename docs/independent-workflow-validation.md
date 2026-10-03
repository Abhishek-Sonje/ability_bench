# Independent workflow usability validation

Status: closed after user explanation and explicit ordering-contract verification.

## Independence and scope

The existing Composio project was not designed around AbilityBench. Its actual saved
100-app dataset, `analyzeDataset()` implementation, `renderReport()` implementation,
and case-study data-copy operations supplied the workflow. This is different from the
earlier agent-authored 103-record screening demo.

The user independently supplied the five-stage model and cache reasoning, then approved
a verification join and an isolated output-directory environment setting. The agent
implemented and ran the adapter, then the user interpreted its actual decisions.
This is evidence for the agreed modeling/understanding gate, not a blind third-party
study or proof that all future integrations will be straightforward.

All adapter code, dependency snapshots, raw research, generated site data, and detailed
results remain in the ignored local workspace `.abilitybench/usability-composio-20261003/`.
Neither project's implementation files changed. No providers, credentials, replay,
database, cloud, workflow editing, UI code, or release operations were involved.

## User's final model

```text
load-dataset -----> copy-dataset -----------------+
      |                                          |
      v                                          v
analyze-dataset --> copy-analysis ----------> verify-site-data
      |
      v
generate-report
```

Load and report are cacheable. Analysis is not, because the existing function reads
current time. Both copies are non-cacheable side effects. Verification is non-cacheable
because it reads actual destination bytes. The copy stages explicitly declare
`ABILITYBENCH_SITE_OUTPUT_DIRECTORY`; the adapter permits only two isolated destinations.

## Exercised decisions

R = reused; X = executed successfully; F = failed; S = skipped.

| Scenario | Load | Analyze | Report | Copy dataset | Copy analysis | Verify |
| --- | --- | --- | --- | --- | --- | --- |
| First run | X | X | X | X | X | X |
| Unchanged plan (predictions only) | R | X | X | X | X | X |
| Unchanged run with missing destination data | R | X | X | X | X | X |
| Report-format implementation change | R | X | X | X | X | X |
| Output-directory environment change | R | X | X | X | X | X |
| Manual report invalidation | R | X | X | X | X | X |
| Watched dataset change | X | X | X | X | X | X |
| Intentional dataset-copy failure | R | X | S | F | X | S |

The first run uses `no_baseline`. Loader reuse uses `fingerprint_match`; changed
dataset bytes use `fingerprint_changed` with `watchedFiles`. Non-cacheable stages use
`cache_disabled`. Report normally uses `dependency_executed` naming analysis, while
manual report invalidation uses `manual_invalidation`.

Execution order is deterministic and sequential: load, analyze, copy-analysis,
copy-dataset, report, verify. The failing copy causes report to be
`skipped_run_stopped`; verification is `skipped_dependency_failed`. Earlier copies
are not rolled back. A planned execute decision is not evidence that a callback ran.

## Actual integration finding and resolution

The initial adapter changed report-row ordering. Canonical artifacts sort object keys;
the upstream renderer observes insertion order for tied distribution rows and for
opportunity-bucket presentation. Values survived, but visible ordering did not.

The user explicitly required original ordering. The isolated adapter now captures
versioned display-order arrays alongside analysis for the ten order-sensitive sections.
After canonical artifact round-trip, report and analysis-copy callbacks reconstruct
those sections in declared order immediately before rendering/writing. The original
functions remain unchanged. Unknown versions/sections, duplicate keys, and missing or
mismatched keys reject the order contract instead of falling back silently.

This is adapter metadata, not a new SDK output codec or automatic dependency mechanism.
The ordering helper is watched. Future upstream renderer changes require rechecking the
adapter's declared order-sensitive sections. Canonical JSON itself remains unchanged.

## Verification and user explanation

One full ordering-verification rerun passed on Node 24.20.0 using existing Zod 4.6.5:

- Seven execution manifests and 39 artifact references verified through the SDK.
- Every candidate names the same immutable baseline; its stored bytes stayed unchanged.
- Unchanged planning left storage and site destinations unchanged.
- An unchanged run restored a deliberately removed dataset copy.
- Both copy-stage environment component hashes changed for the new destination.
- Original analysis values matched, excluding the intentionally fresh timestamp.
- All completed Markdown outputs matched the original report byte-for-byte, except
  the intentionally changed heading in the formatting scenario.
- Both destination JSON files preserved the original opportunity-bucket order.
- Corrupt order metadata was rejected after an actual canonical artifact round-trip.
- All 196 checked original source/data/config files matched before/after hashes.
- Both project worktrees remained clean during the exercise. Exact CLI inspection
  and baseline-to-dataset-change diff succeeded in the initial exercise.

The user correctly explained why report reruns despite unchanged/equal outputs, why
watched dataset changes invalidate Load, why the two skipped stages have different
causes, and why an undeclared time read makes a cacheable stage unsafe. Their explanation
and required-order decision were explicit; they were not inferred from an audit pass.

## Friction retained, not hidden

- Order-sensitive ordinary JavaScript needs explicit ordering data at a canonical boundary.
- A primary reason can mask another changed influence: cache-disabled env changes and
  dependency-executed watched-code changes still appear in component hash differences.
- Conservative downstream reruns can produce identical output artifacts.
- Fail-fast execution can skip an otherwise healthy branch and leave partial side effects.
- CLI action labels and actual execution statuses must be read together.
- Imported helper/package boundaries remain the developer's responsibility. The harness
  conservatively watched the entire copied Zod package (843 implementation files in the
  selected package/code boundary); this is not an SDK requirement or auto-discovery feature.

No unsafe reuse, storage-integrity failure, or unexplained decision remains in this
exercise. The ordering compatibility issue was resolved at the adapter boundary. The
agreed usability gate is closed; no AbilityBench implementation change was justified.
The next authorized milestone is a read-only local workflow viewer. Public release,
live Gemini, replay, SQLite, cloud, and workflow editing remain deferred.
