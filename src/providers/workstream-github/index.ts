import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthCheck } from '../../core/health.js';
import type { Task } from '../../core/types.js';
import type { WorkstreamCompletionUpdate, WorkstreamItem, WorkstreamProvider } from '../../core/workstream.js';
import { runCommand } from '../../util/command.js';
import { readJson, writeJson } from '../../util/fs.js';

// Token resolution order: env vars, then the gh CLI keyring, so users authenticated
// via `gh auth login` need no extra setup while CI can inject GITHUB_TOKEN.
export async function resolveGitHubToken(): Promise<string | undefined> {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const result = await runCommand('gh', ['auth', 'token']);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export interface GitHubWorkstreamConfig { owner?: string; repo?: string }
export interface GitHubRestTransport { request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> }

const complexities: Task['complexity'][] = ['trivial', 'small', 'medium', 'large'];
const markerStart = '<!-- forge-workstream:';
const markerEnd = '-->';
const bodyStart = '<!-- forge-body:start -->';
const bodyEnd = '<!-- forge-body:end -->';
type LinkCache = Record<string, { issueNumber?: number; taskId?: string }>;
type RawItem = { id?: unknown; title?: unknown; description?: unknown; dependencies?: unknown; complexity?: unknown; status?: unknown; taskId?: unknown };

export class FetchGitHubRestTransport implements GitHubRestTransport {
  constructor(private token?: string) {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.token ??= await resolveGitHubToken();
    if (!this.token) throw new Error('No GitHub token: set GITHUB_TOKEN/GH_TOKEN or run gh auth login');
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, { method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      const cause = error instanceof Error && 'cause' in error && error.cause instanceof Error ? `: ${error.cause.message}` : error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`GitHub REST request failed before response for ${method} ${path}${cause}. Check host network/DNS connectivity to api.github.com; this request runs in the Forge CLI process, not inside the task Podman container.`);
    }
    if (!response.ok) throw new Error(`GitHub REST request failed for ${method} ${path}: ${response.status} ${response.statusText}: ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export class GitHubIssuesWorkstreamProvider implements WorkstreamProvider {
  id = 'workstream.github';
  kind = 'workstream' as const;
  constructor(private config: GitHubWorkstreamConfig, private root = process.cwd(), private transport: GitHubRestTransport = new FetchGitHubRestTransport()) {}

  async import(input: { path?: string; items?: unknown[]; replace?: boolean } = {}): Promise<WorkstreamItem[]> {
    const source = input.items ?? (input.path ? await readJson<unknown>(input.path) : []);
    const items = this.normalize(source);
    const existing = await this.list();
    const existingById = new Map(existing.map(item => [item.id, item]));
    const rawIssues = await this.listRaw();
    const issueByItemId = new Map(rawIssues.map(issue => [this.issueToItem(issue, {}).id, issue]));
    const cache = await this.readCache();
    for (const item of items) {
      const previous = existingById.get(item.id);
      const merged = previous?.status === 'queued' ? { ...item, status: previous.status, taskId: previous.taskId } : item;
      const issue = issueByItemId.get(item.id);
      if (issue) {
        await this.transport.request('PATCH', `${this.issuesPath()}/${issue.number}`, { title: merged.title, body: this.bodyFor(merged), labels: this.labelsFor(merged) });
        cache[item.id] = { ...cache[item.id], issueNumber: issue.number, taskId: merged.taskId ?? cache[item.id]?.taskId };
        continue;
      }
      if (cache[item.id]?.issueNumber) continue;
      const created = await this.transport.request<GitHubIssue>('POST', this.issuesPath(), { title: merged.title, body: this.bodyFor(merged), labels: this.labelsFor(merged) });
      cache[item.id] = { issueNumber: created.number, taskId: merged.taskId };
    }
    await this.writeCache(cache);
    return this.list();
  }

  async list(): Promise<WorkstreamItem[]> {
    const cache = await this.readCache();
    const issues = await this.transport.request<GitHubIssue[]>('GET', `${this.issuesPath()}?state=open&labels=${encodeURIComponent('forge:workstream')}&per_page=100`);
    return issues.filter(issue => !issue.pull_request).map(issue => this.issueToItem(issue, cache));
  }

  async update(id: string, patch: Partial<Pick<WorkstreamItem, 'status' | 'taskId'>>): Promise<WorkstreamItem> {
    const issue = await this.findIssue(id);
    if (!issue) throw new Error(`No GitHub workstream issue '${id}'`);
    const current = this.issueToItem(issue, await this.readCache());
    const updated: WorkstreamItem = { ...current, ...patch };
    await this.transport.request('PATCH', `${this.issuesPath()}/${issue.number}`, { body: this.bodyFor(updated, issue.body ?? undefined), labels: this.labelsFor(updated) });
    if (patch.taskId) await this.transport.request('POST', `${this.issuesPath()}/${issue.number}/comments`, { body: queueComment(patch.taskId) });
    const cache = await this.readCache();
    cache[id] = { ...cache[id], issueNumber: issue.number, taskId: patch.taskId ?? cache[id]?.taskId };
    cache[`#${issue.number}`] = { issueNumber: issue.number, taskId: patch.taskId ?? cache[`#${issue.number}`]?.taskId };
    await this.writeCache(cache);
    return updated;
  }

  async completeWorkstreamItem(input: WorkstreamCompletionUpdate): Promise<void> {
    const issue = await this.findIssue(input.itemId, 'all');
    if (!issue) throw new Error(`No GitHub workstream issue '${input.itemId}'`);
    const labels = new Set(issue.labels.map(label => typeof label === 'string' ? label : label.name).filter((label): label is string => !!label));
    labels.delete('forge:planned');
    labels.delete('forge:queued');
    labels.add('forge:done');
    const body = this.bodyWithCompletionMetadata(issue.body ?? '', input);
    await this.transport.request('PATCH', `${this.issuesPath()}/${issue.number}`, { state: 'closed', labels: [...labels], body });
    await this.transport.request('POST', `${this.issuesPath()}/${issue.number}/comments`, { body: completionComment(input) });
  }

  checks(input: { scope?: 'host' | 'workspace' } = {}): HealthCheck[] { if (input.scope === 'workspace') return []; return [
    { id: 'github-workstream:token', label: 'GitHub token', run: async () => (await resolveGitHubToken()) ? { id: 'github-workstream:token', status: 'pass', message: 'GitHub token available (env or gh auth)' } : { id: 'github-workstream:token', status: 'fail', message: 'No GitHub token: set GITHUB_TOKEN/GH_TOKEN or run gh auth login' } },
    { id: 'github-workstream:config', label: 'GitHub repository config', run: async () => this.owner() && this.repo() ? { id: 'github-workstream:config', status: 'pass', message: `GitHub repo ${this.owner()}/${this.repo()} configured` } : { id: 'github-workstream:config', status: 'fail', message: '[github] owner and repo are required' } },
  ]; }

  private issueToItem(issue: GitHubIssue, cache: LinkCache): WorkstreamItem {
    const labels = issue.labels.map(label => typeof label === 'string' ? label : label.name);
    const metadata = parseMetadata(issue.body ?? '');
    const id = metadata.id ?? `#${issue.number}`;
    // Hand-written issues carry no metadata block; honor natural "Depends on #3, #4" /
    // "Blocked by #5" phrasing so humans can express ordering directly in GitHub.
    const dependencies = metadata.dependencies ?? parseHumanDependencies(issue.body ?? '');
    return { id, title: issue.title, description: stripMetadata(issue.body ?? '') || undefined, dependencies, complexity: complexities.find(level => labels.includes(`forge:${level}`)) ?? 'small', status: labels.includes('forge:queued') ? 'queued' : 'planned', taskId: metadata.taskId ?? cache[id]?.taskId ?? cache[`#${issue.number}`]?.taskId };
  }
  private async findIssue(id: string, state: 'open' | 'all' = 'open') { return (await this.listRaw(state)).find(issue => this.issueToItem(issue, {}).id === id || `#${issue.number}` === id || String(issue.number) === id); }
  private async listRaw(state: 'open' | 'all' = 'open') { return (await this.transport.request<GitHubIssue[]>('GET', `${this.issuesPath()}?state=${state}&labels=${encodeURIComponent('forge:workstream')}&per_page=100`)).filter(issue => !issue.pull_request); }
  private labelsFor(item: WorkstreamItem) { return ['forge:workstream', `forge:${item.complexity}`, item.status === 'queued' ? 'forge:queued' : 'forge:planned']; }
  private bodyFor(item: WorkstreamItem, previous?: string) {
    const description = stripMetadata(previous ?? item.description ?? '').trim() || '_No description provided._';
    const deps = item.dependencies.length ? item.dependencies.map(dep => `- \`${dep}\``).join('\n') : '- _None_';
    const task = item.taskId ? `\`${item.taskId}\`` : '_Not queued yet_';
    return `${bodyStart}\n${description}\n${bodyEnd}\n\n## Forge workstream details\n\n| Field | Value |\n| --- | --- |\n| Workstream item | \`${item.id}\` |\n| Status | \`${item.status}\` |\n| Complexity | \`${item.complexity}\` |\n| Forge task | ${task} |\n\n## Dependencies\n\n${deps}\n\n${markerStart}${JSON.stringify({ id: item.id, dependencies: item.dependencies, taskId: item.taskId })}${markerEnd}`.trim();
  }
  private bodyWithCompletionMetadata(previous: string, input: WorkstreamCompletionUpdate) { const metadata = parseMetadata(previous); return this.bodyFor({ id: metadata.id ?? input.itemId, title: input.itemId, description: stripMetadata(previous), dependencies: metadata.dependencies ?? [], complexity: 'small', status: 'planned', taskId: metadata.taskId ?? (typeof input.metadata?.taskId === 'string' ? input.metadata.taskId : undefined) }).replace(markerEnd, `,"completion":${JSON.stringify({ status: input.status, acceptedRunId: input.acceptedRunId, commit: input.commit, sync: input.sync })}${markerEnd}`); }
  private owner() { return this.config.owner ?? process.env.GITHUB_OWNER; }
  private repo() { return this.config.repo ?? process.env.GITHUB_REPO; }
  private issuesPath() { const owner = this.owner(), repo = this.repo(); if (!owner || !repo) throw new Error('[github] owner and repo are required'); return `/repos/${owner}/${repo}/issues`; }
  private cachePath() { return join(this.root, '.forge', 'github-workstream-links.json'); }
  private async readCache(): Promise<LinkCache> { try { return await readJson<LinkCache>(this.cachePath()); } catch { return {}; } }
  private async writeCache(cache: LinkCache) { await mkdir(join(this.root, '.forge'), { recursive: true }); await writeJson(this.cachePath(), cache); }
  private normalize(source: unknown): WorkstreamItem[] { const rawItems = Array.isArray(source) ? source : Array.isArray((source as { items?: unknown })?.items) ? (source as { items: unknown[] }).items : []; return rawItems.map((raw, index) => this.normalizeItem(raw as RawItem, index)); }
  private normalizeItem(raw: RawItem, index: number): WorkstreamItem { if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error(`Workstream item ${index + 1} is missing a title`); return { id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `item-${index + 1}`, title: raw.title.trim(), description: typeof raw.description === 'string' ? raw.description : undefined, dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.filter((dep): dep is string => typeof dep === 'string') : [], complexity: typeof raw.complexity === 'string' && complexities.includes(raw.complexity as Task['complexity']) ? raw.complexity as Task['complexity'] : 'small', status: raw.status === 'queued' ? 'queued' : 'planned', taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined }; }
}

function parseMetadata(body: string): { id?: string; dependencies?: string[]; taskId?: string } { const start = body.indexOf(markerStart); if (start === -1) return {}; const end = body.indexOf(markerEnd, start); if (end === -1) return {}; try { return JSON.parse(body.slice(start + markerStart.length, end).trim()); } catch { return {}; } }
function parseHumanDependencies(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/(?:depends on|blocked by)[:\s]+((?:#\d+[,\s]*)+)/gi)) {
    for (const ref of match[1].matchAll(/#(\d+)/g)) refs.add(`#${ref[1]}`);
  }
  return [...refs];
}
function stripMetadata(body: string): string {
  const bodyRegionStart = body.indexOf(bodyStart);
  const bodyRegionEnd = body.indexOf(bodyEnd, bodyRegionStart + bodyStart.length);
  if (bodyRegionStart !== -1 && bodyRegionEnd !== -1) return body.slice(bodyRegionStart + bodyStart.length, bodyRegionEnd).trim();
  const start = body.indexOf(markerStart);
  if (start === -1) return body.trim();
  const end = body.indexOf(markerEnd, start);
  return `${body.slice(0, start)}${end === -1 ? '' : body.slice(end + markerEnd.length)}`.replace(/\n\nDepends on:.*$/s, '').trim();
}
function queueComment(taskId: string): string { return `## Forge queued this work\n\n- Task: \`${taskId}\`\n\nForge will update this issue again when the linked task is accepted.`; }
function completionComment(input: WorkstreamCompletionUpdate): string {
  const lines = ['## Forge completed this work', '', `- Accepted run: \`${input.acceptedRunId ?? 'unknown'}\``];
  if (input.metadata?.taskId) lines.push(`- Task: \`${input.metadata.taskId}\`${input.metadata.taskTitle ? ` — ${input.metadata.taskTitle}` : ''}`);
  if (input.commit) lines.push(`- Commit: ${formatRef(input.commit)}`);
  if (input.sync) lines.push(`- Sync: ${formatRef(input.sync)}`);
  if (input.comment) lines.push('', '### Acceptance message', '', input.comment);
  return lines.join('\n');
}
function formatRef(ref: NonNullable<WorkstreamCompletionUpdate['commit']>): string { return [ref.sha, ref.branch, ref.url, ref.status, ref.message].filter(Boolean).join(' | '); }
interface GitHubIssue { number: number; title: string; body?: string | null; labels: Array<string | { name: string }>; pull_request?: unknown }
