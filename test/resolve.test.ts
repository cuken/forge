import { describe, expect, it } from 'vitest';
import { resolveTask } from '../src/core/resolve.js';
import type { Task, TaskStore } from '../src/core/types.js';

function task(id: string, title: string, status: Task['status']): Task { return { id, title, status, complexity: 'small', createdAt: '', updatedAt: '', contextRefs: [] }; }
function store(tasks: Task[]): TaskStore { return { id:'s', kind:'task-store', init:async()=>{}, create:async()=>{throw new Error('unused')}, get:async id=>tasks.find(t=>t.id===id)??null, list:async()=>tasks, update:async()=>{throw new Error('unused')} }; }

describe('task resolution', () => {
  it('resolves by unique title pattern', async () => {
    await expect(resolveTask(store([task('1','add toml config','ready')]), 'toml')).resolves.toMatchObject({ id: '1' });
  });
  it('requires a pattern when multiple status matches exist', async () => {
    await expect(resolveTask(store([task('1','a','ready'), task('2','b','ready')]), undefined, 'ready')).rejects.toThrow('Multiple tasks match');
  });
  it('reports ambiguous patterns', async () => {
    await expect(resolveTask(store([task('1','toml config','ready'), task('2','toml parser','ready')]), 'toml')).rejects.toThrow('Multiple tasks match');
  });
});
