import { describe, expect, it } from 'vitest';
import { logPrefix, processLogLine } from '../src/cli.js';

describe('process command output formatting', () => {
  it('adds timestamps and clear fixed-width labels to process log lines', () => {
    const now = new Date('2026-07-08T12:34:56.000Z');

    expect(processLogLine('wdo', 'specced 1, approved 1, accepted 1, errors 0', '⚡', now))
      .toBe('12:34:56 wdo        ⚡ specced 1, approved 1, accepted 1, errors 0');
    expect(logPrefix('agent', now)).toBe('12:34:56 agent     ');
  });
});
