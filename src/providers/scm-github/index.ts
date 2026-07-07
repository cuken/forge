import { spawn } from 'node:child_process';
import type { DoctorProvider } from '../../core/health.js';
import type { IssueRef, ScmProvider } from '../../core/types.js';
import { commandExists, runCommand } from '../../util/command.js';

export class GitHubScmProvider implements ScmProvider, DoctorProvider {
  id = 'scm.github';
  kind = 'scm' as const;
  checks() {
    return [
      { id: `${this.id}:gh-binary`, label: 'GitHub CLI', run: async () => (await commandExists('gh')) ? { id: `${this.id}:gh-binary`, status: 'pass' as const, message: 'gh is available' } : { id: `${this.id}:gh-binary`, status: 'fail' as const, message: 'gh is not available' } },
      { id: `${this.id}:auth`, label: 'GitHub auth', run: async () => { const r = await runCommand('gh', ['auth', 'status']); return r.exitCode === 0 ? { id: `${this.id}:auth`, status: 'pass' as const, message: 'gh auth is configured' } : { id: `${this.id}:auth`, status: 'warn' as const, message: 'gh auth is not configured', detail: r.stderr || r.stdout }; } },
      { id: `${this.id}:repo`, label: 'GitHub repository', run: async () => { const r = await runCommand('gh', ['repo', 'view', '--json', 'nameWithOwner']); return r.exitCode === 0 ? { id: `${this.id}:repo`, status: 'pass' as const, message: `GitHub repo detected: ${r.stdout.trim()}` } : { id: `${this.id}:repo`, status: 'warn' as const, message: 'no GitHub repo detected from current directory', detail: r.stderr || r.stdout }; } },
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
}
