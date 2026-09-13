import { describe, expect, it } from 'vitest';
import { FIRST_LOOK_MAX_TOKENS_DEFAULT, firstLookMaxTokens, modelTimeoutMs } from '../match-job.js';

describe('firstLookMaxTokens', () => {
  it('defaults above the 8,192 ceiling that truncated production first looks', () => {
    expect(FIRST_LOOK_MAX_TOKENS_DEFAULT).toBeGreaterThan(8_192);
    expect(firstLookMaxTokens(undefined)).toBe(FIRST_LOOK_MAX_TOKENS_DEFAULT);
  });
  it('honors a valid override', () => {
    expect(firstLookMaxTokens('32000')).toBe(32_000);
  });
  it.each(['', 'abc', '1000.5', '512', '32001', '-1'])('falls back for %j', (value) => {
    expect(firstLookMaxTokens(value)).toBe(FIRST_LOOK_MAX_TOKENS_DEFAULT);
  });
});

describe('modelTimeoutMs', () => {
  it('keeps the SDK default for short outputs and grows with the token ceiling', () => {
    expect(modelTimeoutMs(8_192)).toBe(163_840);
    expect(modelTimeoutMs(4_096)).toBe(120_000);
    expect(modelTimeoutMs(FIRST_LOOK_MAX_TOKENS_DEFAULT)).toBeGreaterThan(300_000);
  });
});
