import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readForgeConfigSync } from '../src/core/config.js';

describe('Forge config loading', () => {
  it('reads the selected isolation provider from forge toml config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-test-'));
    await mkdir(join(root, '.forge'));
    await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nisolation = "podman"\n');

    expect(readForgeConfigSync(root)?.providers?.isolation).toBe('podman');
  });

  it('prefers forge toml config over generated json config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-precedence-test-'));
    await mkdir(join(root, '.forge'));
    await writeFile(join(root, '.forge', 'config.json'), JSON.stringify({ providers: { isolation: 'host' } }));
    await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nisolation = "docker"\n');

    expect(readForgeConfigSync(root)?.providers?.isolation).toBe('docker');
  });
});
