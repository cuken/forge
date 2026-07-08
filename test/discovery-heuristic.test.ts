import { describe, expect, it } from 'vitest';
import { HeuristicTaskDiscoveryProvider } from '../src/providers/discovery-heuristic/index.js';

const provider = new HeuristicTaskDiscoveryProvider();

describe('heuristic task discovery', () => {
  it('does not serialize every workstream task on generic documentation/test instructions in the description', async () => {
    const discovery = await provider.discoverTask({
      title: 'Add notification channel configuration to Forge config',
      description: 'Cover with tests and update docs. Follow AGENTS.md.',
      complexity: 'medium',
    });

    expect(discovery.resourceScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'config' }),
    ]));
    expect(discovery.resourceScopes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'docs', value: 'docs' }),
      expect.objectContaining({ kind: 'tests', value: 'test' }),
    ]));
  });

  it('still scopes documentation-focused tasks to docs', async () => {
    const discovery = await provider.discoverTask({ title: 'Document the notification workflow', complexity: 'small' });

    expect(discovery.resourceScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'docs', value: 'docs' }),
    ]));
  });
});
