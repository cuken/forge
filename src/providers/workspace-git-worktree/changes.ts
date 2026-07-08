import { simpleGit } from 'simple-git';
import type { ChangeSetProvider } from '../../core/changes.js';
import type { RunRecord } from '../../core/types.js';

function requireWorkspace(run: RunRecord) {
  if (!run.workspace?.path || !run.workspace.branch) throw new Error(`Run ${run.id} has no workspace metadata`);
  return run.workspace;
}

export class GitWorktreeChangeSetProvider implements ChangeSetProvider {
  id = 'change-set.git-worktree';
  kind = 'change-set' as const;
  constructor(private root = process.cwd()) {}

  async review(input: { run: RunRecord }) {
    const ws = requireWorkspace(input.run);
    const git = simpleGit(ws.path);
    const status = await git.status();
    const stat = await git.diff(['--stat']);
    const nameStatus = await git.diff(['--name-status']);
    const statusLines = status.files.map(file => `${file.index}${file.working_dir}\t${file.path}`);
    const files = [...status.files.map(file => file.path), ...nameStatus.split('\n').filter(Boolean).map(line => line.split(/\s+/).slice(1).join(' '))];
    const uniqueFiles = [...new Set(files.filter(Boolean))].sort();
    const summary = [
      `branch=${ws.branch}`,
      `workspace=${ws.path}`,
      stat.trim(),
      nameStatus.trim(),
      statusLines.length ? `status:\n${statusLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: uniqueFiles.length ? 'changed' as const : 'empty' as const, files: uniqueFiles, summary };
  }

  async accept(input: { run: RunRecord; message?: string }) {
    const ws = requireWorkspace(input.run);
    const review = await this.review(input);
    if (review.status === 'empty') return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'empty' as const, message: 'No changes to accept' };

    const rootGit = simpleGit(this.root);
    const rootStatus = await rootGit.status();
    if (!rootStatus.isClean()) {
      return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'blocked' as const, message: 'Cannot accept change set: project checkout has uncommitted changes' };
    }

    const worktreeGit = simpleGit(ws.path);
    await worktreeGit.add('.');
    const commit = await worktreeGit.commit(input.message ?? `Accept Forge run ${input.run.id}: ${input.run.taskTitle}`);

    await rootGit.merge([ws.branch]);
    return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'accepted' as const, message: `Accepted ${commit.commit} from ${ws.branch}` };
  }
}
