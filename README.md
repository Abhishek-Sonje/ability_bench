# AbilityBench

AbilityBench is being prepared as a recorded-result SDK and independent history CLI
for local TypeScript workflows. The authoritative release contract is
[specification #10](https://github.com/Abhishek-Sonje/ability_bench/issues/10).

This checkout implements isolation [#11](https://github.com/Abhishek-Sonje/ability_bench/issues/11)
and selected ordered-history reads [#12](https://github.com/Abhishek-Sonje/ability_bench/issues/12).
It is an intermediate, private development version, not a qualified 0.1.0 release.
The root entrypoint exposes `openHistory`, `AbilityBenchError` and their associated
types. Workflow execution, history listing/comparison, legacy-format reading and the
four-command CLI arrive in subsequent tickets; retired runtime exports stay private.

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
exports, CLI installation and clean-consumer qualification belong to #21/#24.

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

No later behavioral slice is claimed complete here. Retained sorted codec, old graph,
fingerprint/execution helpers and phase-0 records are temporary private
expand/retain/migrate boundaries so useful checks remain green while later tickets
replace behavior. There is no second coordinator, module-count or code-reduction goal.
