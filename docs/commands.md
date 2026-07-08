# Forge Commands

## `forge init`

Initializes Forge in the current working directory.

Effects:

- creates `.forge/config.json`
- creates `.forge/context/project-summary.md`
- initializes provider store
- asks the configured VCS provider to initialize if needed

Current Git implementation runs `git init` if the directory is not already a Git repo. It does not contact GitHub.

## `forge doctor`

Runs provider-declared environment checks.

The CLI does not know about Git, GitHub, or pi. It calls `ForgeRuntime.doctor()`, which discovers providers implementing `DoctorProvider`.

Current checks:

- `vcs.git`: git binary, repository, worktree support
- `change-set.git-worktree`: git metadata and worktree `.git` pointer accessibility needed by `forge runs review` and `forge runs accept`; this catches container/worktree mounts where Git can see the checkout but the referenced metadata is missing or inaccessible
- selected isolation provider via `FORGE_ISOLATION=host|docker|podman` or `.forge/config.toml`
- `agent.pi`: pi binary, pi version
- `scm.github`: gh binary, gh auth, repo detection

Exit code is non-zero if any check fails. Warnings are printed but do not fail the command.

## `forge isolation status`

Reports the selected isolation provider and readiness.

Selection uses the same configuration as task execution and `forge doctor`: `FORGE_ISOLATION=host|docker|podman` takes precedence, then `.forge/config.toml` `[providers] isolation = "host"|"docker"|"podman"`, then the generated `.forge/config.json`, then `host`. Readiness is derived from checks declared by the selected isolation provider. Any failing check makes the command exit non-zero.

Example:

```toml
# .forge/config.toml
[providers]
isolation = "podman"
```

```bash
forge isolation status
```

Output includes the provider id, aggregate readiness (`pass`, `warn`, or `fail`), and provider check details.

## `forge status`

Lists pending human actions and prints a ready-to-run command on every line. It summarizes tasks needing specs, specs awaiting approval, succeeded runs awaiting review/validation/acceptance, deferred runs ready to retry, and planned workstream items blocked on unfinished dependencies. Commands use unique title fragments where task/run resolution supports them, so users do not need to copy full IDs.

Example:

```bash
forge status
```

Example output:

```text
awaiting approval: Add TOML config -> forge task approve 'toml'
awaiting validation: Add status command -> forge runs validate 'status'
deferred: Update shared provider -> forge task run 'shared'
blocked workstream: Add final docs (waiting on core-slice) -> forge workstream enqueue final-docs
```

If nothing is waiting on a human, Forge prints `no pending human actions`.

## `forge sync`

Runs provider-declared sync tasks to reconcile local state with declared upstream systems.

Options:

- `--dry-run` — report intended work without changing state
- `-m, --message <message>` — commit/sync message passed to providers

Current Git sync tasks:

1. Ensure the current directory is a Git repo.
2. Commit local changes if the working tree is dirty.
3. Push current branch to `upstream`, falling back to `origin`.

Sync task execution stops on `blocked` or `failed` results.

## `forge lease status`

Lists active provider-neutral resource leases after asking the configured lease provider to clean stale entries. The filesystem provider (`[providers] lease = "filesystem"`) stores leases in `.forge/leases` so multiple Forge processes coordinate the same discovered resource scopes.

## `forge lease cleanup`

Removes stale leases through the configured lease provider and prints the number removed. For `lease.filesystem`, stale age defaults to one hour and can be changed with `FORGE_LEASE_STALE_AFTER_MS`.

## `forge process`

Runs a thin CLI loop around `ForgeRuntime.sweepWorkstream()`. Each sweep:

1. Enqueues planned workstream items whose dependencies are done.
2. Runs all ready tasks with bounded parallelism.
3. In `--yolo` mode only, generates placeholder specs, approves specs, and accepts succeeded runs so the daemon can continue past human gates.
4. Prints the same pending-human-actions summary as `forge status`.

Options:

- `--once` — run one sweep and exit
- `--interval <seconds>` — delay between sweeps (default: 60)
- `--parallel <count>` / `-p <count>` — ready-task parallelism for each sweep (default: 2)
- `--yolo` — bypass human gates during each sweep: generate a placeholder spec for `needs-spec` tasks, approve `awaiting-approval` specs, and accept succeeded `reviewing` runs after validation passes

```bash
forge process --parallel 3
forge process --once
forge process --yolo --parallel 3
```

By default, the daemon never bypasses human gates: medium/large workstream items still stop at `needs-spec`, specs remain `awaiting-approval` until a human runs `forge task approve`, and completed runs remain `reviewing` until a human validates/reviews/accepts them. `--yolo` is the explicit opt-in escape hatch for trusted backlog burn-downs; validation gates still run before acceptance, and failed validation remains blocked. Press Ctrl-C to request graceful shutdown; Forge finishes the in-flight sweep, prints its summary, and exits before starting another sweep.

## `forge workstream plan <prompt...>`

Defines a workstream interactively with the configured `WorkstreamPlannerProvider`. The provider may ask clarifying questions (scope edges, sequencing, constraints) through a generic channel; the CLI relays them as terminal prompts. Pass `--no-questions` to plan without an interview. The resulting items are merged into the existing backlog — queued items are untouched, and new item ids that collide with backlog ids are suffixed (with intra-plan dependency references remapped to match).

The built-in planner is `workstream-planner.pi` (`[providers] workstreamPlanner = "pi"`), which asks pi for clarifying questions, then for a JSON plan of dependency-ordered items sized with honest complexity so the spec gate still applies to risky work.

After planning: `forge workstream enqueue` to queue unblocked items, then `forge task run-ready --parallel <n>`.

## `forge workstream import [path]`

Imports provider-neutral roadmap/workstream backlog items from JSON into the configured `WorkstreamProvider`. The built-in filesystem provider stores normalized items in `.forge/workstream.json`; `[providers] workstream = "github"` stores items as GitHub issues using `[github] owner`/`repo` plus `GITHUB_TOKEN` or `GH_TOKEN`. Input may be an array or an object with an `items` array. Each item supports `id`, `title`, `description`, `dependencies`, and `complexity` (`trivial|small|medium|large`).

Import merges by item `id`: incoming items update matching backlog items (preserving the queued status and task linkage of items that were already enqueued), new items are appended, and backlog items absent from the file are kept. Pass `--replace` to rewrite the entire backlog from the file instead.

## `forge workstream list`

Lists workstream backlog items with ID, status (`planned` or `queued`), complexity, dependencies, title, and the linked Forge task ID once queued.

## `forge workstream enqueue [ids...]`

Creates Forge tasks from planned workstream items through the normal `createTask` flow, preserving complexity gates: trivial/small items become `ready`, while medium/large items become `needs-spec`. Each enqueued item is marked `queued` and linked to its task, so running enqueue repeatedly never duplicates tasks.

Without arguments, enqueue only takes planned items whose dependencies are all done: every dependency must already be queued and its linked task must have status `done` (dependencies that don't name a workstream item are ignored). This makes `forge workstream enqueue` safe to run repeatedly as a sweep — each pass releases the next wave of unblocked items. Passing explicit ids force-enqueues those items past dependency gating (but never re-queues an already-queued item).

## `forge build <request...>`

Alias: `forge b`.

Accepts a natural-language build request, asks the configured build planner provider to turn it into Forge's task/spec/run flow, and then applies the resulting policy.

Options:

- `--name <name>` — hard-define the task title instead of using the planner-generated title
- `--pattern <pattern>` — pass a provider-specific task matching pattern for future provider use
- `--auto-approve` — approve generated specs without stopping for human review
- `--no-run` — create/plan the task without invoking the agent

Current heuristic planner behavior:

- small requests become ready tasks and run immediately by default
- medium/large requests get a generated spec and stop at `awaiting-approval`
- provider/config/storage/workflow/gate/memory/indexing/sync/workspace terms increase estimated complexity

Example:

```bash
forge build update forge so that it honors toml files in the config instead of json config files
```

This should draft a spec and print the approval command. Future planners may use context maps, memory, survey agents, or LLMs to estimate complexity.

## `forge task create <title>`

Creates a task in the configured `TaskStore`. If a `TaskDiscoveryProvider` is configured, Forge also stores task discovery metadata with likely resource scopes.

Options:

- `-d, --description <text>`
- `-c, --complexity <trivial|small|medium|large>`
- `--issue` — ask configured SCM provider to create an issue

Complexity policy:

- `trivial` and `small` start as `ready`
- `medium` and `large` start as `needs-spec`

## `forge task list`

Lists local tasks with ID, status, complexity, title, and discovered resource scopes when present.

## `forge task spec <id> <body>`

Writes `.forge/specs/<id>.md`, attaches it to the task, and moves the task to `awaiting-approval`.

## `forge approve [pattern]`

Alias for `forge task approve [pattern]`.

Approves one awaiting task and moves it to `ready`. If exactly one task is awaiting approval, no pattern is needed. If multiple tasks are awaiting approval, pass an ID or unique title fragment.

```bash
forge approve toml
```

## `forge run [pattern]`

Alias for `forge task run [pattern]`.

Runs one ready task. If exactly one task is ready, no pattern is needed. If multiple tasks are ready, pass an ID or unique title fragment.

```bash
forge run toml
```

## `forge task approve [pattern]`

Marks a task spec approved and moves the task to `ready`. Supports ID or unique title fragment resolution.

## `forge task run [pattern]`

Runs one ready task by ID or unique title fragment.

## `forge task run-ready`

Runs all ready tasks. By default Forge runs one task at a time. Use `--parallel <count>` (or `-p <count>`) to let Forge dispatch multiple ready tasks concurrently. Use `--lease-wait <seconds>` to bound how long a task waits for busy resource scope leases before it is deferred (default: 15 minutes).

Parallel execution still goes through the provider contracts for each task: when discovered resource scopes are present, the runtime asks the lease provider to acquire those scopes, then asks the workspace provider for an isolated workspace, the isolation provider for an execution environment, the agent provider to run in that environment, and the run store to persist task-specific logs/metadata. Providers remain responsible for their own external-system behavior; Forge only controls how many ready task pipelines are in flight.

For each ready task:

1. Mark task `running`.
2. Ask `LeaseProvider` to acquire discovered resource scopes when configured and scopes are present. Built-in providers are `lease.memory` for one process and `lease.filesystem`/`filesystem` for cross-process coordination via `.forge/leases`; select one in `.forge/config.toml` with `[providers] lease = "filesystem"`. When a scope is held elsewhere, the runtime waits with exponential backoff (250ms up to 5s between attempts) and logs progress at most every 10 seconds. If the wait exceeds `--lease-wait`, the task is deferred: it returns to `ready`, its run record is marked `deferred`, and the run-ready result includes `"deferred": true`. Any lease error that is not a scope conflict fails the task immediately instead of retrying.
3. Ask `WorkspaceProvider` to create a workspace.
4. Ask `IsolationProvider` to prepare the execution environment when configured. Select the built-in provider with `FORGE_ISOLATION=host|docker|podman` or `.forge/config.toml` `[providers] isolation = "host"|"docker"|"podman"`. The host provider returns the worktree directly; container providers own setup hooks, readiness checks, command delivery, and cleanup details. The Podman provider can run agent commands through `podman exec` once its retrying readiness command passes.
5. Ask `AgentProvider` to run with task/workspace/environment context.
6. Ask the isolation provider to clean up a prepared environment after the agent attempt.
7. Release any acquired resource scope lease.
8. Append durable run output to `.forge/logs/<run-id>.log` while the agent runs.
9. Persist a durable run record in `.forge/runs/<run-id>.json` with task, workspace, environment, agent, status, exit code, and log path metadata.
10. Mark task `reviewing` on success or `failed` on failure.

Results are returned in ready-task order even when tasks finish out of order. A future implementation can replace this ready-task dispatcher with a graph scheduler while preserving the same provider boundaries.

## `forge runs list`

Alias group: `forge run-history list`.

Lists durable run records with ID, status, task ID, start/finish timestamps, and task title. Use `--task <id>` to filter to one task.

## `forge runs log <id>`

Alias group: `forge run-history log <id>`.

Prints captured output for a durable run from `.forge/logs/<run-id>.log` so users can inspect agent output after the run finishes.

## `forge runs show <id>`

Alias group: `forge run-history show <id>`.

Shows human-friendly durable run metadata including task, workspace, environment, validation, acceptance, and log path. Run arguments resolve by exact ID, ID prefix, task ID prefix, task title fragment, or workspace branch fragment. Ambiguous fragments are rejected.

## `forge runs review <id>`

Summarizes the provider-neutral change set for a succeeded run. The runtime calls the configured `ChangeSetProvider`; the built-in Git worktree implementation reports changed files, diff stats, and name-status output from the run workspace.

## `forge runs validate <id>`

Runs provider-neutral validation gates for a succeeded run and records the validation results on the run record. Configure the built-in shell validation provider in `.forge/config.toml`:

```toml
[providers]
validation = "shell"

[validation]
commands = ["npm test", "npm run build"]
```

Each command executes in the completed run workspace. Any non-zero exit is a failed gate.

## `forge runs accept <id>`

Accepts the provider-neutral change set for a succeeded run whose task is `reviewing`, then marks the task `done`. Validation gates run first; acceptance is blocked if any gate fails.

Options:

- `-m, --message <message>` — accept/commit message passed to the change set provider
- `--dry-run` — run validation and review the change set without accepting, merging, or marking the task done

The built-in Git worktree implementation stages and commits workspace changes on the run branch, then merges that branch into the project checkout. Successful acceptance records acceptance metadata on the run record; validation results are recorded for both normal and dry-run accepts.
