export type SyncStatus = 'changed' | 'unchanged' | 'blocked' | 'failed';

export interface SyncResult {
  id: string;
  status: SyncStatus;
  message: string;
  detail?: string;
}

export interface SyncTask {
  id: string;
  label: string;
  run(input: SyncInput): Promise<SyncResult>;
}

export interface SyncInput {
  message?: string;
  dryRun?: boolean;
}

export interface SyncProvider {
  syncTasks(): SyncTask[];
}

export function hasSync(value: unknown): value is SyncProvider {
  return typeof value === 'object' && value !== null && 'syncTasks' in value && typeof (value as { syncTasks?: unknown }).syncTasks === 'function';
}

export async function runSyncTasks(tasks: SyncTask[], input: SyncInput): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const task of tasks) {
    try {
      const result = await task.run(input);
      results.push(result);
      if (result.status === 'blocked' || result.status === 'failed') break;
    } catch (error) {
      results.push({ id: task.id, status: 'failed', message: `${task.label} failed`, detail: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return results;
}
