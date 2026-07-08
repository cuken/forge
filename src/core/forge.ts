import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasBuildPlanner, type BuildPlannerProvider, type BuildRequest, type BuildResult } from './build.js';
import { hasDoctor, runChecks, type HealthCheckResult } from './health.js';
import type { IsolationProvider, IsolationStatus } from './isolation.js';
import { resolveTask } from './resolve.js';
import { hasSync, runSyncTasks, type SyncInput, type SyncResult } from './sync.js';
import type { AgentProvider, ForgeConfig, ForgeProvider, RunStore, ScmProvider, Task, TaskStore, VcsProvider, WorkspaceProvider } from './types.js';
import { writeJson } from '../util/fs.js';

export class ForgeRuntime {
  constructor(public deps: { store: TaskStore; runStore?: RunStore; vcs: VcsProvider; workspace: WorkspaceProvider; agent: AgentProvider; isolation?: IsolationProvider; scm?: ScmProvider; buildPlanner?: BuildPlannerProvider & ForgeProvider; root?: string }) {}
  get root() { return this.deps.root ?? process.cwd(); }

  async init(projectName: string): Promise<ForgeConfig> {
    await mkdir(join(this.root, '.forge', 'context'), { recursive: true });
    await this.deps.vcs.init();
    await this.deps.store.init();
    await this.deps.runStore?.init();
    const config: ForgeConfig = { version: 1, project: { name: projectName }, providers: { store: this.deps.store.id, vcs: this.deps.vcs.id, workspace: this.deps.workspace.id, isolation: this.deps.isolation?.id, agent: this.deps.agent.id, scm: this.deps.scm?.id, buildPlanner: this.deps.buildPlanner?.id }, pi: { command: 'pi', args: ['-p'] } };
    await writeJson(join(this.root, '.forge', 'config.json'), config);
    await writeFile(join(this.root, '.forge', 'context', 'project-summary.md'), `# ${projectName}\n\nForge project context. Update this as the project evolves.\n`);
    return config;
  }

  providers() { return [this.deps.store, this.deps.runStore, this.deps.vcs, this.deps.workspace, this.deps.isolation, this.deps.agent, this.deps.scm, this.deps.buildPlanner].filter(Boolean); }

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
    return this.deps.store.create({ title, description: options.description, complexity, status, issue, contextRefs: [] });
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

  async runReady(taskId?: string, observer?: (event: string) => void) {
    const ready = (await this.deps.store.list()).filter(t => t.status === 'ready' && (!taskId || t.id === taskId));
    const results = [];
    for (const task of ready) {
      observer?.(`starting task ${task.id}: ${task.title}\n`);
      const run = await this.deps.runStore?.start({ task, agentId: this.deps.agent.id });
      const outputWrites: Promise<void>[] = [];
      const emit = async (chunk: string) => { observer?.(chunk); if (run) await this.deps.runStore?.appendLog(run.id, chunk); };
      const capture = (chunk: string) => { outputWrites.push(emit(chunk)); };
      await this.deps.store.update(task.id, { status: 'running' });
      try {
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
        results.push({ task: task.id, run: run?.id, workspace: ws, environment: env, result });
      } catch (error) {
        await this.deps.store.update(task.id, { status: 'failed' });
        await this.deps.runStore?.update(run!.id, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
        results.push({ task: task.id, run: run?.id, error: String(error) });
      }
    }
    return results;
  }
}
