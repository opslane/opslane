import type { SessionChunkEnvelope } from '@opslane/shared';
import { calculateCost } from '@opslane/agent-core';
import * as db from '../db.js';
import type { ClaimedJob } from '../db.js';
import { pricingFor } from '../harness/agent-loop.js';
import { logger } from '../logger.js';
import type { NarrativeClient } from './client.js';
import { buildNarrativePrompt, NARRATIVE_PROMPT_VERSION } from './prompt.js';
import { renderTimeline } from './renderer.js';
import { validateNarrative } from './validate.js';

export interface NarrateJobDeps {
  client: NarrativeClient;
  loadChunks(sessionId: string, projectId: string): Promise<SessionChunkEnvelope[]>;
  dailyCap: number;
  wallClockBudgetMs: number;
  appContext: string;
  projectName: string;
}

export async function processNarration(
  job: ClaimedJob & { sessionId: string },
  deps: NarrateJobDeps,
  signal: AbortSignal,
): Promise<void> {
  const pending = await db.claimPendingNarrative(
    job.sessionId,
    job.projectId,
    NARRATIVE_PROMPT_VERSION,
  );
  if (!pending) return;

  const finish = async (args: Parameters<typeof db.finishNarrative>[1]): Promise<void> => {
    const result = await db.finishNarrative(job, args);
    if (!result.written) {
      throw new Error('narrative terminal write rejected (lease lost or superseded)');
    }
  };

  const reserved = await db.reserveNarrativeBudget({
    sessionId: job.sessionId,
    projectId: job.projectId,
    stage: 'narrate',
    cap: deps.dailyCap,
  });
  if (!reserved) {
    await finish({ sessionId: job.sessionId, projectId: job.projectId, status: 'skipped_cap' });
    return;
  }
  if (await db.narrativeMonthlySpendExceeded(job.projectId)) {
    await finish({ sessionId: job.sessionId, projectId: job.projectId, status: 'skipped_budget' });
    return;
  }

  const envelopes = await deps.loadChunks(job.sessionId, job.projectId);
  if (signal.aborted) throw new Error('narrative job aborted');
  const startedAt = Date.now();
  const timeline = renderTimeline(envelopes);
  if (Date.now() - startedAt > deps.wallClockBudgetMs) {
    await finish({ sessionId: job.sessionId, projectId: job.projectId, status: 'render_aborted' });
    return;
  }
  const prompt = buildNarrativePrompt({
    appContext: deps.appContext,
    projectName: deps.projectName,
    timelineText: timeline.text,
  });
  const response = await deps.client.complete(prompt);
  const usage = {
    input: response.inputTokens,
    output: response.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
  };
  // Spend ledger (design 2026-09-01 scope item): narration is the dominant
  // prospective variable cost; it must appear in job_usage like every LLM job.
  // recordJobUsage is best-effort and never fails the narration.
  await db.recordJobUsage({
    jobId: job.id,
    execution: job.attempts,
    phase: 'narrate',
    model: deps.client.modelName,
    usage,
    costUsd: calculateCost(usage, pricingFor(deps.client.modelName)),
  });
  const validation = response.stopReason === 'max_tokens'
    ? { ok: false as const, reason: 'truncated (max_tokens)' }
    : validateNarrative(response.text, timeline);
  if (!validation.ok) {
    logger.warn('Narrative failed validation; terminal parse_failed', {
      job_id: job.id,
      session_id: job.sessionId,
      reason: validation.reason,
    });
    await finish({
      sessionId: job.sessionId,
      projectId: job.projectId,
      status: 'parse_failed',
      rawResponse: response.text,
      model: deps.client.modelName,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    return;
  }

  const compactTimeline = {
    startTs: timeline.startTs,
    lines: timeline.lines.map((line) => ({
      t: line.text,
      s: line.selector,
      r: line.route,
      a: line.atMs,
      ...(line.kind === 'idle' ? { k: 'idle' as const } : {}),
    })),
  };
  const hasObservations = validation.narrative.observations.length > 0;
  await finish({
    sessionId: job.sessionId,
    projectId: job.projectId,
    status: 'ok',
    narrative: validation.narrative,
    timeline: compactTimeline,
    model: deps.client.modelName,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    verificationState: hasObservations ? 'pending' : 'none',
  });
  if (hasObservations) {
    await db.enqueueJob('session_verify_frames', job.projectId, job.sessionId);
  }
}
