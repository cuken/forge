import type { AcceptChangeSetResult } from './changes.js';
import type { SyncInput, SyncResult } from './sync.js';
import type { ForgeProvider, Json, RunRecord, Task } from './types.js';

export type LifecycleHookEvent = 'run.accepted' | 'task.succeeded' | 'task.failed' | 'sync.completed';

export interface LifecycleIdentity {
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  workstreamItemId?: string;
}

export interface LifecycleCommitContext {
  providerId?: string;
  status?: 'accepted' | 'empty' | 'blocked' | 'merge-conflict';
  message?: string;
  dryRun?: boolean;
}

export interface LifecycleSyncContext {
  message?: string;
  dryRun?: boolean;
  results?: SyncResult[];
}

export interface LifecycleHookPayload {
  event: LifecycleHookEvent;
  occurredAt: string;
  identity: LifecycleIdentity;
  task?: Pick<Task, 'id' | 'title' | 'status' | 'complexity' | 'targetRelease'>;
  run?: Pick<RunRecord, 'id' | 'status' | 'startedAt' | 'finishedAt' | 'exitCode' | 'error' | 'workspace' | 'environment'>;
  commit?: LifecycleCommitContext;
  sync?: LifecycleSyncContext;
  metadata?: Record<string, Json>;
}

export interface LifecycleHookProvider {
  lifecycleHook(input: LifecycleHookPayload): Promise<void>;
}

export function hasLifecycleHooks(value: unknown): value is LifecycleHookProvider {
  return typeof value === 'object' && value !== null && 'lifecycleHook' in value && typeof (value as { lifecycleHook?: unknown }).lifecycleHook === 'function';
}

export function buildLifecyclePayload(input: { event: LifecycleHookEvent; task?: Task; run?: RunRecord; acceptance?: AcceptChangeSetResult | RunRecord['acceptance']; sync?: { input?: SyncInput; results?: SyncResult[] }; occurredAt?: string; metadata?: Record<string, Json> }): LifecycleHookPayload {
  const workstreamItemId = input.task ? workstreamItemIdFromTask(input.task) : undefined;
  return {
    event: input.event,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    identity: {
      runId: input.run?.id,
      taskId: input.task?.id ?? input.run?.taskId,
      taskTitle: input.task?.title ?? input.run?.taskTitle,
      workstreamItemId,
    },
    task: input.task ? { id: input.task.id, title: input.task.title, status: input.task.status, complexity: input.task.complexity, targetRelease: input.task.targetRelease } : undefined,
    run: input.run ? { id: input.run.id, status: input.run.status, startedAt: input.run.startedAt, finishedAt: input.run.finishedAt, exitCode: input.run.exitCode, error: input.run.error, workspace: input.run.workspace, environment: input.run.environment } : undefined,
    commit: input.acceptance ? { providerId: input.acceptance.providerId, status: input.acceptance.status, message: input.acceptance.message, dryRun: 'dryRun' in input.acceptance ? input.acceptance.dryRun : undefined } : undefined,
    sync: input.sync ? { message: input.sync.input?.message, dryRun: input.sync.input?.dryRun, results: input.sync.results } : undefined,
    metadata: input.metadata,
  };
}

function workstreamItemIdFromTask(task: Task): string | undefined {
  const match = task.description?.match(/^Workstream item:\s*(.+)$/m);
  return match?.[1]?.trim();
}
