import type { GateDecision, GateDecisionKind, GateProvider, GateSubject, PendingGateDecision } from '../../core/gate.js';
import type { HealthCheck } from '../../core/health.js';
import type { RunRecord, Task } from '../../core/types.js';
import { runCommand } from '../../util/command.js';
import { resolveGitHubToken } from '../workstream-github/index.js';

export interface GitHubIssuesGateConfig { owner?: string; repo?: string }
export interface GitHubCliTransport { api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> }

const markerStart = '<!-- forge-gate:';
const markerEnd = '-->';
const openLabels = ['forge:gate', 'forge:pending'];

export class GhCliTransport implements GitHubCliTransport {
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const args = ['api', '--method', method, path, '--header', 'Accept: application/vnd.github+json'];
    if (body !== undefined) {
      args.push('--input', '-');
    }
    const result = await runCommand('gh', args, body === undefined ? undefined : { stdin: `${JSON.stringify(body)}\n` });
    if (result.exitCode !== 0) throw new Error(`gh api ${method} ${path} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) as T : undefined as T;
  }
}

export class GitHubIssuesGateProvider implements GateProvider {
  id = 'gate.github-issues';
  kind = 'gate' as const;
  constructor(private config: GitHubIssuesGateConfig, private transport: GitHubCliTransport = new GhCliTransport()) {}

  async publishDecision(input: { subject: GateSubject; message?: string }): Promise<PendingGateDecision> {
    const existing = await this.findIssue(this.gateKey(input.subject));
    const body = this.bodyFor(input.subject, input.message);
    const issue = existing
      ? await this.transport.api<GitHubIssue>('PATCH', `${this.issuesPath()}/${existing.number}`, { body })
      : await this.transport.api<GitHubIssue>('POST', this.issuesPath(), { title: this.titleFor(input.subject), body, labels: [...openLabels, `forge:${input.subject.kind}`] });
    if (existing && input.message) await this.transport.api('POST', `${this.issuesPath()}/${issue.number}/comments`, { body: input.message });
    return { providerId: this.id, gateId: String(issue.number), kind: input.subject.kind, status: 'pending', taskId: input.subject.task.id, runId: input.subject.kind === 'run-acceptance' ? input.subject.run.id : undefined, url: issue.html_url, message: `Waiting for GitHub issue #${issue.number}` , metadata: { issueNumber: issue.number } };
  }

  async readDecision(input: { gateId: string; kind?: GateDecisionKind; task?: Task; run?: RunRecord }): Promise<GateDecision | null> {
    const issue = await this.issueFor(input);
    if (!issue) return null;
    const metadata = parseMetadata(issue.body ?? '');
    const comments = await this.transport.api<GitHubComment[]>('GET', `${this.issuesPath()}/${issue.number}/comments?per_page=100`);
    const fromLabels = this.decisionFromLabels(issue.labels.map(labelName));
    const fromComments = [...comments].reverse().map(comment => this.decisionFromComment(comment)).find(Boolean);
    const decided = fromComments ?? fromLabels;
    const kind = input.kind ?? metadata.kind ?? 'spec-approval';
    const decisionMetadata: Record<string, string | number> = { issueNumber: issue.number };
    if (issue.html_url) decisionMetadata.url = issue.html_url;
    return { providerId: this.id, gateId: String(issue.number), kind, status: decided?.status ?? 'pending', taskId: metadata.taskId ?? input.task?.id ?? '', runId: metadata.runId ?? input.run?.id, decidedAt: decided?.at, decidedBy: decided?.by, message: decided?.message ?? (decided ? `GitHub issue #${issue.number} ${decided.status}` : `Waiting for GitHub issue #${issue.number}`), metadata: decisionMetadata };
  }

  checks(): HealthCheck[] { return [
    { id: 'github-gate:gh', label: 'GitHub CLI auth', run: async () => (await resolveGitHubToken()) ? { id: 'github-gate:gh', status: 'pass', message: 'GitHub auth available via env or gh' } : { id: 'github-gate:gh', status: 'fail', message: 'No GitHub auth: set GITHUB_TOKEN/GH_TOKEN or run gh auth login' } },
    { id: 'github-gate:config', label: 'GitHub gate repository config', run: async () => this.owner() && this.repo() ? { id: 'github-gate:config', status: 'pass', message: `GitHub repo ${this.owner()}/${this.repo()} configured` } : { id: 'github-gate:config', status: 'fail', message: '[github] owner and repo are required' } },
  ]; }

  private decisionFromLabels(labels: string[]): GitHubGateDecision | undefined { if (labels.includes('forge:approved') || labels.includes('forge:accepted')) return { status: 'approved' }; if (labels.includes('forge:rejected')) return { status: 'rejected' }; if (labels.includes('forge:canceled')) return { status: 'canceled' }; return undefined; }
  private decisionFromComment(comment: GitHubComment): GitHubGateDecision | undefined { const text = comment.body.trim().toLowerCase(); const command = text.match(/^\/(approve|accept|reject|cancel)\b/); if (!command) return undefined; const status = command[1] === 'reject' ? 'rejected' : command[1] === 'cancel' ? 'canceled' : 'approved'; return { status, by: comment.user?.login, at: comment.created_at, message: comment.body.trim() }; }
  private async issueFor(input: { gateId: string; task?: Task; run?: RunRecord }) { const byNumber = input.gateId.match(/^#?(\d+)$/); if (byNumber) return this.transport.api<GitHubIssue>('GET', `${this.issuesPath()}/${byNumber[1]}`); return this.findIssue(input.gateId) ?? (input.task ? this.findIssue(input.run ? `run:${input.run.id}` : `task:${input.task.id}`) : null); }
  private async findIssue(key: string) { const issues = await this.transport.api<GitHubIssue[]>('GET', `${this.issuesPath()}?state=open&labels=${encodeURIComponent('forge:gate')}&per_page=100`); return issues.find(issue => parseMetadata(issue.body ?? '').key === key) ?? null; }
  private gateKey(subject: GateSubject) { return subject.kind === 'run-acceptance' ? `run:${subject.run.id}` : `task:${subject.task.id}`; }
  private titleFor(subject: GateSubject) { return subject.kind === 'spec-approval' ? `Approve spec: ${subject.task.title}` : `Accept run: ${subject.task.title}`; }
  private bodyFor(subject: GateSubject, message?: string) { const parts = [message, `Task: ${subject.task.id} — ${subject.task.title}`]; if (subject.kind === 'spec-approval') parts.push(`\n## Spec\n\n${subject.specBody ?? subject.specPath}`); else parts.push(`\n## Run summary\n\n${subject.summary ?? `Run ${subject.run.id} completed.`}`); parts.push(`\nDecision: add label \`forge:approved\` / \`forge:accepted\`, or comment \`/approve\` / \`/accept\`. Reject with \`forge:rejected\` or \`/reject\`.`); parts.push(`${markerStart}${JSON.stringify({ key: this.gateKey(subject), kind: subject.kind, taskId: subject.task.id, runId: subject.kind === 'run-acceptance' ? subject.run.id : undefined })}${markerEnd}`); return parts.filter(Boolean).join('\n\n'); }
  private owner() { return this.config.owner ?? process.env.GITHUB_OWNER; }
  private repo() { return this.config.repo ?? process.env.GITHUB_REPO; }
  private issuesPath() { const owner = this.owner(), repo = this.repo(); if (!owner || !repo) throw new Error('[github] owner and repo are required'); return `/repos/${owner}/${repo}/issues`; }
}

function labelName(label: string | { name: string }) { return typeof label === 'string' ? label : label.name; }
function parseMetadata(body: string): { key?: string; kind?: GateDecisionKind; taskId?: string; runId?: string } { const start = body.indexOf(markerStart); if (start === -1) return {}; const end = body.indexOf(markerEnd, start); if (end === -1) return {}; try { return JSON.parse(body.slice(start + markerStart.length, end).trim()); } catch { return {}; } }
interface GitHubGateDecision { status: 'approved' | 'rejected' | 'canceled'; by?: string; at?: string; message?: string }
interface GitHubIssue { number: number; title: string; body?: string | null; labels: Array<string | { name: string }>; html_url?: string }
interface GitHubComment { body: string; created_at?: string; user?: { login?: string } }
