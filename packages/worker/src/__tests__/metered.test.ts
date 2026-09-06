import { describe, expect, it, vi } from 'vitest';
import { PhaseMeter, usageFromResponse } from '../metered.js';

const usage = (output: number) => ({ input: 10, output, cacheRead: 100, cacheWrite: 5 });

describe('PhaseMeter', () => {
  it('writes nothing when no model call was made', async () => {
    const record = vi.fn();
    await new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record }).flush();
    expect(record).not.toHaveBeenCalled();
  });

  it('aggregates repeat calls per model and keeps fallback models separate', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(100));
    meter.add('claude-sonnet-5', usage(50));
    meter.add('claude-haiku-4-5-20251001', usage(20));

    await meter.flush();

    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'j', execution: 0, phase: 'diff_judge', model: 'claude-sonnet-5',
      usage: { input: 20, output: 150, cacheRead: 200, cacheWrite: 10 },
    }));
  });

  it('never throws and a later flush retries only failed models', async () => {
    const record = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));

    await expect(meter.flush()).resolves.toBeUndefined();
    await expect(meter.flush()).resolves.toBeUndefined();

    expect(record).toHaveBeenCalledTimes(2);
  });

  it('prices the aggregated usage per model', async () => {
    // cost_usd is the whole point of the meter and nothing else asserts it.
    // Haiku is 1 USD per million input tokens.
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-haiku-4-5-20251001', {
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    await meter.flush();
    expect(record.mock.calls[0]![0].costUsd).toBeCloseTo(1, 4);
  });

  it('prices a model the table does not list rather than charging zero', async () => {
    // pricingFor falls back silently, so pin the fallback: an unpriced new
    // model must cost something visible, not nothing.
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-not-in-the-table', {
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    await meter.flush();
    expect(record.mock.calls[0]![0].costUsd).toBeGreaterThan(0);
  });

  it('drops usage added after the flush rather than writing a colliding row', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));
    await meter.flush();
    meter.add('claude-sonnet-5', usage(99));
    await meter.flush();
    expect(record).toHaveBeenCalledOnce();
  });

  it('is idempotent and coalesces concurrent flushes', async () => {
    const record = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    );
    const meter = new PhaseMeter({ jobId: 'j', execution: 0, phase: 'diff_judge', record });
    meter.add('claude-sonnet-5', usage(1));

    await Promise.all([meter.flush(), meter.flush()]);
    await meter.flush();

    expect(record).toHaveBeenCalledOnce();
  });
});

describe('usageFromResponse', () => {
  it('maps every Anthropic usage key and zeroes non-numeric ones', () => {
    expect(usageFromResponse({ usage: {
      input_tokens: 1, output_tokens: 2,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    } })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(usageFromResponse({ usage: { input_tokens: Number.NaN, output_tokens: '5' } }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('normalizes present and omitted Anthropic usage fields', () => {
    expect(usageFromResponse({ usage: { input_tokens: 4, output_tokens: 6 } }))
      .toEqual({ input: 4, output: 6, cacheRead: 0, cacheWrite: 0 });
    expect(usageFromResponse(null))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
