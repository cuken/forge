import type { BuildPlannerProvider, BuildRequest } from '../../core/build.js';
import type { ForgeProvider, Task } from '../../core/types.js';

export class HeuristicBuildPlannerProvider implements ForgeProvider, BuildPlannerProvider {
  id = 'build-planner.heuristic';
  kind = 'build-planner';

  async planBuild(input: BuildRequest) {
    const prompt = input.prompt.trim();
    const complexity = this.estimateComplexity(prompt);
    const requiresSpec = complexity === 'medium' || complexity === 'large';
    const title = input.taskName ?? this.titleFromPrompt(prompt);
    return {
      title,
      description: prompt,
      complexity,
      requiresSpec,
      reason: requiresSpec
        ? 'Task appears to affect architecture, configuration, providers, storage, or multiple files; spec approval is required before execution.'
        : 'Task appears narrow enough for a direct implementation run.',
      specBody: requiresSpec ? this.specFor(title, prompt, complexity) : undefined,
    };
  }

  private estimateComplexity(prompt: string): Task['complexity'] {
    const text = prompt.toLowerCase();
    const highRisk = ['architecture', 'provider', 'providers', 'config', 'configuration', 'schema', 'migration', 'storage', 'workflow', 'gate', 'memory', 'index', 'toml', 'json', 'sync', 'workspace'];
    const mediumHits = highRisk.filter(word => text.includes(word)).length;
    if (text.length > 280 || mediumHits >= 2) return 'large';
    if (text.length > 140 || mediumHits === 1 || /\b(add|replace|migrate|support|honou?r|integrate)\b/.test(text)) return 'medium';
    if (/\b(fix|typo|readme|docs?)\b/.test(text)) return 'small';
    return 'small';
  }

  private titleFromPrompt(prompt: string) {
    return prompt.replace(/^forge\s+build\s+/i, '').replace(/[.\n]+$/g, '').slice(0, 96) || 'Forge build task';
  }

  private specFor(title: string, prompt: string, complexity: Task['complexity']) {
    return `# Spec: ${title}\n\n## Request\n\n${prompt}\n\n## Complexity\n\n${complexity}\n\n## Proposed flow\n\n1. Confirm current behavior and relevant provider boundaries.\n2. Implement the smallest provider-neutral change.\n3. Add or update meaningful tests.\n4. Update Forge docs and agent instructions if behavior changes.\n5. Run \`npm test\`, \`npm run build\`, and \`forge doctor\`.\n\n## Approval\n\nApprove this spec before implementation unless the caller passed an explicit auto-approval flag.\n`;
  }
}
