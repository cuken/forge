# Provider Authoring Guide

Providers are Forge's extension mechanism. A provider is a class/object with an `id`, `kind`, and one required domain interface. Providers may also implement optional capability interfaces.

## Current domain interfaces

Defined in `src/core/types.ts`:

- `TaskStore` — persist tasks
- `VcsProvider` — version-control basics
- `WorkspaceProvider` — create isolated workspaces
- `IsolationProvider` — prepare the execution environment/safety boundary for agent processes
- `AgentProvider` — execute agent work
- `ScmProvider` — source-control-management systems such as GitHub issues
- `ChangeSetProvider` — review and accept changes produced by completed runs
- `ValidationProvider` — run provider-neutral gates before completed runs are accepted
- `TaskDiscoveryProvider` — attach provider-neutral discovery metadata, including likely task resource scopes, when tasks are created
- `LeaseProvider` — acquire and release provider-neutral resource scope leases around task runs
- `WorkstreamProvider` — import and list provider-neutral roadmap/workstream backlog items before they are enqueued as Forge tasks
- `WorkstreamPlannerProvider` — turn a natural-language goal into workstream items, optionally asking clarifying questions through a generic channel
- `NotificationProvider` — receive provider-neutral run lifecycle notifications without coupling runtime orchestration to a delivery channel

## Current optional capabilities

Defined in `src/core/health.ts`, `src/core/sync.ts`, and related capability files:

- `DoctorProvider` — declares environment checks for `forge doctor`; isolation providers also use these checks for `forge isolation status`
- `SyncProvider` — declares ordered sync tasks for `forge sync`
- `BuildPlannerProvider` — converts natural-language build requests into task/spec/run plans for `forge build`
- `TaskDiscoveryProvider` — discovers likely resource scopes for task metadata; the runtime calls it structurally during task creation
- `LeaseProvider` — leases discovered resource scopes before workspace/isolation/agent execution and releases them after the run completes or fails
- `WorkstreamProvider` — stores planned work items with dependencies and complexity for later task creation
- `WorkstreamPlannerProvider` — plans workstream items from a prompt for `forge workstream plan`, relaying clarifying questions through the caller-supplied `ask` channel
- `NotificationProvider` — receives best-effort run lifecycle events such as started, workspace-created, environment-prepared, deferred, succeeded, and failed

Optional capabilities must be discovered structurally with guards like `hasDoctor()` and `hasSync()`.

## Provider rules

1. Provider IDs should be stable and namespaced, e.g. `vcs.git`, `agent.pi`, `scm.github`.
2. Provider code may depend on external commands/APIs. Core code may not.
3. Provider tasks should return structured results instead of throwing for expected user-fixable states.
4. Checks and sync tasks should be idempotent where possible.
5. Destructive sync tasks must support `dryRun` if they can change user state.
6. Add tests for real state transitions or command output behavior.
7. Update docs whenever adding/changing provider behavior.

## Adding a provider capability

1. Add the generic interface in `src/core/<capability>.ts`.
2. Add a structural guard, e.g. `hasCapability(value)`.
3. Add a generic runtime method on `ForgeRuntime`.
4. Add CLI command if user-facing.
5. Implement in one provider.
6. Add tests proving generic discovery.
7. Document it here and in `docs/commands.md` if user-facing.

## Minimal provider example

```ts
import type { AgentProvider, Task } from '../core/types.js';
import type { DoctorProvider } from '../core/health.js';

export class MyAgentProvider implements AgentProvider, DoctorProvider {
  id = 'agent.my-agent';
  kind = 'agent' as const;

  async run(input: { task: Task; workspacePath: string; context: string }) {
    // call your harness/model/tool here
    return { exitCode: 0, output: 'done' };
  }

  checks() {
    return [{
      id: `${this.id}:available`,
      label: 'My agent available',
      run: async () => ({ id: `${this.id}:available`, status: 'pass', message: 'available' }),
    }];
  }
}
```

## Build planners

`BuildPlannerProvider` lets Forge accept human-friendly commands without forcing users to coordinate opaque IDs. A planner receives a natural-language request plus optional task name/pattern and returns a `BuildPlan` with title, description, complexity, spec requirement, rationale, and optional spec body.

Initial implementation: `build-planner.heuristic`. Future implementations can survey the repo with code indexes, query memory/context providers, or spawn agents before estimating complexity.

## Task discovery

`TaskDiscoveryProvider` lets providers annotate newly-created tasks with metadata about likely resource scopes without coupling Forge core to a code host, tracker, or index. The metadata is stored on the task as `discovery`, with the provider id, discovery timestamp, and `resourceScopes` entries such as `path`, `provider`, `config`, `docs`, `tests`, or `unknown`.

Initial implementation: `task-discovery.heuristic`, which recognizes explicit file paths anywhere in the task text and broad terms such as provider, config, docs, tests, task metadata, resource scopes, and discovery from the task title. Generic implementation checklist language in descriptions, such as "update docs" or "cover with tests", does not create broad `docs`/`tests` leases, so unrelated workstream items can still run in parallel.

## Change sets

`ChangeSetProvider` lets Forge review and accept changes produced by completed runs without hardcoding a VCS or code-host workflow into the runtime. `review()` returns an `empty` or `changed` summary with user-visible file and diff information. `accept()` returns an `accepted`, `empty`, or `blocked` result with a human-readable `message`.

Providers must use `blocked` for expected, user-fixable refusal cases instead of throwing or inventing provider-specific typed states. The runtime records the returned message in run acceptance metadata and leaves the task in `reviewing`; callers can show the reason and retry after the user fixes the condition. Throw only for unexpected provider failures. The built-in `change-set.git-worktree` provider returns `blocked` when the target project checkout has uncommitted changes, preserving the reason `Cannot accept change set: project checkout has uncommitted changes` in CLI output and run state.

## Resource scope leasing

`LeaseProvider` lets Forge coordinate potentially-conflicting ready tasks without coupling the runtime to a specific queue, lock service, code host, or database. When a task has discovery `resourceScopes`, `ForgeRuntime.runReady()` acquires a lease before creating the workspace and releases it in a `finally` hook after the agent run completes or fails.

Contract details:

- Providers must throw `LeaseConflictError` (from `src/core/lease.ts`) when a scope is held elsewhere. The runtime treats conflicts as expected contention and retries with backoff until the lease-wait deadline, then defers the task. Any other acquire error is treated as a provider failure and fails the task immediately, so do not wrap I/O or backend errors in `LeaseConflictError`.
- Scope keys come from `leaseScopeKey()`, which normalizes values (trims whitespace, strips trailing slashes) so `docs` and `docs/` contend for the same lease.

Built-in implementations:

- `lease.memory` is an in-process provider for local runs. It rejects overlapping scope keys such as `path:src/core/forge.ts` while the scope is already held.
- `lease.filesystem` persists one lock file per scope under `.forge/leases`, uses atomic file creation so separate Forge processes cannot acquire the same scope concurrently, removes stale lock files before acquisition/status, and reports active locks to `forge lease status`. Scopes are acquired in sorted key order so processes contending on overlapping scope sets collide on the first shared scope instead of deadlocking on partial holds. Configure stale cleanup with `FORGE_LEASE_STALE_AFTER_MS` (default: one hour).

Future implementations can back the same interface with Redis, SCM checks, or remote schedulers.

## Workstreams

`WorkstreamProvider` lets Forge ingest planned roadmap items without coupling core to a tracker, spreadsheet, or planning system. Items have provider-neutral `id`, `title`, optional `description`, `dependencies`, `complexity`, a `status` (`planned` or `queued`), and a `taskId` linking a queued item to its Forge task. The contract is `import`/`list`/`update`; the runtime owns enqueue semantics (dependency gating, dedupe) and calls `update` to record queue state, so providers only persist items.

`ForgeRuntime.enqueueWorkstream()` turns eligible planned items into tasks through `createTask()`, so the same complexity gates, discovery metadata, and future create-task behavior apply. An item is eligible when every dependency's linked task is `done`; explicit ids bypass gating but never re-queue.

Built-in implementations:

- `workstream.filesystem` imports JSON arrays or `{ "items": [...] }` documents and stores normalized backlog state in `.forge/workstream.json`, preserving queued status/task links when a roadmap is re-imported.
- `workstream.linear` backs the contract with Linear's GraphQL API. Select it with `[providers] workstream = "linear"`, configure `[linear] teamKey = "ENG"` and optional `project = "Roadmap"`, and set `LINEAR_API_KEY` in the environment. Linear issue identifiers become item ids; `forge:trivial|small|medium|large` labels map complexity (default `small`), `forge:queued` maps queued status, blocked-by issue relations map dependencies, and a local `.forge/linear-workstream-links.json` cache records Forge task links. `update()` applies the queued label and posts a comment with the Forge task id. The provider declares doctor checks for the API key and required config.
- `workstream.github` backs the contract with GitHub Issues. Select it with `[providers] workstream = "github"`, configure `[github] owner = "OWNER"` and `repo = "REPO"`, and set `GITHUB_TOKEN` or `GH_TOKEN`. Imported items become open issues labelled `forge:workstream`, `forge:planned|queued`, and `forge:trivial|small|medium|large`; item ids, dependency ids, and queued Forge task ids are written to a hidden issue-body metadata block, with dependency references also rendered as `Depends on:` text. A local `.forge/github-workstream-links.json` cache preserves task links for issue ids. `update()` rewrites labels/body state and comments with the Forge task id. The provider declares doctor checks for token and repository config.

Future implementations can back the same interface with Jira or any tracker that can represent titled items with dependencies — the runtime never sees tracker-specific concepts.

## Workstream planning

`WorkstreamPlannerProvider` turns a natural-language goal into draft workstream items without coupling core to any particular agent or planning tool. The contract is one method, `planWorkstream({ prompt, context, ask? })`. The optional `ask` callback is a generic clarification channel: the provider decides what to ask and when, while the caller decides how a human answers (the CLI uses terminal prompts; another host could use a web form or chat). When `ask` is absent the provider must plan without questions.

`ForgeRuntime.planWorkstream()` supplies project context from `.forge/context/project-summary.md`, merges the returned drafts into the existing backlog without touching queued items, and renames colliding ids (remapping intra-plan dependencies).

Built-in implementation: `workstream-planner.pi`, which runs the configured pi command twice — once to elicit at most four clarifying questions as JSON, once (with the answers) to produce the plan JSON. It parses JSON leniently from chatty agent output and normalizes complexity to the standard `trivial|small|medium|large` gates. Future implementations can wrap other agents, planning services, or fully deterministic templates.

## Run lifecycle notifications

`NotificationProvider` lets providers send lifecycle updates about Forge runs without the core knowing about chat, email, webhooks, terminals, or any other concrete channel. The contract is `notifyRun({ event, task, run?, message })`, where `event` is one of `run.started`, `run.workspace-created`, `run.environment-prepared`, `run.deferred`, `run.succeeded`, or `run.failed`.

`ForgeRuntime` discovers this capability structurally with `hasNotification()`. Providers that do not implement it are ignored. Notification delivery is best-effort: provider failures are swallowed so a broken notification backend cannot change task/run state or mask the real agent result. Providers should therefore log or track their own delivery errors if users need diagnostics.

Future implementations can deliver the same neutral events through any channel or service while keeping runtime orchestration provider-neutral.

## Current implementations

- `src/providers/build-heuristic` estimates request complexity and drafts specs for complex tasks.
- `src/providers/discovery-heuristic` attaches heuristic task discovery metadata and resource scopes to newly-created tasks.
- `src/providers/lease-memory` implements `LeaseProvider` with in-memory scope locks for the current Forge process.
- `src/providers/lease-filesystem` implements cross-process `LeaseProvider` locks in `.forge/leases` with stale lease cleanup and status reporting.
- `src/providers/workstream-filesystem` implements `WorkstreamProvider` by importing/listing normalized backlog JSON in `.forge/workstream.json`.
- `src/providers/workstream-linear` implements `WorkstreamProvider` against Linear GraphQL, including labels, issue relations, comments, link-cache persistence, and doctor checks.
- `src/providers/workstream-github` implements `WorkstreamProvider` against GitHub Issues, including labels, issue-body metadata, comments, link-cache persistence, and doctor checks.
- `src/providers/planner-pi` implements `WorkstreamPlannerProvider` by interviewing through pi and emitting dependency-ordered workstream drafts.
- `src/providers/store-filesystem` stores task JSON under `.forge/tasks`.
- `src/providers/vcs-git` implements Git VCS, doctor checks, and sync tasks.
- `src/providers/workspace-git-worktree` creates one Git worktree per task and provides `change-set.git-worktree` for reviewing changed files and accepting run branches back into the project checkout. New configs record this provider as `providers.changeSet`.
- `src/providers/isolation-host` runs agents directly on the host worktree and warns that it is not a sandbox.
- `src/providers/isolation-docker` prepares a Docker container for a task workspace, bind-mounts the workspace at `/workspace` by default, starts the container with network disabled unless policy requests inherited networking, and removes the container during cleanup. It implements `DoctorProvider` with a Docker daemon check.
- `src/providers/isolation-podman` prepares a Podman container with the task workspace bind-mounted, can run provider-owned setup hooks, verifies readiness with a retrying readiness command, exposes an environment executor that runs agent commands through `podman exec`, declares Podman doctor checks, and removes the container during isolation cleanup. Default image is `localhost/forge-agent-pi:latest`; build it with `npm run podman:image` or configure `FORGE_PODMAN_IMAGE`, `FORGE_PODMAN_READY`, and `FORGE_PODMAN_READY_ATTEMPTS`. Workspace mounts default to `rw,Z`/`ro,Z` for rootless Podman on SELinux systems. By default the provider copies the host pi agent config into `/root/.pi/agent` so containerized `pi` can use the same auth while keeping session writes inside the ephemeral container; disable with `FORGE_PODMAN_MOUNT_PI_CONFIG=0` or override source with `FORGE_PODMAN_PI_CONFIG`.
- `src/providers/agent-pi` runs `pi -p` against a task/workspace prompt.
- `src/providers/scm-github` creates issues and validates GitHub CLI state.
- `src/providers/validation-shell` implements `ValidationProvider` by running configured shell commands from `.forge/config.toml` `[validation] commands = [...]` in the completed run workspace before `forge runs accept` proceeds.
