import type { TaskResourceScope } from './discovery.js';
import type { ForgeProvider, Task } from './types.js';

export interface LeaseHandle {
  providerId: string;
  id: string;
  taskId: string;
  scopes: TaskResourceScope[];
  acquiredAt: string;
}

export interface LeaseProvider extends ForgeProvider {
  kind: 'lease';
  acquire(input: { task: Task; scopes: TaskResourceScope[] }): Promise<LeaseHandle>;
  release(lease: LeaseHandle): Promise<void>;
}

export function hasLease(value: unknown): value is LeaseProvider {
  return typeof value === 'object' && value !== null &&
    'acquire' in value && typeof (value as { acquire?: unknown }).acquire === 'function' &&
    'release' in value && typeof (value as { release?: unknown }).release === 'function';
}

export function leaseScopeKey(scope: TaskResourceScope): string {
  return `${scope.kind}:${scope.value}`;
}
