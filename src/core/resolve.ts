import type { Task, TaskStore } from './types.js';

export async function resolveTask(store: TaskStore, pattern?: string, status?: Task['status']): Promise<Task> {
  const tasks = (await store.list()).filter(t => !status || t.status === status);
  if (!pattern) {
    if (tasks.length === 1) return tasks[0]!;
    if (tasks.length === 0) throw new Error(status ? `No ${status} tasks found` : 'No tasks found');
    throw new Error(`Multiple tasks match; pass a pattern:\n${tasks.map(t => `  ${t.id}\t${t.status}\t${t.title}`).join('\n')}`);
  }
  const q = pattern.toLowerCase();
  const matches = tasks.filter(t => t.id === pattern || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No task matches '${pattern}'`);
  throw new Error(`Multiple tasks match '${pattern}':\n${matches.map(t => `  ${t.id}\t${t.status}\t${t.title}`).join('\n')}`);
}
