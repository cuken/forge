import type { SpecPlan, SpecProvider } from '../../core/spec.js';
import type { Task } from '../../core/types.js';
import { runCommand } from '../../util/command.js';

export class PiSpecProvider implements SpecProvider {
  id = 'spec.pi';
  kind = 'spec' as const;
  constructor(private command = 'pi', private args: string[] = ['-p']) {}

  async generateSpec(input: { task: Task; context?: string }): Promise<SpecPlan> {
    const output = await this.runPi(this.prompt(input));
    const body = this.extractMarkdown(output, input.task);
    return { providerId: this.id, body };
  }

  private async runPi(prompt: string): Promise<string> {
    const result = await runCommand(this.command, [...this.args, prompt]);
    if (result.exitCode !== 0) throw new Error(`${this.command} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  private prompt(input: { task: Task; context?: string }) {
    return `You are writing a Forge task specification for an implementation agent. Forge is provider-neutral orchestration; core owns contracts and workflow, providers own external behavior.\n\nTask title: ${input.task.title}\nComplexity: ${input.task.complexity}\n${input.task.description ? `Description:\n${input.task.description}\n` : ''}${input.task.discovery?.resourceScopes.length ? `Likely resource scopes:\n${input.task.discovery.resourceScopes.map(scope => `- ${scope.kind}:${scope.value} (${scope.confidence}) ${scope.reason}`).join('\n')}\n` : ''}${input.context ? `Project context:\n${input.context}\n` : ''}\nWrite a concise but actionable Markdown spec. Include:\n- Goal\n- Non-goals / boundaries\n- Design notes respecting provider boundaries\n- Implementation steps\n- Tests and docs required\n- Acceptance criteria\n\nRespond with Markdown only. Do not wrap in code fences.`;
  }

  private extractMarkdown(output: string, task: Task) {
    const trimmed = output.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```$/i, '').trim();
    return trimmed || `# Spec: ${task.title}\n\n${task.description ?? task.title}\n`;
  }
}
