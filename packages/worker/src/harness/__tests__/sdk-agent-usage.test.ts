import { describe, expect, it } from 'vitest';
import { applyResultUsage } from '../sdk-agent.js';

const accumulated = () => ({ input: 5, output: 9, cacheRead: 700, cacheWrite: 80 });

describe('applyResultUsage', () => {
  it('overwrites accumulated totals with cumulative result usage', () => {
    const target = accumulated();
    expect(applyResultUsage(target, {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 120,
        output_tokens: 9_400,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 31_000,
      },
    })).toBe(true);
    expect(target).toEqual({ input: 120, output: 9_400, cacheRead: 250_000, cacheWrite: 31_000 });
  });

  it('keeps accumulated fields that a result omits', () => {
    const target = accumulated();
    expect(applyResultUsage(target, {
      type: 'result', subtype: 'error_max_turns',
      usage: { input_tokens: 10, output_tokens: 20 },
    })).toBe(true);
    expect(target).toEqual({ input: 10, output: 20, cacheRead: 700, cacheWrite: 80 });
  });

  it('changes nothing without result usage', () => {
    const target = accumulated();
    expect(applyResultUsage(target, { type: 'result', subtype: 'success' })).toBe(false);
    expect(applyResultUsage(target, { type: 'assistant', usage: { output_tokens: 1 } })).toBe(false);
    expect(target).toEqual(accumulated());
  });
});
