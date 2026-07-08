import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import { FileRunStore } from '../src/providers/store-filesystem/runs.js';
import type { ChangeSetProvider } from '../src/core/changes.js';
import type { AgentProvider, RunRecord, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; repo=false; async isRepo(){return this.repo;} async init(){this.repo=true;} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; runs: string[]=[]; async run(input:{task:Task; workspacePath:string; context:string; onOutput?: (chunk: string) => void}){ this.runs.push(input.task.id); input.onOutput?.('agent output\n'); return { exitCode: 0, output: 'ok' }; } }
class MemoryChangeSet implements ChangeSetProvider { id='change-set.memory'; kind='change-set' as const; accepted: string[]=[]; async review(input:{run:RunRecord}){ return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'changed' as const, files: ['file.txt'], summary: 'M file.txt' }; } async accept(input:{run:RunRecord}){ this.accepted.push(input.run.id); return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'accepted' as const, message: 'accepted file.txt' }; } }

async function makeRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const agent = new MemoryAgent();
  const changeSet = new MemoryChangeSet();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent, changeSet });
  return { rt, agent, changeSet };
}

describe('Forge vertical slice', () => {
  it('initializes config, store, and project context', async () => {
    const { rt } = await makeRuntime();
    const cfg = await rt.init('demo');
    expect(cfg.providers.store).toBe('store.filesystem');
    expect(await rt.deps.vcs.isRepo()).toBe(true);
  });

  it('creates small tasks as ready and medium tasks behind spec gate', async () => {
    const { rt } = await makeRuntime();
    await rt.init('demo');
    const small = await rt.createTask('small thing');
    const medium = await rt.createTask('risky thing', { complexity: 'medium' });
    expect(small.status).toBe('ready');
    expect(medium.status).toBe('needs-spec');
  });

  it('requires spec approval before gated task can run', async () => {
    const { rt, agent } = await makeRuntime();
    await rt.init('demo');
    const task = await rt.createTask('build provider', { complexity: 'medium' });
    await rt.writeSpec(task.id, '# Spec');
    expect((await rt.runReady())).toHaveLength(0);
    await rt.approve(task.id);
    const results = await rt.runReady();
    expect(results).toHaveLength(1);
    expect(agent.runs).toEqual([task.id]);
    expect((await rt.deps.store.get(task.id))?.status).toBe('reviewing');
  });

  it('persists run records and captured logs', async () => {
    const { rt } = await makeRuntime();
    await rt.init('demo');
    const task = await rt.createTask('loggable task');
    const results = await rt.runTask(task.id);
    const runId = results[0].run;
    expect(runId).toBeTruthy();
    const runs = await rt.deps.runStore!.list({ taskId: task.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, taskId: task.id, status: 'succeeded', agentId: 'agent.memory', exitCode: 0 });
    expect(runs[0].workspace?.path).toContain(task.id);
    await expect(readFile(join(rt.root, runs[0].logPath), 'utf8')).resolves.toContain('agent output');
    await expect(rt.deps.runStore!.readLog(runId!)).resolves.toContain('agent exited 0');
  });

  it('reviews and accepts provider-neutral change sets for completed runs', async () => {
    const { rt, changeSet } = await makeRuntime();
    await rt.init('demo');
    const task = await rt.createTask('reviewable task');
    const results = await rt.runTask(task.id);
    const runId = results[0].run!;

    await expect(rt.reviewRun(runId)).resolves.toMatchObject({ status: 'changed', files: ['file.txt'], summary: 'M file.txt' });
    await expect(rt.acceptRun(runId, 'accept reviewable task')).resolves.toMatchObject({ status: 'accepted', message: 'accepted file.txt' });
    expect(changeSet.accepted).toEqual([runId]);
    expect((await rt.deps.store.get(task.id))?.status).toBe('done');
  });
});
