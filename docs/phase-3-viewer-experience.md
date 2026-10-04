# Minimal viewer experience

The first viewer has one screen, not a navigation system of dashboards.

1. **History rail:** verified runs for the explicitly selected workflow/store. Each entry shows time, execution result, and baseline/candidate identity. Choosing a run loads only its recorded immutable baseline; there is no baseline picker or implicit latest baseline.
2. **Run context:** selected run identity, exact baseline identity, distinct execution/evaluation/regression results, and stage-status counts. Evaluation remains “No receipt selected” until an exact verified receipt is selected; this does not imply the run was never evaluated.
3. **Historical DAG:** recorded dependencies, not the current workflow. Text-labelled stage statuses (reused/executed/failed/skipped), selectable by keyboard or pointer. A compact dependency list remains useful at narrow widths.
4. **Stage inspector:** actual status first; human explanation and recorded reason; planned action vs actual outcome; dependencies; baseline/candidate fingerprint component differences; artifact identity and bounded, opt-in preview. Skipped-dependency and fail-fast explanations remain different. Missing historical fields are not reconstructed.
5. **Evaluation inspection:** exact receipt ID, criteria identity, separate evaluation and regression results, and check-by-check baseline/candidate verdicts. No evaluation launch button.

Selection updates the inspector without hiding the graph. The familiar developer inspection layout is pinned by the user-approved brief, not replaced by a visual-concept tournament. The physical scene is a developer inspecting evidence on a desktop in normal office light: restrained cool-white surfaces, dark readable text, blue selection, semantic status colours reinforced by words, system UI type, monospace only for identities. No animation is needed beyond immediate selection feedback. At narrow widths the rail becomes a bounded list above the graph and inspector.

## Read boundary and limits

Start with an explicit storage root and workflow ID. Bind only to IPv4 loopback. Serve fixed bundled assets and GET-only read endpoints. Check Host, Origin and browser fetch metadata; deny cross-origin embedding and all writes. Never import config/workflow/evaluator code. IDs and artifact references are verified by existing stores. Bound list/record/preview sizes, reject symlinked storage entries, and report corruption rather than hide it. Read operations do not create missing stores.

History is bounded to 500 manifest files per store; exceeding that bound is an explicit limitation, not silent truncation. Individual JSON records are limited to 2 MiB and artifact previews to 256 KiB. Larger artifacts show their recorded identity and a not-previewed notice; their bytes are not claimed verified. SDK reads remain whole-file and a concurrent hostile local writer is outside this local developer-tool boundary.

No new storage format, index, receipt list, or execution semantics are introduced. Exact receipt entry is deliberately basic until experience justifies more infrastructure.
