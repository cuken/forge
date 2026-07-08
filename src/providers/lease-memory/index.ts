import type { TaskResourceScope } from '../../core/discovery.js';
import { leaseScopeKey, type LeaseHandle, type LeaseProvider } from '../../core/lease.js';
import type { Task } from '../../core/types.js';

export class MemoryLeaseProvider implements LeaseProvider {
  id = 'lease.memory';
  kind = 'lease' as const;
  private held = new Map<string, string>();
  private sequence = 0;

  async acquire(input: { task: Task; scopes: TaskResourceScope[] }): Promise<LeaseHandle> {
    const keys = input.scopes.map(leaseScopeKey);
    const conflict = keys.find(key => this.held.has(key));
    if (conflict) throw new Error(`resource scope '${conflict}' is already leased by task ${this.held.get(conflict)}`);
    const lease: LeaseHandle = { providerId: this.id, id: `lease-${++this.sequence}`, taskId: input.task.id, scopes: input.scopes, acquiredAt: new Date().toISOString() };
    for (const key of keys) this.held.set(key, input.task.id);
    return lease;
  }

  async release(lease: LeaseHandle): Promise<void> {
    for (const scope of lease.scopes) {
      const key = leaseScopeKey(scope);
      if (this.held.get(key) === lease.taskId) this.held.delete(key);
    }
  }
}
