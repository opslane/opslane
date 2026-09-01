import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processNarration } from '../job.js';

const dbMock = vi.hoisted(() => ({
  claimPendingNarrative: vi.fn(),
  reserveNarrativeBudget: vi.fn(),
  narrativeMonthlySpendExceeded: vi.fn(),
  finishNarrative: vi.fn(),
  enqueueJob: vi.fn(),
}));
vi.mock('../../db.js', () => dbMock);

const job = {
  id: 'j1', projectId: 'p1', sessionId: 's1', workerId: 'w1', leaseGeneration: '1',
} as never;
const envelopes = [{
  events: [
    { type: 4, data: { href: 'https://x.test/assets' }, timestamp: 1_000 },
    { type: 5, timestamp: 2_000, data: { tag: 'opslane.telemetry', payload: {
      kind: 'click', clickId: 'c1', selector: 'button.a', cursor: 'pointer', at: 2_000,
    } } },
  ],
  meta: { chunked_at: 1_000, has_full_snapshot: false, sdk_version: 'test' },
}] as never;

function dependencies(modelText: string) {
  return {
    client: {
      modelName: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: modelText, inputTokens: 10, outputTokens: 5, stopReason: 'end_turn',
      }),
    } as never,
    loadChunks: vi.fn().mockResolvedValue(envelopes),
    dailyCap: 2_000,
    wallClockBudgetMs: 60_000,
    appContext: '',
    projectName: 'Test',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.claimPendingNarrative.mockResolvedValue({ promptVersion: 1 });
  dbMock.reserveNarrativeBudget.mockResolvedValue(true);
  dbMock.narrativeMonthlySpendExceeded.mockResolvedValue(false);
  dbMock.finishNarrative.mockResolvedValue({ written: true });
});

describe('processNarration', () => {
  it('no-ops when the reservation cannot be claimed', async () => {
    dbMock.claimPendingNarrative.mockResolvedValue(null);
    const deps = dependencies('{}');
    await processNarration(job, deps, new AbortController().signal);
    expect((deps.client as unknown as { complete: ReturnType<typeof vi.fn> }).complete).not.toHaveBeenCalled();
  });

  it('records invalid model output as a terminal parse failure', async () => {
    await processNarration(job, dependencies('not JSON'), new AbortController().signal);
    expect(dbMock.finishNarrative).toHaveBeenCalledWith(job, expect.objectContaining({
      status: 'parse_failed', rawResponse: 'not JSON',
    }));
  });

  it('stores observations before enqueueing frame verification', async () => {
    await processNarration(job, dependencies(JSON.stringify({
      user_goal: 'Save', narrative: 'The save was slow.', notable: true,
      observations: [{
        category: 'slow_response', what: 'Saving was slow.', evidence_lines: ['L1'], severity: 'low',
      }],
    })), new AbortController().signal);
    expect(dbMock.finishNarrative).toHaveBeenCalledWith(job, expect.objectContaining({
      status: 'ok', verificationState: 'pending',
    }));
    expect(dbMock.enqueueJob).toHaveBeenCalledWith('session_verify_frames', 'p1', 's1');
  });

  it('does not enqueue verification for an empty observation set', async () => {
    await processNarration(job, dependencies(JSON.stringify({
      user_goal: 'Browse', narrative: 'No friction observed.', notable: false, observations: [],
    })), new AbortController().signal);
    expect(dbMock.enqueueJob).not.toHaveBeenCalled();
  });
});
