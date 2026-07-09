# Forge

Forge is a provider-neutral orchestration layer for wide, non-blocking agentic software work. It coordinates tasks, specs, agents, workspaces, version control, sync, and context so projects can safely go wide.

## Current vertical slice

- generic core interfaces for tasks, VCS, workspaces, agents, SCM, and stores
- provider-declared health checks via `forge doctor`
- isolation provider readiness reporting via `forge isolation status`
- provider-declared sync tasks via `forge sync`
- natural-language build flow via `forge build`
- filesystem task, run-history, and release-record stores
- Git VCS provider
- Git worktree workspace provider
- host execution isolation provider
- Docker execution isolation provider for container-prepared workspaces
- Podman execution isolation provider for container-prepared workspaces
- pi agent provider
- GitHub issue provider via `gh`
- spec gate for medium/large tasks
- provider-neutral validation gates before accepting completed runs
- optional parallel dispatch for multiple ready tasks
- filesystem resource-scope lease provider with stale cleanup for coordinating parallel Forge processes
- provider-neutral workstream backlog import/list/enqueue flow backed by filesystem JSON, Linear, or GitHub Issues
- interactive workstream planning through a generic planner provider (pi-backed interview by default)
- provider-neutral run lifecycle notifications with configurable provider/channel selection, including local `.forge/audit.log` JSONL audit logging
- stale-run continuity checks: `forge status` reports running/orphaned environments, and sweeps recover containerized runs whose agent process disappeared
- provider-neutral release records with version, lifecycle status, target metadata, and timestamps
- work items can target exactly one planned release and show that target in task/status output

## Targeted release workflow

Forge models releases provider-neutrally while letting providers implement concrete review mechanics. A typical targeted release flow is:

1. Create the release intent: `forge release create 1.2.3 --target-kind package --target-id forge-cli`.
2. Target work to the planned release with `forge task create ... --release <release-id>` or `forge task update ... --release <release-id>`.
3. Run agents normally with `forge task run-ready`; targeted tasks resolve the provider-owned release ref and build their worktrees from it.
4. Review, validate, and accept run outputs as usual, merging accepted changes into the release working ref through the configured providers.
5. Prepare the release for a human with `forge release prepare <release-id>`. Core asks a generic `ReleaseVcsProvider` for a review artifact and never assumes branch names or merges automatically.

With the built-in GitHub provider, `forge release prepare` ensures the release branch exists (default `release/{version}`, configurable with `[github] releaseBranchTemplate`, based on `[github] releaseBaseBranch` or the repository default), stores the branch/ref and compare URL in release metadata, and prints manual review/merge next steps.

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
# inside isolated task containers, use workspace-scoped checks:
forge doctor --scope workspace
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
forge doctor --scope workspace # container/task workspace checks; host doctor remains authoritative
forge isolation status
FORGE_ISOLATION=docker forge doctor
FORGE_ISOLATION=podman forge isolation status
FORGE_ISOLATION=podman forge doctor
FORGE_ISOLATION=podman FORGE_PODMAN_IMAGE=your-agent-image forge run toml
# or set .forge/config.toml:
# [providers]
# isolation = "podman"
# taskDiscovery = "agent-survey" # optional agent survey; default is heuristic
forge sync --dry-run
forge process --yolo --sync --parallel 3
forge lease status
forge lease cleanup
forge cleanup all
forge cleanup all --apply
forge workstream plan build a plugin system with docs and a sample plugin
forge workstream import roadmap.json
forge workstream list
forge workstream enqueue
forge workstream reconcile --apply
forge build update forge so that it honors toml files in the config instead of json config files
forge task create "Add feature" --complexity small
forge task create "Fix for next release" --release 1-2-3-package-forge-cli
forge task update "Fix for next release" --release 1-2-4-package-forge-cli
forge task create "Risky feature" --complexity medium
forge task spec <id> "# Spec..."
forge approve toml
forge run toml
forge release create 1.2.3 --target-kind package --target-id forge-cli
forge task create "Fix for 1.2.3" --release 1-2-3-package-forge-cli
forge task run-ready
forge runs accept <run-id>
forge release prepare 1-2-3-package-forge-cli
forge release list
forge runs list
forge runs log <run-id>
forge runs show <run-id-or-title-fragment>
forge runs validate <run-id>
forge runs accept <run-id> --dry-run
forge runs accept <run-id>
forge task approve <id>
forge task run-ready
forge task run-ready --parallel 3
```
