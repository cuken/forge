import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseRecord, ReleaseStore } from '../../core/types.js';
import { readJson, writeJson } from '../../util/fs.js';

export class FileReleaseStore implements ReleaseStore {
  id = 'store.filesystem.releases';
  kind = 'release-store' as const;
  constructor(private root = process.cwd()) {}
  private dir() { return join(this.root, '.forge', 'releases'); }
  private recordPath(id: string) { return join(this.dir(), `${id}.json`); }
  async init() { await mkdir(this.dir(), { recursive: true }); }
  async create(input: Omit<ReleaseRecord, 'createdAt' | 'updatedAt'>): Promise<ReleaseRecord> {
    await this.init();
    const existing = await this.get(input.id);
    if (existing) throw new Error(`Release already exists: ${input.id}`);
    const now = new Date().toISOString();
    const release: ReleaseRecord = { ...input, createdAt: now, updatedAt: now };
    await writeJson(this.recordPath(input.id), release);
    return release;
  }
  async get(id: string): Promise<ReleaseRecord | null> {
    try { return await readJson<ReleaseRecord>(this.recordPath(id)); } catch { return null; }
  }
  async list(input: { status?: ReleaseRecord['status']; targetKind?: string } = {}): Promise<ReleaseRecord[]> {
    await this.init();
    const files = (await readdir(this.dir())).filter(f => f.endsWith('.json'));
    const releases = await Promise.all(files.map(f => readJson<ReleaseRecord>(join(this.dir(), f))));
    return releases
      .filter(release => !input.status || release.status === input.status)
      .filter(release => !input.targetKind || release.target.kind === input.targetKind)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async update(id: string, patch: Partial<ReleaseRecord>): Promise<ReleaseRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Release not found: ${id}`);
    const release = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    await writeJson(this.recordPath(id), release);
    return release;
  }
}
