import type { DoctorProvider, HealthCheck } from '../../core/health.js';
import type { ExecutionEnvironment, IsolationPolicy, IsolationProvider, WorkspaceRef } from '../../core/isolation.js';
import type { Task } from '../../core/types.js';
import { runCommand } from '../../util/command.js';

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type DockerCommandRunner = (command: string, args: string[], options?: { cwd?: string; shell?: boolean }) => Promise<CommandResult>;

export interface DockerIsolationOptions {
  command?: string;
  image?: string;
  mountPath?: string;
  containerPrefix?: string;
  user?: string;
  extraCreateArgs?: string[];
  run?: DockerCommandRunner;
}

export class DockerIsolationProvider implements IsolationProvider, DoctorProvider {
  id = 'isolation.docker';
  kind = 'isolation' as const;
  private command: string;
  private image: string;
  private mountPath: string;
  private containerPrefix: string;
  private user?: string;
  private extraCreateArgs: string[];
  private run: DockerCommandRunner;

  constructor(options: DockerIsolationOptions = {}) {
    this.command = options.command ?? 'docker';
    this.image = options.image ?? 'node:22-bookworm';
    this.mountPath = options.mountPath ?? '/workspace';
    this.containerPrefix = options.containerPrefix ?? 'forge';
    this.user = options.user;
    this.extraCreateArgs = options.extraCreateArgs ?? [];
    this.run = options.run ?? runCommand;
  }

  async prepare(input: { task: Task; workspace: WorkspaceRef; policy?: IsolationPolicy }): Promise<ExecutionEnvironment> {
    const writable = input.policy?.writable ?? true;
    const requestedNetwork = input.policy?.network ?? 'disabled';
    const dockerNetwork = requestedNetwork === 'inherit' ? undefined : 'none';
    const containerName = this.containerName(input.task.id);
    const volumeMode = writable ? 'rw' : 'ro';
    const args = [
      'create',
      '--name', containerName,
      '--label', `forge.provider=${this.id}`,
      '--label', `forge.task=${input.task.id}`,
      '--workdir', this.mountPath,
      '--volume', `${input.workspace.path}:${this.mountPath}:${volumeMode}`,
    ];
    if (dockerNetwork) args.push('--network', dockerNetwork);
    if (this.user) args.push('--user', this.user);
    args.push(...this.extraCreateArgs, this.image, 'sleep', 'infinity');

    const create = await this.run(this.command, args);
    if (create.exitCode !== 0) {
      throw new Error(`docker container creation failed: ${(create.stderr || create.stdout).trim()}`);
    }
    const containerId = create.stdout.trim().split(/\s+/)[0] || containerName;

    const start = await this.run(this.command, ['start', containerId]);
    if (start.exitCode !== 0) {
      await this.run(this.command, ['rm', '-f', containerId]);
      throw new Error(`docker container start failed: ${(start.stderr || start.stdout).trim()}`);
    }

    return {
      id: `${this.id}:${containerId}`,
      kind: 'container',
      workspacePath: this.mountPath,
      description: `Docker container ${containerId} from ${this.image} with workspace mounted at ${this.mountPath}.`,
      metadata: {
        containerId,
        containerName,
        image: this.image,
        hostWorkspacePath: input.workspace.path,
        containerWorkspacePath: this.mountPath,
        branch: input.workspace.branch,
        network: requestedNetwork,
        writable: String(writable),
      },
    };
  }

  async cleanup(environment: ExecutionEnvironment): Promise<void> {
    const containerId = environment.metadata?.containerId;
    if (!containerId) return;
    const result = await this.run(this.command, ['rm', '-f', containerId]);
    if (result.exitCode !== 0) {
      throw new Error(`docker container cleanup failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  checks(): HealthCheck[] {
    return [{
      id: `${this.id}:daemon`,
      label: 'Docker daemon',
      run: async () => {
        const result = await this.run(this.command, ['version', '--format', '{{.Server.Version}}']);
        if (result.exitCode === 0) {
          return { id: `${this.id}:daemon`, status: 'pass' as const, message: `docker daemon available${result.stdout.trim() ? ` (${result.stdout.trim()})` : ''}` };
        }
        return { id: `${this.id}:daemon`, status: 'fail' as const, message: 'docker daemon is not available', detail: result.stderr || result.stdout };
      },
    }];
  }

  private containerName(taskId: string) {
    const safeTaskId = taskId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
    return `${this.containerPrefix}-${safeTaskId}-${Date.now().toString(36)}`;
  }
}
