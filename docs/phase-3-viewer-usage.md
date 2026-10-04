# Read-only local viewer

The first viewer is implemented using Node/TypeScript and native browser modules. It adds no runtime dependency or frontend framework. It does not change the execution engine, storage format, or existing CLI commands.

## Start

From the repository root:

```bash
pnpm viewer --store .abilitybench/usability-composio-20261003/.abilitybench --workflow user-composio-case-study
```

Open `http://127.0.0.1:4310`. Use the numeric loopback address, not `localhost` (Host checks deliberately permit only the printed origin). Optional `--port` accepts 1024–65535. Stop with Ctrl+C. A missing store stays missing and displays empty history; corrupt records produce errors.

For the retained screening demo with evaluation receipts:

```bash
pnpm viewer --store examples/composio-research/.abilitybench/history-8lo2nI/.abilitybench --workflow composio-research-screening --port 4311
```

That path is local retained evidence, not a portable fixture. If rerunning the demo later, use `retainedStorageDir` in its ignored `demo-results.json`. Running the viewer itself does not regenerate any demo.

## Inspect

Choose a run. Its exact recorded immutable baseline is shown automatically; it cannot be reassigned. Click a stage to see actual execution status, planned/final action, recorded reason, dependencies, and hash-component comparisons. Reused/executed/failed/skipped are labelled in words. Skipped because of a dependency and skipped because fail-fast stopped the run remain distinct.

“Inspect recorded outputs” verifies and previews only that stage's manifest-referenced artifacts. Large artifacts show a not-previewed warning, not a false integrity claim. Structured data uses labelled fields/items; long text, entry count and nesting have explicit preview limits.

Open “Inspect an evaluation receipt” and enter an exact `eval_…` ID from the same store. It must match the selected candidate and recorded baseline. Execution, absolute evaluation, and regression results are independently labelled. Changing runs clears the selected receipt. No selected receipt means **not inspected**, not “never evaluated.”

Saved manifests do not contain raw input values, environment values, watched filenames, source code, or per-stage timing. Hash comparisons do not reconstruct these. Different output identities mean different recorded bytes, not necessarily a semantic regression; evaluation receipts supply that distinct conclusion.

## Verification and current acceptance status

On Windows, the complete quality gate passed with 195 active tests and one existing POSIX-only skip. New tests cover branched/joined history, both skip reasons, exact receipts, deleted current modules, no callbacks, unchanged storage, missing/corrupt records, wrong workflow/pair, bounded reads, junction containment, fixed assets, HTTP origin/Host checks and rejected write methods.

Read-only verification against real retained stores:

| Retained history | Runs | Stage results | Verified previews | Oversized previews not read | Receipts |
| --- | ---: | --- | ---: | ---: | ---: |
| Independent Composio case-study | 21 | 15 reused, 102 executed, 3 failed, 3 dependency-skipped, 3 fail-fast-skipped | 96 | 21 | 0 |
| Composio research screening | 6 | 15 reused, 19 executed, 1 failed, 1 dependency-skipped | 34 | 0 | 5 |

The independent store includes three retained seven-run validation iterations; each candidate resolves its own exact baseline. The final agreed usability exercise remains the seven-run iteration documented separately. Screening receipts include passed/no-regressions, failed/regressed, and failed/no-regressions. Every retained entry and byte was unchanged after reads. No source Composio files were modified.

Reproduce the data verification without executing workflows:

```bash
pnpm build
node scripts/verify-viewer-history.mjs .abilitybench/usability-composio-20261003/.abilitybench user-composio-case-study
node scripts/verify-viewer-history.mjs examples/composio-research/.abilitybench/history-8lo2nI/.abilitybench composio-research-screening
```

**Milestone closed by user verification.** The user inspected the viewer, reported that it looks good, and explicitly accepted the read-only viewer milestone. Agent-side browser automation remained unavailable; desktop/mobile screenshots and an independent automated visual finish review are not claimed. The Impeccable detector ran once in degraded regex-only mode (parser modules unavailable); no findings is not a rendered accessibility/contrast pass. User acceptance closes this milestone without inventing that missing evidence.

No further UI features are authorized unless a real usability issue appears. The next milestone is a separately budgeted live Gemini experiment, not more viewer work.

## Limits

One explicit store/workflow per server; 500 manifests per store; 2 MiB per record/receipt-reference artifact, 16 MiB total receipt-reference artifacts; 128 checks; 256 KiB artifact preview. Diagrams support up to 100 stages (complete dependency-list fallback beyond that). JSON previews stop at 30 entries per collection, six levels, 300 total entries, and 4,000 characters per scalar. Symlinked storage/ancestors are rejected. Concurrent hostile local filesystem mutation, remote hosting, authentication and streaming huge artifacts are outside this prototype's boundary. Do not expose the server through a proxy or tunnel.
