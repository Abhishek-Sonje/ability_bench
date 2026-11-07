# Release Readiness Example

This example models a small deterministic developer workflow:

    inventory ---- unit-tests --+
             +--- security -----+--- summary --- report
    documentation --------------+

Build the package and run the first snapshot:

    pnpm build
    node dist/cli.js run --config examples/release-readiness/abilitybench.config.ts --inputs examples/release-readiness/inputs.json

Pass the printed run ID to execute a candidate against that exact baseline:

    node dist/cli.js run --config examples/release-readiness/abilitybench.config.ts --inputs examples/release-readiness/inputs.json --baseline run_<64-character-digest>

The smaller `run.ts` file demonstrates the equivalent programmatic SDK flow.

With unchanged inputs, all stages reuse. The integration test changes only the security signal;
security, summary, and report execute while the other stages reuse.

This example is intentionally local and deterministic. It does not call an LLM, invoke tools, or
perform evaluation, keeping it within Phase 0.

The workflow uses typed stage handles and built-in input descriptors. Direct dependency outputs and
selected external values are inferred by TypeScript. Each cache declaration groups its revision,
watched files, and environment influences.
