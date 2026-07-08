import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemNotificationProvider } from '../src/providers/notification-filesystem/index.js';
import type { RunNotificationInput } from '../src/core/notification.js';

const baseInput: RunNotificationInput = {
  event: 'run.failed',
  message: 'agent exited 1',
  task: { id: 'task-1', title: 'audit notifications', status: 'failed', complexity: 'small', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', contextRefs: [] },
  run: { id: 'run-1', taskId: 'task-1', taskTitle: 'audit notifications', status: 'failed', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', agentId: 'agent.pi', exitCode: 1, logPath: '.forge/runs/run-1.log' },
  metadata: { failureReason: 'agent exited 1', exitCode: 1 }
};

describe('FilesystemNotificationProvider', () => {
  it('appends run lifecycle notifications to the local audit log as json lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-notification-filesystem-'));
    const provider = new FilesystemNotificationProvider(root, 'audit');

    await provider.notifyRun(baseInput);
    await provider.notifyRun({ ...baseInput, event: 'run.succeeded', message: 'agent exited 0', metadata: undefined, run: { ...baseInput.run!, status: 'succeeded', exitCode: 0 } });

    const lines = (await readFile(join(root, '.forge', 'audit.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ channel: 'audit', event: 'run.failed', message: 'agent exited 1', task: { id: 'task-1', title: 'audit notifications' }, run: { id: 'run-1', status: 'failed', exitCode: 1 }, metadata: { failureReason: 'agent exited 1', exitCode: 1 } });
    expect(lines[0].timestamp).toEqual(expect.any(String));
    expect(lines[1]).toMatchObject({ channel: 'audit', event: 'run.succeeded', run: { status: 'succeeded', exitCode: 0 } });
  });
});
