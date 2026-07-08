import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { defaultProviderRegistry } from '../src/cli.js';
import type { ForgeProvider } from '../src/core/types.js';

class FakeProvider implements ForgeProvider {
  id = 'fake.alpha';
  kind = 'fake';
}

describe('ProviderRegistry', () => {
  it('looks up providers by canonical id and alias', () => {
    const registry = new ProviderRegistry().register({ kind: 'fake', id: 'fake.alpha', aliases: ['alpha'], create: () => new FakeProvider() });

    expect(registry.create('fake', 'fake.alpha').id).toBe('fake.alpha');
    expect(registry.create('fake', 'alpha').id).toBe('fake.alpha');
  });

  it('fails clearly for unknown providers', () => {
    const registry = new ProviderRegistry().register({ kind: 'fake', id: 'fake.alpha', aliases: ['alpha'], create: () => new FakeProvider() });

    expect(() => registry.create('fake', 'missing')).toThrow("Unknown fake provider 'missing'. Expected alpha, fake.alpha.");
  });

  it('registers in-repo providers with legacy aliases', () => {
    const registry = defaultProviderRegistry({ version: 1, project: { name: 'test' }, providers: { store: 'filesystem', vcs: 'git', workspace: 'git-worktree', agent: 'pi' } });

    expect(registry.create('isolation', 'host').id).toBe('isolation.host');
    expect(registry.create('isolation', 'isolation.podman').id).toBe('isolation.podman');
    expect(registry.create('workstream', 'github').id).toBe('workstream.github');
    expect(registry.create('spec', 'pi').id).toBe('spec.pi');
  });
});
