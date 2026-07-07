# Forge Agent Instructions

Forge is designed to be modified by agents from inside Forge. Keep the core small, provider-neutral, and documented.

## Mandatory rules

- Do not hardcode provider-specific behavior in `ForgeRuntime` or CLI orchestration. Add provider capabilities such as `DoctorProvider` or `SyncProvider` and let providers declare work.
- Every new command, provider capability, provider implementation, config field, or workflow gate must update docs in the same change.
- Every behavior change must include meaningful tests. Avoid tests that only assert mocks were called without validating user-visible behavior or state transitions.
- Run before sync/push:
  - `npm test`
  - `npm run build`
  - `forge doctor`
- Use `forge sync -m "<message>"` to publish local work once tests pass.

## Current stack

- Language/runtime: TypeScript on Node.js
- CLI: Commander
- Tests: Vitest
- VCS: `vcs.git`
- Workspace: `workspace.git-worktree`
- Agent: `agent.pi`
- SCM: `scm.github`
- Store: `store.filesystem`

## Architecture constraints

Core owns contracts, orchestration, policy, and event/state transitions. Providers own external systems.

If you need a new external behavior, prefer one of these patterns:

1. Add a generic capability interface in `src/core/`.
2. Implement it in one or more providers under `src/providers/`.
3. Have `ForgeRuntime` discover providers implementing that capability.
4. Have CLI commands call the generic runtime method.
5. Document the capability and provider implementation.

## Documentation map

- `README.md` — user quick start and command overview
- `docs/agent-guide.md` — how agents should augment Forge
- `docs/architecture.md` — core concepts and boundaries
- `docs/providers.md` — provider/capability authoring guide
- `docs/commands.md` — CLI behavior
- `docs/documentation-policy.md` — required doc updates
