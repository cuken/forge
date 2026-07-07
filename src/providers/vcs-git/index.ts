import { simpleGit, type SimpleGit } from 'simple-git';
import type { DoctorProvider } from '../../core/health.js';
import type { SyncInput, SyncProvider } from '../../core/sync.js';
import type { VcsProvider } from '../../core/types.js';
import { commandExists, runCommand } from '../../util/command.js';

export class GitVcsProvider implements VcsProvider, DoctorProvider, SyncProvider {
  id = 'vcs.git';
  kind = 'vcs' as const;
  private git: SimpleGit;
  constructor(private root = process.cwd()) { this.git = simpleGit(root); }
  async isRepo() { return await this.git.checkIsRepo(); }
  async init() { if (!(await this.isRepo())) await this.git.init(); }
  async currentBranch() { const b = await this.git.branchLocal(); return b.current || 'main'; }
  async status() { const s = await this.git.status(); return { clean: s.isClean(), summary: s.files.map(f => `${f.working_dir || f.index} ${f.path}`).join('\n') }; }
  checks() {
    return [
      { id: `${this.id}:binary`, label: 'Git binary', run: async () => (await commandExists('git')) ? { id: `${this.id}:binary`, status: 'pass' as const, message: 'git is available' } : { id: `${this.id}:binary`, status: 'fail' as const, message: 'git is not available' } },
      { id: `${this.id}:repo`, label: 'Git repository', run: async () => (await this.isRepo()) ? { id: `${this.id}:repo`, status: 'pass' as const, message: 'current directory is a git repository' } : { id: `${this.id}:repo`, status: 'warn' as const, message: 'current directory is not a git repository; forge init will run git init' } },
      { id: `${this.id}:worktree`, label: 'Git worktree support', run: async () => { const r = await runCommand('git', ['worktree', 'list'], { cwd: this.root }); return r.exitCode === 0 ? { id: `${this.id}:worktree`, status: 'pass' as const, message: 'git worktree is available' } : { id: `${this.id}:worktree`, status: 'warn' as const, message: 'git worktree unavailable until repository exists', detail: r.stderr || r.stdout }; } },
    ];
  }
  syncTasks() {
    return [
      { id: `${this.id}:ensure-repo`, label: 'Ensure git repository', run: async () => { if (!(await this.isRepo())) return { id: `${this.id}:ensure-repo`, status: 'blocked' as const, message: 'not a git repository; run forge init first' }; return { id: `${this.id}:ensure-repo`, status: 'unchanged' as const, message: 'git repository present' }; } },
      { id: `${this.id}:commit-local`, label: 'Commit local changes', run: async (input: SyncInput) => {
        const status = await this.git.status();
        if (status.isClean()) return { id: `${this.id}:commit-local`, status: 'unchanged' as const, message: 'working tree clean' };
        if (input.dryRun) return { id: `${this.id}:commit-local`, status: 'changed' as const, message: 'local changes would be committed', detail: status.files.map(f => f.path).join('\n') };
        await this.git.add(['.']);
        const msg = input.message ?? 'chore: sync forge project';
        const commit = await this.git.commit(msg);
        return { id: `${this.id}:commit-local`, status: 'changed' as const, message: `committed ${commit.commit}` };
      } },
      { id: `${this.id}:push-upstream`, label: 'Push current branch to declared remote', run: async (input: SyncInput) => {
        const branch = await this.currentBranch();
        const remotes = await this.git.getRemotes(true);
        const remote = remotes.find(r => r.name === 'upstream') ?? remotes.find(r => r.name === 'origin');
        if (!remote) return { id: `${this.id}:push-upstream`, status: 'blocked' as const, message: 'no git remote named upstream or origin' };
        if (input.dryRun) return { id: `${this.id}:push-upstream`, status: 'changed' as const, message: `would push ${branch} to ${remote.name}/${branch}` };
        const r = await runCommand('git', ['push', '-u', remote.name, branch], { cwd: this.root });
        if (r.exitCode !== 0) return { id: `${this.id}:push-upstream`, status: 'failed' as const, message: `push to ${remote.name}/${branch} failed`, detail: r.stderr || r.stdout };
        return { id: `${this.id}:push-upstream`, status: 'changed' as const, message: `pushed ${branch} to ${remote.name}/${branch}`, detail: r.stdout || r.stderr };
      } },
    ];
  }
}
