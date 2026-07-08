# Forge Handoff

## Product ethos

Forge is a provider-neutral orchestration layer for agentic software work. It should help a project go wide: many non-blocking tasks can be planned, isolated, executed, reviewed, validated, accepted, and synced without different agents trampling each other.

Core principles:

1. **Forge orchestrates; providers implement.** Core should not know GitHub, Podman, pi, Docker, memory servers, MCP, or future tools directly.
2. **Provider boundaries first.** Add generic contracts in `src/core/`, then implementations under `src/providers/`.
3. **Dogfood Forge.** New features should be built through `forge build ...`, using Podman isolation by default.
4. **Everything is observable.** Runs, logs, statuses, leases, validation, and acceptance should be inspectable after the fact.
5. **Specs/gates before risky work.** Medium/large tasks should stop for spec approval unless explicitly auto-approved.
6. **Parallelism must be safe.** Discovery proposes scopes; leases coordinate execution; validation gates acceptance.
7. **Docs are part of the implementation.** Any new command, provider, config, lifecycle state, or behavior must update docs and tests.

## Current project structure

```txt
AGENTS.md                         agent instructions and mandatory rules
HANDOFF.md                        this handoff
README.md                         user-facing overview
.forge/
  config.json                     generated config
  config.toml                     human config; currently selects podman, shell validation, filesystem leases
  context/                        project context
  tasks/                          ignored local task records
  specs/                          ignored local specs
  runs/                           ignored durable run records
  logs/                           ignored run logs
  leases/                         ignored filesystem lease files
containers/podman/Containerfile   Forge agent image with node/git/pi
docs/
  architecture.md                 core concepts and boundaries
  providers.md                    provider authoring guide
  commands.md                     CLI behavior
  agent-guide.md                  agent workflow guidance
  documentation-policy.md         mandatory doc-update policy
src/
  cli.ts                          CLI composition and provider selection
  core/                           provider-neutral contracts/runtime
  providers/                      concrete provider implementations
test/                             Vitest coverage
```

## Core contracts/features currently present

### Task/build/spec flow

- `forge build <request...>` converts natural language into task/spec/run flow through `BuildPlannerProvider`.
- `build-planner.heuristic` estimates complexity and drafts specs.
- Medium/large tasks require spec unless `--auto-approve`.

### Config

- `.forge/config.toml` preferred over generated JSON.
- Current config:

```toml
[providers]
isolation = "podman"
validation = "shell"
lease = "filesystem"

[validation]
commands = ["npm ci", "npm test", "npm run build"]
```

### Isolation

- `IsolationProvider` prepares an execution environment.
- Current providers:
  - `isolation.host`
  - `isolation.docker`
  - `isolation.podman`
- Podman provider is the dogfood path:
  - image: `localhost/forge-agent-pi:latest`
  - build with `npm run podman:image`
  - copies host pi config into container
  - runs readiness check
  - executes agent commands via `podman exec`

### Runs/logging

- `RunStore` persists records under `.forge/runs/`.
- Logs under `.forge/logs/`.
- Commands:
  - `forge runs list`
  - `forge runs show <id-or-fragment>`
  - `forge runs log <id>`

### Review/accept

- `ChangeSetProvider` reviews/accepts completed run output.
- Current provider: `change-set.git-worktree`.
- Commands:
  - `forge runs review <id-or-fragment>`
  - `forge runs accept <id-or-fragment> [--dry-run] [-m message]`

### Validation

- `ValidationProvider` gates acceptance.
- Current provider: `validation.shell`.
- Configured commands: `npm ci`, `npm test`, `npm run build`.
- Command:
  - `forge runs validate <id-or-fragment>`

### Discovery

- `TaskDiscoveryProvider` proposes task resource scopes.
- Current provider: `task-discovery.heuristic`.
- Stores discovery metadata on task.
- `forge task list` shows `scopes=` when present.

### Leases

- `LeaseProvider` coordinates discovered scopes.
- Current providers:
  - `lease.memory` for one process
  - `lease.filesystem` for cross-process coordination under `.forge/leases`
- Commands:
  - `forge lease status`
  - `forge lease cleanup`
- `forge task run-ready --parallel N` acquires/retries/releases leases around task runs.

### Sync

- `SyncProvider` reconciles local state.
- Current Git provider commits local changes and pushes to `upstream`/`origin`.
- Command:
  - `forge sync [-m message] [--dry-run]`

## Working commands

```bash
npm test
npm run build
npm run podman:image
forge doctor
forge isolation status
forge build <request...> --auto-approve
forge task list
forge task run-ready --parallel 2
forge runs list
forge runs show <fragment>
forge runs review <fragment>
forge runs validate <fragment>
forge runs accept <fragment> --dry-run
forge lease status
forge sync -m "message"
```

## Suggested next best features

### 1. Make `forge runs accept` truly close the loop

Current accept exists, but it has not been heavily exercised as the default integration path. Improve/verify:

- accept a completed run from worktree to main
- record acceptance metadata reliably
- optionally run `forge sync` after accept or print a precise next step
- handle merge conflicts cleanly through provider result states instead of raw errors
- add tests around dirty main checkout, empty changes, merge conflict, and successful accept

Suggested build:

```bash
forge build harden forge runs accept so completed worktree runs merge safely with conflict reporting acceptance metadata and clear post accept sync guidance --auto-approve
```

### 2. Lease conflict semantics beyond exact keys

Filesystem leases currently lock per normalized scope key. We need richer conflict rules:

- `unknown:*` conflicts with all
- path prefix conflicts, e.g. `src/core/` vs `src/core/forge.ts`
- provider/config/docs/test scope families conflict sensibly
- expose conflict reason in logs/status

This should remain provider-owned: improve `lease.filesystem`, not core.

Suggested build:

```bash
forge build improve filesystem lease conflict detection for wildcard and path prefix resource scopes with clear conflict reasons --auto-approve
```

### 3. Discovery refinement and explicit user scopes

Discovery is heuristic-only. Add explicit override support:

```bash
forge task create "..." --scope src/core/forge.ts --scope docs/
forge build "..." --scope src/core/
```

Rules:

- explicit scopes are stored on task
- discovery can still add rationale but must not override explicit scopes
- task list/review should distinguish explicit vs discovered scopes

Suggested build:

```bash
forge build add explicit task resource scopes to build and task create commands while preserving provider discovery metadata --auto-approve
```

### 4. Run lifecycle cleanup

Worktrees, containers, runs, logs, and leases will accumulate. Add cleanup/status:

```bash
forge workspaces list
forge workspaces cleanup --done
forge runs cleanup --older-than 7d
```

Provider-neutral direction:

- `WorkspaceProvider` should expose optional list/cleanup hooks
- Git worktree provider implements them

Suggested build:

```bash
forge build add provider neutral workspace listing and cleanup commands for completed forge task worktrees --auto-approve
```

### 5. Better scheduler state and deferrals — DONE (2026-07-07)

Implemented directly in core:

- `forge task run-ready --lease-wait <seconds>` bounds lease waiting (default 15 minutes) with exponential backoff (250ms–5s) and log throttling.
- On timeout the task returns to `ready`, the run record is marked `deferred` (new `RunRecord` status), and the result includes `deferred: true` — never `failed`.
- Providers signal contention with `LeaseConflictError` (in `src/core/lease.ts`, carries `scopeKey`/`ownerTaskId`); any other acquire error fails the task immediately instead of retrying.
- `lease.filesystem` acquires scopes in sorted key order to avoid cross-process deadlock on overlapping scope sets, and only maps `EEXIST` to a conflict.
- `leaseScopeKey()` normalizes values (trim, strip trailing slashes) so `docs` and `docs/` contend.

Remaining follow-up: surface the conflict owner in `run-ready` JSON results (currently only in logs/error message).

### 6. Provider package/plugin loading

Currently providers are wired in `src/cli.ts`. Long term, users should add providers as packages/modules.

First slice:

- config-driven built-in provider selection is okay
- document an internal registry
- move CLI wiring toward a provider registry abstraction

Suggested build:

```bash
forge build introduce provider registry abstraction for builtin providers as first step toward package loaded forge providers --auto-approve
```

### 7. Agent survey discovery provider

Add a discovery provider that can ask an agent to survey the repo and propose scopes, without Forge knowing how it works.

Provider-owned details:

- may call pi
- may call MCP/memory
- may inspect repo map
- returns generic `TaskDiscoveryMetadata`

Suggested build:

```bash
forge build add agent survey task discovery provider that proposes resource scopes through the generic TaskDiscoveryProvider contract --auto-approve
```

## Important risks / known rough edges

- Containerized worktrees may have `.git` pointer issues inside Podman. The agent can edit files, but Git commands inside container may fail because worktree metadata points to host paths. Providers should not assume Git works inside the container unless the isolation provider deliberately supplies it.
- `lease.memory` is process-local only. Use `lease.filesystem` for real coordination.
- `forge runs accept` should be hardened before becoming the only integration path.
- Config parser is minimal TOML, not a full TOML parser.
- Provider selection is still mostly hardcoded in `src/cli.ts`; registry/package loading is future work.
- Many local `.forge/tasks`, `.forge/specs`, `.forge/runs`, `.forge/logs`, and `.forge/leases` are ignored and not portable by design.

## Suggested default next command

If continuing immediately, I recommend hardening accept first:

```bash
forge build harden forge runs accept so completed worktree runs merge safely with conflict reporting acceptance metadata and clear post accept sync guidance --auto-approve
```
