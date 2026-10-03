# Contributing

## Scope

Keep changes within the active milestone. The Phase 0 engine contract remains normative, and the
active Phase 1 slice is the local CLI in `docs/phase-1-cli.md`. Provider integrations, databases,
user interfaces, tool replay, cost tracking, implicit baselines, and cloud features remain out of
scope for the execution milestone. The authorized Phase 2 slice adds only evaluation
declarations, pure comparisons, read-only pair preparation, and sequential in-memory
evaluation as tracked in `docs/phase-2-progress.md`. Receipt persistence remains deferred.

## Workflow

1. Start from a clean working tree.
2. Make one cohesive change.
3. Add or update tests and documentation with the behavior.
4. Run `pnpm check`.
5. Commit with a Conventional Commit message.

Pull requests and pushes to `main` run the same gate on current GitHub-hosted Ubuntu and Windows
runners. CI installs the project-pinned pnpm release from `packageManager`, uses the latest Node 24
release, and requires the committed lockfile to remain authoritative.

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
