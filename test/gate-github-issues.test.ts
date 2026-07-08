import { describe, expect, it } from 'vitest';
import { GitHubIssuesGateProvider, type GitHubCliTransport } from '../src/providers/gate-github-issues/index.js';
import type { Task, RunRecord } from '../src/core/types.js';

class MockGh implements GitHubCliTransport {
  issues: any[] = [];
  comments = new Map<number, any[]>();
  async api<T>(method: string, path: string, body?: any): Promise<T> {
    if (method === 'GET' && path.includes('/comments')) return (this.comments.get(Number(path.match(/issues\/(\d+)/)?.[1])) ?? []) as T;
    if (method === 'GET' && /\/issues\/\d+$/.test(path)) return this.issues.find(i => i.number === Number(path.match(/issues\/(\d+)$/)?.[1])) as T;
    if (method === 'GET' && path.includes('/issues?')) return this.issues as T;
    if (method === 'POST' && path.endsWith('/issues')) { const issue = { number: this.issues.length + 1, title: body.title, body: body.body, labels: body.labels, html_url: `https://github.test/o/r/issues/${this.issues.length + 1}` }; this.issues.push(issue); return issue as T; }
    if (method === 'PATCH') { const issue = this.issues.find(i => i.number === Number(path.match(/issues\/(\d+)/)?.[1])); Object.assign(issue, body); return issue as T; }
    if (method === 'POST' && path.includes('/comments')) { const n = Number(path.match(/issues\/(\d+)/)?.[1]); this.comments.set(n, [...(this.comments.get(n) ?? []), { body: body.body, created_at: '2026-01-02T00:00:00Z', user: { login: 'octo' } }]); return {} as T; }
    throw new Error(`${method} ${path}`);
  }
}

const task: Task = { id: 'task-1', title: 'Needs a decision', status: 'awaiting-approval', complexity: 'medium', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', contextRefs: [], spec: { path: '.forge/specs/task-1.md', approved: false } };
const run: RunRecord = { id: 'run-1', taskId: task.id, taskTitle: task.title, status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', agentId: 'agent', logPath: '/tmp/run.log' };

describe('GitHubIssuesGateProvider', () => {
  it('publishes spec gates as GitHub issues with spec text', async () => {
    const gh = new MockGh();
    const provider = new GitHubIssuesGateProvider({ owner: 'o', repo: 'r' }, gh);
    const pending = await provider.publishDecision({ subject: { kind: 'spec-approval', task, specPath: task.spec!.path, specBody: '# Spec\nDo it.' } });
    expect(pending).toMatchObject({ providerId: 'gate.github-issues', gateId: '1', kind: 'spec-approval', status: 'pending', taskId: task.id });
    expect(gh.issues[0].title).toBe('Approve spec: Needs a decision');
    expect(gh.issues[0].body).toContain('# Spec\nDo it.');
    expect(gh.issues[0].labels).toContain('forge:spec-approval');
  });

  it('reads approval decisions from labels and comment commands', async () => {
    const gh = new MockGh();
    const provider = new GitHubIssuesGateProvider({ owner: 'o', repo: 'r' }, gh);
    const pending = await provider.publishDecision({ subject: { kind: 'run-acceptance', task, run, summary: 'Changed files: src/a.ts' } });
    gh.issues[0].labels.push('forge:accepted');
    await expect(provider.readDecision({ gateId: pending.gateId, kind: 'run-acceptance', task, run })).resolves.toMatchObject({ status: 'approved', runId: run.id });
    await gh.api('POST', '/repos/o/r/issues/1/comments', { body: '/reject needs more tests' });
    await expect(provider.readDecision({ gateId: pending.gateId, kind: 'run-acceptance', task, run })).resolves.toMatchObject({ status: 'rejected', decidedBy: 'octo', message: '/reject needs more tests' });
  });
});
