import { getPool, type SessionRow } from '../db.js';
import { logger } from '../logger.js';
import * as db from '../db.js';
import type { Adjudicator, AdjudicationInput, AdjudicationVerdict, EvidenceWindowMode } from './adjudicator.js';
import type { WindowEvent } from './evidence-window.js';
import {
  findFoldTarget,
  claimSignalsForAdjudication,
  applyFoldOutcome,
  countEligibleUsers,
  listEligibleSignals,
  ensureCandidate,
  claimGeneration,
  findValidAcceptedGeneration,
  attachInheritedSignal,
  applyBucketOutcome,
  tryReserveAdjudicationCall,
  type FoldSignal,
  type BucketTuple,
} from './promotion-db.js';

const PROMOTION_THRESHOLD_USERS = 5;
const WINDOW_DAYS = 7;

interface PendingSignalRow extends FoldSignal {
  signal_type: 'rage_click' | 'dead_click' | 'form_abandon';
  page_url_normalized: string;
  element_selector: string | null;
  occurrence_count: number;
  rule_version: number;
  occurred_ats: number[] | null;
}

export interface AdjudicationRuntime {
  windowMode: EvidenceWindowMode;
  dailyCap: number;
  loadWindows(signal: {
    session_id: string;
    project_id: string;
    occurred_ats: number[] | null;
  }): Promise<WindowEvent[][]>;
}

/**
 * Batch 4 two-path policy (plan D1), run after writeFrictionSignals inside a
 * session_analysis job:
 *
 * - A signal with a possible same-session ±30s error fold is adjudicated
 *   eagerly (one model call for that signal).
 * - A signal with no fold target follows the bucket path: candidate ensured,
 *   raw threshold eligibility counted from active signals, and exactly one
 *   bucket-level model call when five identified users are present — owned
 *   by whichever job wins the durable generation claim.
 * - Later matching signals inherit a still-valid accepted generation with no
 *   model call. Anonymous signals may fold but never count toward or trigger
 *   standalone promotion (plan D3).
 *
 * Adjudicator failures propagate: the poller's failJob/dead-letter machinery
 * owns retries and the unchecked reconciliation (Task 9).
 */
export async function processFrictionOutcomes(
  session: SessionRow,
  jobId: string,
  adjudicator: Adjudicator,
  runtime: AdjudicationRuntime,
): Promise<void> {
  const { rows: pending } = await getPool().query<PendingSignalRow>(
    `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
            occurred_at::text AS occurred_at, signal_type, page_url_normalized,
            element_selector, occurrence_count, rule_version, occurred_ats
     FROM friction_signals
     WHERE session_id = $1 AND project_id = $2
       AND adjudication_status = 'pending'
       AND incident_id IS NULL
       AND retracted_at IS NULL AND superseded_by IS NULL
     ORDER BY occurred_at ASC`,
    [session.id, session.project_id],
  );

  for (const signal of pending) {
    const client = await getPool().connect();
    let foldTarget;
    try {
      foldTarget = await findFoldTarget(
        client,
        signal.project_id,
        signal.session_id,
        signal.occurred_at,
      );
    } finally {
      client.release();
    }

    if (foldTarget) {
      if (!await reserveOrRevisit(session, signal, jobId, runtime)) break;
      await withClient((c) => claimSignalsForAdjudication(c, [signal.id], jobId));
      const input: AdjudicationInput = {
        scope: 'fold',
        signalType: signal.signal_type,
        elementSelector: signal.element_selector,
        pageUrlNormalized: signal.page_url_normalized,
        occurrenceCount: signal.occurrence_count,
        nearbyError: { title: foldTarget.title, secondsAway: foldTarget.secondsAway },
      };
      const verdict = await adjudicate(adjudicator, input, signal, jobId, runtime);
      const stored = storedVerdict(verdict);
      const outcome = await applyFoldOutcome({
        signal,
        verdict: stored,
        meta: { modelId: adjudicator.modelId, promptVersion: adjudicator.promptVersion, jobId },
      });
      logger.info('Friction fold adjudicated', {
        project_id: signal.project_id,
        session_id: signal.session_id,
        signal_id: signal.id,
        job_id: jobId,
        accepted: verdict.accepted,
        uncertain_detail: verdict.uncertain ? verdict.reason : undefined,
        outcome,
      });
      continue;
    }

    // No fold target. Anonymous signals stop here (plan D3).
    if (!signal.end_user_id) {
      logger.info('Friction signal anonymous, standalone path skipped', {
        project_id: signal.project_id,
        session_id: signal.session_id,
        signal_id: signal.id,
        job_id: jobId,
      });
      continue;
    }

    const tuple: BucketTuple = {
      projectId: signal.project_id,
      environmentId: signal.environment_id,
      fingerprint: signal.fingerprint,
      ruleVersion: signal.rule_version,
      promptVersion: adjudicator.promptVersion,
    };

    // Inheritance: a still-valid accepted generation attaches without a call.
    const validGeneration = await withClient((c) => findValidAcceptedGeneration(c, tuple));
    if (validGeneration) {
      const outcome = await attachInheritedSignal(signal, validGeneration);
      logger.info('Friction signal inherited accepted generation', {
        project_id: signal.project_id,
        session_id: signal.session_id,
        signal_id: signal.id,
        generation_id: validGeneration.id,
        job_id: jobId,
        outcome,
      });
      continue;
    }

    await withClient((c) =>
      ensureCandidate(c, tuple, {
        signalType: signal.signal_type,
        pageUrlNormalized: signal.page_url_normalized,
        elementSelector: signal.element_selector,
      }),
    );

    const eligibleUsers = await withClient((c) => countEligibleUsers(c, tuple));
    if (eligibleUsers < PROMOTION_THRESHOLD_USERS) {
      logger.info('Friction candidate below threshold', {
        project_id: signal.project_id,
        session_id: signal.session_id,
        signal_id: signal.id,
        job_id: jobId,
        eligible_users: eligibleUsers,
      });
      continue;
    }

    // Threshold crossed: claim the durable generation; losers skip the call.
    if (!await reserveOrRevisit(session, signal, jobId, runtime)) break;
    const generation = await claimGeneration(tuple, jobId);
    if (!generation) {
      logger.info('Friction generation already in flight, skipping', {
        project_id: signal.project_id,
        signal_id: signal.id,
        job_id: jobId,
      });
      continue;
    }
    const eligible = await withClient((c) => listEligibleSignals(c, tuple));
    await withClient((c) => claimSignalsForAdjudication(c, eligible.ids, jobId));
    const input: AdjudicationInput = {
      scope: 'bucket',
      signalType: signal.signal_type,
      elementSelector: signal.element_selector,
      pageUrlNormalized: signal.page_url_normalized,
      occurrenceCount: signal.occurrence_count,
      bucketSummary: {
        distinctUsers: eligibleUsers,
        totalOccurrences: eligible.totalOccurrences,
        windowDays: WINDOW_DAYS,
      },
    };
    const verdict = await adjudicate(adjudicator, input, signal, jobId, runtime);
    const stored = storedVerdict(verdict);
    const outcome = await applyBucketOutcome({
      tuple,
      generationId: generation.id,
      verdict: stored,
      meta: { modelId: adjudicator.modelId, promptVersion: adjudicator.promptVersion, jobId },
    });
    logger.info('Friction bucket adjudicated', {
      project_id: signal.project_id,
      session_id: signal.session_id,
      signal_id: signal.id,
      generation_id: generation.id,
      job_id: jobId,
      accepted: verdict.accepted,
      uncertain_detail: verdict.uncertain ? verdict.reason : undefined,
      outcome,
    });
  }
}

function storedVerdict(verdict: AdjudicationVerdict): AdjudicationVerdict {
  return verdict.uncertain === true
    ? { accepted: false, reason: 'uncertain' }
    : verdict;
}

async function reserveOrRevisit(
  session: SessionRow,
  signal: PendingSignalRow,
  jobId: string,
  runtime: AdjudicationRuntime,
): Promise<boolean> {
  const reserved = await withClient((client) =>
    tryReserveAdjudicationCall(client, signal.project_id, runtime.dailyCap));
  if (reserved) return true;
  await db.enqueueSessionAnalysisForBudgetRetry(session.id, session.project_id);
  logger.warn('Adjudication daily cap reached; re-enqueued for next budget day', {
    project_id: signal.project_id,
    job_id: jobId,
    cap: runtime.dailyCap,
  });
  return false;
}

async function adjudicate(
  adjudicator: Adjudicator,
  input: AdjudicationInput,
  signal: PendingSignalRow,
  jobId: string,
  runtime: AdjudicationRuntime,
): Promise<AdjudicationVerdict> {
  const windows = runtime.windowMode === 'off' ? [] : await runtime.loadWindows(signal);
  const verdict = await adjudicator.adjudicate(
    runtime.windowMode === 'on' ? { ...input, evidenceWindows: windows } : input,
  );
  if (runtime.windowMode === 'shadow') {
    const reserved = await withClient((client) =>
      tryReserveAdjudicationCall(client, signal.project_id, runtime.dailyCap));
    if (reserved) {
      try {
        const shadowVerdict = await adjudicator.adjudicate({ ...input, evidenceWindows: windows });
        logger.info('Adjudication shadow verdict', {
          project_id: signal.project_id,
          signal_id: signal.id,
          job_id: jobId,
          decided: verdict.accepted,
          shadow: shadowVerdict.accepted,
          shadow_uncertain: shadowVerdict.uncertain === true,
        });
      } catch (error: unknown) {
        logger.warn('Adjudication shadow call failed', { signal_id: signal.id, error: String(error) });
      }
    }
  }
  return verdict;
}

async function withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
