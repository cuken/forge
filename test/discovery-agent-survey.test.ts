import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentSurveyTaskDiscoveryProvider } from '../src/providers/discovery-agent-survey/index.js';
import { defaultProviderRegistry } from '../src/cli.js';

async function script(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-agent-survey-'));
  const file = join(dir, 'survey.sh');
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('AgentSurveyTaskDiscoveryProvider', () => {
  it('normalizes agent survey JSON into discovery metadata', async () => {
    const command = await script(`printf '%s\n' '{"resourceScopes":[{"kind":"path","value":"src/providers/discovery-agent-survey/index.ts","confidence":"high","reason":"provider implementation"},{"kind":"nonsense","value":"","confidence":"certain"}]}'`);
    const provider = new AgentSurveyTaskDiscoveryProvider(command, []);

    const discovery = await provider.discoverTask({ title: 'Add an agent survey discovery provider', complexity: 'small' });

    expect(discovery.providerId).toBe('task-discovery.agent-survey');
    expect(discovery.resourceScopes).toEqual([
      { kind: 'path', value: 'src/providers/discovery-agent-survey/index.ts', confidence: 'high', reason: 'provider implementation' },
      { kind: 'unknown', value: '*', confidence: 'low', reason: 'Agent survey identified this as a likely resource scope.' },
    ]);
  });

  it('falls back to an unknown scope when the agent command is unavailable', async () => {
    const provider = new AgentSurveyTaskDiscoveryProvider('forge-missing-agent-survey-command', []);

    const discovery = await provider.discoverTask({ title: 'Ambiguous task', complexity: 'small' });

    expect(discovery.resourceScopes).toHaveLength(1);
    expect(discovery.resourceScopes[0]).toMatchObject({ kind: 'unknown', value: '*', confidence: 'low' });
    expect(discovery.resourceScopes[0].reason).toContain('unavailable');
  });

  it('is selectable from the default provider registry', () => {
    const provider = defaultProviderRegistry({ pi: { command: 'pi-agent-survey-test', args: ['-p'] } }).create('task-discovery', 'agent-survey');

    expect(provider).toBeInstanceOf(AgentSurveyTaskDiscoveryProvider);
  });
});
