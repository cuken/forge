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
- selected isolation provider via `FORGE_ISOLATION=host|docker|podman`
- `agent.pi`: pi binary, pi version
- `scm.github`: gh binary, gh auth, repo detection

Exit code is non-zero if any check fails. Warnings are printed but do not fail the command.

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

Runs all ready tasks sequentially in the current implementation.

For each ready task:

1. Mark task `running`.
2. Ask `WorkspaceProvider` to create a workspace.
3. Ask `IsolationProvider` to prepare the execution environment when configured. Select the built-in provider with `FORGE_ISOLATION=host|docker|podman`. The host provider returns the worktree directly; container providers own setup hooks, readiness checks, command delivery, and cleanup details. The Podman provider can run agent commands through `podman exec` once its retrying readiness command passes.
4. Ask `AgentProvider` to run with task/workspace/environment context.
5. Ask the isolation provider to clean up a prepared environment after the agent attempt.
6. Mark task `reviewing` on success or `failed` on failure.

Future implementations should replace sequential dispatch with a graph scheduler while preserving provider boundaries.
