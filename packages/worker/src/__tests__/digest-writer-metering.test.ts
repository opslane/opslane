import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  recordJobUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mocks.create } })),
}));
vi.mock('../db.js', () => ({
  getPool: vi.fn(),
  recordJobUsage: mocks.recordJobUsage,
}));

import { defaultDependencies } from '../digest-writer/job.js';

describe('digest writer metering', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    mocks.create.mockReset();
    mocks.recordJobUsage.mockClear();
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('records model usage when job context is bound into the default dependency', async () => {
    mocks.create.mockResolvedValueOnce({
      content: [{
        type: 'tool_use', name: 'submit_daily_message', input: { included: [], deferred: [] },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 80, output_tokens: 20 },
    });

    const deps = defaultDependencies({ jobId: 'digest-job', execution: 3 });
    await deps.askModel([]);
    // The meter spans the run, not the call, so the ledger row lands on flush.
    await deps.flushUsage?.();

    expect(mocks.recordJobUsage).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'digest-job', execution: 3, phase: 'digest_write',
      usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
  });

  it('sums repeat calls in one run into a single ledger row', async () => {
    for (const output of [20, 35]) {
      mocks.create.mockResolvedValueOnce({
        content: [{
          type: 'tool_use', name: 'submit_daily_message', input: { included: [], deferred: [] },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 80, output_tokens: output },
      });
    }

    const deps = defaultDependencies({ jobId: 'digest-job', execution: 3 });
    await deps.askModel([]);
    await deps.askModel([]);
    await deps.flushUsage?.();

    // One insert, not two. A second row would share the ledger key
    // (job, execution, phase, model) and be dropped by ON CONFLICT DO NOTHING,
    // silently losing the second call's spend.
    expect(mocks.recordJobUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordJobUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: { input: 160, output: 55, cacheRead: 0, cacheWrite: 0 },
    }));
  });

  it('records usage for a call that was paid for and then threw', async () => {
    mocks.create.mockResolvedValueOnce({
      content: [], stop_reason: 'max_tokens', usage: { input_tokens: 80, output_tokens: 20 },
    });

    const deps = defaultDependencies({ jobId: 'digest-job', execution: 3 });
    await expect(deps.askModel([])).rejects.toThrow('truncated');
    await deps.flushUsage?.();

    expect(mocks.recordJobUsage).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'digest_write', usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
  });

  it('writes nothing when no job context is bound', async () => {
    mocks.create.mockResolvedValueOnce({
      content: [{
        type: 'tool_use', name: 'submit_daily_message', input: { included: [], deferred: [] },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 80, output_tokens: 20 },
    });

    const deps = defaultDependencies();
    await deps.askModel([]);
    await deps.flushUsage?.();

    expect(mocks.recordJobUsage).not.toHaveBeenCalled();
  });
});
