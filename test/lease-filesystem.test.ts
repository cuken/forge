import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLeaseProvider } from '../src/providers/lease-filesystem/index.js';
import type { Task } from '../src/core/types.js';

const task = (id: string): Task => ({ id, title: id, status: 'ready', complexity: 'small', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', contextRefs: [] });
const scope = { kind: 'path' as const, value: 'src/shared.ts', confidence: 'high' as const, reason: 'test' };

describe('FileLeaseProvider', () => {
  it('coordinates leases across provider instances and reports status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-lease-'));
    const first = new FileLeaseProvider(root, 60_000);
    const second = new FileLeaseProvider(root, 60_000);

    const lease = await first.acquire({ task: task('task-a'), scopes: [scope] });
    await expect(second.acquire({ task: task('task-b'), scopes: [scope] })).rejects.toThrow('lease unavailable');
    await expect(second.status()).resolves.toMatchObject([{ id: lease.id, taskId: 'task-a', scope: { kind: 'path', value: 'src/shared.ts' } }]);

    await first.release(lease);
    await expect(second.acquire({ task: task('task-b'), scopes: [scope] })).resolves.toMatchObject({ taskId: 'task-b' });
  });

  it('cleans up stale lease files before acquiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-lease-'));
    const stale = new FileLeaseProvider(root, 1);
    await stale.acquire({ task: task('stale-task'), scopes: [scope] });
    await new Promise(resolve => setTimeout(resolve, 5));

    const fresh = new FileLeaseProvider(root, 60_000);
    await expect(fresh.acquire({ task: task('fresh-task'), scopes: [scope] })).resolves.toMatchObject({ taskId: 'fresh-task' });
    await expect(fresh.status()).resolves.toMatchObject([{ taskId: 'fresh-task' }]);
  });
});
