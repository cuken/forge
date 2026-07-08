import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasBuildPlanner, type BuildPlannerProvider, type BuildRequest, type BuildResult } from './build.js';
import { hasChangeSet, type AcceptChangeSetResult, type ChangeSetProvider, type ChangeSetSummary } from './changes.js';
import { hasTaskDiscovery, type TaskDiscoveryProvider } from './discovery.js';
import { hasDoctor, runChecks, type HealthCheckResult } from './health.js';
import type { ExecutionEnvironment, IsolationProvider, IsolationStatus } from './isolation.js';
import { hasLease, type LeaseHandle, type LeaseProvider } from './lease.js';
import { resolveTask } from './resolve.js';
import { hasSync, runSyncTasks, type SyncInput, type SyncResult } from './sync.js';
import { hasValidation, type ValidationGateResult, type ValidationProvider } from './validation.js';
import type { AgentProvider, ForgeConfig, ForgeProvider, RunStore, ScmProvider, Task, TaskStore, VcsProvider, WorkspaceProvider } from './types.js';
import { writeJson } from '../util/fs.js';

export class ForgeRuntime {
  constructor(public deps: { store: TaskStore; runStore?: RunStore; vcs: VcsProvider; workspace: WorkspaceProvider; agent: AgentProvider; isolation?: IsolationProvider; scm?: ScmProvider; buildPlanner?: BuildPlannerProvider & ForgeProvider; changeSet?: ChangeSetProvider; validation?: ValidationProvider & ForgeProvider; taskDiscovery?: TaskDiscoveryProvider & ForgeProvider; lease?: LeaseProvider; root?: string }) {}
  get root() { return this.deps.root ?? process.cwd(); }

  async init(projectName: string): Promise<ForgeConfig> {
    await mkdir(join(this.root, '.forge', 'context'), { recursive: true });
    await this.deps.vcs.init();
    await this.deps.store.init();
    await this.deps.runStore?.init();
    const config: ForgeConfig = { version: 1, project: { name: projectName }, providers: { store: this.deps.store.id, vcs: this.deps.vcs.id, workspace: this.deps.workspace.id, isolation: this.deps.isolation?.id, agent: this.deps.agent.id, scm: this.deps.scm?.id, buildPlanner: this.deps.buildPlanner?.id, changeSet: this.deps.changeSet?.id, validation: this.deps.validation?.id, taskDiscovery: this.deps.taskDiscovery?.id, lease: this.deps.lease?.id }, pi: { command: 'pi', args: ['-p'] }, validation: { commands: [] } };
    await writeJson(join(this.root, '.forge', 'config.json'), config);
    await writeFile(join(this.root, '.forge', 'context', 'project-summary.md'), `# ${projectName}\n\nForge project context. Update this as the project evolves.\n`);
    return config;
  }

  providers() { return [this.deps.store, this.deps.runStore, this.deps.vcs, this.deps.workspace, this.deps.isolation, this.deps.agent, this.deps.scm, this.deps.buildPlanner, this.deps.changeSet, this.deps.validation, this.deps.taskDiscovery, this.deps.lease].filter(Boolean); }

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
    await this.deps.store.update(run.taskId, { status: 'done' });
    return result;
  }

  async runReady(taskId?: string, observer?: (event: string) => void, options: { concurrency?: number } = {}) {
    const ready = (await this.deps.store.list()).filter(t => t.status === 'ready' && (!taskId || t.id === taskId));
    const requestedConcurrency = Math.floor(options.concurrency ?? 1);
    const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
    const results: Array<{ task: string; run?: string; workspace?: { id: string; path: string; branch: string }; environment?: ExecutionEnvironment; result?: { exitCode: number; output: string }; error?: string }> = [];
    let next = 0;
    const leaseProvider = this.providers().find(provider => hasLease(provider));
    const runOne = async (task: Task) => {
      observer?.(`starting task ${task.id}: ${task.title}\n`);
      const run = await this.deps.runStore?.start({ task, agentId: this.deps.agent.id });
      const outputWrites: Promise<void>[] = [];
      const emit = async (chunk: string) => { observer?.(chunk); if (run) await this.deps.runStore?.appendLog(run.id, chunk); };
      const capture = (chunk: string) => { outputWrites.push(emit(chunk)); };
      await this.deps.store.update(task.id, { status: 'running' });
      let lease: LeaseHandle | undefined;
      try {
        if (leaseProvider && hasLease(leaseProvider) && task.discovery?.resourceScopes.length) {
          await emit(`acquiring ${task.discovery.resourceScopes.length} resource scope lease(s)...\n`);
          while (!lease) {
            try {
              lease = await leaseProvider.acquire({ task, scopes: task.discovery.resourceScopes });
            } catch (error) {
              await emit(`lease unavailable, waiting: ${String(error)}\n`);
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
          await emit(`lease ${lease.id} acquired by ${lease.providerId}\n`);
        }
        await emit('creating workspace...\n');
        const ws = await this.deps.workspace.create({ task });
        await this.deps.runStore?.update(run!.id, { workspace: ws });
        await emit(`workspace ${ws.path} on ${ws.branch}\n`);
        await emit('preparing execution environment...\n');
        const env = this.deps.isolation ? await this.deps.isolation.prepare({ task, workspace: ws }) : { id: 'isolation.none', kind: 'host' as const, workspacePath: ws.path, description: 'No isolation provider configured' };
        await this.deps.runStore?.update(run!.id, { environment: env });
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
        await this.deps.runStore?.update(run!.id, { status: result.exitCode === 0 ? 'succeeded' : 'failed', exitCode: result.exitCode, finishedAt: new Date().toISOString() });
        return { task: task.id, run: run?.id, workspace: ws, environment: env, result };
      } catch (error) {
        await this.deps.store.update(task.id, { status: 'failed' });
        await this.deps.runStore?.update(run!.id, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
        return { task: task.id, run: run?.id, error: String(error) };
      } finally {
        if (lease) {
          try {
            const leaseProvider = this.providers().find(provider => hasLease(provider));
            if (leaseProvider && hasLease(leaseProvider)) {
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
