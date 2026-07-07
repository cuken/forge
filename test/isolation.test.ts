import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import type { AgentProvider, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';
import type { ExecutionEnvironment, IsolationProvider } from '../src/core/isolation.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){return true;} async init(){} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/host/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class ContainerIsolation implements IsolationProvider { id='isolation.container-test'; kind='isolation' as const; cleaned: string[] = []; async prepare(input:{workspace:{id:string}}): Promise<ExecutionEnvironment> { return { id: `container:${input.workspace.id}`, kind: 'container', workspacePath: '/container/workspace', description: 'test container' }; } async cleanup(environment: ExecutionEnvironment) { this.cleaned.push(environment.id); } }
class CapturingAgent implements AgentProvider { id='agent.capture'; kind='agent' as const; cwd?: string; context?: string; async run(input:{workspacePath:string; context:string}){ this.cwd = input.workspacePath; this.context = input.context; return { exitCode: 0, output: 'ok' }; } }
class ThrowingAgent implements AgentProvider { id='agent.throwing'; kind='agent' as const; async run(){ throw new Error('agent crashed'); } }

describe('execution isolation', () => {
  it('prepares an execution environment before running an agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-isolation-test-'));
    const agent = new CapturingAgent();
    const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), isolation: new ContainerIsolation(), agent });
    await rt.init('demo');
    const task = await rt.createTask('safe task');
    const result = await rt.runTask(task.id);
    expect(agent.cwd).toBe('/container/workspace');
    expect(agent.context).toContain('Execution environment: container:');
    expect(result[0]).toMatchObject({ environment: { kind: 'container', workspacePath: '/container/workspace' } });
  });

  it('cleans up the prepared environment when agent execution fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-isolation-cleanup-test-'));
    const isolation = new ContainerIsolation();
    const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), isolation, agent: new ThrowingAgent() });
    await rt.init('demo');
    const task = await rt.createTask('cleanup task');
    const result = await rt.runTask(task.id);

    expect(isolation.cleaned).toEqual([`container:${task.id}`]);
    expect(result[0]).toEqual({ task: task.id, error: 'Error: agent crashed' });
    expect((await rt.deps.store.get(task.id))?.status).toBe('failed');
  });
});
