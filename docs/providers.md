# Provider Authoring Guide

Providers are Forge's extension mechanism. A provider is a class/object with an `id`, `kind`, and one required domain interface. Providers may also implement optional capability interfaces.

## Current domain interfaces

Defined in `src/core/types.ts`:

- `TaskStore` — persist tasks
- `VcsProvider` — version-control basics
- `WorkspaceProvider` — create isolated workspaces
- `IsolationProvider` — prepare the execution environment/safety boundary for agent processes
- `AgentProvider` — execute agent work
- `ScmProvider` — source-control-management systems such as GitHub issues
- `ChangeSetProvider` — review and accept changes produced by completed runs

## Current optional capabilities

Defined in `src/core/health.ts`, `src/core/sync.ts`, and related capability files:

- `DoctorProvider` — declares environment checks for `forge doctor`; isolation providers also use these checks for `forge isolation status`
- `SyncProvider` — declares ordered sync tasks for `forge sync`
- `BuildPlannerProvider` — converts natural-language build requests into task/spec/run plans for `forge build`

Optional capabilities must be discovered structurally with guards like `hasDoctor()` and `hasSync()`.

## Provider rules

1. Provider IDs should be stable and namespaced, e.g. `vcs.git`, `agent.pi`, `scm.github`.
2. Provider code may depend on external commands/APIs. Core code may not.
3. Provider tasks should return structured results instead of throwing for expected user-fixable states.
4. Checks and sync tasks should be idempotent where possible.
5. Destructive sync tasks must support `dryRun` if they can change user state.
6. Add tests for real state transitions or command output behavior.
7. Update docs whenever adding/changing provider behavior.

## Adding a provider capability

1. Add the generic interface in `src/core/<capability>.ts`.
2. Add a structural guard, e.g. `hasCapability(value)`.
3. Add a generic runtime method on `ForgeRuntime`.
4. Add CLI command if user-facing.
5. Implement in one provider.
6. Add tests proving generic discovery.
7. Document it here and in `docs/commands.md` if user-facing.

## Minimal provider example

```ts
import type { AgentProvider, Task } from '../core/types.js';
import type { DoctorProvider } from '../core/health.js';

export class MyAgentProvider implements AgentProvider, DoctorProvider {
  id = 'agent.my-agent';
  kind = 'agent' as const;

  async run(input: { task: Task; workspacePath: string; context: string }) {
    // call your harness/model/tool here
    return { exitCode: 0, output: 'done' };
  }

  checks() {
    return [{
      id: `${this.id}:available`,
      label: 'My agent available',
      run: async () => ({ id: `${this.id}:available`, status: 'pass', message: 'available' }),
    }];
  }
}
```

## Build planners

`BuildPlannerProvider` lets Forge accept human-friendly commands without forcing users to coordinate opaque IDs. A planner receives a natural-language request plus optional task name/pattern and returns a `BuildPlan` with title, description, complexity, spec requirement, rationale, and optional spec body.

Initial implementation: `build-planner.heuristic`. Future implementations can survey the repo with code indexes, query memory/context providers, or spawn agents before estimating complexity.

## Current implementations

- `src/providers/build-heuristic` estimates request complexity and drafts specs for complex tasks.
- `src/providers/store-filesystem` stores task JSON under `.forge/tasks`.
- `src/providers/vcs-git` implements Git VCS, doctor checks, and sync tasks.
- `src/providers/workspace-git-worktree` creates one Git worktree per task and provides `change-set.git-worktree` for reviewing changed files and accepting run branches back into the project checkout. New configs record this provider as `providers.changeSet`.
- `src/providers/isolation-host` runs agents directly on the host worktree and warns that it is not a sandbox.
- `src/providers/isolation-docker` prepares a Docker container for a task workspace, bind-mounts the workspace at `/workspace` by default, starts the container with network disabled unless policy requests inherited networking, and removes the container during cleanup. It implements `DoctorProvider` with a Docker daemon check.
- `src/providers/isolation-podman` prepares a Podman container with the task workspace bind-mounted, can run provider-owned setup hooks, verifies readiness with a retrying readiness command, exposes an environment executor that runs agent commands through `podman exec`, declares Podman doctor checks, and removes the container during isolation cleanup. Default image is `localhost/forge-agent-pi:latest`; build it with `npm run podman:image` or configure `FORGE_PODMAN_IMAGE`, `FORGE_PODMAN_READY`, and `FORGE_PODMAN_READY_ATTEMPTS`. Workspace mounts default to `rw,Z`/`ro,Z` for rootless Podman on SELinux systems. By default the provider copies the host pi agent config into `/root/.pi/agent` so containerized `pi` can use the same auth while keeping session writes inside the ephemeral container; disable with `FORGE_PODMAN_MOUNT_PI_CONFIG=0` or override source with `FORGE_PODMAN_PI_CONFIG`.
- `src/providers/agent-pi` runs `pi -p` against a task/workspace prompt.
- `src/providers/scm-github` creates issues and validates GitHub CLI state.
