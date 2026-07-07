import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const requiredDocs = [
  'AGENTS.md',
  'docs/agent-guide.md',
  'docs/architecture.md',
  'docs/providers.md',
  'docs/commands.md',
  'docs/documentation-policy.md',
];

describe('agent-facing documentation', () => {
  it('keeps self-augmentation documentation present and connected to core capabilities', async () => {
    for (const path of requiredDocs) {
      const text = await readFile(path, 'utf8');
      expect(text.length, `${path} should not be empty`).toBeGreaterThan(500);
    }

    await expect(readFile('docs/providers.md', 'utf8')).resolves.toContain('DoctorProvider');
    await expect(readFile('docs/providers.md', 'utf8')).resolves.toContain('SyncProvider');
    await expect(readFile('docs/commands.md', 'utf8')).resolves.toContain('forge sync');
    await expect(readFile('AGENTS.md', 'utf8')).resolves.toContain('Every new command, provider capability');
  });
});
