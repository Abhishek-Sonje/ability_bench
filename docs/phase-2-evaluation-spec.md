# Phase 2: Deterministic evaluation contract

Status: design proposal only. No evaluation API, loader, CLI command, or storage
format in this document is implemented. The Phase 0 execution contract and Phase 1
CLI remain authoritative for existing behavior. Drafting this design does not close
the independent-workflow usability gate or authorize a public release.

## 1. Objective and scope

Prove that a developer can apply explicit, versioned checks to saved outputs and
identify an intentional regression against one immutable execution baseline.

The first slice is an SDK-driven offline prototype with:

- a fully declared, validated set of independent checks
- explicit typed selections from one stage artifact per check
- identical criteria and evaluator implementation applied to both runs
- strict boolean verdicts, structured explanations, and separate evaluator errors
- canonical fingerprints and immutable evaluation receipts
- deterministic check ordering and comparison rules

No live LLMs, provider adapters, evaluator cache, evaluator DAG, scoring framework,
SQLite, UI, tool replay, cost accounting, cloud, or automatic execution is included.
Do not add a CLI until the SDK prototype demonstrates a useful comparison.

## 2. Execution and evaluation are separate records

Execution manifests remain byte-for-byte immutable. Their existing
`evaluationStatus: "not_run"` means that no evaluation was recorded *in that
execution receipt*. It does not become a mutable indicator of later evaluations.

Evaluation receipts reference exact run IDs and verified manifest hashes. A run
can have several receipts for different suites or criteria. No mutable "current
evaluation" pointer, implicit latest result, or backpatching of historical manifests
is permitted. Existing `inspect` and `diff` behavior remains unchanged.

An execution can complete while its evaluated output fails a criterion. An
evaluator exception is an evaluation error, not an execution failure and not a
failed assertion. Evaluation never changes execution-baseline eligibility.

## 3. Pair and baseline rules

The caller supplies both `baselineRunId` and `candidateRunId` explicitly.

Before invoking any evaluator:

1. Verify the suite and criteria, then load both exact immutable manifests from the
   configured local store using existing integrity rules.
2. Require different IDs, the same suite workflow ID, and completed execution on
   both sides. Partial and failed executions are outside the first slice.
3. Require `candidate.baselineRunId === baseline.id` and
   `candidate.baselineManifestHash === baseline.manifestHash`. This prevents an
   arbitrary historical pair from masquerading as a candidate's baseline comparison.
4. Require every declared target stage to exist on both sides with `succeeded` or
   `reused` status and a non-null output artifact hash.
5. Verify and decode every distinct required artifact before any callbacks run.
   A missing, corrupt, noncanonical, or unsupported artifact rejects the request.
   Evaluation does not repair it, execute its stage, or search another run.

A baseline may itself reference another baseline; only the candidate's direct
immutable baseline is evaluated here. New or removed untargeted stages do not
prevent comparison. Adding or removing a targeted stage rejects the request rather
than silently reducing coverage. Dependency rewiring is allowed if the targeted
output still satisfies its declared input contract; a verdict is not proof that
the workflows are semantically equivalent.

Previously stored baseline evaluations are never used. Both outputs are checked
again using the *same current* suite, criteria snapshot, and implementation. A
changed criterion therefore cannot be compared against an old verdict by accident.

## 4. Proposed public SDK

The following shape is illustrative, not available exports:

```ts
const reportNonempty = defineCheck({
  id: "report-nonempty",
  targetStage: "report",
  outputInputs: { candidates: input.stringArray("/candidates") },
  revision: "nonempty-v1",
  files: ["./evaluation.ts"],
  evaluate: ({ output, criteria }) => ({
    passed: output.candidates.length > 0,
    details: { candidateCount: output.candidates.length },
  }),
});

const suite = createEvaluationSuite({
  id: "research-screening",
  workflowId: "composio-research-screening",
  root: import.meta.dirname,
  checks: [reportNonempty],
});

const receipt = await evaluateRunPair(suite, {
  baselineRunId: "run_<baseline-digest>",
  candidateRunId: "run_<candidate-digest>",
  criteria: {},
  storageDir: ".abilitybench",
});
```

Each check has a unique ID, one exact target stage ID, nonempty revision, and at
least one watched implementation file. Identifier and file rules match the existing
engine. Defining/sealing a suite never invokes callbacks. Duplicate checks, invalid
selectors, malformed metadata, or an empty suite reject before artifact loading.

`outputInputs` reuses only the existing built-in typed input descriptors and their
stable contract IDs. Selectors apply to the decoded target artifact. Aliases are
explicit, fingerprinted, and unique; callbacks receive only the selected fields,
not a general artifact registry. Optional descriptors retain existing missing-value
behavior. No arbitrary parser functions or inferred TypeScript artifact shapes.

`criteria` is one deeply frozen strict JSON object shared identically with every
check and both sides. It is fully fingerprinted and persisted as an artifact.
The initial API gives it the broad `JsonObject` type: a callback must validate any
field it uses. Built-in typed criteria descriptors can follow only if real usage
justifies their additional declaration surface. Invalid criterion usage is an
evaluator error, never a passed assertion.

Checks receive no run ID, side label, timestamps, execution decisions, baseline
verdict, or unrestricted environment object. This prevents ordinary checks from
accidentally grading reused outputs or one side differently. Pair-level comparison
is performed by the engine after absolute checks, not by user callbacks.

## 5. Purity and implementation identity

A check is a pure transformation of selected artifact fields, the complete criteria
snapshot, and its declared implementation files. It must not use time, randomness,
network responses, undeclared files, process environment, or required side effects.
Imported helpers and relevant dependency lockfiles belong in the watched boundary.

Environment variables and volatile evaluators are intentionally unsupported. A user
can explicitly capture external settings as JSON criteria before calling the SDK.
That capture is outside the evaluator, and its provenance is the caller's responsibility.
Reading criteria from a file means the caller parses and supplies its contents; the
path alone is not a criterion or identity.

No cache exists in the first slice, but purity still matters for meaningful comparison.
There is no sandbox or proof of purity. Native modules, runtime differences, undeclared
helpers, and A-B-A file changes can undermine determinism just as in execution.
Callbacks must correspond to the declared watched implementation. Hashing current
source bytes cannot prove that an already imported callback uses those bytes. Use a
fresh process after code edits; stale module-cache identity is an explicit limitation,
not something the runner can solve by hashing a function's text.

Snapshot all declared file bytes/digests before callbacks, recheck immediately before
and after each side, and recheck the whole suite before finalization. If any declared
file state changes, abort publication of the receipt with `evaluation_inputs_changed`.
Do not publish a mixture of evaluator versions. Ordinary callback errors do not abort
the other side or independent checks; changed implementation inputs do.

## 6. Canonical identities and fingerprints

Use the existing strict `canonical-json-v1` encoder, rejection rules, root-relative
file normalization, exact-byte hashing, and artifact codec. No new codec is needed.

Let `C(x)` be those canonical UTF-8 bytes and `H(bytes)` be SHA-256 with the existing
`sha256:<lowercase-hex>` representation. Define:

```text
suiteHash = H("abilitybench/evaluation-suite/v1\0" || C(suiteDescriptor))
checkFingerprint = H("abilitybench/evaluation-check/v1\0" || C(checkInputs))
receiptHash = H("abilitybench/evaluation-receipt/v1\0" || C(receiptBody))
receiptId = "eval_" + receiptHash's 64 hexadecimal digits
```

`suiteDescriptor` contains exactly:

- `contractVersion: "phase2-evaluation-v1"`, suite ID, workflow ID
- checks sorted by ID, each with ID, target stage, revision, watched-file states
  and byte digests, and output selector aliases/pointers/contract IDs
- fixed runner semantics: sequential order, baseline first, strict boolean results,
  continue after ordinary check errors, and `canonical-json-v1`

Aliases are sorted by alias, watched files by normalized relative path. Descriptor
arrays are not sorted using locale-sensitive comparisons. Use the engine's stable
identifier ordering. Duplicate metadata is rejected or normalized by the same
category rules as existing stage declarations.

For each side, `checkInputs` contains exactly:

- contract version, suite hash, check ID, target stage ID
- verified source artifact hash, output codec
- full criteria artifact hash
- descriptor-selected values with `present`/`missing` states and contract IDs

If selector validation fails, this input fingerprint still describes the canonical
raw selection; invocation becomes an evaluator error. Missing is distinct from
JSON null. The alias-to-selector mapping is represented through the suite hash.

These fingerprints describe inputs, not permission to reuse. Every invocation runs
both sides for every check even if fingerprints or artifacts match. No evaluation
receipt may be substituted for an invocation.
Canonical selections are independently cloned per alias before constructing the
fingerprint material, so overlapping parent/child selectors do not introduce shared
object references rejected by the strict codec.

Absolute roots, storage paths, run IDs, manifest hashes, side labels, and timestamps
are excluded from check fingerprints. Exact run IDs and manifest hashes are retained
in receipt lineage. Runtime/platform version metadata is recorded in the receipt
for diagnostics but not a promise of cross-platform determinism. A future cache
would need an explicitly redesigned runtime-compatibility contract.

Receipt bodies include lineage, criteria hash, suite descriptor/hash, runtime metadata,
timestamps, ordered results, and summaries; exclude only their own ID/hash fields.
Two identical evaluator invocations can have equal check fingerprints but different
receipt IDs because receipts record invocation timestamps and exact lineage.

## 7. Internal records and result validation

Conceptual model (not implemented TypeScript):

```text
EvaluationReceipt
  schemaVersion = phase2-evaluation-receipt-v1
  id, receiptHash
  workflowId, suiteId, suiteHash, suiteDescriptor
  baseline = { runId, manifestHash }
  candidate = { runId, manifestHash }
  criteriaArtifactHash
  runtime = { nodeVersion, platform, arch }
  createdAt, completedAt
  evaluationStatus = passed | failed | error
  comparisonStatus = no_regressions | regressed | error
  checks[] = CheckPairRecord
  summary = { baselinePassed, baselineFailed, baselineErrors,
              candidatePassed, candidateFailed, candidateErrors,
              improved, regressed, unchangedPass, unchangedFail, incomparable }

CheckPairRecord
  checkId, targetStageId
  baseline = CheckSideRecord
  candidate = CheckSideRecord
  comparison = improved | regressed | unchanged_pass | unchanged_fail | incomparable

CheckSideRecord
  sourceArtifactHash, fingerprint
  invocationStatus = completed | error
  verdict = passed | failed | null
  details = strict JSON object
  error = null | { code, name, message }
```

Callbacks return exactly `{ passed: boolean, details: JsonObject }`. Unknown keys,
missing keys, coercible strings/numbers, unsupported values, or noncanonical data
are rejected as `invalid_check_result`. A callback throw/rejection becomes
`check_threw`; descriptor parsing becomes `output_contract_failed`. Error sides
have null verdict and empty details. Completed sides have no error.

Snapshot/clone and freeze callback inputs independently for each side/check; shared
mutable references must not let one invocation alter another. Validate the returned
value with the strict codec before accepting it. Compare booleans only; descriptions
and details never control verdicts or regression classification.

No stack traces or nested causes are persisted. User-supplied error messages and
details can still contain secrets: this receipt is developer-local data, not an
automatically redacted report. Criteria and artifacts must not be treated as a vault.

## 8. Exact comparison and summary rules

| Baseline verdict | Candidate verdict | Comparison |
| --- | --- | --- |
| passed | passed | unchanged_pass |
| failed | passed | improved |
| passed | failed | regressed |
| failed | failed | unchanged_fail |
| either side error | any | incomparable |

`evaluationStatus` evaluates the candidate against absolute criteria: `error` if
any candidate side errors, otherwise `failed` if any candidate verdict fails,
otherwise `passed`.

`comparisonStatus` is `error` if any side is incomparable, otherwise `regressed`
if any check regresses, otherwise `no_regressions`. All classifications and counts
remain visible even when an error takes precedence. A passing candidate with an
errored baseline can have `evaluationStatus: passed` and `comparisonStatus: error`.

No regressions is not equivalent to passing: both sides can fail the same criterion.
Likewise, an intentional stricter screening policy can fail a minimum-count check
without implying worse real research quality. Checks measure declared assertions,
not objective quality or statistical significance.

## 9. Evaluation algorithm and invalidation policy

1. Seal/validate the full suite and canonical criteria before callbacks.
2. Verify exact pair lineage and all required source artifacts.
3. Snapshot implementation identity and write/deduplicate the criteria artifact.
4. In sorted check-ID order, select and isolate the baseline output, fingerprint,
   validate, invoke, and validate its result; repeat for candidate. Record ordinary
   side errors and continue. Missing typed selections are errors, not omitted checks.
5. Classify each pair and compute summaries with the fixed rules above.
6. Recheck all watched inputs. Finalize and atomically publish one immutable receipt.

There is deliberately no reuse/invalidation planner for evaluators. Changes to a
revision, watched file, selector contract, or criteria alter identity and require
a fresh comparison of both sides. A manual rerun is simply another explicit call.
Unknown identity or malformed receipts fail verification, never fall back to an
old result. Changing an evaluator never reruns the workflow's stages.

Preflight failures, input instability, and persistence failures are request errors,
not failed assertions. No finalized receipt is returned after failed publication.
An interrupted invocation may leave deduplicated objects or ignored temporary files,
but must not expose a partial receipt. Failure of one ordinary check is captured
in a finalized receipt; failure of storage integrity is not disguised as a check error.

Evaluation-domain request codes are `invalid_suite`, `invalid_criteria`,
`run_pair_not_completed`, `run_pair_workflow_mismatch`, `run_pair_same_run`,
`run_pair_lineage_mismatch`, `target_stage_unavailable`, and
`evaluation_inputs_changed`. Existing manifest/artifact/storage domain failures retain
their existing codes; exact missing run lookup uses `run_not_found`. Check-side codes
are only `output_contract_failed`, `check_threw`, and `invalid_check_result` in v1.
Error messages are diagnostics, not API identifiers. Consumers must branch on codes.

## 10. Loading and persistence

The initial SDK imports a trusted local `evaluation.ts` module explicitly. It exports
one sealed suite whose root equals the configured execution project's root. Existing
`abilitybench.config.ts` and its accepted keys are unchanged. No auto-discovery,
project scanning, automatic module reload, or new default CLI config is introduced.
As with workflow modules, evaluation imports can execute arbitrary trusted Node code.

Source TypeScript follows the existing supported Node loader restrictions. SDK
callers supply a built suite; module loading is not a way to reconstruct historical
callbacks. The captured suite descriptor supplies historical identity, not executable code.

Use the configured execution store (default `.abilitybench`) and existing containment
and filesystem support rules. Extend storage with:

```text
.abilitybench/
  objects/sha256/<digest>          # existing canonical artifacts, including criteria
  runs/run_<digest>.json           # unchanged execution manifests
  evaluations/eval_<digest>.json   # new immutable canonical evaluation receipts
```

Only strict validated IDs form filenames. Publication uses the existing exclusive
hard-link protocol with content collision checks. Reading verifies exact schema,
allowed fields, enums, nested shapes, canonical bytes, suite/check fingerprints,
lineage references, summary counts, and receipt hash/ID. Do not trust stored summaries.
Artifact-dependent fingerprint checks require verified referenced objects; missing
references make the receipt unavailable for verified inspection.

Source run files and source output objects are never rewritten. Do not watch files
inside storage. There is no mutable index, automatic baseline selection, retention,
garbage collection, or receipt listing requirement in this slice. SDK exact receipt
lookup is enough; CLI design, JSON envelopes, and exit codes remain deferred.

## 11. Prototype verification matrix

Use a synthetic branch-and-join execution fixture and captured JSON outputs. Include
two independent checks targeting a branch and the joined report. A Composio example
may demonstrate a nonempty-report assertion, but not factual research evaluation.

| Case | Required proof |
| --- | --- |
| Full declaration, duplicate IDs, empty suite | Validation before callbacks |
| Reordered declaration or JSON keys | Same suite/check identity, stable result order |
| Typed selectors, absent required/optional fields | Explicit values or side error, never silent pass |
| Same output on both sides | Both callbacks run; equal input fingerprints |
| Pass/pass, fail/pass, pass/fail, fail/fail | Exact four classifications and counts |
| Both sides fail identically | No regressions, candidate evaluation failed |
| Baseline error, candidate pass | Candidate passed, comparison error |
| Candidate throw, baseline pass | Candidate error; comparison incomparable |
| One check errors | Other side/checks still evaluated |
| Invalid result, NaN, Date, shared reference | `invalid_check_result`, no coercion |
| Input/criteria mutation attempt | Independent sides/checks remain unchanged |
| Criteria, revision, file, selector-contract change | New identity; both sides freshly evaluated |
| Changed file during/between callbacks | No mixed-version receipt published |
| Missing or corrupt artifacts/manifests | Preflight failure; zero callbacks |
| Failed run, wrong workflow, self-pair | Explicit rejection before callbacks |
| Candidate names another baseline | Lineage mismatch rejection |
| Added/removed target vs untargeted stage | Reject missing targets; allow untargeted changes |
| Two candidates of one baseline | Separate receipts with identical baseline identity |
| Receipt corruption or altered summaries | Verified lookup rejects |
| Interrupted/colliding publication | No partial receipt or overwrite |
| Evaluate an already evaluated pair | New invocation; no result reuse |
| Successful comparison | Execution manifests/source artifacts byte-identical afterward |
| Existing CLI inspect/diff | Unchanged schema, behavior, exit status |

Run the quality gate on supported Windows and Ubuntu filesystems. Do not expand
platform promises, dependencies, or package publication settings for this prototype.

## 12. Challenge the design before implementation

This adds real machinery. For a single assertion, a normal test over a decoded
artifact is simpler. Proceed only if immutable two-run comparison, versioned criteria,
and explaining intentional regressions save users meaningful effort.

Reject these tempting additions for now:

- evaluator caching: cheap deterministic checks do not justify another cache contract
- evaluator DAGs: independent assertions do not need a second workflow engine
- numeric score deltas: units, direction, tolerances, weighting, and missing data need
  their own design; boolean assertions keep the initial comparison unambiguous
- direct pair callbacks: they can hide an invalid baseline or asymmetric grading
- run-manifest status mutation: it breaks immutable lineage and historical inspection
- automatic promotion of passing candidates: baseline selection remains explicit

Remaining risks are incomplete watched boundaries, unenforced purity, large artifact
memory use, a verbose receipt, private criteria/details, runtime drift, and subjective
criteria that produce misleading claims. The prototype does not solve those by adding
infrastructure. There is no timeout or cancellation guarantee; a hung trusted evaluator
can hang the local invocation, just like an existing stage. Worker isolation is deferred.

## 13. Implementation gate and suggested order

Before code, review this proposed contract for ambiguous semantics. In particular,
confirm that absolute boolean checks, direct-baseline-only pairs, and SDK-only usage
match the intended first evaluation use case. Existing independent usability and
release-ownership gates remain open and are not silently waived by this design.

If the contract is accepted, implement in small verified commits:

1. Suite declaration and pure result/comparison validation tests.
2. Read-only pair preparation and typed artifact selections.
3. Deterministic sequential runner with error and input-stability tests.
4. Immutable receipt storage and integrity verification.
5. Synthetic intentional-regression walkthrough; assess SDK ergonomics before any CLI.

No implementation is part of this specification commit.
