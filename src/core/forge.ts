import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasBuildPlanner, type BuildPlannerProvider, type BuildRequest, type BuildResult } from './build.js';
import { hasChangeSet, type AcceptChangeSetResult, type ChangeSetProvider, type ChangeSetSummary } from './changes.js';
import { hasTaskDiscovery, type TaskDiscoveryProvider } from './discovery.js';
import { hasDoctor, runChecks, type HealthCheckResult } from './health.js';
import type { ExecutionEnvironment, IsolationProvider, IsolationStatus } from './isolation.js';
import { hasLease, LeaseConflictError, type LeaseHandle, type LeaseProvider } from './lease.js';
import { hasNotification, type NotificationProvider, type RunNotificationEvent } from './notification.js';
import { resolveTask } from './resolve.js';
import { hasSync, runSyncTasks, type SyncInput, type SyncResult } from './sync.js';
import { hasValidation, type ValidationGateResult, type ValidationProvider } from './validation.js';
import { hasWorkstream, hasWorkstreamPlanner, type WorkstreamItem, type WorkstreamPlan, type WorkstreamPlannerProvider, type WorkstreamProvider } from './workstream.js';
import type { AgentProvider, ForgeConfig, ForgeProvider, RunRecord, RunStore, ScmProvider, Task, TaskStore, VcsProvider, WorkspaceProvider } from './types.js';
import { writeJson } from '../util/fs.js';

export class ForgeRuntime {
  constructor(public deps: { store: TaskStore; runStore?: RunStore; vcs: VcsProvider; workspace: WorkspaceProvider; agent: AgentProvider; isolation?: IsolationProvider; scm?: ScmProvider; buildPlanner?: BuildPlannerProvider & ForgeProvider; changeSet?: ChangeSetProvider; validation?: ValidationProvider & ForgeProvider; taskDiscovery?: TaskDiscoveryProvider & ForgeProvider; lease?: LeaseProvider; workstream?: WorkstreamProvider; workstreamPlanner?: WorkstreamPlannerProvider; notification?: NotificationProvider & ForgeProvider; root?: string }) {}
  get root() { return this.deps.root ?? process.cwd(); }

  async init(projectName: string): Promise<ForgeConfig> {
    await mkdir(join(this.root, '.forge', 'context'), { recursive: true });
    await this.deps.vcs.init();
    await this.deps.store.init();
    await this.deps.runStore?.init();
    const config: ForgeConfig = { version: 1, project: { name: projectName }, providers: { store: this.deps.store.id, vcs: this.deps.vcs.id, workspace: this.deps.workspace.id, isolation: this.deps.isolation?.id, agent: this.deps.agent.id, scm: this.deps.scm?.id, buildPlanner: this.deps.buildPlanner?.id, changeSet: this.deps.changeSet?.id, validation: this.deps.validation?.id, taskDiscovery: this.deps.taskDiscovery?.id, lease: this.deps.lease?.id, workstream: this.deps.workstream?.id, workstreamPlanner: this.deps.workstreamPlanner?.id, notification: this.deps.notification?.id }, pi: { command: 'pi', args: ['-p'] }, validation: { commands: [] }, notifications: { channel: 'stderr' } };
    await writeJson(join(this.root, '.forge', 'config.json'), config);
    await writeFile(join(this.root, '.forge', 'context', 'project-summary.md'), `# ${projectName}\n\nForge project context. Update this as the project evolves.\n`);
    return config;
  }

  providers() { return [this.deps.store, this.deps.runStore, this.deps.vcs, this.deps.workspace, this.deps.isolation, this.deps.agent, this.deps.scm, this.deps.buildPlanner, this.deps.changeSet, this.deps.validation, this.deps.taskDiscovery, this.deps.lease, this.deps.workstream, this.deps.workstreamPlanner, this.deps.notification].filter(Boolean); }

  async doctor(): Promise<HealthCheckResult[]> {
    const checks = this.providers().flatMap(provider => hasDoctor(provider) ? provider.checks() : []);
    return runChecks(checks);
  }

  async isolationStatus(): Promise<IsolationStatus> {
    const provider = this.deps.isolation;
    if (!provider) {
      return {
        providerId: 'isolation.none',
        readiness: 'warn',
        checks: [{ id: 'isolation.none:configured', status: 'warn', message: 'no isolation provider configured' }],
      };
    }
    const checks = hasDoctor(provider) ? await runChecks(provider.checks()) : [];
    const readiness = checks.some(check => check.status === 'fail') ? 'fail' : checks.some(check => check.status === 'warn') ? 'warn' : 'pass';
    return { providerId: provider.id, readiness, checks };
  }

  async sync(input: SyncInput = {}): Promise<SyncResult[]> {
    const tasks = this.providers().flatMap(provider => hasSync(provider) ? provider.syncTasks() : []);
    return runSyncTasks(tasks, input);
  }

  private leaseProvider(): LeaseProvider | undefined {
    const provider = this.providers().find(provider => hasLease(provider));
    return provider && hasLease(provider) ? provider : undefined;
  }

  private async notifyRun(event: RunNotificationEvent, input: { task: Task; run?: RunRecord; message: string }) {
    await Promise.all(this.providers().filter(provider => hasNotification(provider)).map(async provider => {
      try {
        await provider.notifyRun({ event, task: input.task, run: input.run, message: input.message });
      } catch {
        // Notifications are best-effort lifecycle side effects; provider failures must not alter run state.
      }
    }));
  }

  async leaseStatus() {
    const provider = this.leaseProvider();
    if (!provider?.status) return [];
    return provider.status();
  }

  async cleanupLeases() {
    const provider = this.leaseProvider();
    if (!provider?.cleanupStale) return 0;
    return provider.cleanupStale();
  }

  async build(input: BuildRequest, observer?: (event: string) => void): Promise<BuildResult> {
    const planner = this.providers().find(provider => hasBuildPlanner(provider));
    if (!planner || !hasBuildPlanner(planner)) throw new Error('No build planner provider configured');
    const plan = await planner.planBuild(input);
    const task = await this.createTask(plan.title, { description: plan.description, complexity: plan.complexity });
    if (plan.requiresSpec) {
      const withSpec = await this.writeSpec(task.id, plan.specBody ?? `# Spec: ${plan.title}\n\n${plan.description}\n`);
      if (!input.autoApprove) return { task: withSpec, plan, action: 'awaiting-approval' };
      await this.approve(task.id);
    }
    if (input.run === false) {
      const current = await this.deps.store.get(task.id);
      return { task: current ?? task, plan, action: 'ready' };
    }
    const runResults = await this.runReady(task.id, observer);
    const current = await this.deps.store.get(task.id);
    return { task: current ?? task, plan, action: 'ran', runResults };
  }

  private workstreamProvider(): WorkstreamProvider {
    const provider = this.providers().find(provider => hasWorkstream(provider));
    if (!provider || !hasWorkstream(provider)) throw new Error('No workstream provider configured');
    return provider;
  }

  async importWorkstream(path?: string, options: { replace?: boolean } = {}): Promise<WorkstreamItem[]> {
    return this.workstreamProvider().import({ path, replace: options.replace });
  }

  async planWorkstream(input: { prompt: string; ask?: (question: string) => Promise<string> }): Promise<{ plan: WorkstreamPlan; added: WorkstreamItem[] }> {
    const planner = this.providers().find(provider => hasWorkstreamPlanner(provider));
    if (!planner || !hasWorkstreamPlanner(planner)) throw new Error('No workstream planner provider configured');
    const provider = this.workstreamProvider();
    const plan = await planner.planWorkstream({ prompt: input.prompt, context: await this.projectContext(), ask: input.ask });
    const existing = await provider.list();
    const taken = new Set(existing.map(item => item.id));
    // Planned ids may collide with backlog items from earlier plans; rename and keep
    // intra-plan dependency references pointing at the renamed items.
    const rename = new Map<string, string>();
    const drafts = plan.items.map((item, index) => {
      const base = item.id?.trim() || `item-${index + 1}`;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      if (id !== base) rename.set(base, id);
      return { ...item, id };
    }).map(item => ({ ...item, dependencies: (item.dependencies ?? []).map(dep => rename.get(dep) ?? dep) }));
    const merged = await provider.import({ items: [...existing, ...drafts] });
    const addedIds = new Set(drafts.map(draft => draft.id));
    return { plan, added: merged.filter(item => addedIds.has(item.id)) };
  }

  private async projectContext(): Promise<string | undefined> {
    try { return await readFile(join(this.root, '.forge', 'context', 'project-summary.md'), 'utf8'); } catch { return undefined; }
  }

  async listWorkstream(): Promise<WorkstreamItem[]> {
    return this.workstreamProvider().list();
  }

  private shortFragment(value: string, peers: string[]): string {
    const words = value.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [value.toLowerCase()];
    for (let length = 1; length <= words.length; length++) {
      for (let start = 0; start <= words.length - length; start++) {
        const fragment = words.slice(start, start + length).join(' ');
        if (fragment && peers.filter(peer => peer.toLowerCase().includes(fragment)).length === 1) return fragment;
      }
    }
    return value.slice(0, 32);
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  private runCommand(run: RunRecord, command: string, peers: RunRecord[]): string {
    const fragment = this.shortFragment(run.taskTitle, peers.map(peer => peer.taskTitle));
    return `forge runs ${command} ${this.shellQuote(fragment)}`;
  }

  async status(): Promise<string[]> {
    const lines: string[] = [];
    const tasks = await this.deps.store.list();
    const runs = this.deps.runStore ? await this.deps.runStore.list() : [];
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const taskTitles = tasks.map(task => task.title);
    const taskRef = (task: Task) => this.shellQuote(this.shortFragment(task.title, taskTitles));

    for (const task of tasks.filter(task => task.status === 'needs-spec')) lines.push(`needs spec: ${task.title} -> forge task spec ${taskRef(task)} '<spec body>'`);
    for (const task of tasks.filter(task => task.status === 'awaiting-approval')) lines.push(`awaiting approval: ${task.title} -> forge task approve ${taskRef(task)}`);

    const succeeded = runs.filter(run => run.status === 'succeeded' && !run.acceptance);
    for (const run of succeeded) {
      const task = taskById.get(run.taskId);
      if (task?.status !== 'reviewing') continue;
      lines.push(`awaiting review: ${run.taskTitle} -> ${this.runCommand(run, 'review', succeeded)}`);
      const validationPassed = run.validation?.results.length === 0 || run.validation?.results.every(result => result.status === 'pass');
      if (!run.validation || run.validation.results.some(result => result.status === 'fail')) lines.push(`awaiting validation: ${run.taskTitle} -> ${this.runCommand(run, 'validate', succeeded)}`);
      if (validationPassed) lines.push(`awaiting accept: ${run.taskTitle} -> ${this.runCommand(run, 'accept', succeeded)} -m ${this.shellQuote(`accept ${this.shortFragment(run.taskTitle, succeeded.map(peer => peer.taskTitle))}`)}`);
    }

    for (const run of runs.filter(run => run.status === 'deferred')) {
      const task = taskById.get(run.taskId);
      const command = task ? `forge task run ${taskRef(task)}` : this.runCommand(run, 'show', runs);
      lines.push(`deferred: ${run.taskTitle} -> ${command}`);
    }

    const workstream = this.providers().find(provider => hasWorkstream(provider));
    if (workstream && hasWorkstream(workstream)) {
      const items = await workstream.list();
      const byId = new Map(items.map(item => [item.id, item]));
      for (const item of items.filter(item => item.status === 'planned' && item.dependencies.length)) {
        const blockedBy = item.dependencies.filter(depId => {
          const dep = byId.get(depId);
          if (!dep) return false;
          if (dep.status !== 'queued' || !dep.taskId) return true;
          return taskById.get(dep.taskId)?.status !== 'done';
        });
        if (blockedBy.length) lines.push(`blocked workstream: ${item.title} (waiting on ${blockedBy.join(', ')}) -> forge workstream enqueue ${item.id}`);
      }
    }

    return lines;
  }

  async sweepWorkstream(observer?: (event: string) => void, options: { concurrency?: number; yolo?: boolean } = {}) {
    const enqueued = await this.enqueueWorkstream();
    const beforeRun = options.yolo ? await this.bypassHumanGates(observer) : { specced: [], approved: [], accepted: [], errors: [] };
    const runResults = await this.runReady(undefined, observer, { concurrency: options.concurrency });
    const afterRun = options.yolo ? await this.bypassHumanGates(observer) : { specced: [], approved: [], accepted: [], errors: [] };
    const status = await this.status();
    return { enqueued, runResults, status, yolo: { specced: [...beforeRun.specced, ...afterRun.specced], approved: [...beforeRun.approved, ...afterRun.approved], accepted: [...beforeRun.accepted, ...afterRun.accepted], errors: [...beforeRun.errors, ...afterRun.errors] } };
  }

  async bypassHumanGates(observer?: (event: string) => void) {
    const specced: Task[] = [], approved: Task[] = [], accepted: AcceptChangeSetResult[] = [], errors: string[] = [];
    for (const task of await this.deps.store.list()) {
      try {
        if (task.status === 'needs-spec') {
          const body = `# YOLO spec: ${task.title}\n\n${task.description ?? task.title}\n\nGenerated by forge process --yolo to bypass the human spec gate.\n`;
          const withSpec = await this.writeSpec(task.id, body);
          specced.push(withSpec);
          observer?.(`yolo: generated spec for ${task.id}\n`);
        }
      } catch (error) { errors.push(`spec ${task.id}: ${String(error)}`); }
    }
    for (const task of await this.deps.store.list()) {
      try {
        if (task.status === 'awaiting-approval') {
          const ready = await this.approve(task.id);
          approved.push(ready);
          observer?.(`yolo: approved ${task.id}\n`);
        }
      } catch (error) { errors.push(`approve ${task.id}: ${String(error)}`); }
    }
    const runs = this.deps.runStore ? await this.deps.runStore.list() : [];
    const tasks = new Map((await this.deps.store.list()).map(task => [task.id, task]));
    for (const run of runs.filter(run => run.status === 'succeeded' && !run.acceptance)) {
      try {
        if (tasks.get(run.taskId)?.status !== 'reviewing') continue;
        const result = await this.acceptRun(run.id, `yolo accept ${run.taskTitle}`);
        accepted.push(result);
        observer?.(`yolo: accepted ${run.id}\n`);
      } catch (error) { errors.push(`accept ${run.id}: ${String(error)}`); }
    }
    return { specced, approved, accepted, errors };
  }

  async enqueueWorkstream(ids?: string[]): Promise<Task[]> {
    const provider = this.workstreamProvider();
    const items = await provider.list();
    const wanted = ids?.length ? new Set(ids) : undefined;
    if (wanted) {
      const known = new Set(items.map(item => item.id));
      const missing = [...wanted].filter(id => !known.has(id));
      if (missing.length) throw new Error(`No workstream item '${missing.join("', '")}'`);
    }
    const byId = new Map(items.map(item => [item.id, item]));
    const dependencyDone = async (depId: string) => {
      const dep = byId.get(depId);
      if (!dep) return true;
      if (dep.status !== 'queued' || !dep.taskId) return false;
      return (await this.deps.store.get(dep.taskId))?.status === 'done';
    };
    const tasks: Task[] = [];
    for (const item of items) {
      if (wanted && !wanted.has(item.id)) continue;
      if (item.status === 'queued') continue;
      // Explicitly-named items bypass dependency gating so a user can force order; the
      // default sweep only queues items whose dependencies have finished as done tasks.
      if (!wanted && !(await Promise.all(item.dependencies.map(dependencyDone))).every(Boolean)) continue;
      const task = await this.createTask(item.title, { description: this.workstreamDescription(item), complexity: item.complexity });
      await provider.update(item.id, { status: 'queued', taskId: task.id });
      tasks.push(task);
    }
    return tasks;
  }

  private workstreamDescription(item: WorkstreamItem): string | undefined {
    const lines = [item.description, item.dependencies.length ? `Dependencies: ${item.dependencies.join(', ')}` : undefined, `Workstream item: ${item.id}`].filter(Boolean);
    return lines.length ? lines.join('\n\n') : undefined;
  }

  async createTask(title: string, options: { description?: string; complexity?: Task['complexity']; createIssue?: boolean } = {}) {
    const complexity = options.complexity ?? 'small';
    const status: Task['status'] = complexity === 'medium' || complexity === 'large' ? 'needs-spec' : 'ready';
    let issue;
    if (options.createIssue && this.deps.scm) issue = await this.deps.scm.createIssue({ title, body: options.description ?? title });
    const discoveryProvider = this.providers().find(provider => hasTaskDiscovery(provider));
    const discovery = discoveryProvider && hasTaskDiscovery(discoveryProvider) ? await discoveryProvider.discoverTask({ title, description: options.description, complexity }) : undefined;
    return this.deps.store.create({ title, description: options.description, complexity, status, issue, contextRefs: [], discovery });
  }

  async writeSpec(taskId: string, body: string) {
    const path = join('.forge', 'specs', `${taskId}.md`);
    await mkdir(join(this.root, '.forge', 'specs'), { recursive: true });
    await writeFile(join(this.root, path), body);
    return this.deps.store.update(taskId, { status: 'awaiting-approval', spec: { path, approved: false } });
  }

  async approve(taskIdOrPattern?: string) {
    const task = taskIdOrPattern ? await resolveTask(this.deps.store, taskIdOrPattern) : await resolveTask(this.deps.store, undefined, 'awaiting-approval');
    if (!task.spec) throw new Error('Task has no spec');
    return this.deps.store.update(task.id, { status: 'ready', spec: { ...task.spec, approved: true, approvedAt: new Date().toISOString() } });
  }

  async runTask(taskIdOrPattern?: string, observer?: (event: string) => void) {
    const task = taskIdOrPattern ? await resolveTask(this.deps.store, taskIdOrPattern) : await resolveTask(this.deps.store, undefined, 'ready');
    if (task.status !== 'ready') throw new Error(`Task is ${task.status}, not ready`);
    return this.runReady(task.id, observer);
  }

  private changeSetProvider(): ChangeSetProvider {
    const provider = this.providers().find(provider => hasChangeSet(provider));
    if (!provider || !hasChangeSet(provider)) throw new Error('No change set provider configured');
    return provider;
  }

  async resolveRun(idOrPrefix: string) {
    if (!this.deps.runStore) throw new Error('No run store configured');
    const exact = await this.deps.runStore.get(idOrPrefix);
    if (exact) return exact;
    const needle = idOrPrefix.toLowerCase();
    const matches = (await this.deps.runStore.list()).filter(run =>
      run.id.startsWith(idOrPrefix) ||
      run.taskId.startsWith(idOrPrefix) ||
      run.taskTitle.toLowerCase().includes(needle) ||
      run.workspace?.branch.toLowerCase().includes(needle)
    );
    if (matches.length !== 1) throw new Error(matches.length === 0 ? `No run matches '${idOrPrefix}'` : `Multiple runs match '${idOrPrefix}'`);
    return matches[0];
  }

  async showRun(idOrPrefix: string) {
    return this.resolveRun(idOrPrefix);
  }

  async reviewRun(idOrPrefix: string): Promise<ChangeSetSummary> {
    const run = await this.resolveRun(idOrPrefix);
    if (run.status !== 'succeeded') throw new Error(`Run ${run.id} is ${run.status}, not succeeded`);
    return this.changeSetProvider().review({ run });
  }

  async validateRun(idOrPrefix: string): Promise<ValidationGateResult[]> {
    const run = await this.resolveRun(idOrPrefix);
    if (run.status !== 'succeeded') throw new Error(`Run ${run.id} is ${run.status}, not succeeded`);
    const providers = this.providers().filter(provider => hasValidation(provider));
    const results = (await Promise.all(providers.map(provider => provider.validate({ run })))).flat();
    await this.deps.runStore?.update(run.id, { validation: { validatedAt: new Date().toISOString(), results } });
    const failed = results.filter(result => result.status === 'fail');
    if (failed.length) throw new Error(`Validation failed for run ${run.id}: ${failed.map(result => result.message).join('; ')}`);
    return results;
  }

  async acceptRun(idOrPrefix: string, message?: string, options: { dryRun?: boolean } = {}): Promise<AcceptChangeSetResult> {
    const run = await this.resolveRun(idOrPrefix);
    if (run.status !== 'succeeded') throw new Error(`Run ${run.id} is ${run.status}, not succeeded`);
    const task = await this.deps.store.get(run.taskId);
    if (!task || task.status !== 'reviewing') throw new Error(`Task ${run.taskId} is ${task?.status ?? 'missing'}, not reviewing`);
    await this.validateRun(run.id);
    if (options.dryRun) {
      const summary = await this.changeSetProvider().review({ run });
      return { providerId: summary.providerId, runId: run.id, taskId: run.taskId, status: summary.status === 'empty' ? 'empty' : 'accepted', message: `dry run: would accept ${summary.files.length} file(s)${message ? ` with message '${message}'` : ''}` };
    }
    const result = await this.changeSetProvider().accept({ run, message });
    await this.deps.runStore?.update(run.id, { acceptance: { acceptedAt: new Date().toISOString(), providerId: result.providerId, status: result.status, message: result.message } });
    if (result.status === 'accepted' || result.status === 'empty') await this.deps.store.update(run.taskId, { status: 'done' });
    return result;
  }

  async runReady(taskId?: string, observer?: (event: string) => void, options: { concurrency?: number; leaseWaitMs?: number } = {}) {
    const ready = (await this.deps.store.list()).filter(t => t.status === 'ready' && (!taskId || t.id === taskId));
    const requestedConcurrency = Math.floor(options.concurrency ?? 1);
    const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
    const leaseWaitMs = options.leaseWaitMs ?? 15 * 60 * 1000;
    const results: Array<{ task: string; run?: string; workspace?: { id: string; path: string; branch: string }; environment?: ExecutionEnvironment; result?: { exitCode: number; output: string }; deferred?: boolean; error?: string }> = [];
    let next = 0;
    const leaseProvider = this.leaseProvider();
    const runOne = async (task: Task) => {
      observer?.(`starting task ${task.id}: ${task.title}\n`);
      const run = await this.deps.runStore?.start({ task, agentId: this.deps.agent.id });
      await this.notifyRun('run.started', { task, run, message: `started task ${task.id}: ${task.title}` });
      const outputWrites: Promise<void>[] = [];
      const emit = async (chunk: string) => { observer?.(chunk); if (run) await this.deps.runStore?.appendLog(run.id, chunk); };
      const capture = (chunk: string) => { outputWrites.push(emit(chunk)); };
      await this.deps.store.update(task.id, { status: 'running' });
      let lease: LeaseHandle | undefined;
      try {
        if (leaseProvider && task.discovery?.resourceScopes.length) {
          const scopes = task.discovery.resourceScopes;
          await emit(`acquiring ${scopes.length} resource scope lease(s)...\n`);
          const deadline = Date.now() + leaseWaitMs;
          let delay = 250;
          let lastLoggedAt = 0;
          while (!lease) {
            try {
              lease = await leaseProvider.acquire({ task, scopes });
            } catch (error) {
              if (!(error instanceof LeaseConflictError)) throw error;
              if (Date.now() >= deadline) {
                await emit(`lease wait exceeded ${leaseWaitMs}ms, deferring task: ${error.message}\n`);
                await this.deps.store.update(task.id, { status: 'ready' });
                const deferredRun = await this.deps.runStore?.update(run!.id, { status: 'deferred', error: `lease wait timed out: ${error.message}`, finishedAt: new Date().toISOString() });
                await this.notifyRun('run.deferred', { task, run: deferredRun ?? run, message: `deferred task ${task.id}: ${error.message}` });
                return { task: task.id, run: run?.id, deferred: true, error: error.message };
              }
              if (Date.now() - lastLoggedAt >= 10_000) {
                await emit(`lease unavailable, waiting: ${error.message}\n`);
                lastLoggedAt = Date.now();
              }
              await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(deadline - Date.now(), 1))));
              delay = Math.min(delay * 2, 5000);
            }
          }
          await emit(`lease ${lease.id} acquired by ${lease.providerId}\n`);
        }
        await emit('creating workspace...\n');
        const ws = await this.deps.workspace.create({ task });
        const workspaceRun = await this.deps.runStore?.update(run!.id, { workspace: ws });
        await this.notifyRun('run.workspace-created', { task, run: workspaceRun ?? run, message: `workspace ${ws.path} on ${ws.branch}` });
        await emit(`workspace ${ws.path} on ${ws.branch}\n`);
        await emit('preparing execution environment...\n');
        const env = this.deps.isolation ? await this.deps.isolation.prepare({ task, workspace: ws }) : { id: 'isolation.none', kind: 'host' as const, workspacePath: ws.path, description: 'No isolation provider configured' };
        const environmentRun = await this.deps.runStore?.update(run!.id, { environment: env });
        await this.notifyRun('run.environment-prepared', { task, run: environmentRun ?? run, message: `environment ${env.id}: ${env.description}` });
        await emit(`environment ${env.id}: ${env.description}\n`);
        await emit(`running agent ${this.deps.agent.id}...\n`);
        const result = await (async () => {
          try {
            return await this.deps.agent.run({ task, workspacePath: env.workspacePath, environment: env, context: `Workspace: ${ws.path}\nBranch: ${ws.branch}\nExecution environment: ${env.id} (${env.kind})\n${env.description}`, onOutput: capture });
          } finally {
            await this.deps.isolation?.cleanup?.(env);
          }
        })();
        await Promise.all(outputWrites);
        await emit(result.output && !result.output.endsWith('\n') ? `${result.output}\n` : '');
        await emit(`agent exited ${result.exitCode}\n`);
        const status = result.exitCode === 0 ? 'reviewing' : 'failed';
        await this.deps.store.update(task.id, { status });
        const completedRun = await this.deps.runStore?.update(run!.id, { status: result.exitCode === 0 ? 'succeeded' : 'failed', exitCode: result.exitCode, finishedAt: new Date().toISOString() });
        await this.notifyRun(result.exitCode === 0 ? 'run.succeeded' : 'run.failed', { task, run: completedRun ?? run, message: `agent exited ${result.exitCode}` });
        return { task: task.id, run: run?.id, workspace: ws, environment: env, result };
      } catch (error) {
        await this.deps.store.update(task.id, { status: 'failed' });
        const failedRun = await this.deps.runStore?.update(run!.id, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
        await this.notifyRun('run.failed', { task, run: failedRun ?? run, message: String(error) });
        return { task: task.id, run: run?.id, error: String(error) };
      } finally {
        if (lease) {
          try {
            const leaseProvider = this.leaseProvider();
            if (leaseProvider) {
              await leaseProvider.release(lease);
              await emit(`lease ${lease.id} released\n`);
            }
          } catch (releaseError) {
            await emit(`lease release failed: ${String(releaseError)}\n`);
          }
        }
      }
    };
    const worker = async () => {
      while (next < ready.length) {
        const index = next++;
        const task = ready[index];
        results[index] = await runOne(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ready.length) }, worker));
    return results;
  }
}
