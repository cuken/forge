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

Creates a task in the configured `TaskStore`.

Options:

- `-d, --description <text>`
- `-c, --complexity <trivial|small|medium|large>`
- `--issue` — ask configured SCM provider to create an issue

Complexity policy:

- `trivial` and `small` start as `ready`
- `medium` and `large` start as `needs-spec`

## `forge task list`

Lists local tasks with ID, status, complexity, and title.

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

Runs all ready tasks. By default Forge runs one task at a time. Use `--parallel <count>` (or `-p <count>`) to let Forge dispatch multiple ready tasks concurrently.

Parallel execution still goes through the provider contracts for each task: the runtime asks the workspace provider for an isolated workspace, the isolation provider for an execution environment, the agent provider to run in that environment, and the run store to persist task-specific logs/metadata. Providers remain responsible for their own external-system behavior; Forge only controls how many ready task pipelines are in flight.

For each ready task:

1. Mark task `running`.
2. Ask `WorkspaceProvider` to create a workspace.
3. Ask `IsolationProvider` to prepare the execution environment when configured. Select the built-in provider with `FORGE_ISOLATION=host|docker|podman` or `.forge/config.toml` `[providers] isolation = "host"|"docker"|"podman"`. The host provider returns the worktree directly; container providers own setup hooks, readiness checks, command delivery, and cleanup details. The Podman provider can run agent commands through `podman exec` once its retrying readiness command passes.
4. Ask `AgentProvider` to run with task/workspace/environment context.
5. Ask the isolation provider to clean up a prepared environment after the agent attempt.
6. Append durable run output to `.forge/logs/<run-id>.log` while the agent runs.
7. Persist a durable run record in `.forge/runs/<run-id>.json` with task, workspace, environment, agent, status, exit code, and log path metadata.
8. Mark task `reviewing` on success or `failed` on failure.

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
