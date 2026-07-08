import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotificationProvider, RunNotificationInput } from '../../core/notification.js';
import type { ForgeProvider, Json, RunRecord } from '../../core/types.js';

export type FilesystemNotificationChannel = 'audit';

export interface FilesystemNotificationRecord {
  timestamp: string;
  channel: FilesystemNotificationChannel;
  event: RunNotificationInput['event'];
  message: string;
  task: { id: string; title: string; status: string };
  run?: { id: string; status: string; agentId: string; workspace?: RunRecord['workspace']; environment?: RunRecord['environment']; exitCode?: number; startedAt: string; updatedAt: string; finishedAt?: string; error?: string };
  metadata?: { [key: string]: Json };
}

export class FilesystemNotificationProvider implements NotificationProvider, ForgeProvider {
  id = 'notification.filesystem';
  kind = 'notification';

  constructor(private root = process.cwd(), private channel: FilesystemNotificationChannel = 'audit') {}

  async notifyRun(input: RunNotificationInput): Promise<void> {
    if (this.channel !== 'audit') return;
    const forgeDir = join(this.root, '.forge');
    await mkdir(forgeDir, { recursive: true });
    await appendFile(join(forgeDir, 'audit.log'), `${JSON.stringify(this.record(input))}\n`, 'utf8');
  }

  private record(input: RunNotificationInput): FilesystemNotificationRecord {
    return {
      timestamp: new Date().toISOString(),
      channel: this.channel,
      event: input.event,
      message: input.message,
      task: { id: input.task.id, title: input.task.title, status: input.task.status },
      run: input.run ? {
        id: input.run.id,
        status: input.run.status,
        agentId: input.run.agentId,
        workspace: input.run.workspace,
        environment: input.run.environment,
        exitCode: input.run.exitCode,
        startedAt: input.run.startedAt,
        updatedAt: input.run.updatedAt,
        finishedAt: input.run.finishedAt,
        error: input.run.error
      } : undefined,
      metadata: input.metadata
    };
  }
}
