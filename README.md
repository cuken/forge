# Forge

Forge is a provider-neutral orchestration layer for wide, non-blocking agentic software work.

Initial vertical slice:

- generic core interfaces for tasks, VCS, workspaces, agents, SCM, and stores
- filesystem task store
- Git VCS provider
- Git worktree workspace provider
- pi agent provider
- GitHub issue provider via `gh`
- CLI commands for `forge init`, task creation, spec approval, and ready-task execution

## Development

```bash
npm test
npm run build
node dist/cli.js init
```

## CLI

```bash
forge init
forge task create "Add feature" --complexity small
forge task create "Risky feature" --complexity medium
forge task spec <id> "# Spec..."
forge task approve <id>
forge task run-ready
```
