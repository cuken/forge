import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, RunStore, Task } from '../../core/types.js';
import { readJson, slug, writeJson } from '../../util/fs.js';

export class FileRunStore implements RunStore {
  id = 'store.filesystem.runs';
  kind = 'run-store' as const;
  constructor(private root = process.cwd()) {}
  private dir() { return join(this.root, '.forge', 'runs'); }
  private logDir() { return join(this.root, '.forge', 'logs'); }
  private recordPath(id: string) { return join(this.dir(), `${id}.json`); }
  async init() { await mkdir(this.dir(), { recursive: true }); await mkdir(this.logDir(), { recursive: true }); }
  async start(input: { task: Task; agentId: string }): Promise<RunRecord> {
    await this.init();
    const now = new Date().toISOString();
    const id = `${Date.now()}-${slug(input.task.title)}`;
    const logPath = join('.forge', 'logs', `${id}.log`);
    const record: RunRecord = { id, taskId: input.task.id, taskTitle: input.task.title, status: 'running', startedAt: now, updatedAt: now, agentId: input.agentId, logPath };
    await writeJson(this.recordPath(id), record);
    await appendFile(join(this.root, logPath), '');
    return record;
  }
  async appendLog(id: string, chunk: string): Promise<void> { const run = await this.get(id); if (!run) throw new Error(`Run not found: ${id}`); await appendFile(join(this.root, run.logPath), chunk); }
  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord> { const existing = await this.get(id); if (!existing) throw new Error(`Run not found: ${id}`); const run = { ...existing, ...patch, id, updatedAt: new Date().toISOString() }; await writeJson(this.recordPath(id), run); return run; }
  async get(id: string): Promise<RunRecord | null> { try { return await readJson<RunRecord>(this.recordPath(id)); } catch { return null; } }
  async list(input: { taskId?: string } = {}): Promise<RunRecord[]> { await this.init(); const files = (await readdir(this.dir())).filter(f => f.endsWith('.json')); const runs = await Promise.all(files.map(f => readJson<RunRecord>(join(this.dir(), f)))); return runs.filter(r => !input.taskId || r.taskId === input.taskId).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)); }
  async readLog(id: string): Promise<string> { const run = await this.get(id); if (!run) throw new Error(`Run not found: ${id}`); return readFile(join(this.root, run.logPath), 'utf8'); }
}
