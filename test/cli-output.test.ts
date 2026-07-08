import { describe, expect, it } from 'vitest';
import { acceptResultExitCode, formatAcceptResult, logPrefix, processLogLine } from '../src/cli.js';
import type { AcceptChangeSetResult } from '../src/core/changes.js';

describe('process command output formatting', () => {
  it('adds timestamps and clear fixed-width labels to process log lines', () => {
    const now = new Date('2026-07-08T12:34:56.000Z');

    expect(processLogLine('wdo', 'specced 1, approved 1, accepted 1, errors 0', '⚡', now))
      .toBe('12:34:56 wdo        ⚡ specced 1, approved 1, accepted 1, errors 0');
    expect(logPrefix('agent', now)).toBe('12:34:56 agent     ');
  });
});

describe('accept command output formatting', () => {
  const base = { providerId: 'change-set.test', runId: 'run-1', taskId: 'task-1' };
  const result = (status: AcceptChangeSetResult['status'], message: string): AcceptChangeSetResult => ({ ...base, status, message });

  it('renders accepted and empty results as successful human-readable lines', () => {
    const accepted = result('accepted', 'Accepted abc123 from forge/task');
    const empty = result('empty', 'No changes to accept');

    expect(formatAcceptResult(accepted)).toBe('accepted run-1: Accepted abc123 from forge/task');
    expect(formatAcceptResult(empty)).toBe('empty run-1: No changes to accept');
    expect(formatAcceptResult(accepted, { dryRun: true })).toBe('dry-run accepted run-1: Accepted abc123 from forge/task');
    expect(acceptResultExitCode(accepted)).toBe(0);
    expect(acceptResultExitCode(empty)).toBe(0);
  });

  it('renders blocked and merge-conflict provider results without stack traces and exits non-zero', () => {
    const blocked = result('blocked', 'Cannot accept change set: project checkout has uncommitted changes');
    const conflict = result('merge-conflict', 'Cannot accept change set: merge conflict in README.md');

    expect(formatAcceptResult(blocked)).toBe('blocked run-1: Cannot accept change set: project checkout has uncommitted changes');
    expect(formatAcceptResult(conflict)).toBe('conflict run-1: Cannot accept change set: merge conflict in README.md');
    expect(formatAcceptResult(conflict)).not.toContain('Error:');
    expect(formatAcceptResult(conflict)).not.toContain(' at ');
    expect(acceptResultExitCode(blocked)).toBe(1);
    expect(acceptResultExitCode(conflict)).toBe(1);
  });
});
