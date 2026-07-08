import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinearWorkstreamProvider, type LinearGraphqlTransport } from '../src/providers/workstream-linear/index.js';

class MockLinear implements LinearGraphqlTransport {
  requests: { query: string; variables?: Record<string, unknown> }[] = [];
  issues = [{
    id: 'issue-1', identifier: 'ENG-1', title: 'Build Linear provider', description: 'Use GraphQL',
    labels: { nodes: [{ name: 'forge:large' }, { name: 'forge:queued' }] },
    inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'ENG-0' } }] },
  }];
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    this.requests.push({ query, variables });
    if (query.includes('ForgeLinearWorkstreamList')) return { issues: { nodes: this.issues } } as T;
    if (query.includes('ForgeLinearTeam')) return { teams: { nodes: [{ id: 'team-1' }] } } as T;
    if (query.includes('ForgeLinearProject')) return { projects: { nodes: [{ id: 'project-1' }] } } as T;
    if (query.includes('ForgeLinearCreateIssue')) return { issueCreate: { success: true, issue: { id: 'issue-2', identifier: 'ENG-2' } } } as T;
    if (query.includes('ForgeLinearFindLabel')) return { issueLabels: { nodes: [] } } as T;
    if (query.includes('ForgeLinearCreateLabel')) return { issueLabelCreate: { issueLabel: { id: 'label-queued' } } } as T;
    if (query.includes('ForgeLinearAddLabel')) return { issueAddLabel: { success: true } } as T;
    if (query.includes('ForgeLinearComment')) return { commentCreate: { success: true } } as T;
    throw new Error(`unexpected query: ${query}`);
  }
}

describe('LinearWorkstreamProvider', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('maps Linear issues to provider-neutral workstream items', async () => {
    const provider = new LinearWorkstreamProvider({ teamKey: 'ENG' }, process.cwd(), new MockLinear());

    await expect(provider.list()).resolves.toEqual([{ id: 'ENG-1', title: 'Build Linear provider', description: 'Use GraphQL', complexity: 'large', dependencies: ['ENG-0'], status: 'queued', taskId: undefined }]);
  });

  it('updates Linear queue state, comments with the Forge task id, and persists link cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-linear-test-'));
    const transport = new MockLinear();
    const provider = new LinearWorkstreamProvider({ teamKey: 'ENG' }, root, transport);

    await provider.update('ENG-1', { status: 'queued', taskId: 'task-123' });

    expect(transport.requests.some(request => request.query.includes('ForgeLinearCreateLabel') && request.variables?.name === 'forge:queued')).toBe(true);
    expect(transport.requests.some(request => request.query.includes('ForgeLinearAddLabel') && request.variables?.labelId === 'label-queued')).toBe(true);
    expect(transport.requests.some(request => request.query.includes('ForgeLinearComment') && request.variables?.body === 'Forge task id: task-123')).toBe(true);
    await expect(readFile(join(root, '.forge', 'linear-workstream-links.json'), 'utf8')).resolves.toContain('task-123');
  });

  it('imports new items by creating Linear issues and records created identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-linear-test-'));
    const transport = new MockLinear();
    const provider = new LinearWorkstreamProvider({ teamKey: 'ENG', project: 'Roadmap' }, root, transport);

    await provider.import({ items: [{ id: 'local-1', title: 'New slice', description: 'Create in Linear' }] });

    const create = transport.requests.find(request => request.query.includes('ForgeLinearCreateIssue'));
    expect(create?.variables?.input).toMatchObject({ teamId: 'team-1', projectId: 'project-1', title: 'New slice' });
    await expect(readFile(join(root, '.forge', 'linear-workstream-links.json'), 'utf8')).resolves.toContain('ENG-2');
  });

  it('declares doctor checks for API key and Linear config', async () => {
    vi.stubEnv('LINEAR_API_KEY', 'lin_api_key');
    const provider = new LinearWorkstreamProvider({ teamKey: 'ENG' }, process.cwd(), new MockLinear());

    await expect(Promise.all(provider.checks().map(check => check.run()))).resolves.toEqual([
      { id: 'linear:key', status: 'pass', message: 'LINEAR_API_KEY is set' },
      { id: 'linear:config', status: 'pass', message: 'Linear team ENG configured' },
    ]);
  });
});
