import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStore } from '../../core/types.js';
import { readJson, slug, writeJson } from '../../util/fs.js';

export class FileTaskStore implements TaskStore {
  id = 'store.filesystem';
  kind = 'task-store' as const;
  constructor(private root = process.cwd()) {}
  private dir() { return join(this.root, '.forge', 'tasks'); }
  async init() { await mkdir(this.dir(), { recursive: true }); }
  async create(input: Omit<Task, 'id'|'createdAt'|'updatedAt'> & { id?: string }): Promise<Task> {
    await this.init();
    const now = new Date().toISOString();
    const id = input.id ?? `${Date.now()}-${slug(input.title)}`;
    const task: Task = { ...input, id, createdAt: now, updatedAt: now };
    await writeJson(join(this.dir(), `${id}.json`), task);
    return task;
  }
  async get(id: string): Promise<Task | null> {
    try { return await readJson<Task>(join(this.dir(), `${id}.json`)); } catch { return null; }
  }
  async list(): Promise<Task[]> {
    await this.init();
    const files = (await readdir(this.dir())).filter(f => f.endsWith('.json'));
    return (await Promise.all(files.map(f => readJson<Task>(join(this.dir(), f))))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  async update(id: string, patch: Partial<Task>): Promise<Task> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Task not found: ${id}`);
    const task = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    await writeJson(join(this.dir(), `${id}.json`), task);
    return task;
  }
}
