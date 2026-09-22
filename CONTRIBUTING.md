# Contributing

## Scope

Keep changes within the active milestone in `execution-contract.md`. Phase 0 excludes provider
integrations, databases, user interfaces, tool replay, cost tracking, and cloud features.

## Workflow

1. Start from a clean working tree.
2. Make one cohesive change.
3. Add or update tests and documentation with the behavior.
4. Run `pnpm check`.
5. Commit with a Conventional Commit message.

## Commit convention

Use `type(scope): summary`, for example:

```text
feat(graph): validate dependency cycles
test(cache): cover branch-local invalidation
docs(contract): clarify baseline lineage
```

Preferred types are `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, and `build`.

## Engineering rules

- Treat the execution contract as normative.
- Favor explicit behavior over inference.
- Reject unsupported values rather than coercing them.
- Never reuse an artifact after a failed integrity check.
- Keep structured reason codes separate from presentation strings.
- Do not weaken conservative invalidation to improve headline reuse numbers.
- Preserve deterministic ordering in data, plans, tests, and diagnostics.

## Quality gates

Every commit that changes executable behavior must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

