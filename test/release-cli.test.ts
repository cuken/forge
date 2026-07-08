import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { program } from '../src/cli.js';

async function runForge(args: string[]) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => { lines.push(String(message ?? '')); });
  try {
    await program.parseAsync(args, { from: 'user' });
    return lines.join('\n');
  } finally {
    spy.mockRestore();
  }
}

describe('release CLI commands', () => {
  let cwd: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), 'forge-release-cli-'));
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates a task targeting a planned release and shows the target in task list output', async () => {
    await runForge(['release', 'create', '2.0.0', '--target-kind', 'package', '--target-id', 'forge']);

    const created = await runForge(['task', 'create', 'release fix', '--release', '2-0-0-package-forge']);
    expect(created).toMatch(/release=2-0-0-package-forge$/);

    const listed = await runForge(['task', 'list']);
    expect(listed).toContain('\trelease=2-0-0-package-forge');
    const release = JSON.parse(await runForge(['release', 'show', '2-0-0-package-forge']));
    expect(release.status).toBe('active');

    await runForge(['release', 'create', '2.0.1', '--target-kind', 'package', '--target-id', 'forge']);
    const updated = await runForge(['task', 'update', 'release fix', '--release', '2-0-1-package-forge']);
    expect(updated).toMatch(/release=2-0-1-package-forge$/);
  });

  it('creates, lists, filters, and shows provider-neutral release records', async () => {
    const created = await runForge(['release', 'create', '1.2.3', '--target-kind', 'package', '--target-id', 'forge', '--target-name', 'Forge CLI', '--notes', 'ship release CLI']);

    expect(created).toMatch(/^1-2-3-package-forge\tplanned\t1\.2\.3\tpackage:forge$/);

    const listed = await runForge(['release', 'list']);
    expect(listed).toContain('1-2-3-package-forge\tplanned\t1.2.3\tpackage:forge\t');

    const filteredOut = await runForge(['release', 'list', '--status', 'completed']);
    expect(filteredOut).toBe('');

    const shown = JSON.parse(await runForge(['release', 'show', '1-2-3-package-forge']));
    expect(shown).toMatchObject({
      id: '1-2-3-package-forge',
      version: '1.2.3',
      status: 'planned',
      target: { kind: 'package', id: 'forge', name: 'Forge CLI' },
      notes: 'ship release CLI',
    });
  });
});
