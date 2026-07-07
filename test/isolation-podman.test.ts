import { describe, expect, it } from 'vitest';
import { PodmanIsolationProvider, type PodmanCommandRunner } from '../src/providers/isolation-podman/index.js';
import type { Task } from '../src/core/types.js';

const task: Task = {
  id: 'TASK-123',
  title: 'Podman isolate',
  status: 'ready',
  complexity: 'small',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  contextRefs: [],
};

function fakeRunner() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: PodmanCommandRunner = async (command, args = []) => {
    calls.push({ command, args });
    if (args[0] === 'create') return { exitCode: 0, stdout: 'container-abc123\n', stderr: '' };
    if (args[0] === 'start') return { exitCode: 0, stdout: 'container-abc123\n', stderr: '' };
    if (args[0] === 'rm') return { exitCode: 0, stdout: 'container-abc123\n', stderr: '' };
    if (args[0] === '--version') return { exitCode: 0, stdout: 'podman version 5.0.0\n', stderr: '' };
    if (args[0] === 'info') return { exitCode: 0, stdout: 'crun\n', stderr: '' };
    if (args[0] === 'image') return { exitCode: 1, stdout: '', stderr: 'not found' };
    return { exitCode: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { calls, runner };
}

describe('PodmanIsolationProvider', () => {
  it('creates, starts, describes, and cleans up a podman container for a workspace', async () => {
    const { calls, runner } = fakeRunner();
    const provider = new PodmanIsolationProvider({ runner, image: 'forge-agent:latest' });

    const env = await provider.prepare({
      task,
      workspace: { id: 'ws-1', path: '/tmp/forge/ws-1', branch: 'forge/task-123' },
      policy: { network: 'disabled', writable: false },
    });
    await provider.cleanup(env);

    expect(env).toMatchObject({
      kind: 'container',
      workspacePath: '/tmp/forge/ws-1',
      metadata: {
        containerId: 'container-abc123',
        image: 'forge-agent:latest',
        containerWorkspacePath: '/workspace',
        network: 'disabled',
        writable: 'false',
      },
    });
    expect(calls[0].args).toContain('--volume');
    expect(calls[0].args).toContain('/tmp/forge/ws-1:/workspace:ro');
    expect(calls[0].args).toContain('--network');
    expect(calls[0].args).toContain('none');
    expect(calls[0].args.at(-3)).toBe('forge-agent:latest');
    expect(calls.map(call => call.args[0])).toEqual(['create', 'start', 'rm']);
    expect(calls[2].args).toEqual(['rm', '-f', 'container-abc123']);
  });

  it('reports provider-declared podman health checks', async () => {
    const { runner } = fakeRunner();
    const provider = new PodmanIsolationProvider({ runner, image: 'missing:latest' });

    await expect(Promise.all(provider.checks().map(check => check.run()))).resolves.toEqual([
      { id: 'isolation.podman:binary', status: 'pass', message: 'podman version 5.0.0' },
      { id: 'isolation.podman:engine', status: 'pass', message: 'podman engine available (crun)' },
      { id: 'isolation.podman:image', status: 'warn', message: 'missing:latest is not present locally; podman may pull it when preparing isolation', detail: 'not found' },
    ]);
  });
});
