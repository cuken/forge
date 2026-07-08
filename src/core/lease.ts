import type { TaskResourceScope } from './discovery.js';
import type { ForgeProvider, Task } from './types.js';

export interface LeaseHandle {
  providerId: string;
  id: string;
  taskId: string;
  scopes: TaskResourceScope[];
  acquiredAt: string;
}

export interface LeaseStatusEntry {
  providerId: string;
  id: string;
  taskId: string;
  scope: TaskResourceScope;
  acquiredAt: string;
  heartbeatAt?: string;
  staleAt?: string;
}

export interface LeaseProvider extends ForgeProvider {
  kind: 'lease';
  acquire(input: { task: Task; scopes: TaskResourceScope[] }): Promise<LeaseHandle>;
  release(lease: LeaseHandle): Promise<void>;
  status?(): Promise<LeaseStatusEntry[]>;
  cleanupStale?(): Promise<number>;
}

export function hasLease(value: unknown): value is LeaseProvider {
  return typeof value === 'object' && value !== null &&
    'acquire' in value && typeof (value as { acquire?: unknown }).acquire === 'function' &&
    'release' in value && typeof (value as { release?: unknown }).release === 'function';
}

// Providers throw this for expected contention (scope held elsewhere); the runtime waits and
// retries only on this error. Any other acquire error is a provider failure and fails the task.
export class LeaseConflictError extends Error {
  constructor(message: string, public scopeKey?: string, public ownerTaskId?: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export function leaseScopeKey(scope: TaskResourceScope): string {
  return `${scope.kind}:${scope.value.trim().replace(/\/+$/, '')}`;
}
