import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import { FileWorkstreamProvider } from '../src/providers/workstream-filesystem/index.js';
import { extractJsonBlock } from '../src/providers/planner-pi/index.js';
import type { WorkstreamPlannerProvider, WorkstreamPlanRequest } from '../src/core/workstream.js';
import type { AgentProvider, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){return true;} async init(){} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; async run(){ return { exitCode: 0, output: 'ok' }; } }

class MemoryPlanner implements WorkstreamPlannerProvider {
  id = 'workstream-planner.memory';
  kind = 'workstream-planner' as const;
  received?: WorkstreamPlanRequest;
  answers: string[] = [];
  async planWorkstream(input: WorkstreamPlanRequest) {
    this.received = input;
    if (input.ask) this.answers.push(await input.ask('What is in scope?'));
    return {
      providerId: this.id,
      summary: 'two-step plan',
      items: [
        { id: 'base', title: 'Base slice', complexity: 'small' as const },
        { id: 'follow', title: 'Follow-up slice', dependencies: ['base'], complexity: 'medium' as const },
      ],
    };
  }
}

async function makeRuntime(planner?: WorkstreamPlannerProvider) {
  const root = await mkdtemp(join(tmpdir(), 'forge-workstream-test-'));
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), workstream: new FileWorkstreamProvider(root), workstreamPlanner: planner });
  return { rt, root };
}

async function importItems(rt: ForgeRuntime, root: string, items: unknown) {
  const source = join(root, 'roadmap.json');
  await writeFile(source, JSON.stringify(items));
  return rt.importWorkstream(source);
}

describe('workstream backlog', () => {
  it('imports and lists provider-neutral roadmap items from filesystem JSON', async () => {
    const { rt, root } = await makeRuntime();

    await expect(importItems(rt, root, { items: [{ id: 'ws-1', title: 'Add queue', description: 'Queue roadmap items', dependencies: ['ws-0'], complexity: 'medium' }] }))
      .resolves.toEqual([{ id: 'ws-1', title: 'Add queue', description: 'Queue roadmap items', dependencies: ['ws-0'], complexity: 'medium', status: 'planned', taskId: undefined }]);
    await expect(rt.listWorkstream()).resolves.toHaveLength(1);
  });

  it('enqueues imported workstream items through normal create task status gates', async () => {
    const { rt, root } = await makeRuntime();
    await importItems(rt, root, [{ id: 'small-1', title: 'Small item', complexity: 'small' }, { id: 'large-1', title: 'Large item', complexity: 'large' }]);

    const tasks = await rt.enqueueWorkstream();

    expect(tasks.map(task => [task.title, task.status, task.complexity])).toEqual([['Small item', 'ready', 'small'], ['Large item', 'needs-spec', 'large']]);
    await expect(rt.deps.store.list()).resolves.toHaveLength(2);
    const items = await rt.listWorkstream();
    expect(items.map(item => item.status)).toEqual(['queued', 'queued']);
    expect(items[0].taskId).toBe(tasks[0].id);
  });

  it('does not create duplicate tasks when enqueue runs twice', async () => {
    const { rt, root } = await makeRuntime();
    await importItems(rt, root, [{ id: 'once-1', title: 'Only once' }]);

    await expect(rt.enqueueWorkstream()).resolves.toHaveLength(1);
    await expect(rt.enqueueWorkstream()).resolves.toHaveLength(0);
    await expect(rt.deps.store.list()).resolves.toHaveLength(1);
  });

  it('holds back items until their dependencies are done', async () => {
    const { rt, root } = await makeRuntime();
    await importItems(rt, root, [{ id: 'base', title: 'Base item' }, { id: 'next', title: 'Next item', dependencies: ['base'] }]);

    const first = await rt.enqueueWorkstream();
    expect(first.map(task => task.title)).toEqual(['Base item']);

    await expect(rt.enqueueWorkstream()).resolves.toHaveLength(0);

    await rt.deps.store.update(first[0].id, { status: 'done' });
    const second = await rt.enqueueWorkstream();
    expect(second.map(task => task.title)).toEqual(['Next item']);
  });

  it('force-enqueues named items past dependency gating but never re-queues them', async () => {
    const { rt, root } = await makeRuntime();
    await importItems(rt, root, [{ id: 'base', title: 'Base item' }, { id: 'forced', title: 'Forced item', dependencies: ['base'] }]);

    await expect(rt.enqueueWorkstream(['forced'])).resolves.toHaveLength(1);
    await expect(rt.enqueueWorkstream(['forced'])).resolves.toHaveLength(0);
    await expect(rt.enqueueWorkstream(['missing'])).rejects.toThrow("No workstream item 'missing'");
  });

  it('plans a workstream through the planner provider, relaying clarifying questions', async () => {
    const planner = new MemoryPlanner();
    const { rt } = await makeRuntime(planner);

    const { plan, added } = await rt.planWorkstream({ prompt: 'ship the widget', ask: async question => `answer to: ${question}` });

    expect(plan.summary).toBe('two-step plan');
    expect(planner.received?.prompt).toBe('ship the widget');
    expect(planner.answers).toEqual(['answer to: What is in scope?']);
    expect(added.map(item => [item.id, item.status, item.dependencies])).toEqual([['base', 'planned', []], ['follow', 'planned', ['base']]]);
    await expect(rt.listWorkstream()).resolves.toHaveLength(2);
  });

  it('merges planned items into the existing backlog and remaps colliding ids', async () => {
    const planner = new MemoryPlanner();
    const { rt, root } = await makeRuntime(planner);
    await importItems(rt, root, [{ id: 'base', title: 'Existing base item' }]);
    const [queuedTask] = await rt.enqueueWorkstream(['base']);

    const { added } = await rt.planWorkstream({ prompt: 'ship the widget' });

    expect(added.map(item => [item.id, item.dependencies])).toEqual([['base-2', []], ['follow', ['base-2']]]);
    const items = await rt.listWorkstream();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: 'base', status: 'queued', taskId: queuedTask.id });
  });

  it('extracts balanced JSON blocks from chatty planner output', () => {
    expect(extractJsonBlock('Sure! Here is the plan:\n{"items": [{"title": "a }tricky{ one"}]}\nHope that helps.', '{')).toBe('{"items": [{"title": "a }tricky{ one"}]}');
    expect(extractJsonBlock('thinking...\n["q1", "q2"] trailing', '[')).toBe('["q1", "q2"]');
    expect(extractJsonBlock('no json here', '{')).toBeNull();
  });

  it('preserves queued state when an edited roadmap is re-imported', async () => {
    const { rt, root } = await makeRuntime();
    await importItems(rt, root, [{ id: 'keep', title: 'Keep me' }]);
    const [task] = await rt.enqueueWorkstream();

    const items = await importItems(rt, root, [{ id: 'keep', title: 'Keep me (retitled)' }, { id: 'new', title: 'New item' }]);

    expect(items).toEqual([
      expect.objectContaining({ id: 'keep', title: 'Keep me (retitled)', status: 'queued', taskId: task.id }),
      expect.objectContaining({ id: 'new', status: 'planned' }),
    ]);
    await expect(rt.enqueueWorkstream()).resolves.toHaveLength(1);
  });
});
