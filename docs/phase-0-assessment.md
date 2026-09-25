# Phase 0 Assessment

## Outcome

Phase 0 is a technical success with a conditional SDK-ergonomics pass.

The execution engine has demonstrated deterministic planning, conservative invalidation,
content-addressed persistence, explicit lineage, integrity-checked reuse, and useful structured
reasons on a branch-and-join workflow. It is reasonable to preserve this engine design.

The typed stage-handle checkpoint removed the most immediate ergonomics problem: direct dependency
values are inferred from their stage callbacks while the runtime still receives a fully declared
DAG. External selected inputs remain untyped JSON and require explicit validation.

## Go/no-go gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Deterministic decisions and explanations | Pass | Stable topological ordering and reason-code tests |
| Invalid baseline or artifact is never silently reused | Pass | Missing, corrupt, tampered, and late-loss regressions |
| Branch-local changes preserve unrelated reuse | Pass | Planner, executor, and release-readiness integration tests |
| One immutable baseline is practical | Pass | First run, full reuse, and sibling-candidate lineage tests |
| Serialization failures are understandable | Pass | Strict JSON error codes, paths, and failed-run records |
| Easier than a bespoke cache | Conditional pass | Typed handles remove dependency parsing, but metadata and external-input validation remain verbose |
| Purity boundary is understood by developers | Unproven | Documented thoroughly, but not validated with external users |

## Declaration burden observed

The example contains six stages and is 115 lines including input validation helpers. Every stage repeats
seven contract fields: dependencies, implementation revision, watched paths, selected inputs,
environment names, cache policy, and callback. That repetition is defensible because each field
changes fingerprint or invalidation semantics.

Typed handles now make misspelled dependency keys compile-time errors and eliminate object,
property, and dependency lookup helpers. Selected external inputs still use
`Record<string, JsonValue>`; the example needs helpers for arrays, booleans, and numbers.

## Recommendation

Do not begin the broad original Phase 1 yet. First run a narrow SDK ergonomics checkpoint that
preserves the execution contract:

1. Keep typed stage handles as an additive API until more workflows validate their inference and
   compiler performance.
2. Prototype optional input validators whose stable identity is explicit in the fingerprint
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
