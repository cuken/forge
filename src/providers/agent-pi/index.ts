import { spawn } from 'node:child_process';
import type { ExecutionEnvironment } from '../../core/isolation.js';
import type { DoctorProvider } from '../../core/health.js';
import type { AgentProvider, Task } from '../../core/types.js';
import { commandExists, runCommand } from '../../util/command.js';

export class PiAgentProvider implements AgentProvider, DoctorProvider {
  id = 'agent.pi';
  kind = 'agent' as const;
  constructor(private command = 'pi', private args: string[] = []) {}
  checks() {
    return [
      { id: `${this.id}:binary`, label: 'pi binary', run: async () => (await commandExists(this.command)) ? { id: `${this.id}:binary`, status: 'pass' as const, message: `${this.command} is available` } : { id: `${this.id}:binary`, status: 'fail' as const, message: `${this.command} is not available` } },
      { id: `${this.id}:version`, label: 'pi version', run: async () => { const r = await runCommand(this.command, ['--version']); return r.exitCode === 0 ? { id: `${this.id}:version`, status: 'pass' as const, message: r.stdout.trim() || 'pi responded' } : { id: `${this.id}:version`, status: 'warn' as const, message: 'pi version check failed', detail: r.stderr || r.stdout }; } },
    ];
  }
  async run(input: { task: Task; workspacePath: string; context: string; environment?: ExecutionEnvironment; onOutput?: (chunk: string) => void }) {
    const prompt = `Forge task ${input.task.id}: ${input.task.title}\n\n${input.task.description ?? ''}\n\nContext:\n${input.context}`;
    if (input.environment?.execute) {
      return input.environment.execute({ command: this.command, args: [...this.args, prompt], cwd: input.workspacePath, onOutput: input.onOutput });
    }
    return await new Promise<{ exitCode: number; output: string }>((resolve) => {
      const child = spawn(this.command, [...this.args, prompt], { cwd: input.workspacePath, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => { const text = d.toString(); output += text; input.onOutput?.(text); });
      child.stderr.on('data', d => { const text = d.toString(); output += text; input.onOutput?.(text); });
      child.on('close', code => resolve({ exitCode: code ?? 1, output }));
      child.on('error', err => resolve({ exitCode: 1, output: String(err) }));
    });
  }
}
