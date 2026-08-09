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

/** Tenant-scoped: a globally unique job id is not sufficient authorization. */
async function loadTraceUrlFromDb(fixJobId: string, projectId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ trace_url: string | null }>(
    `SELECT trace_url FROM error_group_jobs
     WHERE id = $1 AND project_id = $2 AND job_type IN ('fix', 'error_fix')`,
    [fixJobId, projectId],
  );
  return rows[0]?.trace_url ?? null;
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
    // With LANGFUSE_PROJECT_ID unset, buildLangfuseTraceUrl never writes a
    // trace_url, so "no trace_url yet" is "never": retrying would only
    // dead-letter. A trace_url written under an earlier config still works.
    if (
      config.projectId === null
      && err instanceof Error && err.message.includes('no trace_url yet')
    ) {
      logger.warn('score_sync: no trace_url and LANGFUSE_PROJECT_ID unset — trace URLs are never recorded in this config, dropping score', {
        job_id: job.id,
      });
      return;
    }
    throw err;
  }
}
