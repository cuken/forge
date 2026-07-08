import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HealthCheck } from '../../core/health.js';
import type { Task } from '../../core/types.js';
import type { WorkstreamItem, WorkstreamProvider } from '../../core/workstream.js';
import { readJson, writeJson } from '../../util/fs.js';

export interface LinearConfig { teamKey?: string; project?: string }
export interface LinearGraphqlTransport { request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> }

const complexities: Task['complexity'][] = ['trivial', 'small', 'medium', 'large'];
type LinkCache = Record<string, { taskId?: string; issueId?: string; identifier?: string }>;

export class FetchLinearGraphqlTransport implements LinearGraphqlTransport {
  constructor(private apiKey = process.env.LINEAR_API_KEY) {}
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.apiKey) throw new Error('LINEAR_API_KEY is not set');
    const response = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: this.apiKey }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new Error(`Linear GraphQL request failed: ${response.status} ${response.statusText}`);
    const json = await response.json() as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Linear GraphQL error: ${json.errors.map(e => e.message).join('; ')}`);
    return json.data as T;
  }
}

export class LinearWorkstreamProvider implements WorkstreamProvider {
  id = 'workstream.linear';
  kind = 'workstream' as const;
  constructor(private config: LinearConfig, private root = process.cwd(), private transport: LinearGraphqlTransport = new FetchLinearGraphqlTransport()) {}

  async import(input: { items?: unknown[] } = {}): Promise<WorkstreamItem[]> {
    const items = this.normalizeItems(input.items ?? []);
    const existing = await this.list();
    const existingIds = new Set(existing.map(item => item.id));
    const cache = await this.readCache();
    const teamId = await this.teamId();
    const projectId = this.config.project ? await this.projectId(teamId) : undefined;
    for (const item of items) {
      if (existingIds.has(item.id) || cache[item.id]?.issueId) continue;
      const data = await this.transport.request<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(`mutation ForgeLinearCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`, { input: { teamId, projectId, title: item.title, description: item.description } });
      cache[item.id] = { issueId: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier };
    }
    await this.writeCache(cache);
    return this.list();
  }

  async list(): Promise<WorkstreamItem[]> {
    const teamKey = this.requireTeamKey();
    const cache = await this.readCache();
    const data = await this.transport.request<{ issues: { nodes: LinearIssue[] } }>(`query ForgeLinearWorkstreamList($teamKey: String!) { issues(filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title description labels { nodes { name } } inverseRelations { nodes { type issue { identifier } } } } } }`, { teamKey });
    return data.issues.nodes.map(issue => this.issueToItem(issue, cache));
  }

  async update(id: string, patch: Partial<Pick<WorkstreamItem, 'status' | 'taskId'>>): Promise<WorkstreamItem> {
    const issue = await this.findIssue(id);
    if (!issue) throw new Error(`No Linear issue '${id}'`);
    if (patch.status === 'queued') await this.ensureLabel(issue.id, 'forge:queued');
    if (patch.taskId) await this.transport.request(`mutation ForgeLinearComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`, { issueId: issue.id, body: `Forge task id: ${patch.taskId}` });
    const cache = await this.readCache();
    cache[id] = { ...cache[id], issueId: issue.id, identifier: issue.identifier, taskId: patch.taskId ?? cache[id]?.taskId };
    cache[issue.identifier] = { ...cache[issue.identifier], issueId: issue.id, identifier: issue.identifier, taskId: patch.taskId ?? cache[issue.identifier]?.taskId };
    await this.writeCache(cache);
    return this.issueToItem({ ...issue, labels: { nodes: [...issue.labels.nodes, ...(patch.status === 'queued' ? [{ name: 'forge:queued' }] : [])] } }, cache);
  }

  checks(): HealthCheck[] { return [
    { id: 'linear:key', label: 'Linear API key', run: async () => process.env.LINEAR_API_KEY ? { id: 'linear:key', status: 'pass', message: 'LINEAR_API_KEY is set' } : { id: 'linear:key', status: 'fail', message: 'LINEAR_API_KEY is not set' } },
    { id: 'linear:config', label: 'Linear config', run: async () => this.config.teamKey ? { id: 'linear:config', status: 'pass', message: `Linear team ${this.config.teamKey} configured` } : { id: 'linear:config', status: 'fail', message: '[linear] teamKey is required' } },
  ]; }

  private issueToItem(issue: LinearIssue, cache: LinkCache): WorkstreamItem {
    const labels = issue.labels.nodes.map(label => label.name);
    const complexity = complexities.find(level => labels.includes(`forge:${level}`)) ?? 'small';
    // Linear models "blocked by" as an inverse relation of type "blocks": the related
    // issue blocks this one, so it is a dependency that must finish first.
    const dependencies = issue.inverseRelations?.nodes.filter(rel => rel.type === 'blocks').map(rel => rel.issue?.identifier).filter((v): v is string => !!v) ?? [];
    return { id: issue.identifier, title: issue.title, description: issue.description ?? undefined, dependencies, complexity, status: labels.includes('forge:queued') ? 'queued' : 'planned', taskId: cache[issue.identifier]?.taskId ?? cache[issue.id]?.taskId };
  }

  private async findIssue(identifier: string): Promise<LinearIssue | undefined> { return (await this.listRaw()).find(issue => issue.identifier === identifier || issue.id === identifier); }
  private async listRaw() { const teamKey = this.requireTeamKey(); return (await this.transport.request<{ issues: { nodes: LinearIssue[] } }>(`query ForgeLinearWorkstreamList($teamKey: String!) { issues(filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title description labels { nodes { name } } inverseRelations { nodes { type issue { identifier } } } } } }`, { teamKey })).issues.nodes; }
  private async ensureLabel(issueId: string, name: string) {
    const teamId = await this.teamId();
    const found = await this.transport.request<{ issueLabels: { nodes: { id: string }[] } }>(`query ForgeLinearFindLabel($teamId: ID, $name: String!) { issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) { nodes { id } } }`, { teamId, name });
    let labelId = found.issueLabels.nodes[0]?.id;
    if (!labelId) {
      const created = await this.transport.request<{ issueLabelCreate: { issueLabel: { id: string } } }>(`mutation ForgeLinearCreateLabel($teamId: String!, $name: String!) { issueLabelCreate(input: { teamId: $teamId, name: $name }) { issueLabel { id } } }`, { teamId, name });
      labelId = created.issueLabelCreate.issueLabel.id;
    }
    await this.transport.request(`mutation ForgeLinearAddLabel($issueId: String!, $labelId: String!) { issueAddLabel(id: $issueId, labelId: $labelId) { success } }`, { issueId, labelId });
  }
  private requireTeamKey() { if (!this.config.teamKey) throw new Error('[linear] teamKey is required'); return this.config.teamKey; }
  private async teamId() { const key = this.requireTeamKey(); const data = await this.transport.request<{ teams: { nodes: { id: string }[] } }>(`query ForgeLinearTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key }); const id = data.teams.nodes[0]?.id; if (!id) throw new Error(`Linear team '${key}' not found`); return id; }
  private async projectId(teamId: string) { const data = await this.transport.request<{ projects: { nodes: { id: string }[] } }>(`query ForgeLinearProject($teamId: String!, $name: String!) { projects(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) { nodes { id } } }`, { teamId, name: this.config.project }); return data.projects.nodes[0]?.id; }
  private cachePath() { return join(this.root, '.forge', 'linear-workstream-links.json'); }
  private async readCache(): Promise<LinkCache> { try { return await readJson<LinkCache>(this.cachePath()); } catch { return {}; } }
  private async writeCache(cache: LinkCache) { await mkdir(join(this.root, '.forge'), { recursive: true }); await writeJson(this.cachePath(), cache); }
  private normalizeItems(source: unknown): WorkstreamItem[] { const raw = Array.isArray(source) ? source : []; return raw.map((item, index) => ({ id: typeof item?.id === 'string' ? item.id : `item-${index + 1}`, title: typeof item?.title === 'string' ? item.title : `Item ${index + 1}`, description: typeof item?.description === 'string' ? item.description : undefined, dependencies: Array.isArray(item?.dependencies) ? item.dependencies.filter((d: unknown): d is string => typeof d === 'string') : [], complexity: complexities.includes(item?.complexity) ? item.complexity : 'small', status: 'planned' as const })); }
}

interface LinearIssue { id: string; identifier: string; title: string; description?: string | null; labels: { nodes: { name: string }[] }; inverseRelations?: { nodes: { type: string; issue?: { identifier: string } | null }[] } }
