import type { TaskDiscoveryMetadata, TaskDiscoveryProvider, TaskResourceScope } from '../../core/discovery.js';
import type { ForgeProvider, Task } from '../../core/types.js';

export class HeuristicTaskDiscoveryProvider implements ForgeProvider, TaskDiscoveryProvider {
  id = 'task-discovery.heuristic';
  kind = 'task-discovery';

  async discoverTask(input: { title: string; description?: string; complexity: Task['complexity'] }): Promise<TaskDiscoveryMetadata> {
    const text = `${input.title}\n${input.description ?? ''}`;
    const scopes = this.scopesFor(input.title, text);
    return { providerId: this.id, discoveredAt: new Date().toISOString(), resourceScopes: scopes.length ? scopes : [{ kind: 'unknown', value: '*', confidence: 'low', reason: 'No resource-specific terms were recognized.' }] };
  }

  private scopesFor(title: string, text: string): TaskResourceScope[] {
    const lower = title.toLowerCase();
    const scopes: TaskResourceScope[] = [];
    const add = (scope: TaskResourceScope) => {
      if (!scopes.some(existing => existing.kind === scope.kind && existing.value === scope.value)) scopes.push(scope);
    };

    const pathMatches = text.match(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|json|md|toml|yml|yaml))\b/g) ?? [];
    for (const match of pathMatches) add({ kind: 'path', value: match.trim(), confidence: 'high', reason: 'Explicit file path mentioned in task text.' });

    if (/\b(provider|providers|capability|capabilities)\b/.test(lower)) add({ kind: 'provider', value: 'src/providers', confidence: 'medium', reason: 'Task mentions providers or capabilities.' });
    if (/\b(config|configuration|schema|toml|json)\b/.test(lower)) add({ kind: 'config', value: '.forge/config.json', confidence: 'medium', reason: 'Task mentions configuration or schema concerns.' });
    if (/\b(doc|docs|readme|documentation|document)\b/.test(lower)) add({ kind: 'docs', value: 'docs', confidence: 'medium', reason: 'Task title mentions documentation.' });
    if (/\b(test|tests|vitest|coverage)\b/.test(lower)) add({ kind: 'tests', value: 'test', confidence: 'medium', reason: 'Task title mentions tests or validation.' });
    if (/\b(task|tasks|store|metadata|resource scope|resource scopes|discovery)\b/.test(lower)) add({ kind: 'path', value: 'src/core/types.ts', confidence: 'medium', reason: 'Task mentions task metadata, discovery, or resource scopes.' });

    return scopes;
  }
}
