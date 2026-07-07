import { createHash } from 'node:crypto';
import type { DoctorProvider } from '../../core/health.js';
import type { ExecutionEnvironment, IsolationPolicy, IsolationProvider, WorkspaceRef } from '../../core/isolation.js';
import type { Task } from '../../core/types.js';
import { runCommand } from '../../util/command.js';

export type PodmanCommandRunner = (command: string, args?: string[], options?: { cwd?: string; shell?: boolean }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface PodmanIsolationOptions {
  command?: string;
  image?: string;
  containerWorkspacePath?: string;
  namePrefix?: string;
  network?: IsolationPolicy['network'];
  writable?: boolean;
  createArgs?: string[];
  volumeOptions?: string[];
  keepAliveCommand?: string[];
  setupCommands?: string[][];
  readyCommand?: string[];
  readyAttempts?: number;
  readyDelayMs?: number;
  runner?: PodmanCommandRunner;
}

export class PodmanIsolationProvider implements IsolationProvider, DoctorProvider {
  id = 'isolation.podman';
  kind = 'isolation' as const;
  private command: string;
  private image: string;
  private containerWorkspacePath: string;
  private namePrefix: string;
  private runner: PodmanCommandRunner;

  constructor(private options: PodmanIsolationOptions = {}) {
    this.command = options.command ?? 'podman';
    this.image = options.image ?? 'localhost/forge-agent-pi:latest';
    this.containerWorkspacePath = options.containerWorkspacePath ?? '/workspace';
    this.namePrefix = options.namePrefix ?? 'forge-';
    this.runner = options.runner ?? runCommand;
  }

  async prepare(input: { task: Task; workspace: WorkspaceRef; policy?: IsolationPolicy }): Promise<ExecutionEnvironment> {
    const containerName = this.containerName(input.task, input.workspace);
    const network = input.policy?.network ?? this.options.network ?? 'restricted';
    const writable = input.policy?.writable ?? this.options.writable ?? true;
    const volumeMode = [writable ? 'rw' : 'ro', ...(this.options.volumeOptions ?? ['Z'])].join(',');
    const createArgs = [
      'create',
      '--name', containerName,
      '--workdir', this.containerWorkspacePath,
      '--volume', `${input.workspace.path}:${this.containerWorkspacePath}:${volumeMode}`,
      '--label', `org.forge.task=${input.task.id}`,
      '--label', `org.forge.workspace=${input.workspace.id}`,
    ];

    if (network === 'disabled') createArgs.push('--network', 'none');
    if (network === 'inherit') createArgs.push('--network', 'host');

    createArgs.push(...(this.options.createArgs ?? []), this.image, ...(this.options.keepAliveCommand ?? ['sleep', 'infinity']));

    const created = await this.runner(this.command, createArgs);
    if (created.exitCode !== 0) throw new Error(`podman create failed: ${(created.stderr || created.stdout).trim()}`);
    const containerId = created.stdout.trim().split(/\s+/)[0] || containerName;

    const started = await this.runner(this.command, ['start', containerId]);
    if (started.exitCode !== 0) {
      await this.runner(this.command, ['rm', '-f', containerId]);
      throw new Error(`podman start failed: ${(started.stderr || started.stdout).trim()}`);
    }

    for (const setupCommand of this.options.setupCommands ?? []) {
      const setup = await this.runner(this.command, ['exec', '--workdir', this.containerWorkspacePath, containerId, ...setupCommand]);
      if (setup.exitCode !== 0) {
        await this.runner(this.command, ['rm', '-f', containerId]);
        throw new Error(`podman setup failed: ${(setup.stderr || setup.stdout).trim()}`);
      }
    }

    const readyCommand = this.options.readyCommand ?? ['sh', '-lc', 'command -v pi >/dev/null && command -v git >/dev/null && test -w .'];
    const attempts = this.options.readyAttempts ?? 10;
    const delayMs = this.options.readyDelayMs ?? 250;
    const ready = await this.waitUntilReady(containerId, readyCommand, attempts, delayMs);
    if (ready.exitCode !== 0) {
      await this.runner(this.command, ['rm', '-f', containerId]);
      throw new Error(`podman environment not ready after ${attempts} attempts: ${(ready.stderr || ready.stdout).trim()}`);
    }

    return {
      id: `${this.id}:${containerId}`,
      kind: 'container',
      workspacePath: this.containerWorkspacePath,
      description: `Podman container ${containerName} from ${this.image}; host workspace is mounted at ${this.containerWorkspacePath}.`,
      metadata: {
        containerId,
        containerName,
        image: this.image,
        hostWorkspacePath: input.workspace.path,
        containerWorkspacePath: this.containerWorkspacePath,
        branch: input.workspace.branch,
        network,
        writable: String(writable),
        readyCommand: readyCommand.join(' '),
        readyAttempts: String(attempts),
      },
      execute: async execInput => {
        const cwd = execInput.cwd ?? this.containerWorkspacePath;
        const result = await this.runner(this.command, ['exec', '--workdir', cwd, containerId, execInput.command, ...(execInput.args ?? [])]);
        const output = result.stdout + result.stderr;
        if (output) execInput.onOutput?.(output);
        return { exitCode: result.exitCode, output };
      },
    };
  }

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    const containerId = environment.metadata?.containerId ?? environment.id.replace(`${this.id}:`, '');
    const removed = await this.runner(this.command, ['rm', '-f', containerId]);
    if (removed.exitCode !== 0) throw new Error(`podman cleanup failed: ${(removed.stderr || removed.stdout).trim()}`);
  }

  checks() {
    return [
      {
        id: `${this.id}:binary`,
        label: 'Podman binary',
        run: async () => {
          const result = await this.runner(this.command, ['--version']);
          return result.exitCode === 0
            ? { id: `${this.id}:binary`, status: 'pass' as const, message: result.stdout.trim() || 'podman is available' }
            : { id: `${this.id}:binary`, status: 'fail' as const, message: `${this.command} is not available`, detail: result.stderr || result.stdout };
        },
      },
      {
        id: `${this.id}:engine`,
        label: 'Podman engine',
        run: async () => {
          const result = await this.runner(this.command, ['info', '--format', '{{.Host.OCIRuntime.Name}}']);
          return result.exitCode === 0
            ? { id: `${this.id}:engine`, status: 'pass' as const, message: `podman engine available${result.stdout.trim() ? ` (${result.stdout.trim()})` : ''}` }
            : { id: `${this.id}:engine`, status: 'fail' as const, message: 'podman engine is not available', detail: result.stderr || result.stdout };
        },
      },
      {
        id: `${this.id}:image`,
        label: 'Podman isolation image',
        run: async () => {
          const result = await this.runner(this.command, ['image', 'exists', this.image]);
          return result.exitCode === 0
            ? { id: `${this.id}:image`, status: 'pass' as const, message: `${this.image} is present locally` }
            : { id: `${this.id}:image`, status: 'warn' as const, message: `${this.image} is not present locally; build it with npm run podman:image or set FORGE_PODMAN_IMAGE`, detail: result.stderr || result.stdout };
        },
      },
    ];
  }

  private async waitUntilReady(containerId: string, readyCommand: string[], attempts: number, delayMs: number) {
    let last = { exitCode: 1, stdout: '', stderr: 'not checked' };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      last = await this.runner(this.command, ['exec', '--workdir', this.containerWorkspacePath, containerId, ...readyCommand]);
      if (last.exitCode === 0) return last;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return last;
  }

  private containerName(task: Task, workspace: WorkspaceRef) {
    const hash = createHash('sha256').update(`${task.id}:${workspace.id}:${workspace.path}`).digest('hex').slice(0, 12);
    const safeTaskId = task.id.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 32) || 'task';
    return `${this.namePrefix}${safeTaskId}-${hash}`;
  }
}
