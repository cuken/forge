import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { ForgeRuntime } from '../src/core/forge.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import { FileRunStore } from '../src/providers/store-filesystem/runs.js';
import { FileReleaseStore } from '../src/providers/store-filesystem/releases.js';
import type { ChangeSetProvider } from '../src/core/changes.js';
import type { TaskDiscoveryProvider } from '../src/core/discovery.js';
import type { ValidationProvider } from '../src/core/validation.js';
import type { NotificationProvider, RunNotificationInput } from '../src/core/notification.js';
import type { SpecProvider } from '../src/core/spec.js';
import { LeaseConflictError, type LeaseHandle, type LeaseProvider } from '../src/core/lease.js';
import { MemoryLeaseProvider } from '../src/providers/lease-memory/index.js';
import { FileWorkstreamProvider } from '../src/providers/workstream-filesystem/index.js';
import { GitWorktreeChangeSetProvider } from '../src/providers/workspace-git-worktree/changes.js';
import type { AgentProvider, ForgeProvider, RunRecord, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; repo=false; async isRepo(){return this.repo;} async init(){this.repo=true;} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; runs: string[]=[]; async run(input:{task:Task; workspacePath:string; context:string; onOutput?: (chunk: string) => void}){ this.runs.push(input.task.id); input.onOutput?.('agent output\n'); return { exitCode: 0, output: 'ok' }; } }
class MemoryChangeSet implements ChangeSetProvider { id='change-set.memory'; kind='change-set' as const; accepted: string[]=[]; async review(input:{run:RunRecord}){ return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'changed' as const, files: ['file.txt'], summary: 'M file.txt' }; } async accept(input:{run:RunRecord}){ this.accepted.push(input.run.id); return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'accepted' as const, message: 'accepted file.txt' }; } }
class MemoryValidation implements ValidationProvider, ForgeProvider { id='validation.memory'; kind='validation'; constructor(private status:'pass'|'fail'){} async validate(){ return [{ id: 'validation.memory:gate', status: this.status, message: this.status === 'pass' ? 'ok' : 'not ok' }]; } }
class MemoryDiscovery implements TaskDiscoveryProvider, ForgeProvider { id='task-discovery.memory'; kind='task-discovery'; async discoverTask(input:{title:string}){ return { providerId: this.id, discoveredAt: '2026-01-01T00:00:00.000Z', resourceScopes: [{ kind: 'path' as const, value: `src/${input.title}.ts`, confidence: 'high' as const, reason: 'test scope' }] }; } }
class MemoryLease implements LeaseProvider { id='lease.memory'; kind='lease' as const; acquired:string[]=[]; released:string[]=[]; async acquire(input:{task:Task}){ this.acquired.push(input.task.id); return { providerId: this.id, id: `lease-${input.task.id}`, taskId: input.task.id, scopes: input.task.discovery?.resourceScopes ?? [], acquiredAt: '2026-01-01T00:00:00.000Z' }; } async release(lease:LeaseHandle){ this.released.push(lease.taskId); } }
class MemorySpec implements SpecProvider, ForgeProvider { id='spec.memory'; kind='spec' as const; async generateSpec(input:{task:Task}){ return { providerId: this.id, body: `# Generated spec\n\n${input.task.title}` }; } }
class MemoryNotification implements NotificationProvider, ForgeProvider { id='notification.memory'; kind='notification'; events:RunNotificationInput[]=[]; async notifyRun(input:RunNotificationInput){ this.events.push(input); } }
class BrokenNotification implements NotificationProvider, ForgeProvider { id='notification.broken'; kind='notification'; async notifyRun(){ throw new Error('notification backend unreachable'); } }

async function makeRuntime(validation?: ValidationProvider & ForgeProvider) {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const agent = new MemoryAgent();
  const changeSet = new MemoryChangeSet();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), releaseStore: new FileReleaseStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent, changeSet, validation, workstream: new FileWorkstreamProvider(root) });
  return { rt, agent, changeSet, root };
}

async function makeRuntimeWithDiscovery() {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const lease = new MemoryLease();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), changeSet: new MemoryChangeSet(), taskDiscovery: new MemoryDiscovery(), lease });
  return { rt, lease };
}

async function makeRuntimeWithLease(lease: LeaseProvider) {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const agent = new MemoryAgent();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent, changeSet: new MemoryChangeSet(), lease });
  return { rt, agent };
}

async function makeRuntimeWithNotification(notification: NotificationProvider & ForgeProvider) {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const agent = new MemoryAgent();
  const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent, changeSet: new MemoryChangeSet(), notification });
  return { rt, agent };
}

const sharedScope = { kind: 'path' as const, value: 'src/shared.ts', confidence: 'high' as const, reason: 'test scope' };
const sharedDiscovery = { providerId: 'task-discovery.test', discoveredAt: '2026-01-01T00:00:00.000Z', resourceScopes: [sharedScope] };

describe('Forge vertical slice', () => {
  it('initializes config, store, and project context', async () => {
    const { rt } = await makeRuntime();
    const cfg = await rt.init('demo');
    expect(cfg.providers.store).toBe('store.filesystem');
    expect(cfg.notifications?.channel).toBe('stderr');
    expect(await rt.deps.vcs.isRepo()).toBe(true);
  });

  it('stores provider-neutral task discovery metadata when a discovery provider is configured', async () => {
    const { rt } = await makeRuntimeWithDiscovery();
    await rt.init('demo');
    const task = await rt.createTask('resourceful-task');

    expect(task.discovery).toMatchObject({ providerId: 'task-discovery.memory', resourceScopes: [{ kind: 'path', value: 'src/resourceful-task.ts', confidence: 'high' }] });
    await expect(rt.deps.store.get(task.id)).resolves.toMatchObject({ discovery: { providerId: 'task-discovery.memory' } });
  });

  it('acquires and releases provider-neutral resource scope leases around agent runs', async () => {
    const { rt, lease } = await makeRuntimeWithDiscovery();
    await rt.init('demo');
    const task = await rt.createTask('leaseable-task');

    const results = await rt.runTask(task.id);

    expect(results[0]).toMatchObject({ task: task.id, result: { exitCode: 0 } });
    expect(lease.acquired).toEqual([task.id]);
    expect(lease.released).toEqual([task.id]);
    const log = await rt.deps.runStore!.readLog(results[0].run!);
    expect(log).toContain('lease lease-');
  });

  it('creates, loads, and lists provider-neutral release records', async () => {
    const { rt, root } = await makeRuntime();
    await rt.init('demo');

    const release = await rt.createRelease({ version: '1.2.3', target: { kind: 'package', id: 'forge-cli', name: 'Forge CLI', metadata: { runtime: 'node' } }, scheduledAt: '2026-02-01T00:00:00.000Z', notes: 'first-class release state' });
    const ready = await rt.updateRelease(release.id, { status: 'ready' });

    expect(release).toMatchObject({ id: '1-2-3-package-forge-cli', version: '1.2.3', status: 'planned', target: { kind: 'package', id: 'forge-cli', name: 'Forge CLI' } });
    expect(Date.parse(ready.updatedAt)).toBeGreaterThanOrEqual(Date.parse(release.updatedAt));
    await expect(rt.getRelease(release.id)).resolves.toMatchObject({ version: '1.2.3', status: 'ready', target: { metadata: { runtime: 'node' } } });
    await expect(rt.listReleases({ status: 'ready' })).resolves.toHaveLength(1);
    await expect(rt.listReleases({ targetKind: 'environment' })).resolves.toEqual([]);
    await expect(readFile(join(root, '.forge', 'releases', `${release.id}.json`), 'utf8')).resolves.toContain('first-class release state');
  });

  it('creates small tasks as ready and medium tasks behind spec gate', async () => {
    const { rt } = await makeRuntime();
    await rt.init('demo');
    const small = await rt.createTask('small thing');
    const medium = await rt.createTask('risky thing', { complexity: 'medium' });
    expect(small.status).toBe('ready');
    expect(medium.status).toBe('needs-spec');
  });

  it('generates task specs through the configured spec provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-test-'));
    const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), spec: new MemorySpec() });
    await rt.init('demo');
    const task = await rt.createTask('provider generated spec', { complexity: 'medium' });

    const withSpec = await rt.generateSpec(task.id);

    expect(withSpec.status).toBe('awaiting-approval');
    await expect(readFile(join(root, withSpec.spec!.path), 'utf8')).resolves.toContain('provider generated spec');
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

  it('runs multiple ready tasks concurrently when requested', async () => {
    const { rt, agent } = await makeRuntime();
    await rt.init('demo');
    let active = 0;
    let maxActive = 0;
    agent.run = async input => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--;
      agent.runs.push(input.task.id);
      return { exitCode: 0, output: `ok ${input.task.id}` };
    };
    const first = await rt.createTask('first concurrent task');
    const second = await rt.createTask('second concurrent task');
    const third = await rt.createTask('third concurrent task');

    const results = await rt.runReady(undefined, undefined, { concurrency: 2 });

    expect(results.map(result => result.task)).toEqual([first.id, second.id, third.id]);
    expect(maxActive).toBe(2);
    await expect(rt.deps.store.get(first.id)).resolves.toMatchObject({ status: 'reviewing' });
    await expect(rt.deps.store.get(second.id)).resolves.toMatchObject({ status: 'reviewing' });
    await expect(rt.deps.store.get(third.id)).resolves.toMatchObject({ status: 'reviewing' });
  });

  it('serializes ready tasks with overlapping resource scopes and releases leases after failures', async () => {
    const { rt, agent } = await makeRuntimeWithLease(new MemoryLeaseProvider());
    await rt.init('demo');
    let activeShared = 0;
    let maxActiveShared = 0;
    agent.run = async input => {
      activeShared++;
      maxActiveShared = Math.max(maxActiveShared, activeShared);
      await new Promise(resolve => setTimeout(resolve, 25));
      activeShared--;
      agent.runs.push(input.task.id);
      return { exitCode: input.task.title.includes('failing') ? 1 : 0, output: `done ${input.task.id}` };
    };
    const failing = await rt.createTask('failing shared task');
    const second = await rt.createTask('second shared task');
    await rt.deps.store.update(failing.id, { discovery: sharedDiscovery });
    await rt.deps.store.update(second.id, { discovery: sharedDiscovery });

    const results = await rt.runReady(undefined, undefined, { concurrency: 2 });

    expect(new Set(results.map(result => result.task))).toEqual(new Set([failing.id, second.id]));
    expect(maxActiveShared).toBe(1);
    await expect(rt.deps.store.get(failing.id)).resolves.toMatchObject({ status: 'failed' });
    await expect(rt.deps.store.get(second.id)).resolves.toMatchObject({ status: 'reviewing' });
  });

  it('defers a task back to ready when its lease wait times out', async () => {
    const lease = new MemoryLeaseProvider();
    const { rt, agent } = await makeRuntimeWithLease(lease);
    await rt.init('demo');
    const blocker = await rt.createTask('external blocker task');
    await lease.acquire({ task: { ...blocker, discovery: sharedDiscovery }, scopes: [sharedScope] });
    const task = await rt.createTask('blocked task');
    await rt.deps.store.update(task.id, { discovery: sharedDiscovery, status: 'ready' });

    const results = await rt.runReady(task.id, undefined, { leaseWaitMs: 30 });

    expect(results[0]).toMatchObject({ task: task.id, deferred: true });
    expect(agent.runs).toEqual([]);
    await expect(rt.deps.store.get(task.id)).resolves.toMatchObject({ status: 'ready' });
    await expect(rt.deps.runStore!.get(results[0].run!)).resolves.toMatchObject({ status: 'deferred' });
  });

  it('fails a task immediately when the lease provider errors for a non-conflict reason', async () => {
    class BrokenLease implements LeaseProvider {
      id = 'lease.broken'; kind = 'lease' as const;
      async acquire(): Promise<LeaseHandle> { throw new Error('lease backend unreachable'); }
      async release() {}
    }
    const { rt, agent } = await makeRuntimeWithLease(new BrokenLease());
    await rt.init('demo');
    const task = await rt.createTask('lease backend task');
    await rt.deps.store.update(task.id, { discovery: sharedDiscovery });

    const results = await rt.runReady(task.id, undefined, { leaseWaitMs: 5000 });

    expect(results[0].error).toContain('lease backend unreachable');
    expect(results[0].deferred).toBeUndefined();
    expect(agent.runs).toEqual([]);
    await expect(rt.deps.store.get(task.id)).resolves.toMatchObject({ status: 'failed' });
  });

  it('discovers notification capability providers for run lifecycle events', async () => {
    const notification = new MemoryNotification();
    const { rt } = await makeRuntimeWithNotification(notification);
    await rt.init('demo');
    const task = await rt.createTask('notified task');

    const results = await rt.runTask(task.id);

    expect(results[0]).toMatchObject({ task: task.id, result: { exitCode: 0 } });
    expect(notification.events.map(event => event.event)).toEqual([
      'run.started',
      'run.workspace-created',
      'run.environment-prepared',
      'run.succeeded',
    ]);
    expect(notification.events[0]).toMatchObject({ task: { id: task.id }, run: { taskId: task.id }, message: expect.stringContaining('started task') });
    const success = notification.events.at(-1)!;
    expect(success).toMatchObject({
      event: 'run.succeeded',
      task: { id: task.id, title: 'notified task' },
      run: {
        taskId: task.id,
        taskTitle: 'notified task',
        status: 'succeeded',
        agentId: 'agent.memory',
        exitCode: 0,
        workspace: { id: task.id, path: `/tmp/ws/${task.id}`, branch: `forge/${task.id}` },
        environment: { id: 'isolation.none', kind: 'host', workspacePath: `/tmp/ws/${task.id}` },
      },
      message: 'agent exited 0',
    });
    expect(success.run?.finishedAt).toEqual(expect.any(String));
  });

  it('ignores providers without notification support and best-effort notification failures', async () => {
    const { rt } = await makeRuntimeWithNotification(new BrokenNotification());
    await rt.init('demo');
    const task = await rt.createTask('notification failure task');

    const results = await rt.runTask(task.id);

    expect(results[0]).toMatchObject({ task: task.id, result: { exitCode: 0 } });
    await expect(rt.deps.store.get(task.id)).resolves.toMatchObject({ status: 'reviewing' });
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
    const acceptedRun = await rt.showRun('reviewable');
    expect(acceptedRun.acceptance).toMatchObject({ providerId: 'change-set.memory', status: 'accepted', message: 'accepted file.txt' });
    expect(acceptedRun.validation?.results).toEqual([]);
  });

  it('reports a dirty target checkout as a blocked acceptance result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-git-accept-'));
    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.name', 'Forge Test');
    await git.addConfig('user.email', 'forge@example.test');
    await writeFile(join(root, 'README.md'), 'initial\n');
    await git.add('.');
    await git.commit('initial');

    const worktreePath = join(root, '..', `forge-git-accept-worktree-${Date.now()}`);
    const branch = 'forge/dirty-target-test';
    await git.raw(['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    await writeFile(join(worktreePath, 'feature.txt'), 'from run\n');
    await writeFile(join(root, 'local.txt'), 'uncommitted target change\n');

    const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), changeSet: new GitWorktreeChangeSetProvider(root) });
    await rt.init('demo');
    const task = await rt.createTask('dirty checkout acceptance');
    await rt.deps.store.update(task.id, { status: 'reviewing' });
    const run = await rt.deps.runStore!.start({ task, agentId: 'agent.memory' });
    await rt.deps.runStore!.update(run.id, { status: 'succeeded', workspace: { id: task.id, path: worktreePath, branch }, exitCode: 0, finishedAt: new Date().toISOString() });

    const result = await rt.acceptRun(run.id, 'accept dirty target test');

    expect(result).toMatchObject({ status: 'blocked', message: 'Cannot accept change set: project checkout has uncommitted changes' });
    await expect(rt.deps.store.get(task.id)).resolves.toMatchObject({ status: 'reviewing' });
    await expect(rt.showRun(run.id)).resolves.toMatchObject({ acceptance: { status: 'blocked', message: result.message } });
  });

  it('runs provider-neutral validation gates before accepting completed runs', async () => {
    const { rt, changeSet } = await makeRuntime(new MemoryValidation('fail'));
    await rt.init('demo');
    const task = await rt.createTask('validation gated task');
    const results = await rt.runTask(task.id);
    const runId = results[0].run!;

    await expect(rt.acceptRun(runId)).rejects.toThrow('Validation failed');
    expect(changeSet.accepted).toEqual([]);
    expect((await rt.deps.store.get(task.id))?.status).toBe('reviewing');
    expect((await rt.showRun(runId)).validation?.results[0]).toMatchObject({ status: 'fail', message: 'not ok' });
  });

  it('summarizes pending human actions with runnable short-fragment commands', async () => {
    const { rt, root } = await makeRuntime(new MemoryValidation('pass'));
    await rt.init('demo');
    const specTask = await rt.createTask('Draft status spec', { complexity: 'medium' });
    await rt.writeSpec(specTask.id, '# Spec');
    const approvalTask = await rt.createTask('Approve status spec', { complexity: 'medium' });
    await rt.writeSpec(approvalTask.id, '# Spec');
    await rt.approve(approvalTask.id);
    const runResult = await rt.runTask(approvalTask.id);
    await rt.validateRun(runResult[0].run!);
    const deferredTask = await rt.createTask('Retry deferred status task');
    await rt.deps.runStore!.start({ task: deferredTask, agentId: 'agent.memory' });
    const [deferredRun] = await rt.deps.runStore!.list({ taskId: deferredTask.id });
    await rt.deps.runStore!.update(deferredRun.id, { status: 'deferred', finishedAt: new Date().toISOString() });
    await writeFile(join(root, 'roadmap.json'), JSON.stringify({ items: [{ id: 'base', title: 'Base dependency' }, { id: 'blocked-status-item', title: 'Blocked status item', dependencies: ['base'] }] }));
    await rt.importWorkstream(join(root, 'roadmap.json'));

    const lines = await rt.status();

    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/awaiting approval: Draft status spec -> forge task approve 'draft'/),
      expect.stringMatching(/awaiting review: Approve status spec -> forge runs review 'approve'/),
      expect.stringMatching(/awaiting accept: Approve status spec -> forge runs accept 'approve' -m 'accept approve'/),
      expect.stringMatching(/deferred: Retry deferred status task -> forge task run 'retry'/),
      'blocked workstream: Blocked status item (waiting on base) -> forge workstream enqueue blocked-status-item',
    ]));
  });

  it('supports dry-run acceptance without marking the task done', async () => {
    const { rt, changeSet } = await makeRuntime(new MemoryValidation('pass'));
    await rt.init('demo');
    const task = await rt.createTask('dry run acceptance task');
    const results = await rt.runTask(task.id);
    const runId = results[0].run!;

    await expect(rt.acceptRun('dry run acceptance', 'accept dry run', { dryRun: true })).resolves.toMatchObject({ status: 'accepted', message: expect.stringContaining('dry run: would accept 1 file') });
    expect(changeSet.accepted).toEqual([]);
    expect((await rt.deps.store.get(task.id))?.status).toBe('reviewing');
    expect((await rt.showRun(runId)).validation?.results[0]).toMatchObject({ status: 'pass' });
  });
});
