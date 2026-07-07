import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { HeuristicBuildPlannerProvider } from '../src/providers/build-heuristic/index.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import type { AgentProvider, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){return true;} async init(){} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; runs: string[]=[]; async run(input:{task:Task}){ this.runs.push(input.task.id); return { exitCode: 0, output: 'ok' }; } }

async function makeRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'forge-build-test-'));
  const agent = new MemoryAgent();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent, buildPlanner: new HeuristicBuildPlannerProvider() });
  await rt.init('demo');
  return { rt, agent };
}

describe('build flow', () => {
  it('turns a simple natural-language request into a runnable task', async () => {
    const { rt, agent } = await makeRuntime();
    const result = await rt.build({ prompt: 'fix readme typo' });
    expect(result.plan.requiresSpec).toBe(false);
    expect(result.action).toBe('ran');
    expect(agent.runs).toEqual([result.task.id]);
    expect((await rt.deps.store.get(result.task.id))?.status).toBe('reviewing');
  });

  it('drafts a spec and waits for approval for complex provider/config changes', async () => {
    const { rt, agent } = await makeRuntime();
    const result = await rt.build({ prompt: 'update forge so that it honors toml files in the config instead of json config files' });
    expect(result.plan.requiresSpec).toBe(true);
    expect(result.action).toBe('awaiting-approval');
    expect(result.task.status).toBe('awaiting-approval');
    expect(result.task.spec?.path).toMatch(/\.forge\/specs\//);
    expect(agent.runs).toEqual([]);
  });

  it('supports explicit task names and auto-approval for generated specs', async () => {
    const { rt, agent } = await makeRuntime();
    const result = await rt.build({ prompt: 'support toml configuration files', taskName: 'TOML config support', autoApprove: true });
    expect(result.task.title).toBe('TOML config support');
    expect(result.action).toBe('ran');
    expect(agent.runs).toEqual([result.task.id]);
  });
});
