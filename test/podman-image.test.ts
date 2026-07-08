import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Podman agent image', () => {
  it('installs pi and the host-declared hypa helper used by copied pi tools', async () => {
    const containerfile = await readFile('containers/podman/Containerfile', 'utf8');

    expect(containerfile).toContain('@earendil-works/pi-coding-agent');
    expect(containerfile).toContain('@hypabolic/hypa');
  });
});
