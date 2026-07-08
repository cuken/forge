import { spawn } from 'node:child_process';
import type { DoctorProvider } from '../../core/health.js';
import type { ReleaseReviewPreparation, ReleaseVcsProvider, ReleaseVcsRef, ReleaseVcsTarget } from '../../core/release-vcs.js';
import type { ForgeConfig, IssueRef, ReleaseRecord, ScmProvider } from '../../core/types.js';
import { commandExists, runCommand, type CommandResult } from '../../util/command.js';

type GitHubConfig = NonNullable<ForgeConfig['github']>;
type Runner = (command: string, args: string[]) => Promise<CommandResult>;

export class GitHubScmProvider implements ScmProvider, DoctorProvider, ReleaseVcsProvider {
  id = 'scm.github';
  kind = 'scm' as const;
  constructor(private config: GitHubConfig = {}, private runner: Runner = runCommand) {}

  checks() {
    return [
      { id: `${this.id}:gh-binary`, label: 'GitHub CLI', run: async () => (await commandExists('gh')) ? { id: `${this.id}:gh-binary`, status: 'pass' as const, message: 'gh is available' } : { id: `${this.id}:gh-binary`, status: 'fail' as const, message: 'gh is not available' } },
      { id: `${this.id}:auth`, label: 'GitHub auth', run: async () => { const r = await this.runner('gh', ['auth', 'status']); return r.exitCode === 0 ? { id: `${this.id}:auth`, status: 'pass' as const, message: 'gh auth is configured' } : { id: `${this.id}:auth`, status: 'warn' as const, message: 'gh auth is not configured', detail: r.stderr || r.stdout }; } },
      { id: `${this.id}:repo`, label: 'GitHub repository', run: async () => { const r = await this.runner('gh', ['repo', 'view', '--json', 'nameWithOwner']); return r.exitCode === 0 ? { id: `${this.id}:repo`, status: 'pass' as const, message: `GitHub repo detected: ${r.stdout.trim()}` } : { id: `${this.id}:repo`, status: 'warn' as const, message: 'no GitHub repo detected from current directory', detail: r.stderr || r.stdout }; } },
    ];
  }

  async createIssue(input: { title: string; body: string }): Promise<IssueRef> {
    return await new Promise((resolve, reject) => {
      const child = spawn('gh', ['issue', 'create', '--title', input.title, '--body', input.body], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('close', code => code === 0 ? resolve({ provider: this.id, id: out.trim().split('/').pop() ?? out.trim(), url: out.trim() }) : reject(new Error(err || out)));
    });
  }

  async ensureReleaseTarget(input: { release: ReleaseRecord }): Promise<ReleaseVcsTarget> {
    const repo = await this.repo();
    return { providerId: this.id, releaseId: input.release.id, targetKind: input.release.target.kind, targetId: input.release.target.id, exists: true, url: repo.url, message: `GitHub repository ${repo.nameWithOwner}` };
  }

  async resolveReleaseRef(input: { release: ReleaseRecord; target: ReleaseVcsTarget }): Promise<ReleaseVcsRef> {
    const repo = await this.repo();
    const baseRef = this.config.releaseBaseBranch ?? repo.defaultBranch;
    const branch = this.renderBranch(input.release);
    const existing = await this.runner('gh', ['api', `repos/${repo.nameWithOwner}/git/ref/heads/${branch}`]);
    if (existing.exitCode !== 0) {
      const base = await this.runner('gh', ['api', `repos/${repo.nameWithOwner}/git/ref/heads/${baseRef}`, '--jq', '.object.sha']);
      if (base.exitCode !== 0) throw new Error(`Could not resolve GitHub release base branch ${baseRef}: ${base.stderr || base.stdout}`);
      const created = await this.runner('gh', ['api', `repos/${repo.nameWithOwner}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${base.stdout.trim()}`]);
      if (created.exitCode !== 0) throw new Error(`Could not create GitHub release branch ${branch}: ${created.stderr || created.stdout}`);
    }
    return { providerId: this.id, releaseId: input.release.id, ref: branch, baseRef, headRef: branch, message: `GitHub release branch ${branch}` };
  }

  async prepareReleaseReview(input: { release: ReleaseRecord; target: ReleaseVcsTarget; ref: ReleaseVcsRef }): Promise<ReleaseReviewPreparation> {
    const repo = await this.repo();
    return { providerId: this.id, releaseId: input.release.id, status: 'ready', reviewUrl: `https://github.com/${repo.nameWithOwner}/compare/${input.ref.baseRef}...${input.ref.headRef}`, message: `Release branch ${input.ref.headRef} is ready for review` };
  }

  private async repo(): Promise<{ nameWithOwner: string; url: string; defaultBranch: string }> {
    const selector = this.config.owner && this.config.repo ? `${this.config.owner}/${this.config.repo}` : undefined;
    const args = ['repo', 'view', ...(selector ? [selector] : []), '--json', 'nameWithOwner,url,defaultBranchRef'];
    const result = await this.runner('gh', args);
    if (result.exitCode !== 0) throw new Error(`Could not resolve GitHub repository: ${result.stderr || result.stdout}`);
    const parsed = JSON.parse(result.stdout) as { nameWithOwner: string; url?: string; defaultBranchRef?: { name?: string } };
    return { nameWithOwner: parsed.nameWithOwner, url: parsed.url ?? `https://github.com/${parsed.nameWithOwner}`, defaultBranch: parsed.defaultBranchRef?.name ?? 'main' };
  }

  private renderBranch(release: ReleaseRecord): string {
    const template = this.config.releaseBranchTemplate ?? 'release/{version}';
    return template
      .replaceAll('{id}', release.id)
      .replaceAll('{version}', release.version)
      .replaceAll('{target.kind}', release.target.kind)
      .replaceAll('{target.id}', release.target.id)
      .split('/')
      .map(part => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'release')
      .join('/');
  }
}
