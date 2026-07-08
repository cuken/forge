import { spawn } from 'node:child_process';

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export async function commandExists(command: string): Promise<boolean> {
  const result = process.platform === 'win32'
    ? await runCommand('where', [command])
    : await runCommand('sh', ['-c', `command -v ${JSON.stringify(command)}`]);
  return result.exitCode === 0;
}

export async function runCommand(command: string, args: string[] = [], options: { cwd?: string; shell?: boolean } = {}) {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: options.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', err => resolve({ exitCode: 1, stdout, stderr: String(err) }));
  });
}
