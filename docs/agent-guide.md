# Guide for Agents Working on Forge

Forge should be self-augmenting. Agents should be able to inspect the repo, read these docs, add providers/capabilities, test them, and publish with `forge sync`.

## Before changing code

1. Read `AGENTS.md`.
2. Read relevant docs in `docs/`.
3. Run `forge doctor` to understand configured providers.
4. Identify whether the change belongs in core or a provider.

## Decision tree

- New external system? Add/modify a provider.
- New cross-provider behavior? Add a generic capability in `src/core/`.
- New user action? Add a CLI command that calls `ForgeRuntime`, not provider internals.
- New task lifecycle rule? Update core types/runtime, tests, and docs.
- New provider package pattern? Update `docs/providers.md` and package docs when present.

## Required implementation shape

For a new capability:

```txt
src/core/<capability>.ts       # generic types, guard, runner
src/core/forge.ts              # runtime discovery method
src/providers/<provider>/      # implementation
src/cli.ts                     # command, if user-facing
test/*.test.ts                 # generic discovery and provider behavior
docs/*.md                      # updated docs
```

## Testing standard

No nonsense tests means tests should validate behavior that would matter to a user or provider author:

- file state changed as expected
- task status transitioned correctly
- provider-declared checks/tasks were discovered generically
- dry-run avoids mutation
- blocked/failed states stop unsafe continuation

Avoid only checking that a mock was called unless that proves a contract boundary.

## Documentation standard

When adding behavior, update at least one of:

- `README.md` for user-facing commands
- `docs/commands.md` for command semantics
- `docs/providers.md` for provider/capability contracts
- `docs/architecture.md` for new core concepts
- `AGENTS.md` for standing agent instructions

## Publishing workflow

```bash
npm test
npm run build
forge doctor
forge sync -m "<clear conventional commit message>"
```

Use `forge sync --dry-run` first when unsure.
