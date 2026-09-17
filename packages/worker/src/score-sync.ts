import type { ClaimedJob } from './db.js';
import { getPool } from './db.js';
import { logger } from './logger.js';
import { pushScore } from './scores.js';
import { resolveTracingConfig } from './tracing-config.js';

export interface PrOutcomePayload {
  fixJobId: string;
  projectId: string;
  outcome: 'merged' | 'closed';
  deliveryId: string;
  occurredAt?: string;
}

interface SyncDeps {
  loadTraceUrl: (fixJobId: string, projectId: string) => Promise<string | null>;
  push: typeof pushScore;
}

function traceIdFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const tracesIndex = segments.lastIndexOf('traces');
    return tracesIndex >= 0 && segments[tracesIndex + 1]
      ? segments[tracesIndex + 1]!
      : null;
  } catch {
    return null;
  }
}

export async function syncScoresForPrOutcome(
  payload: PrOutcomePayload,
  deps: SyncDeps,
): Promise<void> {
  const traceUrl = await deps.loadTraceUrl(payload.fixJobId, payload.projectId);
  const traceId = traceUrl ? traceIdFromUrl(traceUrl) : null;
  if (!traceId) {
    throw new Error(`score_sync: no trace_url yet for fix job ${payload.fixJobId}`);
  }
  await deps.push({
    traceId,
    name: 'pr_outcome',
    value: payload.outcome,
    dataType: 'CATEGORICAL',
    id: `pr-outcome-${payload.deliveryId}`,
    // The scores API has no timestamp field (unknown keys are stripped), so
    // the PR event time rides in metadata where it stays queryable.
    ...(payload.occurredAt ? { metadata: { occurred_at: payload.occurredAt } } : {}),
  });
}

export const TRACING_CONFIGURED_AT = new Date(
  process.env['TRACING_CONFIGURED_AT'] ?? '2026-08-09T00:00:00Z',
);
export const MAX_TRACE_WAIT_ATTEMPTS = 3;

export interface FixJobRecord {
  traceUrl: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  status: string | null;
}

/** Tenant-scoped: a globally unique job id is not sufficient authorization. */
export async function loadFixJobFromDb(fixJobId: string, projectId: string): Promise<FixJobRecord | null> {
  const { rows } = await getPool().query<{
    trace_url: string | null;
    created_at?: Date | string | null;
    updated_at?: Date | string | null;
    status?: string | null;
  }>(
    `SELECT trace_url, created_at, updated_at, status FROM error_group_jobs
     WHERE id = $1 AND project_id = $2 AND job_type IN ('fix', 'error_fix')`,
    [fixJobId, projectId],
  );
  if (!rows[0]) return null;
  return {
    traceUrl: rows[0].trace_url ?? null,
    createdAt: rows[0].created_at ?? null,
    updatedAt: rows[0].updated_at ?? null,
    status: rows[0].status ?? null,
  };
}

async function loadTraceUrlFromDb(fixJobId: string, projectId: string): Promise<string | null> {
  const fixJob = await loadFixJobFromDb(fixJobId, projectId);
  return fixJob?.traceUrl ?? null;
}

export async function processScoreSyncJob(job: ClaimedJob): Promise<void> {
  const config = resolveTracingConfig(process.env);
  if (config.status === 'disabled') {
    // The one permanent no-op: no config means no score can ever be delivered,
    // and retrying cannot change configuration.
    logger.info('score_sync: tracing disabled, score not delivered', { job_id: job.id });
    return;
  }
  if (config.status === 'incomplete') {
    // Unlike 'disabled', this is an operator error (vars present but missing or
    // invalid). THROW so the queue retries until the config is fixed instead of
    // silently discarding the score.
    throw new Error(
      `score_sync: tracing config incomplete (missing: ${config.missing.join(',') || 'none'};`
      + ` invalid: ${config.invalid.join(',') || 'none'})`,
    );
  }
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const fixJobId = payload['fix_job_id'];
  const outcome = payload['outcome'];
  const deliveryId = payload['delivery_id'];
  const occurredAt = payload['occurred_at'];
  if (
    typeof fixJobId !== 'string'
    || typeof deliveryId !== 'string'
    || (outcome !== 'merged' && outcome !== 'closed')
  ) {
    logger.warn('score_sync: malformed payload, dropping', { job_id: job.id });
    return;
  }
  try {
    await syncScoresForPrOutcome(
      {
        fixJobId,
        projectId: job.projectId,
        outcome,
        deliveryId,
        ...(typeof occurredAt === 'string' ? { occurredAt } : {}),
      },
      { loadTraceUrl: loadTraceUrlFromDb, push: pushScore },
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('no trace_url yet')) {
      // With LANGFUSE_PROJECT_ID unset, buildLangfuseTraceUrl never writes a
      // trace_url, so "no trace_url yet" is "never": retrying would only
      // dead-letter. A trace_url written under an earlier config still works.
      if (config.projectId === null) {
        logger.warn(
          'score_sync: no trace_url and LANGFUSE_PROJECT_ID unset — trace URLs are never recorded in this config, dropping score',
          { job_id: job.id },
        );
        return;
      }

      // If the fix job finished before tracing was configured, it will never get a trace URL.
      // Stop retrying immediately, log once, and complete the job.
      const fixJob = await loadFixJobFromDb(fixJobId, job.projectId).catch(() => null);
      const fixJobTimestamp =
        fixJob?.updatedAt ?? fixJob?.createdAt ?? (typeof occurredAt === 'string' ? occurredAt : null);
      if (fixJobTimestamp && new Date(fixJobTimestamp) < TRACING_CONFIGURED_AT) {
        logger.warn(
          'score_sync: fix job finished before tracing was configured, dropping score',
          { job_id: job.id, fix_job_id: fixJobId },
        );
        return;
      }

      // Stop retrying after a bounded time/attempts so the job completes without dead-lettering.
      const maxWaitAttempts =
        Number(process.env['SCORE_SYNC_MAX_TRACE_WAIT_ATTEMPTS']) || MAX_TRACE_WAIT_ATTEMPTS;
      if (job.attempts >= maxWaitAttempts) {
        logger.warn(
          'score_sync: trace_url wait bound reached, dropping score without dead-lettering',
          { job_id: job.id, fix_job_id: fixJobId, attempts: job.attempts },
        );
        return;
      }
    }
    throw err;
  }
}
