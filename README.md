# AbilityBench

AbilityBench records and reuses selected results in local TypeScript workflows.
Declare stages with the SDK, then inspect, compare or export their recorded outputs
with the independent history CLI.

## Try it offline

Use Node >=24.20.0 <25. In an empty consumer directory, create an ESM project and
install `abilitybench@0.1.0`. Before registry publication, use the locally built
tarball in place of the registry package.

```sh
npm init -y
npm pkg set type=module
npm install abilitybench@0.1.0
```

For the local candidate, replace the install line with
`npm install "/path/to/abilitybench-0.1.0.tgz"`.

Save the following as `app.ts`. These stand in for the functions and validator
already owned by your application. Both functions are local and deterministic.

```ts
export function loadFacts() {
  return { topic: "shared inbox", monthlyCost: 20 };
}

export function validateReport(value: unknown, prompt: string) {
  if (typeof value !== "string" || !value.startsWith(prompt + ": ")) {
    throw new Error("Report does not match the requested prompt");
  }
}
```

Save this as `onboard.ts` and run `node onboard.ts`. Node 24 can run these
examples directly with type stripping. To type-check them, use a TypeScript
consumer with `typescript` and `@types/node` installed. Run
`npx tsc --ignoreConfig --noEmit --strict --module NodeNext --types node --allowImportingTsExtensions onboard.ts`.

```ts
import { createWorkflow, openHistory, prepare, stage } from "abilitybench";
import { loadFacts, validateReport } from "./app.ts";

const root = import.meta.dirname;
const historyDirectory = `${root}/history with spaces`;
const facts = stage({
  id: "facts",
  reuse: { revision: "facts-v1" },
  run: loadFacts,
});

function workflow(prompt: string) {
  const report = stage({
    id: "report",
    inputs: { prompt },
    dependencies: { facts },
    reuse: { revision: "report-v1" },
    run: ({ inputs, dependencies }) =>
      `${inputs.prompt}: ${dependencies.facts.topic} ($${dependencies.facts.monthlyCost}/mo)`,
  });
  return createWorkflow({ id: "inbox-report", root, stages: [facts, report] });
}

const first = await prepare(workflow("Brief"), { baseline: null, historyDirectory });
console.log(first.preview);
const baseline = await first.execute();
if (baseline.status === "failed") throw new Error(`Inspect failed run ${baseline.runId}`);

const prompt = "Recommendation";
const changed = await prepare(workflow(prompt), {
  baseline: { runId: baseline.runId },
  historyDirectory,
});
console.log(changed.preview); // facts reuses, report executes with changed inputs
const next = await changed.execute();
if (next.status === "failed") throw new Error(`Inspect failed run ${next.runId}`);
console.log(next.stages.map(({ stageId, actual }) => [stageId, actual.reason]));
console.log({ baseline: baseline.runId, changed: next.runId });

// Your application can do this later without loading the workflow.
validateReport(await openHistory(historyDirectory).output(next.runId, "report"), prompt);
```

Replace FIRST and CHANGED below with the printed run IDs. Run the CLI from the
consumer directory. A different report makes the comparison exit 1.

```sh
npm exec -- abilitybench runs --history "history with spaces" --workflow inbox-report
npm exec -- abilitybench inspect CHANGED --history "history with spaces" --json
npm exec -- abilitybench compare FIRST CHANGED report --history "history with spaces"
npm exec -- abilitybench output CHANGED report --history "history with spaces" > report.json
```

After a successful export, save this as `validate-export.ts` and run
`node validate-export.ts` to call the same application validator independently.

```ts
import { readFile } from "node:fs/promises";
import { validateReport } from "./app.ts";

const value: unknown = JSON.parse(await readFile("report.json", "utf8"));
validateReport(value, "Recommendation");
```

Use the same type-check command for each example file. Two successful exports
can be compared with your usual diff tool. `output` emits the full pretty JSON
value without an envelope.
All four commands accept `--history` (default `.abilitybench` in the current
directory) and `--json`. Exit 0 means success or equality, 1 means a difference,
and 2 means usage or read failure. Under `--json`, errors use
`{ "error": { "code": "...", "message": "...", "operation": "..." } }` on stderr
with applicable context and empty stdout. Check the exit code before consuming
a redirected file. A failed historical run is inspectable with exit 0.
`runs` returns up to 20 results by default (`--limit` accepts 1–1,000).
It scans at most 1,000 committed records across both known formats, before
filtering. A larger scan fails. Direct known-run reads bypass the scan limit.

## Migrate an earlier workflow

- Replace fluent builders, selectors and cache/config factories with direct
  `stage` declarations, typed dependency handles and ordinary stage-local
  inputs. Put application config validation in your application.
- Replace disabled/volatile with always-execute (omit `reuse` or use `false`).
  Replace required files-plus-revision with exact files **or** an explicit
  revision. Both can be supplied when each tracks a separate influence.
- Replace separate plan/run calls with one `prepare`, its `preview` and its
  single-use `execute()`. Replace manual artifact decoding with `openHistory`.
  Earlier source APIs require migration to these entry points.
- Phase 0 history is readable in its recorded sorted order. Start with
  `baseline: null` to write a compatible ordered run. Phase 0 records cannot be
  execution baselines. Compatible failed runs can supply their successful
  reusable outputs.

Save as `migrate.ts` next to `app.ts` and run `node migrate.ts`. This deliberately
starts a fresh baseline and shows a file-only watch and an always-execute stage.

```ts
import { createWorkflow, openHistory, prepare, stage } from "abilitybench";
import { loadFacts, validateReport } from "./app.ts";

const root = import.meta.dirname;
const historyDirectory = `${root}/migration history`;
const facts = stage({
  id: "facts",
  reuse: { files: ["app.ts"] },
  run: loadFacts,
});
const report = stage({
  id: "report",
  dependencies: { facts },
  inputs: { prompt: "Migration" },
  reuse: false,
  run: ({ inputs, dependencies }) => `${inputs.prompt}: ${dependencies.facts.topic}`,
});
const workflow = createWorkflow({ id: "migrated-report", root, stages: [facts, report] });
const prepared = await prepare(workflow, { baseline: null, historyDirectory });
console.log(prepared.preview);
const result = await prepared.execute();
if (result.status === "failed") throw new Error(`Inspect failed run ${result.runId}`);
validateReport(await openHistory(historyDirectory).output(result.runId, "report"), "Migration");
```

The value boundary now preserves object-key enumeration and array order. Each
callback and history read gets independent mutable copies. Relative exact-file
watches stay within the workflow root and explicit absolute paths may reference
external files. History itself cannot be watched. Descendants use whole actual
ordered outputs to decide reuse. A callback can execute and return equal output,
allowing descendants to reuse. Order-only changes can propagate.

## Execution and history

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
Use `refresh: { stages: [facts] }` to resample selected stages. The default scope
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
keep them stopped while you establish exclusive administrative ownership. Confirm
that any paused writer has exited and cannot resume. The token's timestamp and PID
are diagnostic only, and an empty lock can indicate interruption before the token
was written.

Preserve the lock information, quarantine descriptor, corrupt bytes and staging.
Verify the final slot first and leave verified content in place. For a missing
slot, verify the staged file against the transaction's expected format, length and
domain hash. For current artifacts, hash the UTF-8 prefix
`abilitybench/artifact/v2` followed by a zero byte and the entire staged file
with SHA-256. Use a same-volume hard link that fails if the slot is occupied.
Verify the linked slot before returning the history to service. Leave the slot
unavailable if the replacement cannot be verified. Keep quarantine and do not run
callbacks or rewrite runs during maintenance. Remove the abandoned lock last,
then prepare a new attempt if needed. A run linked before the process exited may
already be inspectable even if the caller received no result.
The protocol supports cooperative users on one local NTFS or ext4 volume with
exclusive-create and hard-link capability. Hostile path replacement, network or
cloud-synced storage, and power-loss durability are outside that guarantee.
Your application owns provider deadlines and cancellation. A hanging callback
may require terminating the process. Read limits bound serialized bytes, with
no guarantee about heap usage.

The independent history reads need no workflow, source root, configuration or providers. Inspection
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
calling getters or `toJSON`.

Run reads are bounded to 2 MiB; output payloads to 16 MiB plus the exact fixed header
overhead. Reads check opened regular files, physical containment, actual accumulated
bytes and EOF. Errors distinguish invalid arguments, missing history/run/stage,
absent output, missing/corrupt/unreadable data, unknown format and exceeded limits.
`AbilityBenchError` exposes `code`, `operation` and relevant identity/path/limit context;
`output_absent` includes the recorded status/reason. No fallback search or partial value
is returned. Storage is private: new objects occupy a separate format namespace and
no storage/codec/testing API is exported.


## Support and development

The supported root exports are `stage`, `createWorkflow`, `prepare`,
`openHistory`, `AbilityBenchError` and associated types. The supported runtime
is Node >=24.20.0 <25 with ESM on Windows x64/NTFS and Linux x64/ext4. Keep
history on one local volume with exclusive creation and hard-link support.
Histories and quarantine grow over time. While idle, archive the entire history
directory and deliberately start fresh in a new one. Archived runs remain
inspectable. AbilityBench provides no automatic cleanup.

Patches in 0.1.x preserve documented SDK, CLI, error and history contracts,
including the agreed `phase0-run-v1`/`phase0-artifact-v1` with `canonical-json-v1`
reader and the current ordered format. Breaking changes require a new minor
and migration notes. The latest published minor receives best-effort support
through [GitHub issues](https://github.com/Abhishek-Sonje/ability_bench/issues),
with no SLA or LTS commitment.

Use the pinned pnpm version from `package.json` for checkout development.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:isolated
```

The isolation gate runs the supported lint, build, typecheck and tests with
`legacy/` absent. The older phase documents, examples, experiments and
completion reports are historical. The private prototype remains available via
`pnpm legacy:build`, `pnpm legacy:typecheck`, `pnpm legacy:test` and
`pnpm legacy:check`. Historical results do not qualify the supported package.
