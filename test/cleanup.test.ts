import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import type { AgentProvider, RunRecord, Task, TaskStore, VcsProvider, WorkspaceProvider } from '../src/core/types.js';
import type { CleanupResult, WorkspaceCleanupProvider } from '../src/core/cleanup.js';
import { FileRunStore } from '../src/providers/store-filesystem/runs.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){return true;} async init(){} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; async run(){ return { exitCode: 0, output: '' }; } }
class CleanupWorkspace implements WorkspaceProvider, WorkspaceCleanupProvider {
  id='workspace.cleanup'; kind='workspace' as const; removed: string[] = [];
  async create(input:{task:Task}){ return { id: input.task.id, path: `/tmp/${input.task.id}`, branch: `forge/${input.task.id}` }; }
  async cleanupWorkspaces(input:{tasks:Task[]; runs:RunRecord[]; dryRun?: boolean}): Promise<CleanupResult> {
    const done = new Set(input.tasks.filter(task => task.status === 'done').map(task => task.id));
    const active = new Set(input.runs.filter(run => run.status === 'running').map(run => run.taskId));
    const items = input.runs.filter(run => run.workspace && done.has(run.taskId) && !active.has(run.taskId)).map(run => ({ id: run.taskId, kind: 'workspace' as const, path: run.workspace!.path, reason: 'done task', removed: false }));
    if (!input.dryRun) for (const item of items) { this.removed.push(item.path!); item.removed = true; }
    return { dryRun: !!input.dryRun, items };
  }
}

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

async function makeRuntime(workspace: WorkspaceProvider = new CleanupWorkspace()) {
  const root = await mkdtemp(join(tmpdir(), 'forge-cleanup-'));
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace, agent: new MemoryAgent() });
  await rt.init('cleanup');
  return { rt, root, workspace };
}

describe('cleanup commands', () => {
  it('dry-runs and removes completed/deferred run records and logs without deleting running runs', async () => {
    const { rt, root } = await makeRuntime();
    const done = await rt.createTask('done task');
    const active = await rt.createTask('active task');
    const doneRun = await rt.deps.runStore!.start({ task: done, agentId: 'agent.memory' });
    await rt.deps.runStore!.appendLog(doneRun.id, 'done log');
    await rt.deps.runStore!.update(doneRun.id, { status: 'succeeded', finishedAt: new Date().toISOString() });
    const activeRun = await rt.deps.runStore!.start({ task: active, agentId: 'agent.memory' });

    const dry = await rt.cleanupRuns({ dryRun: true });
    expect(dry.items.map(item => item.id)).toContain(doneRun.id);
    expect(dry.items.map(item => item.id)).not.toContain(activeRun.id);
    expect(await exists(join(root, '.forge', 'runs', `${doneRun.id}.json`))).toBe(true);

    const applied = await rt.cleanupRuns({ dryRun: false });
    expect(applied.items.every(item => item.removed)).toBe(true);
    expect(await exists(join(root, '.forge', 'runs', `${doneRun.id}.json`))).toBe(false);
    expect(await exists(join(root, doneRun.logPath))).toBe(false);
    expect(await exists(join(root, '.forge', 'runs', `${activeRun.id}.json`))).toBe(true);
  });

  it('cleans only done-task workspaces and keeps active work', async () => {
    const workspace = new CleanupWorkspace();
    const { rt } = await makeRuntime(workspace);
    const done = await rt.createTask('finished');
    await rt.deps.store.update(done.id, { status: 'done' });
    const active = await rt.createTask('not finished');
    const doneRun = await rt.deps.runStore!.start({ task: done, agentId: 'agent.memory' });
    await rt.deps.runStore!.update(doneRun.id, { status: 'succeeded', workspace: { id: done.id, path: '/tmp/done', branch: 'forge/done' } });
    const activeRun = await rt.deps.runStore!.start({ task: active, agentId: 'agent.memory' });
    await rt.deps.runStore!.update(activeRun.id, { status: 'running', workspace: { id: active.id, path: '/tmp/active', branch: 'forge/active' } });

    const dry = await rt.cleanupWorkspaces({ dryRun: true });
    expect(dry.items.map(item => item.path)).toEqual(['/tmp/done']);
    expect(workspace.removed).toEqual([]);

    await rt.cleanupWorkspaces({ dryRun: false });
    expect(workspace.removed).toEqual(['/tmp/done']);
  });
});
