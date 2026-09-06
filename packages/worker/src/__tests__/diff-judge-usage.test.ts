import { describe, expect, it } from 'vitest';
import { JUDGE_MODEL } from '../harness/diff-judge.js';

describe('diff judge usage attribution', () => {
  it('exports the Haiku model it actually calls', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
  });
});
