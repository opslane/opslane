import { describe, expect, it } from 'vitest';
import { runObjectPrefix } from '../object-prefix.js';

describe('runObjectPrefix', () => {
  it('uses the UTC date at run start', () => {
    const startedAt = new Date('2026-09-15T23:30:00-07:00'); // 2026-09-16T06:30Z
    expect(runObjectPrefix('p1', 'r1', startedAt)).toBe('agent-runs/p1/2026-09-16/r1/');
  });

  it('rejects ids that would escape the prefix', () => {
    expect(() => runObjectPrefix('p/1', 'r1', new Date())).toThrow(/invalid/);
    expect(() => runObjectPrefix('p1', '../r', new Date())).toThrow(/invalid/);
  });
});
