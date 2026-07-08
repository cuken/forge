import type { DoctorProvider, HealthCheck } from '../../core/health.js';
import type { NotificationProvider, RunNotificationInput } from '../../core/notification.js';
import type { ForgeProvider } from '../../core/types.js';

export type ConsoleNotificationChannel = 'stdout' | 'stderr';

export class ConsoleNotificationProvider implements NotificationProvider, ForgeProvider, DoctorProvider {
  id = 'notification.console';
  kind = 'notification';

  constructor(private channel: ConsoleNotificationChannel = 'stderr') {}

  checks(): HealthCheck[] {
    return [{ id: `${this.id}:channel`, label: 'Console notification channel', run: async () => {
      const stream = this.channel === 'stdout' ? process.stdout : this.channel === 'stderr' ? process.stderr : undefined;
      if (!stream) return { id: `${this.id}:channel`, status: 'fail' as const, message: `unknown console notification channel '${this.channel}'` };
      return stream.writable ? { id: `${this.id}:channel`, status: 'pass' as const, message: `${this.channel} notification channel is writable` } : { id: `${this.id}:channel`, status: 'fail' as const, message: `${this.channel} notification channel is not writable` };
    } }];
  }

  async notifyRun(input: RunNotificationInput): Promise<void> {
    const line = `[forge:${input.event}] ${input.message}`;
    if (this.channel === 'stdout') process.stdout.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  }
}
