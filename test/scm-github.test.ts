import { describe, expect, it } from 'vitest';
import { GitHubScmProvider } from '../src/providers/scm-github/index.js';
import type { CommandResult } from '../src/util/command.js';

function ok(stdout = ''): CommandResult { return { exitCode: 0, stdout, stderr: '' }; }
function fail(stderr = 'not found'): CommandResult { return { exitCode: 1, stdout: '', stderr }; }

describe('GitHubScmProvider release VCS capability', () => {
  it('creates a configured release branch from release metadata and exposes the ref', async () => {
    const calls: string[][] = [];
    const provider = new GitHubScmProvider({ owner: 'acme', repo: 'widget', releaseBranchTemplate: 'releases/{target.id}/v{version}', releaseBaseBranch: 'stable' }, async (_command, args) => {
      calls.push(args);
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranchRef: { name: 'main' } }));
      if (args.join(' ') === 'api repos/acme/widget/git/ref/heads/releases/pkg/v1.2.3') return fail();
      if (args.join(' ') === 'api repos/acme/widget/git/ref/heads/stable --jq .object.sha') return ok('abc123\n');
      if (args[0] === 'api' && args[1] === 'repos/acme/widget/git/refs') return ok(JSON.stringify({ ref: 'refs/heads/releases/pkg/v1.2.3' }));
      return fail(`unexpected ${args.join(' ')}`);
    });

    const release = { id: 'rel-1', version: '1.2.3', status: 'preparing' as const, target: { kind: 'package', id: 'pkg' }, createdAt: 'now', updatedAt: 'now' };
    const target = await provider.ensureReleaseTarget({ release });
    const ref = await provider.resolveReleaseRef({ release, target });
    const review = await provider.prepareReleaseReview({ release, target, ref });

    expect(target).toMatchObject({ providerId: 'scm.github', targetKind: 'package', targetId: 'pkg', url: 'https://github.com/acme/widget' });
    expect(ref).toMatchObject({ ref: 'releases/pkg/v1.2.3', baseRef: 'stable', headRef: 'releases/pkg/v1.2.3' });
    expect(review).toMatchObject({ status: 'ready', reviewUrl: 'https://github.com/acme/widget/compare/stable...releases/pkg/v1.2.3' });
    expect(calls).toContainEqual(['api', 'repos/acme/widget/git/refs', '-f', 'ref=refs/heads/releases/pkg/v1.2.3', '-f', 'sha=abc123']);
  });

  it('reuses an existing release branch without creating a ref', async () => {
    const calls: string[][] = [];
    const provider = new GitHubScmProvider({}, async (_command, args) => {
      calls.push(args);
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'api' && args[1] === 'repos/acme/widget/git/ref/heads/release/2.0.0') return ok(JSON.stringify({ ref: 'refs/heads/release/2.0.0' }));
      return fail(`unexpected ${args.join(' ')}`);
    });

    const release = { id: 'rel-2', version: '2.0.0', status: 'preparing' as const, target: { kind: 'package', id: 'forge' }, createdAt: 'now', updatedAt: 'now' };
    const ref = await provider.resolveReleaseRef({ release, target: await provider.ensureReleaseTarget({ release }) });

    expect(ref).toMatchObject({ ref: 'release/2.0.0', baseRef: 'main' });
    expect(calls.some(args => args[1] === 'repos/acme/widget/git/refs')).toBe(false);
  });
});
