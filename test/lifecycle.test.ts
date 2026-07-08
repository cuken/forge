import { describe, expect, it } from 'vitest';
import { buildLifecyclePayload, hasLifecycleHooks } from '../src/core/lifecycle.js';
import type { RunRecord, Task } from '../src/core/types.js';

const task: Task = {
  id: 'task-1',
  title: 'Add lifecycle hooks',
  description: 'Build provider-neutral hooks.\n\nWorkstream item: define-lifecycle-hook-contract',
  status: 'reviewing',
  complexity: 'small',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  contextRefs: [],
  targetRelease: { id: 'release-1', version: '1.2.3' },
};

const run: RunRecord = {
  id: 'run-1',
  taskId: 'task-1',
  taskTitle: 'Add lifecycle hooks',
  status: 'succeeded',
  startedAt: '2026-01-01T00:01:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  finishedAt: '2026-01-01T00:02:00.000Z',
  workspace: { id: 'ws-1', path: '/tmp/ws', branch: 'forge/task-1' },
  agentId: 'agent.test',
  exitCode: 0,
  logPath: '.forge/runs/run-1.log',
};

describe('lifecycle hook contracts', () => {
  it('constructs provider-neutral run accepted payloads with identifiers and commit context', () => {
    const payload = buildLifecyclePayload({
      event: 'run.accepted',
      task: { ...task, status: 'done' },
      run,
      acceptance: { providerId: 'change-set.test', runId: 'run-1', taskId: 'task-1', status: 'accepted', message: 'merged change set' },
      occurredAt: '2026-01-01T00:03:00.000Z',
    });

    expect(payload).toMatchObject({
      event: 'run.accepted',
      occurredAt: '2026-01-01T00:03:00.000Z',
      identity: { runId: 'run-1', taskId: 'task-1', taskTitle: 'Add lifecycle hooks', workstreamItemId: 'define-lifecycle-hook-contract' },
      task: { id: 'task-1', status: 'done', targetRelease: { id: 'release-1', version: '1.2.3' } },
      run: { id: 'run-1', status: 'succeeded', exitCode: 0, workspace: { branch: 'forge/task-1' } },
      commit: { providerId: 'change-set.test', status: 'accepted', message: 'merged change set' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/github|issue|pull/i);
  });

  it('constructs task succeeded and failed payloads without provider-specific fields', () => {
    const succeeded = buildLifecyclePayload({ event: 'task.succeeded', task, run, occurredAt: '2026-01-01T00:02:00.000Z' });
    const failed = buildLifecyclePayload({ event: 'task.failed', task: { ...task, status: 'failed' }, run: { ...run, status: 'failed', exitCode: 1, error: 'agent exited 1' }, metadata: { failureReason: 'agent exited 1' }, occurredAt: '2026-01-01T00:02:00.000Z' });

    expect(succeeded.identity).toMatchObject({ runId: 'run-1', taskId: 'task-1', workstreamItemId: 'define-lifecycle-hook-contract' });
    expect(failed).toMatchObject({ event: 'task.failed', task: { status: 'failed' }, run: { status: 'failed', exitCode: 1, error: 'agent exited 1' }, metadata: { failureReason: 'agent exited 1' } });
    expect(JSON.stringify([succeeded, failed])).not.toMatch(/github|issue|pull/i);
  });

  it('constructs sync completed payloads with sync context', () => {
    const payload = buildLifecyclePayload({ event: 'sync.completed', sync: { input: { message: 'publish', dryRun: true }, results: [{ id: 'docs', status: 'unchanged', message: 'up to date' }] }, occurredAt: '2026-01-01T00:04:00.000Z' });

    expect(payload).toMatchObject({ event: 'sync.completed', identity: {}, sync: { message: 'publish', dryRun: true, results: [{ id: 'docs', status: 'unchanged', message: 'up to date' }] } });
    expect(payload.task).toBeUndefined();
    expect(payload.run).toBeUndefined();
  });

  it('detects lifecycle hook providers structurally', () => {
    expect(hasLifecycleHooks({ lifecycleHook: async () => undefined })).toBe(true);
    expect(hasLifecycleHooks({ notifyRun: async () => undefined })).toBe(false);
  });
});
