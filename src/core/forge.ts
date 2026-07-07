import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasDoctor, runChecks, type HealthCheckResult } from './health.js';
import { hasSync, runSyncTasks, type SyncInput, type SyncResult } from './sync.js';
import type { AgentProvider, ForgeConfig, ScmProvider, Task, TaskStore, VcsProvider, WorkspaceProvider } from './types.js';
import { writeJson } from '../util/fs.js';

export class ForgeRuntime {
  constructor(public deps: { store: TaskStore; vcs: VcsProvider; workspace: WorkspaceProvider; agent: AgentProvider; scm?: ScmProvider; root?: string }) {}
  get root() { return this.deps.root ?? process.cwd(); }

  async init(projectName: string): Promise<ForgeConfig> {
    await mkdir(join(this.root, '.forge', 'context'), { recursive: true });
    await this.deps.vcs.init();
    await this.deps.store.init();
    const config: ForgeConfig = { version: 1, project: { name: projectName }, providers: { store: this.deps.store.id, vcs: this.deps.vcs.id, workspace: this.deps.workspace.id, agent: this.deps.agent.id, scm: this.deps.scm?.id }, pi: { command: 'pi', args: ['-p'] } };
    await writeJson(join(this.root, '.forge', 'config.json'), config);
    await writeFile(join(this.root, '.forge', 'context', 'project-summary.md'), `# ${projectName}\n\nForge project context. Update this as the project evolves.\n`);
    return config;
  }

  providers() { return [this.deps.store, this.deps.vcs, this.deps.workspace, this.deps.agent, this.deps.scm].filter(Boolean); }

  async doctor(): Promise<HealthCheckResult[]> {
    const checks = this.providers().flatMap(provider => hasDoctor(provider) ? provider.checks() : []);
    return runChecks(checks);
  }

  async sync(input: SyncInput = {}): Promise<SyncResult[]> {
    const tasks = this.providers().flatMap(provider => hasSync(provider) ? provider.syncTasks() : []);
    return runSyncTasks(tasks, input);
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

  async approve(taskId: string) {
    const task = await this.deps.store.get(taskId); if (!task?.spec) throw new Error('Task has no spec');
    return this.deps.store.update(taskId, { status: 'ready', spec: { ...task.spec, approved: true, approvedAt: new Date().toISOString() } });
  }

  async runReady() {
    const ready = (await this.deps.store.list()).filter(t => t.status === 'ready');
    const results = [];
    for (const task of ready) {
      await this.deps.store.update(task.id, { status: 'running' });
      try {
        const ws = await this.deps.workspace.create({ task });
        const result = await this.deps.agent.run({ task, workspacePath: ws.path, context: `Workspace: ${ws.path}\nBranch: ${ws.branch}` });
        await this.deps.store.update(task.id, { status: result.exitCode === 0 ? 'reviewing' : 'failed' });
        results.push({ task: task.id, workspace: ws, result });
      } catch (error) {
        await this.deps.store.update(task.id, { status: 'failed' });
        results.push({ task: task.id, error: String(error) });
      }
    }
    return results;
  }
}
