# AbilityBench

AbilityBench is being prepared as a recorded-result SDK and independent history CLI
for local TypeScript workflows. The authoritative release contract is
[specification #10](https://github.com/Abhishek-Sonje/ability_bench/issues/10).

This checkout implements isolated supported sources (#11), selected ordered-history
reads (#12), typed execution (#13–14), independent mixed-format history (#15–16),
and frozen baseline selection and refresh (#17).
It is an intermediate private development version, not a qualified 0.1.0 release.
The root exports `stage`, `createWorkflow`, `prepare`, `openHistory`, `AbilityBenchError`
and their associated types.

```ts
import { stage, createWorkflow, prepare, openHistory } from "abilitybench";

const research = stage({
  id: "research",
  inputs: { prompt: "Find useful options" },
  environment: ["RESEARCH_ENDPOINT"],
  reuse: { revision: "research-v1" },
  run: async ({ inputs, env }) => existingResearch(inputs.prompt, env.RESEARCH_ENDPOINT),
});
const report = stage({
  id: "report",
  dependencies: { research },
  run: ({ dependencies }) => existingReport(dependencies.research),
});
const workflow = createWorkflow({ id: "research-report", root: import.meta.dirname,
  stages: [research, report] });
const prepared = await prepare(workflow, { baseline: null });
console.log(prepared.preview); // callback-free; creates no run state
const result = await prepared.execute(); // single-use, including after rejection
if (result.status === "failed") process.exitCode = 1;
const retained = await prepare(workflow, { baseline: { runId: result.runId } });
console.log(retained.preview); // research can reuse; report always executes when reached
const next = await retained.execute();
const saved = await openHistory(`${import.meta.dirname}/.abilitybench`)
  .output(next.runId, "report");
```

The callbacks above are your existing application functions. Stage dependencies are
registered handles keyed by nonempty binding names; multiple aliases are allowed.
Graph validation rejects duplicate/unsafe IDs, forged/out-of-graph handles, self
references and cycles. Available traversal ties follow stage declaration order.
Ordinary inputs and metadata need no factories or schema language; keep application
validators for domain configuration and provider responses.

`baseline: null` deliberately executes fresh. `{ runId }` selects exactly one retained,
verified, compatible same-workflow run in the chosen history directory. Missing selection
fails with `baseline_not_found`; a different workflow fails with
`baseline_workflow_mismatch`; recognized old sorted history is `baseline_incompatible`.
`baseline: "latest"` validates every scanned record, then selects the compatible completed
or failed run for this workflow with the greatest recorded finalization timestamp and
descending run ID as the tiebreaker. Known Phase 0 records count toward the scan limit
and are excluded from selection. Corrupt, unreadable, unknown or over-budget history
fails preparation. Latest scans up to 1,000 records, with a 2 MiB bound per record.
Exact selection bypasses the scan limit. When there is no compatible candidate, choose
`baseline: null` to start fresh. Preparation freezes this selection and
shows its identity, format and completed/failed status in preview and finalized history.
It never searches older runs for individual outputs or imports ancestor records.

Omitting `reuse`, or specifying `false`, means always execute when reached, with no
fingerprint or stability obligation; its output remains inspectable. A reuse object
requires nonempty `revision` or unique nonempty `files`, optionally both. In this
slice eligible stages return verified recorded outputs without invoking callbacks.
An always-execute baseline output cannot become reusable just by changing policy.
Relative exact-file watches must remain under the workflow root; explicit absolute regular files
outside it are allowed. Missing/non-file/unreadable watches appear in preview and
fail the reached stage before its callback if still unavailable. Physical aliases
into the selected history and duplicate resolved watches are refused. Watched symlinks
may resolve to external regular files. Restart/reload changed implementation;
file hashes do not establish loaded-code identity or atomic snapshots.

One eligibility calculation serves preview and execution. It checks the current opt-in,
the selected baseline's successful/reused output and reusable policy, all declared
component identities and artifact integrity. Preview invokes no callbacks or providers.
When upstream actual output is unresolved, a potentially reusable descendant is
`conditional`, with `unresolvedStages` and `potentialEligibility` in its details.
Own known changes still predict execution. Preview remains separately recorded;
actual decisions use actual outputs and new influence/artifact observations. Execution
observes watches after verifying the selected artifact and before reusing an output
or invoking a reusable callback. It checks them again after the callback, before
publishing or passing its output to descendants. A detected change during the callback
fails the stage with `influence_changed_during_execution`.
Reasons retain applicable `causes`, named `changedComponents` with before/current
digests, `changedBindings`, and watch/artifact error codes. Primary precedence is
blocked/stopped, always-execute, refresh, fresh, missing/ineligible baseline, changed influences,
unavailable artifact, reused. Failure error codes remain separate. A missing, corrupt
or unreadable selected artifact makes reuse unavailable. A reached stage gets one
regeneration attempt against the same selected baseline. Descendants compare the
regenerated output with the selected output identity. An occupied artifact slot can
still prevent publication of the regenerated output.

Propagation compares whole ordered outputs, including object/array order and fields
such as a provider's `requestHash`. Executing a dependency alone does not invalidate
descendants: equal actual output can stop propagation directly or at an intermediate
stage; independent branches keep their own identities. Reuse copies the original
output reference, `observedAt` and origin, including through baseline chains. New
observations use callback-completion time. Reuse retains an earlier mutable-source
observation and skips the entire callback, including provider charges and incidental
logs. It does not probe freshness, contact mutable sources, expire results or establish
fresh-run equivalence. Required current-run publication belongs in a reached
always-execute stage after reusable generation, or outside the engine.

Preparation captures current declarations, options, full stage inputs and named
environment presence/value. Later caller mutation cannot change that execution.
Each callback receives independent mutable input/dependency/environment copies.
Accepted outputs are validated/copied before downstream consumption or persistence.
Environment influence values are hashed, not stored as explanation metadata.
Hidden closure reads and undeclared influences remain the developer's responsibility.
Declare every relevant prompt/model/setting as stage inputs and every dependency
binding, environment name, implementation revision and exact watched source/helper/prompt
file. Bookkeeping names/physical paths normalize without sorting nested user values.
Disk checks do not detect every A→B→A change or prove an atomic external observation.
Use `refresh: { stages: [research] }` to resample selected stages. The default scope
is `"selected"`. Use `scope: "descendants"` with a stage list to include its transitive
descendants, or `refresh: { scope: "all" }` for the whole workflow. An all-scope request
cannot include a stage list. Refresh runs reached callbacks and leaves prior records
intact. Outside the scope, reuse depends on actual output equality and the other
declared influences. A callback that reads an existing snapshot still reads that snapshot.

History defaults to `<root>/.abilitybench`; `historyDirectory` can select an external
directory. Default `failureMode: "fail-fast"` stops scheduling after failure;
`"continue-independent"` allows unaffected branches. Both retain successful outputs
in a finalized failed run. Failure descendants are `dependency_blocked`; unrelated
work stopped by fail-fast is `run_stopped`. Reasons and error codes are separate;
failed outcomes record whether the callback was invoked. The engine adds no callback
retry, rollback, transaction or exactly-once effect guarantee. Provider retry logic
inside your callback stays yours. Fresh execution establishes neither application
quality nor current-world freshness.

Finalization allocates an attempt UUID before callbacks, then publishes accepted
artifacts before the immutable finalized record. Ordinary stage failures return
`status: "failed"` and `runId`. `finalization_failed` throws with allocated identity,
limits/OS context where available and `status: "not_published" | "uncertain"`.
An allocated identity is not an acknowledgment of saved history: after uncertain
publication, direct history inspection can reconcile it. Prepare anew for another
attempt; the rejected prepared object remains consumed.

Writers stage exclusive same-volume files, close/reopen and boundedly verify them,
then coordinate through the history-wide `writer-lock` directory with an owner token.
Coordination waits at most five seconds before `storage_busy`; callbacks hold no lock.
No-clobber hard links publish only complete verified inodes. Identical occupied data
preserves its inode. Collisions and slots whose format, bytes or identity cannot
be established safely are refused.

For a demonstrably corrupt artifact in a known format, the writer creates a
quarantine transaction with a descriptor identifying the slot, corrupt bytes
and staged replacement. It hard-links the corrupt inode into quarantine and
rechecks the descriptor, preserved bytes and occupied inode before removing
the corrupt name. It publishes the verified replacement with a no-clobber
hard link, verifies the final slot and marks completion. Quarantine is retained.
If publication fails after removal, the staged replacement and quarantine
evidence remain. The stage fails without retrying its callback.

Older successful references to the same hash can read the restored artifact.
Runs remain immutable. Only owned safe temps and the matching owner's lock
are cleaned. Orphan staging files, lock and quarantine entries are excluded from
finalized history. Readers never acquire locks or repair data.

If a process stops with an abandoned lock, stop **all** users of that history and
establish exclusive administrative ownership; age/PID guesses are insufficient.
Inspect the owner and transaction evidence, verify any final slot first and preserve
valid data. A missing slot may be linked from a still-verified staged replacement;
otherwise leave it unavailable. Preserve quarantine and never rerun callbacks as
storage recovery. Remove an abandoned lock only after ensuring its old process
cannot resume, then prepare a new attempt. There is no automatic lock stealing,
history rewriting or callback resumption. Support is local one-volume NTFS/ext4 with
exclusive-create/hard-link capability, not hostile path replacement, network storage
or power-loss durability.

```ts
import { openHistory } from "abilitybench";

const history = openHistory("/absolute/path/to/history");
const inspection = await history.run(runId); // outputReferences: "unchecked"
const value = await history.output(runId, "report"); // ordinary mutable JSON, including null
// Pass value to an existing application validator.
```

These two reads need no workflow, source root, configuration or providers. Inspection
verifies the selected record and reference schemas; output verifies only the selected
artifact. Successful outputs remain readable from failed runs, baseline chains and
always-execute stages, without ancestors or unrelated artifacts. Reads never create,
repair or modify history. Each result is independent and mutable. Integrity is not
authenticity, application validity, reuse eligibility or current-world freshness.

New records use `abilitybench-run-v2`, `ordered-json-v1`, `sha256-domain-v2` and
`declared-influences-v2`. Artifacts have an explicit three-line format header followed
by compact ordered JSON. Object enumeration (including integer keys) and array order
are preserved. Acyclic repeated references copy independently; escaped lone surrogates
are allowed. Unsupported JSON values, descriptors and prototypes reject without
calling getters or `toJSON`. The old sorted codec checks remain transitional internal
checks for the retained machinery, not expectations for new recorded values.

Run reads are bounded to 2 MiB; output payloads to 16 MiB plus the exact fixed header
overhead. Reads check opened regular files, physical containment, actual accumulated
bytes and EOF. Errors distinguish invalid arguments, missing history/run/stage,
absent output, missing/corrupt/unreadable data, unknown format and exceeded limits.
`AbilityBenchError` exposes `code`, `operation` and relevant identity/path/limit context;
`output_absent` includes the recorded status/reason. No fallback search or partial value
is returned. Storage is private: new objects occupy a separate format namespace and
no storage/codec/testing API is exported.

## Development checks

Use Node >=24.20.0 <25 and the pinned pnpm version from `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:isolated
```

`check` runs supported lint, a clean build, typechecking and tests. Supported source
sets are `src/`, `tests/` and root build/test scripts and configurations. CI runs
`check:isolated` on Windows and Ubuntu: it copies only supported source sets into a
new temporary directory containing spaces, shares installed development dependencies,
and runs `check` with no legacy sources or prebuilt output. This proves source
isolation; packed consumers and four-configuration release qualification remain later gates.

The build cleans only generated root `dist/` before emitting supported internals,
preventing retired CLI/viewer/evaluation files from surviving an incremental build.
Package files are allowlisted to compiled JavaScript/types and README. Package exports
permit only the root entrypoint. Final identity, licensing/notices, supported runtime
exports, broader clean-consumer qualification belongs to #21/#24; installed history CLI checks are in #15.

## Private historical prototype

`legacy/` retains the original viewer, evaluation, execution/planning/config CLI,
manifest diff, dependent examples, fixtures and all 29 historical test suites. Its
frozen internal dependency closure is self-contained: historical checks do not import
changing supported sources. Its private package provides historical examples' self-import
resolution, without creating a supported legacy API.

```sh
pnpm legacy:build
pnpm legacy:typecheck
pnpm legacy:test
pnpm legacy:check
pnpm legacy:viewer
```

These opt-in checks are outside release gates. Test fixtures use offline transports;
live provider/example scripts still require separate authorization. Existing phase
documents, experiment/completion reports, `PRODUCT.md`, `plan.md`,
`execution-contract.md`, and original onboarding retained in `legacy/README.md`
are historical. Their results and old contracts do not establish acceptance of the
new release. Paths in historical reports refer to the original layout; corresponding
examples now live under `legacy/examples/`.

## Retained and superseded regression expectations

This table records every category in #10's prior-art table. Supported tests exercise
retained private machinery during prefactoring, without making old low-level interfaces
public. Subsequent slices move behavioral coverage to the supported SDK and installed
CLI as those entrypoints become available.

| Prior art | Transferred supported checks | Historical expectations and replacement slices |
| --- | --- | --- |
| Typed workflow / graph | Dependency inference, wrong-type compile rejection, registered handles, ID grammar, duplicate IDs, missing/self dependencies, cycles, callback-free assembly | Fluent builder, factory metadata, selectors, files AND revision and lexical traversal ties stay private; ordinary inputs/declaration-order graph in #13, reuse declarations in #14 |
| Serialization | Unsupported values, cycles, descriptor checks without invoking getters, symbols/extra array properties, byte/hash verification and decoding | Sorted-key equality, global shared-reference and lone-surrogate rejection stay private; ordered/versioned values, escaped paths and mutable copies in #12/#13 |
| Fingerprint / planning / execution | Watched byte changes, environment presence without secret persistence, invalid/non-file watches, missing dependency identity, direct dependencies, zero-call reuse and late file checks | Old propagation, disabled/volatile split, selectors, reusable missing-watch identities and public-input revalidation stay private; replacement behavior in #14/#17/#18 |
| Runner | Callback-free assembly and immutable run identity checks transferred to graph/manifest suites | Separate plan/run, explicit baseline, watched-history rejection, root-only storage and global input suites stay runnable privately; replacements in #13/#14/#17/#18 |
| Filesystem / manifest / path | All original filesystem/path suites, manifest hash/ID tampering, referenced-artifact verification, deduplication, own-temp cleanup and interrupted temps; real-process publication/collision/ID fixtures | Original formats are temporary fixture scaffolding; bounded schema-valid reads in #12/#16, publication/repair/process schedules in #13/#19/#20; missing-history and failed-baseline expectations replaced in #12/#17 |
| CLI process / commands | Private storage child processes retain real streams/exits, spaced paths and failure checks | Original command/process suites retained privately; config imports, run/plan/evaluate and manifest metadata diff do not define supported history; installed CLI coverage in #15/#21 |
| Composio / Archie / Gemini | Original provider code, offline guardrails, renderer/domain fixtures and required-effect checks retained privately | Mandatory capture orchestration, old policy and presentation-order reconstruction stay historical; original-renderer/provider witness in #22 with SDK behavior from #12–#18 |
| Viewer / evaluation / diff | Shared artifact/record corruption, ID, physical-containment and immutable-storage checks run independently of these features | Full deferred suites including independent-reader cases stay private; bounded independent history/comparison replaces lineage/completed-pair/preview/evaluator restrictions in #12/#15/#16 |

## Independent history SDK and CLI

`openHistory(directory)` needs only retained history. Its asynchronous `runs({workflowId?, limit?})`,
`run(runId)`, `output(runId, stageId)` and `compare(runA, runB, stageId)` never load workflow,
configuration, provider or evaluator code or repair history. Inspection includes dependencies,
baseline, separate preview/actual reasons, failures/skips and `outputReferences: "unchecked"`.
Successful outputs in failed runs and chains remain readable without ancestors. Each read returns
independent mutable JSON. Application validators judge domain validity and quality.

The installed `abilitybench` binary supports exactly:

```sh
abilitybench runs --history "history directory" --workflow research-report --limit 20
abilitybench inspect RUN --history "history directory" --json
abilitybench output RUN report --history "history directory" > before.json
abilitybench compare RUN_A RUN_B report --history "history directory" --json
```

All four commands accept `--history` (default `./.abilitybench`) and `--json`.
`output` always prints complete pretty JSON in recorded order, including with `--json`, without
an envelope. Export two outputs and use an existing text diff tool for detailed changes.
Exit status is 0 for success/equal, 1 for different, 2 for usage/read failure. Errors go only to
stderr and use `{error:{code,message,operation,...context}}` with `--json`. Automation must check
the exit code: shell redirection may create an empty destination on failure.

Comparison verifies both complete selected outputs, even for identical selections/references.
It accepts unrelated, same-run, cross-workflow, failed and chained runs. It returns selected
`left`/`right` identities, `equal`, and `difference: null` or one `{path,reason}`. Reasons are
`type`, `value`, `object_keys`, `object_order`, `array_length`; array item differences recurse.
JSON Pointers escape `~` and `/`; the root is `""`. Object key sets precede order and values;
array length precedes items. Equality is no quality, freshness or reuse verdict.

Listing scans incrementally, validates every scanned record before filtering and fails on the
1,001st entry. Results default to 20, allow positive integer limits up to 1,000, and sort by
recorded finalization time then ID descending. Existing empty history lists `[]`; missing history
fails. Direct known-run/output reads bypass the scan cap. The scan skips original Phase 0
`.tmp-<uuid>` staging files in `runs/`. Current staging, writer-lock and quarantine directories
live outside `runs/`. Corrupt, unreadable or unknown records fail explicitly. Record reads are
bounded at 2 MiB and output payloads at 16 MiB, enforced during actual reads.

The same four operations read mixed Phase 0 and current history. Narrow SDK inspection on
`schemaVersion` to access format-specific fields. Phase 0 inspection keeps its original decisions,
policy reasons, evaluation status, and artifact hashes. The reader verifies the original
`canonical-json-v1` payloads in `objects/sha256/`; current ordered artifacts carry their own
header and live in a separate namespace. Comparisons use decoded values and their observable
key order. Phase 0 stored sorted keys, so the original callback's insertion order cannot be
recovered. Keep the saved bytes in place and use `baseline: null` to begin a current-format
execution history.
