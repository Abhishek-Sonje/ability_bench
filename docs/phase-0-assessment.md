# Phase 0 Assessment

## Outcome

Phase 0 is a technical success and a product-ergonomics hold.

The execution engine has demonstrated deterministic planning, conservative invalidation,
content-addressed persistence, explicit lineage, integrity-checked reuse, and useful structured
reasons on a branch-and-join workflow. It is reasonable to preserve this engine design.

The public stage API is not yet comfortable enough to expand into SQLite, LLM integrations, a
CLI, or a UI. The realistic release-readiness example exposes the issue: safe declarations are
understandable, but direct dependency values are untyped JSON and require repetitive runtime
validation.

## Go/no-go gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Deterministic decisions and explanations | Pass | Stable topological ordering and reason-code tests |
| Invalid baseline or artifact is never silently reused | Pass | Missing, corrupt, tampered, and late-loss regressions |
| Branch-local changes preserve unrelated reuse | Pass | Planner, executor, and release-readiness integration tests |
| One immutable baseline is practical | Pass | First run, full reuse, and sibling-candidate lineage tests |
| Serialization failures are understandable | Pass | Strict JSON error codes, paths, and failed-run records |
| Easier than a bespoke cache | Conditional pass | Engine use is much smaller than reimplementing storage and invalidation, but declarations remain verbose |
| Purity boundary is understood by developers | Unproven | Documented thoroughly, but not validated with external users |

## Declaration burden observed

The example contains six stages and is 135 lines including validation helpers. Every stage repeats
seven contract fields: dependencies, implementation revision, watched paths, selected inputs,
environment names, cache policy, and callback. That repetition is defensible because each field
changes fingerprint or invalidation semantics.

The larger problem is value typing. The current callback receives
`Record<string, JsonValue>` for dependency outputs and selected inputs. The example needs helper
functions to validate objects, arrays, booleans, numbers, properties, and dependency lookup before
performing simple work. This is safe but noisy, and misspelled dependency keys are runtime errors.

## Recommendation

Do not begin the broad original Phase 1 yet. First run a narrow SDK ergonomics checkpoint that
preserves the execution contract:

1. Prototype typed stage handles or an object-based workflow definition that infers direct
   dependency outputs without hiding dependencies.
2. Add optional input/output validators whose stable identity is explicit in the fingerprint
   contract; do not silently infer schemas.
3. Test both API shapes on the release-readiness example and one external developer workflow.
4. Continue only if declarations become materially shorter and type errors become local and clear.

This checkpoint must not add LLM integration, SQLite, UI, tool replay, cost tracking, cloud
features, automatic import discovery, or unsafe cache defaults.

## Remaining external validation

- Run the conformance suite on Linux and macOS before calling those platforms supported.
- Have at least one developer unfamiliar with the implementation declare a small workflow and
  explain which ambient reads would violate cacheability.
- Confirm the local hard-link publication protocol on the filesystems intended for release.

These are release and product-validation requirements, not missing engine features.
