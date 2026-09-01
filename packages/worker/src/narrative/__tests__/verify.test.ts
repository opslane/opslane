import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionNarrative } from '@opslane/shared';
import { processFrameVerification, selectMoments, validateVerification } from '../verify.js';

const dbMock = vi.hoisted(() => ({
  claimVerifyingNarrative: vi.fn(),
  reserveNarrativeBudget: vi.fn(),
  narrativeMonthlySpendExceeded: vi.fn(),
  finalizeVerification: vi.fn(),
}));
vi.mock('../../db.js', () => dbMock);

const narrative: SessionNarrative = {
  userGoal: 'Save an asset', narrative: 'Saving was confusing.', notable: true,
  observations: [
    { id: '0-aaaa', category: 'validation_confusion', what: 'phantom error', evidenceLines: ['L2'], severity: 'high' },
    { id: '1-bbbb', category: 'slow_response', what: 'slow save', evidenceLines: ['L3'], severity: 'low' },
  ],
};
const timeline = {
  startTs: 1_000,
  lines: [
    { t: 'page', s: null, r: '/assets', a: 1_000 },
    { t: 'click', s: 'button.save', r: '/assets', a: 6_000 },
    { t: 'slow', s: null, r: '/assets', a: 10_000 },
  ],
};
const job = { id: 'j1', projectId: 'p1', sessionId: 's1', workerId: 'w', leaseGeneration: '1' } as never;
const gradesJson = JSON.stringify({ grades: [
  { observationId: '0-aaaa', grade: 'refuted', reason: 'not visible' },
  { observationId: '1-bbbb', grade: 'corrected', reason: 'different delay', replacementWhat: 'save takes 12 seconds' },
] });

function dependencies(modelText = gradesJson) {
  return {
    client: {
      modelName: 'vision',
      complete: vi.fn().mockResolvedValue({ text: modelText, inputTokens: 20, outputTokens: 10, stopReason: 'end_turn' }),
    } as never,
    loadChunks: vi.fn().mockResolvedValue([]),
    capture: vi.fn().mockResolvedValue({ frames: [
      { offsetMs: 5_000, pair: 'a' as const, png: Buffer.from('png') },
      { offsetMs: 5_000, pair: 'b' as const, png: Buffer.from('png2') },
    ], assetsMissing: false }),
    uploadFrame: vi.fn().mockResolvedValue(undefined),
    dailyCap: 2_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.claimVerifyingNarrative.mockResolvedValue({ promptVersion: 1, narrative, timeline });
  dbMock.reserveNarrativeBudget.mockResolvedValue(true);
  dbMock.narrativeMonthlySpendExceeded.mockResolvedValue(false);
});

describe('verification validation', () => {
  it('requires exactly one known grade per observation', () => {
    expect(validateVerification(gradesJson, narrative).ok).toBe(true);
    expect(validateVerification(JSON.stringify({ grades: [
      { observationId: '0-aaaa', grade: 'confirmed', reason: 'yes' },
    ] }), narrative).ok).toBe(false);
    expect(validateVerification(gradesJson.replace('1-bbbb', 'unknown'), narrative).ok).toBe(false);
  });

  it('selects highest-severity cited moments first', () => {
    expect(selectMoments(narrative, timeline)).toEqual([5_000, 9_000]);
  });

  it('uses the first non-idle citation for a capture moment', () => {
    const idleFirstNarrative: SessionNarrative = {
      userGoal: 'Save an asset', narrative: 'Saving was confusing.', notable: true,
      observations: [{
        id: '0-idle', category: 'no_feedback_after_action', what: 'no feedback',
        evidenceLines: ['L1', 'L2'], severity: 'high',
      }],
    };
    const idleFirstTimeline = {
      startTs: 1_000,
      lines: [
        { t: '[user idle 2m 0s — away from the app]', s: null, r: '/assets', a: 1_000, k: 'idle' as const },
        { t: 'click', s: 'button.save', r: '/assets', a: 121_000 },
      ],
    };
    expect(selectMoments(idleFirstNarrative, idleFirstTimeline)).toEqual([120_000]);
  });
});

describe('processFrameVerification', () => {
  it('drops refuted observations and substitutes corrected text', async () => {
    await processFrameVerification(job, dependencies(), new AbortController().signal);
    const args = dbMock.finalizeVerification.mock.calls[0]?.[1];
    expect(args.state).toBe('ok');
    expect(args.signalRows).toHaveLength(1);
    expect(args.signalRows[0].what).toBe('save takes 12 seconds');
    expect(args.inputTokens).toBe(20);
  });

  it('falls back to ungraded emission when capture fails', async () => {
    const deps = dependencies();
    deps.capture.mockRejectedValue(new Error('capture failed'));
    await processFrameVerification(job, deps, new AbortController().signal);
    expect(dbMock.finalizeVerification.mock.calls[0]?.[1]).toMatchObject({
      state: 'failed', signalRows: expect.arrayContaining([expect.objectContaining({ what: 'phantom error' })]),
    });
  });

  it('stores the failure reason on fallback', async () => {
    const deps = dependencies();
    deps.capture.mockRejectedValue(new Error('chromium crashed: SIGTRAP'));
    await processFrameVerification(job, deps, new AbortController().signal);
    const call = dbMock.finalizeVerification.mock.calls[0]![1];
    expect(call.state).toBe('failed');
    expect(call.reason).toContain('chromium crashed');
  });

  it('stores the rejection reason when the vision output is invalid', async () => {
    await processFrameVerification(job, dependencies('not json at all'), new AbortController().signal);
    const call = dbMock.finalizeVerification.mock.calls[0]![1];
    expect(call.state).toBe('failed');
    expect(call.reason).toContain('no JSON object in response');
  });

  it('does nothing if another job owns verification', async () => {
    dbMock.claimVerifyingNarrative.mockResolvedValue(null);
    await processFrameVerification(job, dependencies(), new AbortController().signal);
    expect(dbMock.finalizeVerification).not.toHaveBeenCalled();
  });
});
