import type { ForgeProvider, RunRecord, Task } from './types.js';

export interface CleanupItem {
  id: string;
  kind: 'run-record' | 'run-log' | 'workspace' | 'branch';
  path?: string;
  ref?: string;
  reason: string;
  removed: boolean;
}

export interface CleanupResult {
  dryRun: boolean;
  items: CleanupItem[];
}

export interface RunCleanupStore extends ForgeProvider {
  cleanupRuns(input: { statuses?: RunRecord['status'][]; dryRun?: boolean }): Promise<CleanupResult>;
}

export function hasRunCleanup(provider: unknown): provider is RunCleanupStore {
  return !!provider && typeof (provider as RunCleanupStore).cleanupRuns === 'function';
}

export interface WorkspaceCleanupProvider extends ForgeProvider {
  cleanupWorkspaces(input: { tasks: Task[]; runs: RunRecord[]; dryRun?: boolean }): Promise<CleanupResult>;
}

export function hasWorkspaceCleanup(provider: unknown): provider is WorkspaceCleanupProvider {
  return !!provider && typeof (provider as WorkspaceCleanupProvider).cleanupWorkspaces === 'function';
}
