import { describe, expect, it } from 'vitest';
import { DockerIsolationProvider } from '../src/providers/isolation-docker/index.js';
import type { Task } from '../src/core/types.js';

const task: Task = {
  id: 'Task 123',
  title: 'Docker isolation',
  status: 'running',
  complexity: 'small',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  contextRefs: [],
};

const workspace = { id: 'ws-1', path: '/tmp/forge ws', branch: 'forge/task-123' };

describe('DockerIsolationProvider', () => {
  it('creates, starts, describes, and cleans up a Docker execution environment', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const provider = new DockerIsolationProvider({
      image: 'forge-agent:test',
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'create') return { exitCode: 0, stdout: 'container-123\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const environment = await provider.prepare({ task, workspace });
    await provider.cleanup(environment);

    expect(environment).toMatchObject({
      id: 'isolation.docker:container-123',
      kind: 'container',
      workspacePath: '/workspace',
      metadata: {
        containerId: 'container-123',
        image: 'forge-agent:test',
        hostWorkspacePath: '/tmp/forge ws',
        containerWorkspacePath: '/workspace',
        branch: 'forge/task-123',
        network: 'disabled',
        writable: 'true',
      },
    });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      'create',
      '--label', 'forge.provider=isolation.docker',
      '--label', 'forge.task=Task 123',
      '--workdir', '/workspace',
      '--volume', '/tmp/forge ws:/workspace:rw',
      '--network', 'none',
      'forge-agent:test',
      'sleep',
      'infinity',
    ]));
    expect(calls[1]).toEqual({ command: 'docker', args: ['start', 'container-123'] });
    expect(calls[2]).toEqual({ command: 'docker', args: ['rm', '-f', 'container-123'] });
  });

  it('honors writable and network isolation policy when preparing Docker arguments', async () => {
    const calls: string[][] = [];
    const provider = new DockerIsolationProvider({
      run: async (_command, args) => {
        calls.push(args);
        return args[0] === 'create'
          ? { exitCode: 0, stdout: 'container-readonly\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await provider.prepare({ task, workspace, policy: { writable: false, network: 'inherit' } });

    expect(calls[0]).toContain('/tmp/forge ws:/workspace:ro');
    expect(calls[0]).not.toContain('--network');
    expect(calls[0]).not.toContain('none');
  });

  it('reports Docker daemon health through provider-declared doctor checks', async () => {
    const provider = new DockerIsolationProvider({
      run: async () => ({ exitCode: 0, stdout: '27.0.0\n', stderr: '' }),
    });

    await expect(provider.checks()[0].run()).resolves.toEqual({
      id: 'isolation.docker:daemon',
      status: 'pass',
      message: 'docker daemon available (27.0.0)',
    });
  });

  it('removes a created container if Docker start fails', async () => {
    const calls: string[][] = [];
    const provider = new DockerIsolationProvider({
      run: async (_command, args) => {
        calls.push(args);
        if (args[0] === 'create') return { exitCode: 0, stdout: 'container-stopped\n', stderr: '' };
        if (args[0] === 'start') return { exitCode: 1, stdout: '', stderr: 'cannot start' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await expect(provider.prepare({ task, workspace })).rejects.toThrow('docker container start failed: cannot start');
    expect(calls.at(-1)).toEqual(['rm', '-f', 'container-stopped']);
  });
});
