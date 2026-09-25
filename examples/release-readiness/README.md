# Release Readiness Example

This example models a small deterministic developer workflow:

    inventory ---- unit-tests --+
             +--- security -----+--- summary --- report
    documentation --------------+

Build the package and run the first snapshot:

    pnpm build
    node examples/release-readiness/run.ts

Pass the printed run ID to execute a candidate against that exact baseline:

    node examples/release-readiness/run.ts run_<64-character-digest>

With unchanged inputs, all stages reuse. The integration test changes only the security signal;
security, summary, and report execute while the other stages reuse.

This example is intentionally local and deterministic. It does not call an LLM, invoke tools, or
perform evaluation, keeping it within Phase 0.
