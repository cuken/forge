import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import type { AgentProvider, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; repo=false; async isRepo(){return this.repo;} async init(){this.repo=true;} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; runs: string[]=[]; async run(input:{task:Task; workspacePath:string; context:string}){ this.runs.push(input.task.id); return { exitCode: 0, output: 'ok' }; } }

async function makeRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const agent = new MemoryAgent();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent });
  return { rt, agent };
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
});
