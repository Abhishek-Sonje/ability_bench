# AbilityBench

AbilityBench is an experimental local-first execution engine for dependency-aware incremental
workflow runs.

The current milestone is deliberately narrow: Phase 0 proves that a fully declared DAG can reuse
valid artifacts from one immutable baseline and conservatively rerun affected stages.

## Status

Phase 0 is under active development. The public contract is specified before implementation:

- [Product plan](./plan.md)
- [Phase 0 execution contract](./execution-contract.md)

AbilityBench is not ready for production use.

## Development

Requirements:

- Node.js 24.20.0 or newer
- Corepack with pnpm 12.5.1

```bash
corepack enable
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions and quality gates.

