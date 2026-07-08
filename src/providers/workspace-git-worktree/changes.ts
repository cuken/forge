import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ChangeSetProvider } from '../../core/changes.js';
import type { DoctorProvider, HealthCheck } from '../../core/health.js';
import type { RunRecord } from '../../core/types.js';
import { runCommand } from '../../util/command.js';

function requireWorkspace(run: RunRecord) {
  if (!run.workspace?.path || !run.workspace.branch) throw new Error(`Run ${run.id} has no workspace metadata`);
  return run.workspace;
}

type GitWorktreeProbe = {
  readFile?: typeof readFile;
  access?: typeof access;
  runCommand?: typeof runCommand;
};

export class GitWorktreeChangeSetProvider implements ChangeSetProvider, DoctorProvider {
  id = 'change-set.git-worktree';
  kind = 'change-set' as const;
  private probes: Required<GitWorktreeProbe>;
  constructor(private root = process.cwd(), probes: GitWorktreeProbe = {}) {
    this.probes = { readFile: probes.readFile ?? readFile, access: probes.access ?? access, runCommand: probes.runCommand ?? runCommand };
  }

  checks(): HealthCheck[] {
    return [{
      id: `${this.id}:metadata`,
      label: 'Git worktree metadata for acceptance',
      run: async () => {
        const revParse = await this.probes.runCommand('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd: this.root });
        if (revParse.exitCode !== 0) return { id: `${this.id}:metadata`, status: 'fail' as const, message: 'git metadata is not readable from this checkout', detail: revParse.stderr || revParse.stdout };

        const [gitDirLine, commonDirLine] = revParse.stdout.split('\n').map(line => line.trim()).filter(Boolean);
        const gitDirs = [gitDirLine, commonDirLine].filter(Boolean).map(dir => isAbsolute(dir) ? dir : resolve(this.root, dir));
        try {
          await Promise.all(gitDirs.map(dir => this.probes.access(dir)));
        } catch (error) {
          return { id: `${this.id}:metadata`, status: 'fail' as const, message: 'git metadata path is inaccessible from this environment', detail: error instanceof Error ? error.message : String(error) };
        }

        try {
          const gitFile = await this.probes.readFile(resolve(this.root, '.git'), 'utf8');
          const match = gitFile.match(/^gitdir:\s*(.+)$/m);
          if (match) {
            const gitDir = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(this.root, match[1].trim());
            await this.probes.access(gitDir);
          }
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'EISDIR') {
            return { id: `${this.id}:metadata`, status: 'pass' as const, message: 'git metadata directory is accessible for review and accept' };
          }
          return { id: `${this.id}:metadata`, status: 'fail' as const, message: '.git metadata pointer is inaccessible from this environment', detail: error instanceof Error ? error.message : String(error) };
        }

        return { id: `${this.id}:metadata`, status: 'pass' as const, message: 'git worktree metadata is accessible for review and accept' };
      },
    }];
  }

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

    try {
      await rootGit.merge([ws.branch]);
    } catch (error) {
      const conflicted = (await rootGit.status()).conflicted;
      if (conflicted.length) {
        return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'merge-conflict' as const, message: `Cannot accept change set: merge conflict in ${conflicted.join(', ')}` };
      }
      throw error;
    }
    const head = await rootGit.revparse(['HEAD']);
    return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'accepted' as const, message: `Accepted ${commit.commit} from ${ws.branch}`, commit: { providerId: this.id, id: head.trim(), sha: head.trim(), branch: ws.branch, message: input.message } };
  }
}
