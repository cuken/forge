import type { DoctorProvider } from '../../core/health.js';
import type { ExecutionEnvironment, IsolationProvider, WorkspaceRef } from '../../core/isolation.js';
import type { Task } from '../../core/types.js';

export class HostIsolationProvider implements IsolationProvider, DoctorProvider {
  id = 'isolation.host';
  kind = 'isolation' as const;

  async prepare(input: { task: Task; workspace: WorkspaceRef }): Promise<ExecutionEnvironment> {
    return {
      id: `${this.id}:${input.workspace.id}`,
      kind: 'host',
      workspacePath: input.workspace.path,
      description: 'Host process isolation: agent runs directly in the git worktree on this machine.',
      metadata: { branch: input.workspace.branch },
    };
  }

  checks(input: { scope?: 'host' | 'workspace' } = {}) {
    if (input.scope === 'workspace') return [];
    return [{
      id: `${this.id}:available`,
      label: 'Host isolation available',
      run: async () => ({ id: `${this.id}:available`, status: 'warn' as const, message: 'host isolation is available but does not sandbox process execution' }),
    }];
  }
}
