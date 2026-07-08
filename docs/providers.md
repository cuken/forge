# Provider Authoring Guide

Providers are Forge's extension mechanism. A provider is a class/object with an `id`, `kind`, and one required domain interface. Providers may also implement optional capability interfaces.

## Current domain interfaces

Defined in `src/core/types.ts`:

- `TaskStore` — persist tasks
- `ReleaseStore` — persist provider-neutral release records with version, lifecycle status, target metadata, and timestamps
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
- `GateProvider` — publish pending human decisions to an external system of record and read provider-neutral decisions back

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
- `ReleaseVcsProvider` — prepares provider-neutral release records for human merge/release review without hardcoded branch behavior
- `GateProvider` — bridges Forge approval gates to external systems without exposing tracker-specific concepts to core

Optional capabilities must be discovered structurally with guards like `hasDoctor()` and `hasSync()`. Provider-owned doctor checks should cover external/environmental prerequisites that the runtime cannot know about; for example, `change-set.git-worktree` verifies Git worktree metadata and `.git` pointer accessibility so `forge doctor` can flag container mounts that would make review/accept fail. Notification providers also declare channel-readiness checks so `forge doctor` can report whether the selected console stream or filesystem audit log is writable before run lifecycle events are emitted.

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

## Spec generation

`SpecProvider` lets Forge create task specs without baking a particular agent or template into core. The contract is `generateSpec({ task, context }) -> { providerId, body }`; runtime writes the returned Markdown with the same `writeSpec` path used for human-authored specs, so approval gates remain provider-neutral.

The built-in `spec.pi` provider runs the configured pi command (`[pi] command`/`args`) and asks it for a concise Markdown spec with goals, boundaries, provider-boundary design notes, implementation steps, tests/docs, and acceptance criteria. Select it with `[providers] spec = "pi"`; CLI wiring defaults to pi when no spec provider is configured so `forge task spec --generate <task>` and `forge process --yolo` can create meaningful specs for workstream items.

## Task discovery

`TaskDiscoveryProvider` lets providers annotate newly-created tasks with metadata about likely resource scopes without coupling Forge core to a code host, tracker, or index. The metadata is stored on the task as `discovery`, with the provider id, discovery timestamp, and `resourceScopes` entries such as `path`, `provider`, `config`, `docs`, `tests`, or `unknown`.

Initial implementation: `task-discovery.heuristic`, which recognizes explicit file paths anywhere in the task text and broad terms such as provider, config, docs, tests, task metadata, resource scopes, and discovery from the task title. Generic implementation checklist language in descriptions, such as "update docs" or "cover with tests", does not create broad `docs`/`tests` leases, so unrelated workstream items can still run in parallel.

## Change sets

`ChangeSetProvider` lets Forge review and accept changes produced by completed runs without hardcoding a VCS or code-host workflow into the runtime. `review()` returns an `empty` or `changed` summary with user-visible file and diff information. `accept()` returns an `accepted`, `empty`, `blocked`, or `merge-conflict` result with a human-readable `message`.

Providers must use `blocked` for expected, user-fixable refusal cases and `merge-conflict` for expected merge-conflict outcomes instead of throwing or inventing provider-specific typed states. The runtime records the returned message in run acceptance metadata and leaves the task in `reviewing`; callers can show the reason and retry after the user fixes the condition. The CLI renders these as concise human-facing result lines (`blocked <run>: ...` and `conflict <run>: ...`) with non-zero exit codes and no raw stack traces. Throw only for unexpected provider failures. The built-in `change-set.git-worktree` provider returns `blocked` when the target project checkout has uncommitted changes, preserving the reason `Cannot accept change set: project checkout has uncommitted changes` in CLI output and run state. It returns `merge-conflict` when merging the run branch into the target checkout produces conflicted files, with a message naming the conflicted paths.

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
- `workstream.github` backs the contract with GitHub Issues. Select it with `[providers] workstream = "github"`, configure `[github] owner = "OWNER"` and `repo = "REPO"`, and set `GITHUB_TOKEN` or `GH_TOKEN`. Imported items become open issues labelled `forge:workstream`, `forge:planned|queued`, and `forge:trivial|small|medium|large`; item ids, dependency ids, and queued Forge task ids are written to a hidden issue-body metadata block, with dependency references also rendered as `Depends on:` text. A local `.forge/github-workstream-links.json` cache preserves task links for issue ids. `update()` rewrites labels/body state and comments with the Forge task id. Network/DNS failures are reported as host-side GitHub REST failures (the workstream calls run in the CLI process, not task Podman containers). The provider declares doctor checks for token and repository config.
- `gate.github-issues` backs `GateProvider` with GitHub Issues via the `gh` CLI. Select it with `[providers] gate = "github"` or `"gate.github-issues"` and configure the same `[github] owner`/`repo`. It creates `forge:gate` issues containing spec text or run summaries, posts additional summaries as comments, and reads approvals from `forge:approved` / `forge:accepted` labels or `/approve` / `/accept` comments. Rejections use `forge:rejected` or `/reject`.

Future implementations can back the same interface with Jira or any tracker that can represent titled items with dependencies — the runtime never sees tracker-specific concepts.

## Workstream planning

`WorkstreamPlannerProvider` turns a natural-language goal into draft workstream items without coupling core to any particular agent or planning tool. The contract is one method, `planWorkstream({ prompt, context, ask? })`. The optional `ask` callback is a generic clarification channel: the provider decides what to ask and when, while the caller decides how a human answers (the CLI uses terminal prompts; another host could use a web form or chat). When `ask` is absent the provider must plan without questions.

`ForgeRuntime.planWorkstream()` supplies project context from `.forge/context/project-summary.md`, merges the returned drafts into the existing backlog without touching queued items, and renames colliding ids (remapping intra-plan dependencies).

Built-in implementation: `workstream-planner.pi`, which runs the configured pi command twice — once to elicit at most four clarifying questions as JSON, once (with the answers) to produce the plan JSON. It parses JSON leniently from chatty agent output and normalizes complexity to the standard `trivial|small|medium|large` gates. Future implementations can wrap other agents, planning services, or fully deterministic templates.

## Release records

`ReleaseStore` persists first-class release domain records independently of task runs, GitHub releases, branch names, or deployment backends. A `ReleaseRecord` has a stable `id`, semantic or project-defined `version`, lifecycle `status` (`planned`, `active`, `ready`, `completed`), a provider-neutral `target` (`kind`, `id`, optional `name` and metadata), timestamps, notes, and arbitrary metadata.

`ForgeRuntime.createRelease()`, `getRelease()`, `listReleases()`, and `updateRelease()` expose the generic store pattern. Providers should keep target identifiers stable and let future delivery/deployment capabilities interpret release records instead of encoding external-system behavior in core.

`ReleaseVcsProvider` is the generic source-control capability for release preparation. `ForgeRuntime.prepareRelease()` discovers it structurally with `hasReleaseVcs()` and calls, in order, `ensureReleaseTarget({ release })`, `resolveReleaseRef({ release, target })`, and `prepareReleaseReview({ release, target, ref })`. Providers own branch/tag/ref naming, remote existence checks, and review artifact creation; core advances release status through `active`/`ready` and persists the structured provider results under release metadata. Expected human-fixable refusal should return review status `blocked` with `blockingItems` and, where useful, `nextSteps`; unexpected backend failures may throw. Providers must not merge or publish automatically; humans make those decisions and mark releases `completed` afterward.

`ForgeRuntime.runReady()` also uses `ReleaseVcsProvider` for tasks with `targetRelease`: it resolves the release ref at execution time and passes that provider-owned ref to `WorkspaceProvider.create({ baseBranch })`. Untargeted tasks do not resolve release refs and keep the workspace provider default. Core must not hardcode release branch names; tests should assert the workspace base comes from the provider result.

The built-in `scm.github` provider implements `ReleaseVcsProvider` with GitHub branches through `gh`. Configure `[github] owner`/`repo` to select a repository explicitly, `[github] releaseBranchTemplate` to derive a branch from release metadata tokens (`{id}`, `{version}`, `{target.kind}`, `{target.id}`), and `[github] releaseBaseBranch` to choose the source branch. The default branch template is `release/{version}` and the default base is the repository default branch. Preparing a release ensures the branch exists on GitHub, creating it from the base branch when needed, and returns the branch/ref plus a GitHub compare URL and manual merge next steps to Forge.

For the end-to-end targeted release workflow, provider boundaries remain strict: `ReleaseStore` records release intent, `TaskStore` records which planned release a work item targets, `ReleaseVcsProvider` resolves the provider-owned working ref at run time, `WorkspaceProvider` creates each task workspace from that ref, `AgentProvider` performs the work, `ChangeSetProvider`/validation gates handle acceptance, and `ReleaseVcsProvider.prepareReleaseReview()` produces the final human review artifact. Core coordinates these transitions but does not name branches, create pull requests, publish GitHub releases, or merge code.

In the GitHub implementation, the release working ref is a branch rendered from `[github] releaseBranchTemplate`; tokens are sanitized path segments from the provider-neutral release metadata. `resolveReleaseRef()` checks for the branch with `gh api`, creates it from `[github] releaseBaseBranch` (or the repository default branch) when absent, and returns `{ ref, baseRef, headRef }`. `prepareReleaseReview()` returns `ready` with the compare URL `https://github.com/<owner>/<repo>/compare/<baseRef>...<headRef>` and next steps instructing a human to review and merge manually. Providers for other code hosts should expose equivalent provider-neutral refs and review URLs without changing core semantics.

The built-in `store.filesystem.releases` provider stores one JSON file per release in `.forge/releases/` and supports listing by status or target kind.

## Human approval gates

`GateProvider` lets Forge expose pending human decisions (currently spec approval and run acceptance) through an external system of record without coupling core to a tracker, chat app, or code host. The contract lives in `src/core/gate.ts` and has two methods:

- `publishDecision({ subject, message, metadata })` creates or updates a pending external decision and returns a provider-neutral `PendingGateDecision` containing `providerId`, stable `gateId`, `kind`, `taskId`, optional `runId`, optional `url`, and a human-readable `message`.
- `readDecision({ gateId, kind, task, run })` reads the external decision state and returns a `GateDecision` with status `pending`, `approved`, `rejected`, or `canceled`, or `null` when the external record is not found.

Subjects are provider-neutral unions: `spec-approval` carries the Forge task plus spec path/body, and `run-acceptance` carries the Forge task plus run record and optional summary. Providers may map these subjects to issues, pull requests, forms, tickets, chat messages, or any other durable system, but core must only persist and act on the neutral ids, statuses, messages, URLs, and JSON metadata returned by the provider.

Expected human outcomes should be returned as decision statuses rather than thrown errors. Throw only for unexpected backend failures. Provider-specific fields belong in `metadata`; do not add tracker-specific ids or workflow states to `Task`, `RunRecord`, or runtime orchestration.

## Run lifecycle notifications

`NotificationProvider` lets providers send lifecycle updates about Forge runs without the core knowing about chat, email, webhooks, terminals, or any other concrete channel. The contract is `notifyRun({ event, task, run?, message, metadata? })`, where `event` is one of `run.started`, `run.workspace-created`, `run.environment-prepared`, `run.deferred`, `run.succeeded`, or `run.failed`.

`ForgeRuntime` discovers this capability structurally with `hasNotification()`. Providers that do not implement it are ignored. The runtime emits notifications during the normal run flow: `run.started` when execution begins, `run.workspace-created` after workspace preparation, `run.environment-prepared` after isolation setup, `run.deferred` when dependency or lease policy defers work, and a terminal `run.succeeded` or `run.failed` after the final `RunRecord` is persisted. Successful terminal events include provider-neutral data such as task id/title, run id/status, workspace, environment, agent id, exit code, and finish time. Failure terminal events cover both non-zero agent exits and Forge execution errors; they include `metadata.failureReason` and add `metadata.exitCode` for non-zero exits. Notification delivery is best-effort: provider failures are swallowed so a broken notification backend cannot change task/run state or mask the real agent result. Providers should therefore log or track their own delivery errors if users need diagnostics.

The built-in `notification.console` implementation writes lifecycle messages to either `stderr` or `stdout`. Select it with `[providers] notification = "console"` and `[notifications] channel = "stderr"` (or `"stdout"`). Its doctor check reports whether the selected stream is writable. This provider is intended for immediate receipt by an operator or calling process.

The built-in `notification.filesystem` implementation appends audit records to `.forge/audit.log` as JSON Lines. Select it with `[providers] notification = "filesystem"` and `[notifications] channel = "audit"`. Each record includes a timestamp, channel, event, message, task summary, optional run summary, and optional metadata such as failure details. Its doctor checks report audit-channel configuration and whether `.forge/audit.log` can be prepared for appends. Audit consumers should treat the file as append-only JSONL and filter records by `event`, `task.id`, `run.id`, `run.status`, or `metadata.failureReason` when reconstructing a run timeline. Unknown notification providers or channels fail during CLI wiring before Forge starts work, matching the validation behavior for other configured providers.

Provider authors implementing a new notification backend should keep the same end-to-end contract: expose a `NotificationProvider`, optionally expose `DoctorProvider` checks for channel readiness, accept the neutral run notification payload, deliver or persist it without mutating Forge state, and keep provider-specific delivery ids or error details inside provider-owned logs or metadata rather than core run/task records.

Future implementations can deliver the same neutral events through any channel or service while keeping runtime orchestration provider-neutral.

## Current implementations

- `src/providers/build-heuristic` estimates request complexity and drafts specs for complex tasks.
- `src/providers/discovery-heuristic` attaches heuristic task discovery metadata and resource scopes to newly-created tasks.
- `src/providers/lease-memory` implements `LeaseProvider` with in-memory scope locks for the current Forge process.
- `src/providers/lease-filesystem` implements cross-process `LeaseProvider` locks in `.forge/leases` with stale lease cleanup and status reporting.
- `src/providers/workstream-filesystem` implements `WorkstreamProvider` by importing/listing normalized backlog JSON in `.forge/workstream.json`.
- `src/providers/workstream-linear` implements `WorkstreamProvider` against Linear GraphQL, including labels, issue relations, comments, link-cache persistence, and doctor checks.
- `src/providers/workstream-github` implements `WorkstreamProvider` against GitHub Issues, including labels, issue-body metadata, comments, link-cache persistence, and doctor checks.
- `src/providers/gate-github-issues` implements `GateProvider` against GitHub Issues through `gh api`, including spec/run issue bodies, labels, comment commands, and doctor checks.
- `src/providers/planner-pi` implements `WorkstreamPlannerProvider` by interviewing through pi and emitting dependency-ordered workstream drafts.
- `src/providers/spec-pi` implements `SpecProvider` by asking pi to draft Markdown specs for gated tasks.
- `src/providers/notification-console` implements `NotificationProvider` by writing run lifecycle notifications to the configured console stream, and `DoctorProvider` by checking stream writability.
- `src/providers/notification-filesystem` implements `NotificationProvider` by appending run lifecycle notifications to `.forge/audit.log` for the local `audit` channel, and `DoctorProvider` by checking audit channel configuration plus audit log writability.
- Future `GateProvider` implementations can publish spec approval and run acceptance decisions to trackers, chats, review tools, or other durable approval systems.
- `src/providers/store-filesystem` stores task JSON under `.forge/tasks` and release JSON under `.forge/releases`.
- `src/providers/vcs-git` implements Git VCS, doctor checks, and sync tasks.
- `src/providers/workspace-git-worktree` creates one Git worktree per task and provides `change-set.git-worktree` for reviewing changed files and accepting run branches back into the project checkout. New configs record this provider as `providers.changeSet`.
- `src/providers/isolation-host` runs agents directly on the host worktree and warns that it is not a sandbox.
- `src/providers/isolation-docker` prepares a Docker container for a task workspace, bind-mounts the workspace at `/workspace` by default, starts the container with network disabled unless policy requests inherited networking, and removes the container during cleanup. It implements `DoctorProvider` with a Docker daemon check.
- `src/providers/isolation-podman` prepares a Podman container with the task workspace bind-mounted, can run provider-owned setup hooks, verifies readiness with a retrying readiness command, exposes an environment executor that runs agent commands through `podman exec`, declares Podman doctor checks, and removes the container during isolation cleanup. Default image is `localhost/forge-agent-pi:latest`; build it with `npm run podman:image` or configure `FORGE_PODMAN_IMAGE`, `FORGE_PODMAN_READY`, and `FORGE_PODMAN_READY_ATTEMPTS`. The bundled image installs pi plus the `hypa` helper used by copied host pi tool configuration. Workspace mounts default to `rw,Z`/`ro,Z` for rootless Podman on SELinux systems. By default the provider copies the host pi agent config into `/root/.pi/agent` so containerized `pi` can use the same auth while keeping session writes inside the ephemeral container; disable with `FORGE_PODMAN_MOUNT_PI_CONFIG=0` or override source with `FORGE_PODMAN_PI_CONFIG`.
- `src/providers/agent-pi` runs `pi -p` against a task/workspace prompt.
- `src/providers/scm-github` creates issues, validates GitHub CLI state, and implements release branch preparation for `ReleaseVcsProvider` using configurable GitHub branch templates.
- `src/providers/validation-shell` implements `ValidationProvider` by running configured shell commands from `.forge/config.toml` `[validation] commands = [...]` in the completed run workspace before `forge runs accept` proceeds.
