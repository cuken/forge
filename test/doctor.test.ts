import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import type { AgentProvider, TaskStore, VcsProvider, WorkspaceProvider } from '../src/core/types.js';
import type { DoctorProvider } from '../src/core/health.js';
import { ConsoleNotificationProvider } from '../src/providers/notification-console/index.js';

const store: TaskStore = { id:'store', kind:'task-store', init:async()=>{}, create:async()=>{throw new Error('unused')}, get:async()=>null, list:async()=>[], update:async()=>{throw new Error('unused')} };
const vcs: VcsProvider = { id:'vcs', kind:'vcs', isRepo:async()=>true, init:async()=>{}, currentBranch:async()=>'main', status:async()=>({clean:true, summary:''}) };
const workspace: WorkspaceProvider = { id:'ws', kind:'workspace', create:async()=>({id:'x', path:'x', branch:'x'}) };
const agent: AgentProvider & DoctorProvider = { id:'agent.checked', kind:'agent', run:async()=>({exitCode:0, output:''}), checks:()=>[{ id:'agent.checked:model', label:'model', run:async()=>({ id:'agent.checked:model', status:'pass', message:'model available' }) }] };

describe('doctor', () => {
  it('runs checks declared by providers instead of hardcoded runtime checks', async () => {
    const rt = new ForgeRuntime({ store, vcs, workspace, agent });
    await expect(rt.doctor()).resolves.toEqual([{ id:'agent.checked:model', status:'pass', message:'model available' }]);
  });

  it('includes notification provider readiness checks', async () => {
    const rt = new ForgeRuntime({ store, vcs, workspace, agent, notification: new ConsoleNotificationProvider('stderr') });
    await expect(rt.doctor()).resolves.toContainEqual({ id:'notification.console:channel', status:'pass', message:'stderr notification channel is writable' });
  });

  it('passes the requested doctor scope to providers', async () => {
    const scopedAgent: AgentProvider & DoctorProvider = { id:'agent.scoped', kind:'agent', run:async()=>({exitCode:0, output:''}), checks:(input)=>[{ id:'agent.scoped:scope', label:'scope', run:async()=>({ id:'agent.scoped:scope', status:'pass', message:`scope=${input?.scope ?? 'host'}` }) }] };
    const rt = new ForgeRuntime({ store, vcs, workspace, agent: scopedAgent });
    await expect(rt.doctor({ scope: 'workspace' })).resolves.toEqual([{ id:'agent.scoped:scope', status:'pass', message:'scope=workspace' }]);
  });
});
