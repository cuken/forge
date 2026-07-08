import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LeaseConflictError, leaseScopeKey, type LeaseHandle, type LeaseProvider, type LeaseStatusEntry } from '../../core/lease.js';
import type { TaskResourceScope } from '../../core/discovery.js';
import type { Task } from '../../core/types.js';

interface LeaseFile {
  providerId: string;
  leaseId: string;
  taskId: string;
  scope: TaskResourceScope;
  acquiredAt: string;
  heartbeatAt: string;
  staleAfterMs: number;
  pid: number;
}

export class FileLeaseProvider implements LeaseProvider {
  id = 'lease.filesystem';
  kind = 'lease' as const;
  constructor(private root = process.cwd(), private staleAfterMs = 60 * 60 * 1000) {}

  private dir() { return join(this.root, '.forge', 'leases'); }
  private pathFor(scope: TaskResourceScope) { return join(this.dir(), `${Buffer.from(leaseScopeKey(scope)).toString('base64url')}.json`); }

  async init() { await mkdir(this.dir(), { recursive: true }); }

  async acquire(input: { task: Task; scopes: TaskResourceScope[] }): Promise<LeaseHandle> {
    await this.init();
    await this.cleanupStale();
    const id = `lease-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const acquiredAt = new Date().toISOString();
    // Acquire in sorted key order so processes contending on overlapping scope sets
    // always collide on the first shared scope instead of deadlocking on partial holds.
    const scopes = [...input.scopes].sort((a, b) => leaseScopeKey(a).localeCompare(leaseScopeKey(b)));
    const written: string[] = [];
    try {
      for (const scope of scopes) {
        const path = this.pathFor(scope);
        const body: LeaseFile = { providerId: this.id, leaseId: id, taskId: input.task.id, scope, acquiredAt, heartbeatAt: acquiredAt, staleAfterMs: this.staleAfterMs, pid: process.pid };
        try {
          await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const holder = await this.readLeaseFile(path);
          throw new LeaseConflictError(`resource scope '${leaseScopeKey(scope)}' is already leased${holder ? ` by task ${holder.taskId}` : ''}`, leaseScopeKey(scope), holder?.taskId);
        }
        written.push(path);
      }
    } catch (error) {
      await Promise.all(written.map(path => rm(path, { force: true })));
      throw error;
    }
    return { providerId: this.id, id, taskId: input.task.id, scopes, acquiredAt };
  }

  async release(lease: LeaseHandle): Promise<void> {
    for (const scope of lease.scopes) {
      const path = this.pathFor(scope);
      const file = await this.readLeaseFile(path);
      if (file?.leaseId === lease.id && file.taskId === lease.taskId) await rm(path, { force: true });
    }
  }

  async cleanupStale(now = Date.now()): Promise<number> {
    await mkdir(this.dir(), { recursive: true });
    let removed = 0;
    for (const name of await readdir(this.dir())) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir(), name);
      const file = await this.readLeaseFile(path);
      if (!file) continue;
      const heartbeat = Date.parse(file.heartbeatAt || file.acquiredAt);
      const ttl = file.staleAfterMs || this.staleAfterMs;
      if (Number.isFinite(heartbeat) && now - heartbeat > ttl) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }

  async status(): Promise<LeaseStatusEntry[]> {
    await this.cleanupStale();
    const entries: LeaseStatusEntry[] = [];
    for (const name of await readdir(this.dir())) {
      if (!name.endsWith('.json')) continue;
      const file = await this.readLeaseFile(join(this.dir(), name));
      if (file) entries.push({ providerId: this.id, id: file.leaseId, taskId: file.taskId, scope: file.scope, acquiredAt: file.acquiredAt, heartbeatAt: file.heartbeatAt, staleAt: new Date(Date.parse(file.heartbeatAt || file.acquiredAt) + (file.staleAfterMs || this.staleAfterMs)).toISOString() });
    }
    return entries.sort((a, b) => leaseScopeKey(a.scope).localeCompare(leaseScopeKey(b.scope)));
  }

  private async readLeaseFile(path: string): Promise<LeaseFile | null> {
    try { return JSON.parse(await readFile(path, 'utf8')) as LeaseFile; }
    catch { return null; }
  }
}
