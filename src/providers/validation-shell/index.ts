import { runCommand } from '../../util/command.js';
import type { ForgeProvider, RunRecord } from '../../core/types.js';
import type { ValidationGateResult, ValidationProvider } from '../../core/validation.js';

export class ShellValidationProvider implements ForgeProvider, ValidationProvider {
  id = 'validation.shell';
  kind = 'validation';
  constructor(private commands: string[] = []) {}

  async validate(input: { run: RunRecord }): Promise<ValidationGateResult[]> {
    const cwd = input.run.workspace?.path;
    if (!cwd) return [{ id: 'validation.shell:workspace', status: 'fail', message: 'run has no workspace path' }];
    const results: ValidationGateResult[] = [];
    for (const [index, command] of this.commands.entries()) {
      const result = await runCommand(command, [], { cwd, shell: true });
      const output = `${result.stdout}${result.stderr}`.trim();
      results.push({
        id: `validation.shell:${index + 1}`,
        status: result.exitCode === 0 ? 'pass' : 'fail',
        message: `${command} exited ${result.exitCode}`,
        detail: output || undefined,
      });
    }
    return results;
  }
}
