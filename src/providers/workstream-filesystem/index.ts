import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkstreamItem, WorkstreamProvider } from '../../core/workstream.js';
import type { Task } from '../../core/types.js';
import { readJson, writeJson } from '../../util/fs.js';

type RawItem = { id?: unknown; title?: unknown; description?: unknown; dependencies?: unknown; complexity?: unknown; status?: unknown; taskId?: unknown };

const complexities: Task['complexity'][] = ['trivial', 'small', 'medium', 'large'];

export class FileWorkstreamProvider implements WorkstreamProvider {
  id = 'workstream.filesystem';
  kind = 'workstream' as const;
  constructor(private root = process.cwd()) {}
  private path() { return join(this.root, '.forge', 'workstream.json'); }

  async import(input: { path?: string; items?: unknown[] } = {}): Promise<WorkstreamItem[]> {
    const source = input.items ?? (input.path ? await readJson<unknown>(input.path) : await this.readDefaultOrEmpty());
    const existing = new Map(this.normalize(await this.readDefaultOrEmpty()).map(item => [item.id, item]));
    // Re-importing an edited roadmap must not forget which items were already queued.
    const items = this.normalize(source).map(item => {
      const previous = existing.get(item.id);
      return previous?.status === 'queued' ? { ...item, status: previous.status, taskId: previous.taskId } : item;
    });
    await mkdir(join(this.root, '.forge'), { recursive: true });
    await writeJson(this.path(), items);
    return items;
  }

  async list(): Promise<WorkstreamItem[]> {
    return this.normalize(await this.readDefaultOrEmpty());
  }

  async update(id: string, patch: Partial<Pick<WorkstreamItem, 'status' | 'taskId'>>): Promise<WorkstreamItem> {
    const items = this.normalize(await this.readDefaultOrEmpty());
    const index = items.findIndex(item => item.id === id);
    if (index === -1) throw new Error(`No workstream item '${id}'`);
    items[index] = { ...items[index], ...patch };
    await writeJson(this.path(), items);
    return items[index];
  }

  private async readDefaultOrEmpty(): Promise<unknown> {
    try { return await readJson<unknown>(this.path()); } catch { return []; }
  }

  private normalize(source: unknown): WorkstreamItem[] {
    const rawItems = Array.isArray(source) ? source : Array.isArray((source as { items?: unknown })?.items) ? (source as { items: unknown[] }).items : [];
    return rawItems.map((raw, index) => this.normalizeItem(raw as RawItem, index));
  }

  private normalizeItem(raw: RawItem, index: number): WorkstreamItem {
    if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error(`Workstream item ${index + 1} is missing a title`);
    const complexity = typeof raw.complexity === 'string' && complexities.includes(raw.complexity as Task['complexity']) ? raw.complexity as Task['complexity'] : 'small';
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `item-${index + 1}`,
      title: raw.title.trim(),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.filter((dep): dep is string => typeof dep === 'string') : [],
      complexity,
      status: raw.status === 'queued' ? 'queued' : 'planned',
      taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
    };
  }
}
