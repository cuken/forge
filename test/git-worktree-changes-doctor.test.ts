import { describe, expect, it } from 'vitest';
import { GitWorktreeChangeSetProvider } from '../src/providers/workspace-git-worktree/changes.js';

const passingRunCommand = async () => ({ exitCode: 0, stdout: '.git/worktrees/task\n.git\n', stderr: '' });

describe('GitWorktreeChangeSetProvider doctor checks', () => {
  it('passes when git worktree metadata and pointer targets are accessible', async () => {
    const checked: string[] = [];
    const provider = new GitWorktreeChangeSetProvider('/repo/worktree', {
      runCommand: passingRunCommand,
      readFile: async () => 'gitdir: ../.git/worktrees/task\n',
      access: async path => { checked.push(String(path)); },
    });

    await expect(provider.checks()[0].run()).resolves.toEqual({
      id: 'change-set.git-worktree:metadata',
      status: 'pass',
      message: 'git worktree metadata is accessible for review and accept',
    });
    expect(checked).toContain('/repo/worktree/.git/worktrees/task');
    expect(checked).toContain('/repo/worktree/.git');
    expect(checked).toContain('/repo/.git/worktrees/task');
  });

  it('fails when git cannot resolve metadata in the current environment', async () => {
    const provider = new GitWorktreeChangeSetProvider('/repo/worktree', {
      runCommand: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
      readFile: async () => '',
      access: async () => {},
    });

    await expect(provider.checks()[0].run()).resolves.toMatchObject({
      id: 'change-set.git-worktree:metadata',
      status: 'fail',
      message: 'git metadata is not readable from this checkout',
      detail: 'fatal: not a git repository',
    });
  });

  it('fails when a worktree gitdir pointer escapes to inaccessible host metadata', async () => {
    const provider = new GitWorktreeChangeSetProvider('/repo/worktree', {
      runCommand: passingRunCommand,
      readFile: async () => 'gitdir: /host/repo/.git/worktrees/task\n',
      access: async path => {
        if (String(path) === '/host/repo/.git/worktrees/task') throw new Error('permission denied');
      },
    });

    await expect(provider.checks()[0].run()).resolves.toMatchObject({
      id: 'change-set.git-worktree:metadata',
      status: 'fail',
      message: '.git metadata pointer is inaccessible from this environment',
      detail: 'permission denied',
    });
  });
});
