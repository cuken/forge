# Forge Architecture

Forge is a provider-neutral orchestration layer for wide, non-blocking agentic software work.

## Product thesis

Forge should let a project go wide: many agents can work on independent tasks concurrently, with explicit specs, isolated workspaces, shared context, and provider-declared synchronization back to version control and task systems.

Forge is not itself a coding model, VCS, issue tracker, queue, vector database, or sandbox. Forge coordinates those systems through contracts.

## Core pattern borrowed from pi

Pi keeps a small harness and makes behavior discoverable through project instructions, skills, extensions, packages, and docs. Forge follows the same principle:

- project-local instructions live in `AGENTS.md`
- reusable agent guidance lives in `docs/`
- external behavior is added as providers/capabilities
- commands call generic runtime capabilities, not specific tools
- future Forge packages should bundle providers, docs, prompts, and agent instructions

## Core nouns

- **Task** — desired work with status, complexity, optional issue, optional spec, and context refs.
- **Spec** — human or machine-approved design/evidence gate before execution.
- **Run** — one durable execution attempt by an agent, with metadata in `.forge/runs/` and captured output in `.forge/logs/`.
- **Release** — provider-neutral record for a versioned delivery target, with lifecycle status, target metadata, and timestamps in `.forge/releases/`.
- **Workspace** — isolated filesystem/repo location for a task.
- **Execution environment** — provider-prepared safety boundary where the agent process runs. This may be the host worktree, a container, a remote VM, or another sandbox.
- **Provider** — implementation of an external capability.
- **Capability** — optional interface a provider can implement, such as health checks or sync tasks.
- **Context** — reusable project/task knowledge to reduce repeated repo discovery.
- **Sync** — provider-declared reconciliation between local state and declared upstream systems.
- **Change set** — provider-neutral summary and acceptance hook for changes produced by a completed run.
- **Resource scope lease** — provider-neutral claim on discovered task scopes, acquired before execution and released after completion/failure.
- **Lifecycle hook** — provider-neutral event payload emitted after key state transitions such as run acceptance, task success/failure, and sync completion.
- **Build plan** — provider-generated translation from a natural-language request into task complexity, spec policy, and execution flow.

## Boundary rule

`ForgeRuntime` may know about generic capabilities, but must not know provider details like GitHub, Git worktrees, or pi command flags.

Good:

```ts
const tasks = providers.flatMap(p => hasSync(p) ? p.syncTasks() : []);
```

Bad:

```ts
await git.push('upstream', 'main');
```

## Current vertical slice

- `forge init` initializes `.forge/` and Git.
- `forge doctor` runs provider-declared environment checks.
- `forge sync` runs provider-declared synchronization tasks and emits a provider-neutral `sync.completed` lifecycle hook with the sync input and results.
- `forge build <request>` turns natural language into the opinionated task/spec/run flow through a build planner provider.
- `forge task create` creates local tasks and optionally GitHub issues.
- `forge task spec` writes a spec file and moves a task to approval.
- `forge task approve` marks the spec approved.
- `forge task run-ready` acquires provider-neutral leases for discovered resource scopes (waiting with backoff and deferring the task back to `ready` if a scope stays busy past the lease-wait deadline), creates worktrees, prepares an execution environment, invokes the configured agent, releases leases, records durable run metadata/logs for history inspection, and emits `task.succeeded` or `task.failed` lifecycle hooks. These hooks let providers observe task completion outcomes without core directly updating external trackers; successful completion still waits for acceptance before the task is truly closed. It can dispatch multiple ready tasks concurrently with `--parallel`, but each task still crosses only the generic lease, workspace, isolation, agent, and store provider contracts. Host, Docker, and Podman isolation providers are implemented behind the generic `IsolationProvider` contract.
- `forge runs review` and `forge runs accept` call a generic `ChangeSetProvider` to inspect and accept completed run output without embedding Git behavior in the runtime. Successful acceptance records commit context and emits `run.accepted`.
- `forge release create/list/show/status/prepare` manages first-class release records and asks a generic provider to prepare human merge review without assuming GitHub releases, branch names, automatic merges, or any specific deployment provider.

## Extension direction

Upcoming extensions should remain capability based:

- `CodeIndexProvider`
- `ContextProvider`
- `MemoryProvider`
- `WorkflowProvider`
- `QueueProvider`
- `IsolationProvider`
- `ReviewProvider`
- `MergeProvider`
- `LeaseProvider`
- `PackageProvider`

Each should be documented before broad implementation.
