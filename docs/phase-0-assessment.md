# Phase 0 Assessment

## Outcome

Phase 0 is a technical success with a local SDK-ergonomics pass.

The execution engine has demonstrated deterministic planning, conservative invalidation,
content-addressed persistence, explicit lineage, integrity-checked reuse, and useful structured
reasons on a branch-and-join workflow. It is reasonable to preserve this engine design.

Typed stage handles infer direct dependency values, and built-in input descriptors validate and
infer selected external values. Grouped cache declarations keep revision, watched files, and
environment names together while the runtime still receives a fully declared DAG.

## Go/no-go gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Deterministic decisions and explanations | Pass | Stable topological ordering and reason-code tests |
| Invalid baseline or artifact is never silently reused | Pass | Missing, corrupt, tampered, and late-loss regressions |
| Branch-local changes preserve unrelated reuse | Pass | Planner, executor, and release-readiness integration tests |
| One immutable baseline is practical | Pass | First run, full reuse, and sibling-candidate lineage tests |
| Serialization failures are understandable | Pass | Strict JSON error codes, paths, and failed-run records |
| Easier than a bespoke cache | Pass locally | Typed handles and input descriptors remove parsing boilerplate while preserving explicit influences |
| Purity boundary is understood by developers | Unproven | Documented thoroughly, but not validated with external users |

## Declaration burden observed

The example contains six stages in 84 lines with no validation helpers. Each stage declares five
top-level fields: ID, dependencies, typed inputs, grouped cache influences, and callback. Revision,
watched files, environment names, and cache policy remain explicit inside the cache declaration
because each changes fingerprint or invalidation semantics.

Typed handles make misspelled dependency keys compile-time errors. Input descriptors make selected
values typed and fail a stage with a pointer-specific error when input violates its contract.
Changing a descriptor contract changes the selected-input fingerprint component.

## Recommendation

The local SDK checkpoint is complete. Keep typed handles and built-in descriptors additive until
an external workflow validates inference, compiler performance, and the purity documentation.
Custom input parsers remain deferred because arbitrary parsing code would need an explicit,
versioned identity and a clear transformation contract.

This checkpoint must not add LLM integration, SQLite, UI, tool replay, cost tracking, cloud
features, automatic import discovery, or unsafe cache defaults.

## Remaining external validation

- Run the conformance suite on Linux and macOS before calling those platforms supported.
- Have at least one developer unfamiliar with the implementation declare a small workflow and
  explain which ambient reads would violate cacheability.
- Confirm the local hard-link publication protocol on the filesystems intended for release.

These are release and product-validation requirements, not missing engine features.
