import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { CleanupResult } from '../../core/cleanup.js';
import type { RunRecord, Task, WorkspaceProvider } from '../../core/types.js';
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
  async cleanupWorkspaces(input: { tasks: Task[]; runs: RunRecord[]; dryRun?: boolean }): Promise<CleanupResult> {
    const doneTaskIds = new Set(input.tasks.filter(task => task.status === 'done').map(task => task.id));
    const activeTaskIds = new Set(input.tasks.filter(task => task.status !== 'done').map(task => task.id));
    const candidates = new Map<string, { path: string; branch: string; taskId: string }>();
    for (const run of input.runs) {
      if (!run.workspace || !doneTaskIds.has(run.taskId) || activeTaskIds.has(run.taskId)) continue;
      if (run.status === 'running') continue;
      candidates.set(run.workspace.path, { path: run.workspace.path, branch: run.workspace.branch, taskId: run.taskId });
    }
    const git = simpleGit(this.root);
    const items: CleanupResult['items'] = [];
    for (const candidate of candidates.values()) {
      items.push({ id: candidate.taskId, kind: 'workspace', path: candidate.path, reason: 'task is done and no run is active', removed: false });
      items.push({ id: candidate.taskId, kind: 'branch', ref: candidate.branch, reason: 'branch belongs to done task workspace', removed: false });
      if (!input.dryRun) {
        await git.raw(['worktree', 'remove', '--force', candidate.path]);
        items[items.length - 2].removed = true;
        try {
          await git.raw(['branch', '-D', candidate.branch]);
          items[items.length - 1].removed = true;
        } catch {
          // Branch may already be gone or not local; workspace removal is the safety-critical cleanup.
        }
      }
    }
    return { dryRun: !!input.dryRun, items };
  }
}
