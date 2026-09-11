import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionNarrative } from '@opslane/shared';
import { processFrameVerification, selectMoments, validateVerification } from '../verify.js';
import { calculateCost } from '@opslane/agent-core';
import { pricingFor } from '../../harness/agent-loop.js';

const dbMock = vi.hoisted(() => ({
  claimVerifyingNarrative: vi.fn(),
  reserveNarrativeBudget: vi.fn(),
  narrativeMonthlySpendExceeded: vi.fn(),
  finalizeVerification: vi.fn(),
  recordJobUsage: vi.fn().mockResolvedValue(undefined),
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
const job = {
  id: 'j1', projectId: 'p1', sessionId: 's1', workerId: 'w', leaseGeneration: '1', attempts: 0,
} as never;
const gradesJson = JSON.stringify({ grades: [
  { observationId: '0-aaaa', grade: 'refuted', reason: 'not visible' },
  { observationId: '1-bbbb', grade: 'corrected', reason: 'different delay', replacementWhat: 'save takes 12 seconds' },
] });

function dependencies(modelText = gradesJson) {
  return {
    client: {
      modelName: 'claude-sonnet-5',
      complete: vi.fn().mockResolvedValue({ text: modelText, inputTokens: 20, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 40, stopReason: 'end_turn' }),
    } as never,
    loadChunks: vi.fn().mockResolvedValue([]),
    capture: vi.fn().mockResolvedValue({ frames: [
      { offsetMs: 5_000, pair: 'a' as const, png: Buffer.from('png'), modelPng: Buffer.from('small-png') },
      { offsetMs: 5_000, pair: 'b' as const, png: Buffer.from('png2'), modelPng: Buffer.from('small-png2') },
    ], assetsMissing: false }),
    uploadFrame: vi.fn().mockResolvedValue(undefined),
    dailyCap: 2_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.claimVerifyingNarrative.mockResolvedValue({ promptVersion: 1, narrativeId: 'stable-narrative-id', narrative, timeline });
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
  it('uses the claimed narrative identity when emitting observations', async () => {
    await processFrameVerification(job, { ...dependencies(), supported: false }, new AbortController().signal);
    expect(dbMock.finalizeVerification).toHaveBeenCalledWith(job, expect.objectContaining({
      signalRows: expect.arrayContaining([expect.objectContaining({
        narrativeId: 'stable-narrative-id', observationId: '0-aaaa',
      })]),
    }));
  });

  it.each(['valid', 'invalid', 'truncated'])('ledgers paid %s responses before finalizing', async (outcome) => {
    const deps = dependencies(outcome === 'invalid' ? 'not json' : gradesJson);
    const complete = deps.client as unknown as { complete: ReturnType<typeof vi.fn> };
    if (outcome === 'truncated') {
      complete.complete.mockResolvedValue({ text: gradesJson, inputTokens: 20, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 40, stopReason: 'max_tokens' });
    }
    await processFrameVerification(job, deps, new AbortController().signal);
    expect(dbMock.recordJobUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      jobId: 'j1', execution: 0, phase: 'verify', model: 'claude-sonnet-5',
      usage: { input: 20, output: 10, cacheRead: 30, cacheWrite: 40 },
      // Derived from the pricing table, not a hand-computed literal: a rate
      // change should move this expectation, not fail it with a bare number.
      // Rounded to 4dp because that is the precision the meter writes and the
      // only precision cost_usd can hold, so a sub-$0.0001 call lands as zero.
      costUsd: Number(calculateCost(
        { input: 20, output: 10, cacheRead: 30, cacheWrite: 40 },
        pricingFor('claude-sonnet-5'),
      ).toFixed(4)),
    }));
    expect(dbMock.recordJobUsage.mock.invocationCallOrder[0])
      .toBeLessThan(dbMock.finalizeVerification.mock.invocationCallOrder[0]!);
    expect(dbMock.finalizeVerification).toHaveBeenCalledWith(job, expect.objectContaining({
      state: outcome === 'valid' ? 'ok' : 'failed', inputTokens: 20, outputTokens: 10,
    }));
  });

  it('sends downsampled images to the model and stores original evidence', async () => {
    const deps = dependencies();
    await processFrameVerification(job, deps, new AbortController().signal);
    expect(deps.uploadFrame).toHaveBeenNthCalledWith(1, expect.any(String), Buffer.from('png'));
    expect((deps.client as unknown as { complete: ReturnType<typeof vi.fn> }).complete)
      .toHaveBeenCalledWith(expect.objectContaining({ images: [
        { mediaType: 'image/png', base64: Buffer.from('small-png').toString('base64') },
        { mediaType: 'image/png', base64: Buffer.from('small-png2').toString('base64') },
      ] }));
  });

  it('keeps the usage record when finalization loses the lease', async () => {
    dbMock.finalizeVerification.mockRejectedValueOnce(new Error('lease lost'));
    await expect(processFrameVerification(job, dependencies(), new AbortController().signal))
      .rejects.toThrow('lease lost');
    expect(dbMock.recordJobUsage).toHaveBeenCalledOnce();
  });

  it('does not invent usage when the provider fails before returning a response', async () => {
    const deps = dependencies();
    (deps.client as unknown as { complete: ReturnType<typeof vi.fn> }).complete
      .mockRejectedValueOnce(new Error('connection failed'));
    await expect(processFrameVerification(job, deps, new AbortController().signal))
      .rejects.toThrow('connection failed');
    expect(dbMock.recordJobUsage).not.toHaveBeenCalled();
  });

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
    expect(dbMock.recordJobUsage).not.toHaveBeenCalled();
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
    expect(dbMock.recordJobUsage).not.toHaveBeenCalled();
  });
});
