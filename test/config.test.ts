import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readForgeConfigSync } from '../src/core/config.js';
import { notificationProvider } from '../src/cli.js';

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

  it('reads shell validation commands from forge toml config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-validation-test-'));
    await mkdir(join(root, '.forge'));
    await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nvalidation = "shell"\n\n[validation]\ncommands = ["npm test", "npm run build"]\n');

    expect(readForgeConfigSync(root)?.validation?.commands).toEqual(['npm test', 'npm run build']);
  });

  it('reads notification provider and channel selection from forge toml config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-notification-test-'));
    await mkdir(join(root, '.forge'));
    await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nnotification = "console"\n\n[notifications]\nchannel = "stdout"\n');

    expect(readForgeConfigSync(root)).toMatchObject({ providers: { notification: 'console' }, notifications: { channel: 'stdout' } });
  });

  it('validates notification provider and channel during CLI wiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-config-notification-validation-test-'));
    await mkdir(join(root, '.forge'));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nnotification = "console"\n\n[notifications]\nchannel = "stdout"\n');
      expect(notificationProvider()?.id).toBe('notification.console');

      await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nnotification = "pager"\n');
      expect(() => notificationProvider()).toThrow("Unknown notification provider 'pager'");

      await writeFile(join(root, '.forge', 'config.toml'), '[providers]\nnotification = "console"\n\n[notifications]\nchannel = "pager"\n');
      expect(() => notificationProvider()).toThrow("Unknown notification channel 'pager'");
    } finally {
      process.chdir(cwd);
    }
  });
});
