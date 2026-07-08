import type { NotificationProvider, RunNotificationInput } from '../../core/notification.js';
import type { ForgeProvider } from '../../core/types.js';

export type ConsoleNotificationChannel = 'stdout' | 'stderr';

export class ConsoleNotificationProvider implements NotificationProvider, ForgeProvider {
  id = 'notification.console';
  kind = 'notification';

  constructor(private channel: ConsoleNotificationChannel = 'stderr') {}

  async notifyRun(input: RunNotificationInput): Promise<void> {
    const line = `[forge:${input.event}] ${input.message}`;
    if (this.channel === 'stdout') process.stdout.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  }
}
