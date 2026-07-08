import type { RunRecord, Task } from './types.js';

export type RunNotificationEvent =
  | 'run.started'
  | 'run.workspace-created'
  | 'run.environment-prepared'
  | 'run.deferred'
  | 'run.succeeded'
  | 'run.failed';

export interface RunNotificationInput {
  event: RunNotificationEvent;
  task: Task;
  run?: RunRecord;
  message: string;
}

export interface NotificationProvider {
  notifyRun(input: RunNotificationInput): Promise<void>;
}

export function hasNotification(value: unknown): value is NotificationProvider {
  return typeof value === 'object' && value !== null && typeof (value as { notifyRun?: unknown }).notifyRun === 'function';
}
