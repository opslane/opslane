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

    await defaultDependencies({ jobId: 'digest-job', execution: 3 }).askModel([]);

    expect(mocks.recordJobUsage).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'digest-job', execution: 3, phase: 'digest_write',
      usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
  });
});
