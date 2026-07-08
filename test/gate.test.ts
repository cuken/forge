import { describe, expect, it } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import { hasGate, type GateProvider, type GateSubject } from '../src/core/gate.js';
import type { AgentProvider, RunRecord, RunStore, Task, TaskStore, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryTaskStore implements TaskStore { id='store.memory'; kind='task-store' as const; async init(){} async create(input: Omit<Task, 'id'|'createdAt'|'updatedAt'> & { id?: string }){ const now = '2026-01-01T00:00:00.000Z'; return { ...input, id: input.id ?? 'task-1', createdAt: now, updatedAt: now }; } async get(){ return null; } async list(){ return []; } async update(id: string, patch: Partial<Task>){ const now = '2026-01-01T00:00:00.000Z'; return { id, title: 'updated', status: 'ready', complexity: 'small', createdAt: now, updatedAt: now, contextRefs: [], ...patch }; } }
class MemoryRunStore implements RunStore { id='run-store.memory'; kind='run-store' as const; async init(){} async start(input:{task:Task; agentId:string}){ return { id: 'run-1', taskId: input.task.id, taskTitle: input.task.title, status: 'running' as const, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', agentId: input.agentId, logPath: '/tmp/run.log' }; } async appendLog(){} async update(id:string, patch:Partial<RunRecord>){ return { id, taskId: 'task-1', taskTitle: 'Task', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', agentId: 'agent.memory', logPath: '/tmp/run.log', ...patch }; } async get(){ return null; } async list(){ return []; } async readLog(){ return ''; } }
class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){ return true; } async init(){} async currentBranch(){ return 'main'; } async status(){ return { clean: true, summary: '' }; } }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws', branch: 'forge/task-1' }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; async run(){ return { exitCode: 0, output: 'ok' }; } }
class MemoryGate implements GateProvider { id='gate.memory'; kind='gate' as const; subjects: GateSubject[] = []; async publishDecision(input:{subject:GateSubject; message?: string}){ this.subjects.push(input.subject); return { providerId: this.id, gateId: `${input.subject.kind}:${input.subject.task.id}`, kind: input.subject.kind, status: 'pending' as const, taskId: input.subject.task.id, runId: input.subject.kind === 'run-acceptance' ? input.subject.run.id : undefined, url: 'https://approvals.test/gate-1', message: input.message ?? 'approval requested' }; } async readDecision(input:{gateId:string}){ return { providerId: this.id, gateId: input.gateId, kind: 'spec-approval' as const, status: 'approved' as const, taskId: 'task-1', decidedAt: '2026-01-02T00:00:00.000Z', decidedBy: 'human', message: 'approved externally' }; } }

const task: Task = { id: 'task-1', title: 'Define human gate capability', status: 'awaiting-approval', complexity: 'medium', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', contextRefs: [], spec: { path: 'specs/task-1.md', approved: false } };

function runtimeWithGate(gate: GateProvider) {
  return new ForgeRuntime({ store: new MemoryTaskStore(), runStore: new MemoryRunStore(), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), gate });
}

describe('GateProvider', () => {
  it('is discovered structurally by kind and required methods', () => {
    expect(hasGate(new MemoryGate())).toBe(true);
    expect(hasGate({ id: 'gate.incomplete', kind: 'gate', publishDecision: async () => undefined })).toBe(false);
  });

  it('publishes and reads provider-neutral human decisions through the runtime', async () => {
    const gate = new MemoryGate();
    const rt = runtimeWithGate(gate);

    const pending = await rt.publishGateDecision({ subject: { kind: 'spec-approval', task, specPath: task.spec!.path, specBody: '# Spec' }, message: 'Please approve spec' });
    const decision = await rt.readGateDecision({ gateId: pending.gateId, kind: pending.kind, task });

    expect(pending).toMatchObject({ providerId: 'gate.memory', gateId: 'spec-approval:task-1', kind: 'spec-approval', status: 'pending', taskId: 'task-1', url: 'https://approvals.test/gate-1' });
    expect(gate.subjects[0]).toMatchObject({ kind: 'spec-approval', specPath: 'specs/task-1.md' });
    expect(decision).toMatchObject({ status: 'approved', decidedBy: 'human', message: 'approved externally' });
  });
});
