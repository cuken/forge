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
- **Run** — one execution attempt by an agent.
- **Workspace** — isolated filesystem/repo location for a task.
- **Provider** — implementation of an external capability.
- **Capability** — optional interface a provider can implement, such as health checks or sync tasks.
- **Context** — reusable project/task knowledge to reduce repeated repo discovery.
- **Sync** — provider-declared reconciliation between local state and declared upstream systems.
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
- `forge sync` runs provider-declared synchronization tasks.
- `forge build <request>` turns natural language into the opinionated task/spec/run flow through a build planner provider.
- `forge task create` creates local tasks and optionally GitHub issues.
- `forge task spec` writes a spec file and moves a task to approval.
- `forge task approve` marks the spec approved.
- `forge task run-ready` creates worktrees and invokes the configured agent for ready tasks.

## Extension direction

Upcoming extensions should remain capability based:

- `CodeIndexProvider`
- `ContextProvider`
- `MemoryProvider`
- `WorkflowProvider`
- `QueueProvider`
- `ReviewProvider`
- `MergeProvider`
- `PackageProvider`

Each should be documented before broad implementation.
