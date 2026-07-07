# Forge

Forge is a provider-neutral orchestration layer for wide, non-blocking agentic software work. It coordinates tasks, specs, agents, workspaces, version control, sync, and context so projects can safely go wide.

## Current vertical slice

- generic core interfaces for tasks, VCS, workspaces, agents, SCM, and stores
- provider-declared health checks via `forge doctor`
- isolation provider readiness reporting via `forge isolation status`
- provider-declared sync tasks via `forge sync`
- natural-language build flow via `forge build`
- filesystem task store
- Git VCS provider
- Git worktree workspace provider
- host execution isolation provider
- Docker execution isolation provider for container-prepared workspaces
- Podman execution isolation provider for container-prepared workspaces
- pi agent provider
- GitHub issue provider via `gh`
- spec gate for medium/large tasks

## Self-augmentation docs

Forge follows the same self-description pattern as pi: keep a small core, document extension points, and let agents safely modify the system from inside the repo.

Start here:

- `AGENTS.md` — standing instructions for agents
- `docs/agent-guide.md` — how agents should augment Forge
- `docs/architecture.md` — core concepts and boundaries
- `docs/providers.md` — provider/capability authoring guide
- `docs/commands.md` — CLI behavior
- `docs/documentation-policy.md` — mandatory documentation updates

## Development

```bash
npm test
npm run build
npm run podman:image
forge doctor
```

Publish local work:

```bash
forge sync --dry-run
forge sync -m "feat: describe your change"
```

## CLI

```bash
forge init
forge doctor
forge isolation status
FORGE_ISOLATION=docker forge doctor
FORGE_ISOLATION=podman forge isolation status
FORGE_ISOLATION=podman forge doctor
FORGE_ISOLATION=podman FORGE_PODMAN_IMAGE=your-agent-image forge run toml
forge sync --dry-run
forge build update forge so that it honors toml files in the config instead of json config files
forge task create "Add feature" --complexity small
forge task create "Risky feature" --complexity medium
forge task spec <id> "# Spec..."
forge approve toml
forge run toml
forge task approve <id>
forge task run-ready
```
