import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchGitHubRestTransport, GitHubIssuesWorkstreamProvider, type GitHubRestTransport } from '../src/providers/workstream-github/index.js';

class MockGitHub implements GitHubRestTransport {
  requests: { method: string; path: string; body?: unknown }[] = [];
  issues: any[] = [{
    number: 1,
    title: 'Build GitHub provider',
    body: 'Use issues\n\nDepends on: base\n\n<!-- forge-workstream:{"id":"github-provider","dependencies":["base"],"taskId":"task-1"}-->',
    labels: [{ name: 'forge:workstream' }, { name: 'forge:large' }, { name: 'forge:queued' }],
  }];
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requests.push({ method, path, body });
    if (method === 'GET' && path.includes('/issues?')) return this.issues as T;
    if (method === 'POST' && path.endsWith('/issues')) return { number: 2, title: (body as { title: string }).title, body: (body as { body: string }).body, labels: (body as { labels: string[] }).labels } as T;
    if (method === 'PATCH' && path.endsWith('/issues/1')) { this.issues[0] = { ...this.issues[0], ...(body as object) }; return this.issues[0] as T; }
    if (method === 'POST' && path.endsWith('/issues/1/comments')) return { id: 1 } as T;
    throw new Error(`unexpected ${method} ${path}`);
  }
}

describe('GitHubIssuesWorkstreamProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports host-side GitHub network failures with actionable context', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.github.com') }); }));
    const transport = new FetchGitHubRestTransport('token');

    await expect(transport.request('GET', '/repos/acme/repo/issues')).rejects.toThrow(/host network\/DNS connectivity to api\.github\.com/);
    await expect(transport.request('GET', '/repos/acme/repo/issues')).rejects.toThrow(/not inside the task Podman container/);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('maps GitHub issues to provider-neutral workstream items', async () => {
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, process.cwd(), new MockGitHub());

    await expect(provider.list()).resolves.toEqual([{ id: 'github-provider', title: 'Build GitHub provider', description: 'Use issues', dependencies: ['base'], complexity: 'large', status: 'queued', taskId: 'task-1' }]);
  });

  it('parses human-written dependency phrasing from issues without metadata blocks', async () => {
    const transport = new MockGitHub();
    transport.issues = [{ number: 7, title: 'Hand-written issue', body: 'Please do this.\n\nDepends on #3, #4\nBlocked by #5', labels: [{ name: 'forge:workstream' }] }];
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, process.cwd(), transport);

    await expect(provider.list()).resolves.toMatchObject([{ id: '#7', dependencies: ['#3', '#4', '#5'], complexity: 'small', status: 'planned' }]);
  });

  it('imports items by creating labelled GitHub issues with dependency metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-github-workstream-test-'));
    const transport = new MockGitHub();
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, root, transport);

    await provider.import({ items: [{ id: 'new-slice', title: 'New slice', description: 'Create in GitHub', dependencies: ['github-provider'], complexity: 'medium' }] });

    const create = transport.requests.find(request => request.method === 'POST' && request.path.endsWith('/issues'));
    expect(create?.body).toMatchObject({ title: 'New slice', labels: ['forge:workstream', 'forge:medium', 'forge:planned'] });
    expect(JSON.stringify(create?.body)).toContain('github-provider');
    await expect(readFile(join(root, '.forge', 'github-workstream-links.json'), 'utf8')).resolves.toContain('new-slice');
  });

  it('updates queue labels/body, comments with the Forge task id, and persists link cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-github-workstream-test-'));
    const transport = new MockGitHub();
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, root, transport);

    await provider.update('github-provider', { status: 'queued', taskId: 'task-123' });

    const patch = transport.requests.find(request => request.method === 'PATCH' && request.path.endsWith('/issues/1'));
    expect(patch?.body).toMatchObject({ labels: ['forge:workstream', 'forge:large', 'forge:queued'] });
    expect(JSON.stringify(patch?.body)).toContain('task-123');
    expect(transport.requests.some(request => request.method === 'POST' && request.path.endsWith('/comments') && (request.body as { body?: string }).body === 'Forge task id: task-123')).toBe(true);
    await expect(readFile(join(root, '.forge', 'github-workstream-links.json'), 'utf8')).resolves.toContain('task-123');
  });

  it('declares doctor checks for token and GitHub repo config', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'token');
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, process.cwd(), new MockGitHub());

    await expect(Promise.all(provider.checks().map(check => check.run()))).resolves.toEqual([
      { id: 'github-workstream:token', status: 'pass', message: 'GitHub token available (env or gh auth)' },
      { id: 'github-workstream:config', status: 'pass', message: 'GitHub repo acme/repo configured' },
    ]);
  });
});
