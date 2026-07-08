import type { TaskDiscoveryMetadata, TaskDiscoveryProvider, TaskResourceScope } from '../../core/discovery.js';
import type { ForgeProvider, Task } from '../../core/types.js';
import { commandExists, runCommand } from '../../util/command.js';
import { extractJsonBlock } from '../planner-pi/index.js';

const scopeKinds: TaskResourceScope['kind'][] = ['path', 'provider', 'config', 'docs', 'tests', 'unknown'];
const confidences: TaskResourceScope['confidence'][] = ['low', 'medium', 'high'];

export class AgentSurveyTaskDiscoveryProvider implements ForgeProvider, TaskDiscoveryProvider {
  id = 'task-discovery.agent-survey';
  kind = 'task-discovery';

  constructor(private command = 'pi', private args: string[] = ['-p']) {}

  async discoverTask(input: { title: string; description?: string; complexity: Task['complexity'] }): Promise<TaskDiscoveryMetadata> {
    const discoveredAt = new Date().toISOString();
    try {
      if (!(await commandExists(this.command))) return this.fallback(discoveredAt, `Agent command '${this.command}' is unavailable.`);
      const result = await runCommand(this.command, [...this.args, this.prompt(input)]);
      if (result.exitCode !== 0) return this.fallback(discoveredAt, `Agent survey exited ${result.exitCode}.`);
      const block = extractJsonBlock(result.stdout, '{');
      if (!block) return this.fallback(discoveredAt, 'Agent survey returned no JSON discovery response.');
      const parsed = JSON.parse(block) as { resourceScopes?: unknown };
      const scopes = Array.isArray(parsed.resourceScopes) ? parsed.resourceScopes.map(scope => this.normalizeScope(scope)).filter((scope): scope is TaskResourceScope => !!scope).slice(0, 12) : [];
      return { providerId: this.id, discoveredAt, resourceScopes: scopes.length ? scopes : [this.unknown('Agent survey returned no usable resource scopes.')] };
    } catch (error) {
      return this.fallback(discoveredAt, `Agent survey failed safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private prompt(input: { title: string; description?: string; complexity: Task['complexity'] }) {
    return `You are helping Forge discover likely resource scopes before a coding task runs. Identify only likely areas the task may need to read or edit. Do not execute the task. Prefer concrete repository paths when implied, otherwise use provider-neutral scopes.

Task title: ${input.title}
Complexity: ${input.complexity}
${input.description ? `Description:\n${input.description}\n` : ''}
Allowed scope kind values: path, provider, config, docs, tests, unknown.
Allowed confidence values: low, medium, high.

Respond with ONLY JSON in this shape:
{"resourceScopes":[{"kind":"path","value":"src/example.ts","confidence":"medium","reason":"short reason"}]}
Return an unknown scope if there is not enough information.`;
  }

  private fallback(discoveredAt: string, reason: string): TaskDiscoveryMetadata {
    return { providerId: this.id, discoveredAt, resourceScopes: [this.unknown(reason)] };
  }

  private unknown(reason: string): TaskResourceScope {
    return { kind: 'unknown', value: '*', confidence: 'low', reason };
  }

  private normalizeScope(raw: unknown): TaskResourceScope | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const kind = typeof record.kind === 'string' && scopeKinds.includes(record.kind as TaskResourceScope['kind']) ? record.kind as TaskResourceScope['kind'] : 'unknown';
    const value = typeof record.value === 'string' && record.value.trim() ? record.value.trim() : kind === 'unknown' ? '*' : '';
    if (!value) return null;
    const confidence = typeof record.confidence === 'string' && confidences.includes(record.confidence as TaskResourceScope['confidence']) ? record.confidence as TaskResourceScope['confidence'] : 'low';
    const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'Agent survey identified this as a likely resource scope.';
    return { kind, value, confidence, reason };
  }
}
