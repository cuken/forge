import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeRuntime } from '../src/core/forge.js';
import type { ChangeSetProvider } from '../src/core/changes.js';
import type { AgentProvider, RunRecord, Task, VcsProvider, WorkspaceProvider } from '../src/core/types.js';
import { FileTaskStore } from '../src/providers/store-filesystem/index.js';
import { FileRunStore } from '../src/providers/store-filesystem/runs.js';
import { FetchGitHubRestTransport, GitHubIssuesWorkstreamProvider, type GitHubRestTransport } from '../src/providers/workstream-github/index.js';

class MemoryVcs implements VcsProvider { id='vcs.memory'; kind='vcs' as const; async isRepo(){return true;} async init(){} async currentBranch(){return 'main';} async status(){return {clean:true, summary:''};} }
class MemoryWorkspace implements WorkspaceProvider { id='workspace.memory'; kind='workspace' as const; async create(input:{task:Task}){ return { id: input.task.id, path: '/tmp/ws/'+input.task.id, branch: 'forge/'+input.task.id }; } }
class MemoryAgent implements AgentProvider { id='agent.memory'; kind='agent' as const; async run(){ return { exitCode: 0, output: 'ok' }; } }
class MemoryChangeSet implements ChangeSetProvider { id='change-set.memory'; kind='change-set' as const; async review(input:{run:RunRecord}){ return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'changed' as const, files: ['file.txt'], summary: 'M file.txt' }; } async accept(input:{run:RunRecord}){ return { providerId: this.id, runId: input.run.id, taskId: input.run.taskId, status: 'accepted' as const, message: 'accepted file.txt', commit: { providerId: this.id, sha: 'abc123', id: 'abc123', branch: 'forge/github-provider' }, sync: { providerId: this.id, id: 'pr-9', url: 'https://example.test/pull/9', status: 'open' } }; } }

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

  it('closes linked issues with done audit labels, completion metadata, and accepted run comments', async () => {
    const transport = new MockGitHub();
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, process.cwd(), transport);

    await provider.completeWorkstreamItem({
      itemId: 'github-provider',
      status: 'completed',
      acceptedRunId: 'run-123',
      comment: 'Accepted changes',
      commit: { sha: 'abc123', branch: 'main', url: 'https://example.test/commit/abc123' },
      sync: { status: 'pushed', url: 'https://example.test/pull/1' },
      metadata: { taskId: 'task-123', taskTitle: 'Build GitHub provider' },
    });

    const patch = transport.requests.find(request => request.method === 'PATCH' && request.path.endsWith('/issues/1'));
    expect(patch?.body).toMatchObject({ state: 'closed' });
    expect((patch?.body as { labels: string[] }).labels).toContain('forge:done');
    expect((patch?.body as { labels: string[] }).labels).not.toContain('forge:queued');
    expect(JSON.stringify(patch?.body)).toContain('run-123');
    expect(JSON.stringify(patch?.body)).toContain('abc123');
    const comment = transport.requests.find(request => request.method === 'POST' && request.path.endsWith('/comments'));
    expect((comment?.body as { body?: string }).body).toContain('Forge accepted run run-123');
    expect((comment?.body as { body?: string }).body).toContain('task-123');
    expect((comment?.body as { body?: string }).body).toContain('abc123');
    expect((comment?.body as { body?: string }).body).toContain('pushed');
  });

  it('closes a tracker-backed GitHub issue when its Forge run is accepted and surfaces close failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-github-workstream-e2e-'));
    const transport = new MockGitHub();
    transport.issues[0].body = 'Use issues\n\n<!-- forge-workstream:{"id":"github-provider","dependencies":["base"]}-->';
    transport.issues[0].labels = [{ name: 'forge:workstream' }, { name: 'forge:small' }, { name: 'forge:planned' }];
    const provider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, root, transport);
    const rt = new ForgeRuntime({ root, store: new FileTaskStore(root), runStore: new FileRunStore(root), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), changeSet: new MemoryChangeSet(), workstream: provider, workstreamCompletion: provider });

    const [task] = await rt.enqueueWorkstream(['github-provider']);
    const [{ run }] = await rt.runReady(task.id);
    await expect(rt.acceptRun(run!, 'accept GitHub-backed workstream item')).resolves.toMatchObject({ status: 'accepted' });

    const close = transport.requests.find(request => request.method === 'PATCH' && request.path.endsWith('/issues/1') && (request.body as { state?: string }).state === 'closed');
    expect(close?.body).toMatchObject({ state: 'closed' });
    expect((close?.body as { labels: string[] }).labels).toContain('forge:done');
    expect(JSON.stringify(close?.body)).toContain(run!);
    expect(JSON.stringify(close?.body)).toContain(task.id);
    expect(JSON.stringify(close?.body)).toContain('abc123');
    const comments = transport.requests.filter(request => request.method === 'POST' && request.path.endsWith('/issues/1/comments'));
    expect(comments.some(request => (request.body as { body?: string }).body?.includes(`Forge accepted run ${run}`))).toBe(true);

    const failingTransport = new MockGitHub();
    failingTransport.issues[0].body = 'Use issues\n\n<!-- forge-workstream:{"id":"github-provider","dependencies":["base"]}-->';
    failingTransport.issues[0].labels = [{ name: 'forge:workstream' }, { name: 'forge:small' }, { name: 'forge:planned' }];
    const originalRequest = failingTransport.request.bind(failingTransport);
    failingTransport.request = async (method, path, body) => {
      if (method === 'PATCH' && path.endsWith('/issues/1') && (body as { state?: string }).state === 'closed') throw new Error('GitHub close rejected');
      return originalRequest(method, path, body);
    };
    const failingRoot = await mkdtemp(join(tmpdir(), 'forge-github-workstream-e2e-fail-'));
    const failingProvider = new GitHubIssuesWorkstreamProvider({ owner: 'acme', repo: 'repo' }, failingRoot, failingTransport);
    const failingRt = new ForgeRuntime({ root: failingRoot, store: new FileTaskStore(failingRoot), runStore: new FileRunStore(failingRoot), vcs: new MemoryVcs(), workspace: new MemoryWorkspace(), agent: new MemoryAgent(), changeSet: new MemoryChangeSet(), workstream: failingProvider, workstreamCompletion: failingProvider });
    const [failingTask] = await failingRt.enqueueWorkstream(['github-provider']);
    const [{ run: failingRun }] = await failingRt.runReady(failingTask.id);

    await expect(failingRt.acceptRun(failingRun!, 'accept but tracker fails')).rejects.toThrow('Workstream completion update failed after run');
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
