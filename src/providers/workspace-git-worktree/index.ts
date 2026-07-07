import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Task, WorkspaceProvider } from '../../core/types.js';
import { slug } from '../../util/fs.js';

export class GitWorktreeProvider implements WorkspaceProvider {
  id = 'workspace.git-worktree';
  kind = 'workspace' as const;
  constructor(private root = process.cwd()) {}
  async create(input: { task: Task; baseBranch?: string }) {
    const branch = `forge/${input.task.id}-${slug(input.task.title)}`.slice(0, 100);
    const dir = resolve(this.root, '..', `.forge-worktrees`, input.task.id);
    await mkdir(resolve(this.root, '..', '.forge-worktrees'), { recursive: true });
    await simpleGit(this.root).raw(['worktree', 'add', '-b', branch, dir, input.baseBranch ?? 'HEAD']);
    return { id: input.task.id, path: dir, branch };
  }
}
