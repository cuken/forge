import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import type { AgentProvider, TaskStore, VcsProvider, WorkspaceProvider } from '../src/core/types.js';
import type { SyncProvider } from '../src/core/sync.js';

const store: TaskStore = { id:'store', kind:'task-store', init:async()=>{}, create:async()=>{throw new Error('unused')}, get:async()=>null, list:async()=>[], update:async()=>{throw new Error('unused')} };
const vcs: VcsProvider & SyncProvider = { id:'vcs.checked', kind:'vcs', isRepo:async()=>true, init:async()=>{}, currentBranch:async()=>'main', status:async()=>({clean:true, summary:''}), syncTasks:()=>[{ id:'vcs.checked:sync', label:'sync', run:async input=>({ id:'vcs.checked:sync', status: input.dryRun ? 'unchanged' : 'changed', message: input.message ?? 'synced' }) }] };
const workspace: WorkspaceProvider = { id:'ws', kind:'workspace', create:async()=>({id:'x', path:'x', branch:'x'}) };
const agent: AgentProvider = { id:'agent', kind:'agent', run:async()=>({exitCode:0, output:''}) };

describe('sync', () => {
  it('runs provider-declared sync tasks with caller input', async () => {
    const rt = new ForgeRuntime({ store, vcs, workspace, agent });
    await expect(rt.sync({ message: 'ship it' })).resolves.toEqual([{ id:'vcs.checked:sync', status:'changed', message:'ship it' }]);
  });
});
