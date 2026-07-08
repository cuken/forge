# Forge Handoff

Last updated: 2026-07-08.

## Product ethos

Forge is a provider-neutral orchestration layer for agentic software work. It should help a project go wide: many non-blocking tasks can be planned, isolated, executed, reviewed, validated, accepted, and synced without different agents trampling each other.

Core principles:

1. **Forge orchestrates; providers implement.** Core must not know GitHub, Linear, Podman, pi, Docker, or future tools directly.
2. **Provider boundaries first.** Add generic contracts in `src/core/`, then implementations under `src/providers/`.
3. **Dogfood Forge.** New features should be built through `forge build ...` or workstream items run through the normal pipeline, using Podman isolation by default.
4. **Everything is observable.** Runs, logs, statuses, leases, validation, and acceptance are inspectable after the fact; `forge status` lists every pending human action with a runnable command.
5. **Specs/gates before risky work.** Medium/large tasks stop for spec approval unless explicitly auto-approved. The daemon never bypasses human gates.
6. **Parallelism must be safe.** Discovery proposes scopes; leases coordinate execution; validation gates acceptance.
7. **Docs are part of the implementation.** Any new command, provider, config, lifecycle state, or behavior must update docs and tests.

## The intended workflow

```bash
forge workstream plan <goal>       # interview → dependency-ordered backlog items
forge process                      # daemon: enqueue unblocked → run ready → report gates (Ctrl-C to stop)
forge status                       # what's waiting on a human, with the exact command to run
forge task approve '<fragment>'    # open spec gates
forge runs review/validate/accept '<fragment>'   # close out completed runs
forge sync -m "message"            # commit + push
```

All task/run commands resolve short unique title fragments — full ids are never required.

## Configuration

`.forge/config.toml` is the human-owned config (preferred over the generated `.forge/config.json`). Current contents:

```toml
[providers]
isolation = "podman"
validation = "shell"
lease = "filesystem"
workstream = "github"
workstreamPlanner = "pi"
spec = "pi"
notification = "console"

[github]
owner = "cuken"
repo = "forge"

[notifications]
channel = "stderr"

[validation]
commands = ["npm ci", "npm test", "npm run build"]
```

### Switching the backlog to GitHub Issues (live-verified 2026-07-08)

```toml
[providers]
workstream = "github"

[github]
owner = "cuken"
repo = "forge"
```

- Auth: uses `GITHUB_TOKEN`/`GH_TOKEN` if set, otherwise falls back to `gh auth token` — an existing `gh auth login` keyring session needs no extra setup.
- Backlog = open issues labelled `forge:workstream`. Complexity from `forge:trivial|small|medium|large` labels (default small); `forge:queued` + a "Forge task id" comment record queue state; a hidden issue-body metadata block round-trips ids/dependencies/taskId; hand-written `Depends on #N` / `Blocked by #N` phrasing works on plain issues.
- Verify with `forge doctor` (token + repo config checks), then `forge workstream list`.
- **Migration is manual**: switching providers does not move the existing `.forge/workstream.json` backlog. Migrate by importing the old items while the github provider is active (each becomes a labelled issue), or keep the local file until it drains.

### Switching the backlog to Linear (implemented, NOT yet live-verified)

```toml
[providers]
workstream = "linear"

[linear]
teamKey = "ENG"          # required
project = "Roadmap"      # optional
```

- Requires `LINEAR_API_KEY` in the environment. Verify with `forge doctor`, then `forge workstream list`.
- Issue identifiers (`ENG-123`) are item ids; `forge:*` labels map complexity/queued state; blocked-by relations map dependencies; task links cached in `.forge/linear-workstream-links.json`.
- Expect first-contact wrinkles: the GraphQL shapes are mock-verified only.

### Other config

- Isolation: `FORGE_ISOLATION=host|docker|podman` overrides `[providers] isolation`. Podman image: `localhost/forge-agent-pi:latest`, built with `npm run podman:image`.
- Leases: `FORGE_LEASE_STALE_AFTER_MS` tunes stale-lease cleanup (default 1h).
- The TOML parser is minimal (sections + `key = "value"` lines), not a full TOML implementation.

## Current project structure

```txt
AGENTS.md                         agent instructions and mandatory rules
HANDOFF.md                        this handoff
README.md                         user-facing overview
.forge/
  config.toml                     human config (see Configuration above)
  config.json                     generated config
  context/                        project context
  tasks/ specs/ runs/ logs/       ignored local state
  leases/                         ignored filesystem lease files
  workstream.json                 ignored local backlog (filesystem provider)
  *-workstream-links.json         ignored tracker task-link caches
containers/podman/Containerfile   Forge agent image with node/git/pi
docs/                             architecture, providers, commands, agent guide, doc policy
src/cli.ts                        CLI composition and provider selection
src/core/                         provider-neutral contracts/runtime
src/providers/                    concrete provider implementations
test/                             Vitest coverage (104 tests as of last sync)
```

## Capabilities and providers

| Capability | Contract | Providers | Commands |
|---|---|---|---|
| Task store / runs | `TaskStore`, `RunStore` | `store.filesystem` | `forge task list`, `forge runs list/show/log` |
| Build planning | `BuildPlannerProvider` | `build-planner.heuristic` | `forge build <request...> [--auto-approve]` |
| Workspaces | `WorkspaceProvider` | `workspace.git-worktree` | (used by run pipeline) |
| Isolation | `IsolationProvider` | host, docker, podman | `forge isolation status` |
| Agent | `AgentProvider` | `agent.pi` | (used by run pipeline) |
| Discovery | `TaskDiscoveryProvider` | `task-discovery.heuristic` | scopes shown in `forge task list` |
| Leases | `LeaseProvider` | `lease.memory`, `lease.filesystem` | `forge lease status/cleanup` |
| Change sets | `ChangeSetProvider` | `change-set.git-worktree` | `forge runs review/accept` |
| Validation | `ValidationProvider` | `validation.shell` | `forge runs validate` |
| Workstream | `WorkstreamProvider` | filesystem, github (live-verified), linear (mock-verified) | `forge workstream import/list/enqueue` |
| Planning | `WorkstreamPlannerProvider` | `workstream-planner.pi` | `forge workstream plan` |
| Sync | `SyncProvider` | `vcs.git` | `forge sync` |

Cross-cutting commands: `forge status` (pending human actions), `forge process` (daemon sweep loop), `forge doctor` (provider health checks).

Key semantics worth knowing:

- **Enqueue** is a safe repeated sweep: only planned items whose dependencies' linked tasks are `done` are queued; queued items are never duplicated; explicit ids force past gating. Enqueued tasks flow through `createTask`, so discovery scopes and spec gates apply.
- **Import merges by item id** (queued state preserved, absent items kept); `--replace` rewrites the backlog. Tracker-backed providers treat `--replace` as a no-op.
- **Leases**: providers throw `LeaseConflictError` for contention; the runtime retries with backoff up to `--lease-wait` (default 15 min) then defers the task back to `ready` (run recorded as `deferred`, never `failed`). Any other lease error fails the task immediately. `lease.filesystem` acquires scopes in sorted order to prevent cross-process deadlock.
- **The daemon (`forge process`)** supports `--yolo` for trusted burn-downs: specs are generated by `spec.pi`, approvals are automatic, and succeeded runs are accepted after validation.

## Pending state at handoff

- GitHub workstream issues #2-#29 were completed, synced to `upstream/main`, commented, and closed. `forge workstream list` is empty because the GitHub provider lists open `forge:workstream` issues only.
- `forge status` reports `no pending human actions`.
- Main is clean and pushed at handoff time.
- Local ignored state still contains historical runs/worktrees/logs from the burn-down. This is expected but should be cleaned by a first-class lifecycle cleanup feature.

## Suggested next work (in order)

1. **Close the loop automatically for tracker-backed workstreams** — add a provider-neutral completion path so `acceptRun()`/successful task completion updates the linked `WorkstreamProvider` item. `workstream.github` should close the issue, add `forge:done` or equivalent audit metadata, and comment with accepted run/commit info. This removes the current manual GitHub issue-closing step.
2. **Add daemon sync policy** — support `forge process --sync` / config-driven sync so accepted YOLO work can be committed and pushed after each successful sweep or batch. Keep this provider-neutral through `SyncProvider`; surface sync failures without losing accepted local state.
3. **First-class run/workspace/lease cleanup** — add commands such as `forge runs cleanup`, `forge workspaces cleanup --done`, and safer stale-run detection. The new `forge runs recover` helped, but stale containers, duplicate failed runs, old worktrees, and ignored logs still accumulate under daemon operation.
4. **Container-aware validation/doctor mode** — agents inside Podman repeatedly report `forge doctor` failures for expected container gaps (`podman`, `gh`, host git metadata). Add `forge doctor --scope workspace` or update agent/spec prompts so container validation focuses on `npm test`/`npm run build`, while host acceptance remains authoritative.
5. **Improve discovery/lease precision for parallelism** — `unknown:*` and broad `provider:src/providers` scopes still serialize too much work. Add path-prefix conflict semantics, better planner-provided scopes, and avoid broad unknown leases when tasks can safely run in parallel.

Later: provider registry/plugin loading (hardcoded wiring in `src/cli.ts` is fine while all providers are in-repo), agent-survey discovery provider, Linear live verification.

## Risks / known rough edges

- Git commands can fail inside Podman worktrees (worktree `.git` metadata points at host paths). Agents can edit files; providers must not assume in-container git works.
- `forge runs accept` is not yet hardened as the sole integration path; most historical integration in this repo was done via manual `git apply` + `forge sync`, with tasks closed by editing `.forge/tasks/*.json` afterward.
- GitHub's issues list endpoint has brief read-after-write lag; an import's returned list can momentarily miss a just-created issue. Harmless at daemon sweep cadence.
- `workstream.linear` has never touched a live workspace.
- Task ids are `<epoch-ms>-<slug>`; two tasks created in the same millisecond collide only if their slugs also match (has not happened, but the id scheme is weak).
- Local `.forge/` state (tasks, specs, runs, logs, leases, workstream, link caches) is ignored and not portable by design — the tracker-backed workstream providers are the portability story.
