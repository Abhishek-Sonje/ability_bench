# Developer-local completion report

## Completed technical scope

- Full typed DAG declaration before execution, cycle validation, deterministic
  topological planning, and explicit dependency outputs.
- Declared cache boundaries, canonical fingerprints, watched-file/environment hashing,
  manual invalidation, volatile/non-cacheable behavior, and conservative propagation.
- Serialized artifacts, immutable execution history, one explicit baseline per candidate,
  integrity-checked storage, and reasons for every reuse/rerun decision.
- Execution CLI: run, plan, inspect, diff, and bounded run listing.
- Deterministic SDK evaluation with typed artifact selections, explicit criteria,
  fresh independent checks, distinct absolute/regression statuses, and immutable receipts.
- Evaluation CLI: explicit pair evaluation and exact verified receipt inspection,
  lazy suite loading, structured errors, and documented exit statuses.
- Synthetic branch-and-join and captured Composio demos with retained verified history.
  No live providers or writes to the source Composio project are required.

## Verification evidence

Implementation commit `0692ca3` passed `pnpm check` locally on Windows: lint, build,
type-check, and 187 tests passed; one POSIX-specific test was skipped. Built-process
coverage exercises all seven commands and includes paths with spaces, junction/symlink
containment, corrupt inputs/history, immutable manifests, and publication failures.

`pnpm example:evaluation-regression` passed after implementation. Fresh CLI evaluation
of its unchanged candidate passed; exact CLI inspection of its regression receipt
showed completed execution, failed candidate evaluation, and regression separately.

Windows/Ubuntu CI was previously verified through `23ad85d` in the
[assessment](./phase-2-assessment.md). That evidence does not verify `0692ca3`.
New CI requires pushing these local commits; no push or release has been performed.
The audit pass is user-reported, not a newly claimed independent review.

## Remaining validation/release gates

1. Push the completed commits when authorized and confirm Windows/Ubuntu CI for them.
2. Collect independent developer feedback on workflow modeling and decision explanations.
3. Before a public release, decide package ownership/name, license, initial version,
   compatibility policy, and support commitments; verify package contents and installation.

These are verification and product-ownership gates, not missing engine/CLI features.
macOS remains provisional; network filesystems remain unsupported. The package remains
private and version `0.0.0`; no publication is implied by technical completion.

## Deliberate exclusions and known limits

LLMs/providers, UI, SQLite, replay, cost accounting, cloud, numeric scores, evaluator
caching, automatic baseline promotion, and garbage collection are not requirements
of this completed scope. Adding them needs a separate problem statement and contract.

Purity is declarative, not sandboxed. Undeclared inputs and stale imported code can
invalidate claims of deterministic behavior. Watched checks are not atomic snapshots
and cannot detect A-B-A changes. Callbacks can hang; large JSON can exhaust memory.
Hashes detect corruption, not malicious rewriting of all references. Criteria and
callback diagnostics are not automatically redacted. An ordinary assertion script
can be simpler when immutable pair comparisons are unnecessary.
