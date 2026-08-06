import pg from 'pg';
import type { Diagnosis, DiagnosisOutcome, ErrorGroupStatus, NeedsHumanReason, ConfidenceLevel, JobType, SetupPrStatus, EvidenceRecord, PRPosture } from '@opslane/shared';
import { reconcileDeadLetteredSessionAnalysis } from './friction/dead-letter.js';
import type { Platform } from './platform.js';
import type { FixSurface } from './fix-surface.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env['DATABASE_URL'],
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** A NULL column means the whole repository, preserving pre-existing behavior. */
export async function loadFixSurface(projectId: string): Promise<FixSurface> {
  const { rows } = await getPool().query<{ fix_surface_globs: string[] | null }>(
    'SELECT fix_surface_globs FROM projects WHERE id = $1',
    [projectId],
  );
  return { globs: rows[0]?.fix_surface_globs ?? null };
}

export interface DecisionRow {
  outcome: DiagnosisOutcome;
  decisionReason: string;
  causeLocation?: string | null;
  diagnosis: Diagnosis | null;
  model: string;
  promptVersion: string;
  jobId?: string | null;
}

async function insertDiagnosisDecision(
  queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  errorGroupId: string,
  projectId: string,
  row: DecisionRow,
): Promise<void> {
  await queryable.query(
    `INSERT INTO diagnosis_decisions
       (error_group_id, project_id, job_id, outcome, decision_reason, cause_location, diagnosis, model, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING`,
    [
      errorGroupId,
      projectId,
      row.jobId ?? null,
      row.outcome,
      row.decisionReason,
      row.causeLocation ?? null,
      row.diagnosis === null ? null : JSON.stringify(row.diagnosis),
      row.model,
      row.promptVersion,
    ],
  );
}

/** Append a diagnosis decision. A retried job is idempotent, never overwritten. */
export async function recordDiagnosisDecision(
  errorGroupId: string,
  projectId: string,
  row: DecisionRow,
): Promise<void> {
  await insertDiagnosisDecision(getPool(), errorGroupId, projectId, row);
}

export interface ClaimedJob {
  id: string;
  workerId: string;
  errorGroupId: string | null;
  sourceId: string | null;
  projectId: string;
  jobType: JobType;
  attempts: number;
  /** Maximum failed executions before the job dead-letters. Populated by claimJob. */
  maxAttempts?: number;
  guidance: string | null;
  /** Monotonically increasing fencing token for this claim. */
  leaseGeneration: string;
  triggeredBy: 'auto' | 'human' | null;
  sessionId: string | null;
  /** Effective routing platform persisted on durable fix jobs. */
  platform?: Platform | null;
  payload?: unknown;
}

export interface JobLease {
  id: string;
  workerId: string;
  leaseGeneration: string;
  projectId: string;
  errorGroupId: string | null;
  sessionId: string | null;
}

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Job lease lost for ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

export async function assertJobLease(lease: JobLease): Promise<void> {
  const result = await getPool().query(
    `SELECT 1
     FROM error_group_jobs
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND project_id = $4
       AND error_group_id IS NOT DISTINCT FROM $5::uuid
       AND session_id IS NOT DISTINCT FROM $6
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [
      lease.id,
      lease.workerId,
      lease.leaseGeneration,
      lease.projectId,
      lease.errorGroupId,
      lease.sessionId,
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);
}

/** Default fleet-wide ceiling on concurrently claimed session_analysis jobs. */
const DEFAULT_SESSION_ANALYSIS_CAP = 2;

function sessionAnalysisCapFromEnv(): number {
  const raw = process.env['SESSION_ANALYSIS_MAX_CONCURRENT'];
  if (raw === undefined || raw === '') return DEFAULT_SESSION_ANALYSIS_CAP;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_ANALYSIS_CAP;
}

/** Claims one pending job using FOR UPDATE SKIP LOCKED (issue #28 scheduling).
 *
 * Policy, in order:
 * 1. error_fix always wins — rare, human-facing work is never queued behind
 *    background analysis.
 * 2. session_analysis is capped: it is claimable only while fewer than
 *    `sessionAnalysisCap` analysis jobs hold a live lease.
 * 3. Within the remaining work, the analysis lane and the interactive lane
 *    (investigate/fix/setup_pr) alternate: analysis is preferred only when
 *    its most recent claim is older than the interactive lane's. A fix
 *    backlog therefore cannot starve analysis, and an analysis backlog
 *    cannot starve fixes, without any scheduler state outside the jobs table.
 *
 * Admission is serialized with a transaction-scoped advisory lock: without
 * it, simultaneous claimers all read the same running count and lane maxima
 * and can overshoot the cap by up to the fleet size. Admission is serialized
 * fleet-wide, so claim latency bounds total claim throughput. Measured at
 * 4.05ms with 4k rows pending (the ORDER BY CASE matches no index, so every
 * claim sorts the whole eligible set), giving a ceiling near 250 claims/sec
 * that degrades linearly with backlog depth. A drain-looping worker claims at
 * roughly 1/job-duration, so the margin is wide at current fleet size.
 * Re-measure with EXPLAIN (ANALYZE, BUFFERS) before scaling the fleet or
 * letting the pending set grow much larger.
 *
 * Lease and terminal-status semantics are untouched: only the candidate
 * selection changed. */
export async function claimJob(
  workerId: string,
  leaseDurationMs: number,
  sessionAnalysisCap: number = sessionAnalysisCapFromEnv()
): Promise<ClaimedJob | null> {
  const client = await getPool().connect();
  let result: pg.QueryResult<{
    id: string;
    error_group_id: string | null;
    source_id: string | null;
    project_id: string;
    job_type: JobType;
    attempts: number;
    max_attempts: number;
    guidance: string | null;
    worker_id: string;
    lease_generation: string;
    triggered_by: 'auto' | 'human' | null;
    session_id: string | null;
    platform: string | null;
    payload: unknown;
  }>;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('opslane-job-claim'))`
    );
    result = await client.query(
      `UPDATE error_group_jobs
     SET status = 'claimed',
         worker_id = $1,
         claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => $2::double precision),
         lease_generation = lease_generation + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM error_group_jobs
       WHERE status = 'pending'
         AND available_at <= now()
         AND (job_type <> 'session_analysis'
              OR (SELECT COUNT(*) FROM error_group_jobs
                   WHERE status = 'claimed'
                     AND job_type = 'session_analysis'
                     AND lease_expires_at > now()) < $3)
       ORDER BY CASE
         WHEN job_type = 'error_fix' THEN 0
         WHEN job_type = 'session_analysis'
              AND COALESCE((SELECT MAX(claimed_at) FROM error_group_jobs
                             WHERE job_type = 'session_analysis'), 'epoch'::timestamptz)
                < COALESCE((SELECT MAX(claimed_at) FROM error_group_jobs
                             WHERE job_type <> 'session_analysis'), 'epoch'::timestamptz)
           THEN 1
         WHEN job_type <> 'session_analysis' THEN 2
         ELSE 3
       END, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, error_group_id, source_id, project_id, job_type, attempts, max_attempts, guidance,
               worker_id, lease_generation::text AS lease_generation,
               triggered_by, session_id, platform, payload`,
      [workerId, leaseDurationMs / 1000, sessionAnalysisCap]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    workerId: row.worker_id,
    errorGroupId: row.error_group_id,
    sourceId: row.source_id,
    projectId: row.project_id,
    jobType: row.job_type,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    guidance: row.guidance,
    leaseGeneration: row.lease_generation,
    triggeredBy: row.triggered_by,
    sessionId: row.session_id,
    platform: row.platform === 'python'
      ? 'python'
      : row.platform === 'javascript' ? 'javascript' : null,
    payload: row.payload,
  };
}

export interface QueueDepthRow {
  jobType: string;
  eligible: number;
  backedOff: number;
  oldestEligibleSeconds: number | null;
}

/** Queue shape by job type, sampled on a timer rather than per claim. */
export async function getQueueDepth(): Promise<QueueDepthRow[]> {
  const { rows } = await getPool().query<{
    job_type: string;
    eligible: string;
    backed_off: string;
    oldest_eligible_seconds: string | null;
  }>(
    `SELECT job_type,
            count(*) FILTER (WHERE available_at <= now())::text AS eligible,
            count(*) FILTER (WHERE available_at > now())::text AS backed_off,
            EXTRACT(EPOCH FROM (now() - min(created_at)
              FILTER (WHERE available_at <= now())))::text AS oldest_eligible_seconds
       FROM error_group_jobs
      WHERE status = 'pending'
      GROUP BY job_type`,
  );
  return rows.map((row) => ({
    jobType: row.job_type,
    eligible: Number(row.eligible),
    backedOff: Number(row.backed_off),
    oldestEligibleSeconds:
      row.oldest_eligible_seconds === null
        ? null
        : Math.round(Number(row.oldest_eligible_seconds)),
  }));
}

export class JobRescheduledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was durably rescheduled`);
    this.name = 'JobRescheduledError';
  }
}

/** Return a claimed job to pending without consuming a retry attempt. */
export async function rescheduleJob(
  lease: JobLease,
  availableAt: Date,
  payload?: unknown,
): Promise<void> {
  const result = await getPool().query(
    `UPDATE error_group_jobs
     SET status = 'pending', worker_id = NULL, claimed_at = NULL,
         lease_expires_at = NULL, available_at = $7,
         payload = COALESCE($8::jsonb, payload), updated_at = now()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3::bigint
       AND project_id = $4
       AND error_group_id IS NOT DISTINCT FROM $5::uuid
       AND session_id IS NOT DISTINCT FROM $6
       AND status = 'claimed' AND lease_expires_at > now()`,
    [
      lease.id,
      lease.workerId,
      lease.leaseGeneration,
      lease.projectId,
      lease.errorGroupId,
      lease.sessionId,
      availableAt,
      payload === undefined ? null : JSON.stringify(payload),
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);
}

/** Extends the lease on a claimed job. Returns false if the job is no longer owned by this worker. */
export async function heartbeat(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  leaseDurationMs: number
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET lease_expires_at = now() + make_interval(secs => $4::double precision),
         updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration, leaseDurationMs / 1000]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Marks a claimed job as completed. */
export async function completeJob(
  jobId: string,
  workerId: string,
  leaseGeneration: string
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET status = 'completed',
         updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Retry backoff floor and ceiling, shared by failJob and the reaper.
 *  The tick used to be the only retry spacing; these replace it. */
export const RETRY_BACKOFF_BASE_SECONDS = 30;
export const RETRY_BACKOFF_CAP_SECONDS = 900;

/**
 * Fails a job: increments attempts and records the error.
 * Resets to 'pending' for retry, or 'dead_letter' at max_attempts.
 */
export async function failJob(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  error: string
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      status: string;
      job_type: JobType;
      project_id: string;
    }>(
      `UPDATE error_group_jobs
       SET attempts = attempts + 1,
           last_error = $4,
           status = CASE
             WHEN attempts + 1 >= max_attempts THEN 'dead_letter'::job_status
             ELSE 'pending'::job_status
           END,
           worker_id = CASE
             WHEN attempts + 1 >= max_attempts THEN worker_id
             ELSE NULL
           END,
           claimed_at = CASE
             WHEN attempts + 1 >= max_attempts THEN claimed_at
             ELSE NULL
           END,
           lease_expires_at = CASE
             WHEN attempts + 1 >= max_attempts THEN lease_expires_at
             ELSE NULL
           END,
           available_at = CASE
             WHEN attempts + 1 >= max_attempts THEN available_at
             ELSE now() + make_interval(secs => LEAST(
                    $5::double precision * power(2, attempts) * (0.5 + random()),
                    $6::double precision))
           END,
           updated_at = now()
       WHERE id = $1
         AND worker_id = $2
         AND lease_generation = $3::bigint
         AND status = 'claimed'
         AND lease_expires_at > now()
       RETURNING status, job_type, project_id`,
      [
        jobId,
        workerId,
        leaseGeneration,
        error,
        RETRY_BACKOFF_BASE_SECONDS,
        RETRY_BACKOFF_CAP_SECONDS,
      ]
    );
    const row = result.rows[0];
    // Dead-lettered session analysis must not strand its claimed signals or
    // block the in-flight generation slot; reconcile in the SAME transaction.
    if (row && row.status === 'dead_letter' && row.job_type === 'session_analysis') {
      await reconcileDeadLetteredSessionAnalysis(client, jobId, row.project_id);
    }
    await client.query('COMMIT');
    return row !== undefined;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reaper: reclaims jobs with expired leases.
 * Resets to 'pending' for retry, or 'dead_letter' at max_attempts.
 */
export async function requeueStaleJobs(): Promise<number> {
  const client = await getPool().connect();
  let rows: Array<{
    id: string;
    error_group_id: string | null;
    session_id: string | null;
    project_id: string;
    job_type: JobType;
    status: string;
  }>;
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: string;
      error_group_id: string | null;
      session_id: string | null;
      project_id: string;
      job_type: JobType;
      status: string;
    }>(
      `UPDATE error_group_jobs
       SET attempts = attempts + 1,
           status = CASE
             WHEN attempts + 1 >= max_attempts THEN 'dead_letter'::job_status
             ELSE 'pending'::job_status
           END,
           last_error = CASE
             WHEN attempts + 1 >= max_attempts THEN 'dead-lettered by reaper: lease expired ' || (attempts + 1) || ' times'
             ELSE 'reaper: lease expired (attempt ' || (attempts + 1) || ')'
           END,
           worker_id = CASE
             WHEN attempts + 1 >= max_attempts THEN worker_id
             ELSE NULL
           END,
           claimed_at = CASE
             WHEN attempts + 1 >= max_attempts THEN claimed_at
             ELSE NULL
           END,
           lease_expires_at = CASE
             WHEN attempts + 1 >= max_attempts THEN lease_expires_at
             ELSE NULL
           END,
           available_at = CASE
             WHEN attempts + 1 >= max_attempts THEN available_at
             ELSE now() + make_interval(secs => LEAST(
                    $1::double precision * power(2, attempts) * (0.5 + random()),
                    $2::double precision))
           END,
           updated_at = now()
       WHERE status = 'claimed' AND lease_expires_at < now()
       RETURNING id, error_group_id, session_id, project_id, job_type, status`,
      [RETRY_BACKOFF_BASE_SECONDS, RETRY_BACKOFF_CAP_SECONDS],
    );
    rows = result.rows;

    // Dead-lettered session analysis: flip claimed pending signals and the
    // owning generation to unchecked, upsert the diagnostic, and mark the
    // session failed — atomically with the job flip (issue #56).
    for (const row of rows) {
      if (row.status === 'dead_letter' && row.job_type === 'session_analysis') {
        await reconcileDeadLetteredSessionAnalysis(client, row.id, row.project_id);
        if (row.session_id) {
          await client.query(
            `UPDATE sessions SET status = 'analysis_failed' WHERE id = $1 AND project_id = $2`,
            [row.session_id, row.project_id],
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Reconcile any FIX job that just dead-lettered: its error group is stuck in
  // 'fixing' and will never resolve on its own. Terminate it as needs_human with a
  // complete reason so the incident doesn't hang (and the writeup is preserved).
  // Best-effort post-commit, matching prior behavior for the error pipeline.
  for (const row of rows) {
    if (
      row.status === 'dead_letter' &&
      (row.job_type === 'fix' || row.job_type === 'error_fix') &&
      row.error_group_id
    ) {
      await updateGroupStatus(row.error_group_id, row.project_id, 'needs_human', {
        reason: {
          reason_code: 'lease_lost',
          reason_message: 'The fix job exceeded its retry limit (repeated lease expiry) and was abandoned.',
          remediation:
            'Re-run the fix from the incident, or review manually — the worker could not hold a lease long enough to finish.',
        },
      }).catch(() => {});
    }
  }

  return rows.length;
}

/** Stores the Langfuse trace URL on a job row (fire-and-forget). */
export async function updateJobTraceUrl(
  jobId: string,
  workerId: string,
  leaseGeneration: string,
  traceUrl: string
): Promise<boolean> {
  const db = getPool();
  const result = await db.query(
    `UPDATE error_group_jobs
     SET trace_url = $4, updated_at = now()
     WHERE id = $1
       AND worker_id = $2
       AND lease_generation = $3::bigint
       AND status = 'claimed'
       AND lease_expires_at > now()`,
    [jobId, workerId, leaseGeneration, traceUrl]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Updates the error_group status and optional resolution fields.
 * Enforces terminal reason contract: needs_human MUST include reason fields.
 */
export async function updateGroupStatus(
  errorGroupId: string,
  projectId: string,
  status: ErrorGroupStatus,
  fields?: {
    confidence?: ConfidenceLevel;
    pr_url?: string;
    pr_number?: number;
    pr_fix_job_id?: string;
    reason?: NeedsHumanReason;
    candidate_diff?: string;
    evidence?: EvidenceRecord;
  },
  lease?: JobLease,
): Promise<void> {
  if (status === 'needs_human') {
    const reason = fields?.reason;
    if (!reason) {
      throw new Error(
        `needs_human requires reason fields (reason_code, reason_message, remediation) for group ${errorGroupId}`
      );
    }
    if (!reason.reason_code || !reason.reason_message || !reason.remediation) {
      throw new Error(
        `needs_human reason fields must all be non-empty for group ${errorGroupId}`
      );
    }
  }

  const reason = fields?.reason;
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $13
           AND worker_id = $14
           AND lease_generation = $15::bigint
           AND project_id = $2
           AND error_group_id = $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await db.query(
    `${ownedCte}
     UPDATE error_groups
     SET status = $3::error_group_status,
         confidence = $4,
         pr_url = $5,
         pr_number = $6,
         pr_fix_job_id = COALESCE($7, pr_fix_job_id),
         reason_code = $8,
         reason_message = $9,
         remediation = $10,
         candidate_diff = $11,
         verification_evidence = $12::jsonb,
         pr_created_at = CASE
           WHEN $3::error_group_status = 'pr_created'
                AND status IS DISTINCT FROM 'pr_created' THEN now()
           ELSE pr_created_at
         END,
         needs_human_at = CASE
           WHEN $3::error_group_status = 'needs_human'
                AND status IS DISTINCT FROM 'needs_human' THEN now()
           ELSE needs_human_at
         END,
         updated_at = now()
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
     RETURNING id`,
    [
      errorGroupId,
      projectId,
      status,
      fields?.confidence ?? null,
      fields?.pr_url ?? null,
      fields?.pr_number ?? null,
      fields?.pr_fix_job_id ?? null,
      reason?.reason_code ?? null,
      reason?.reason_message ?? null,
      reason?.remediation ?? null,
      fields?.candidate_diff ?? null,
      fields?.evidence ? JSON.stringify(fields.evidence) : null,
      ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
    ]
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

export interface DeliveryReservation {
  operationKey: string;
  branchName: string;
  posture: 'ready' | 'draft';
  candidateDiff: string;
  state: 'reserved' | 'pushed' | 'open' | 'closed';
  headSha?: string;
  prUrl?: string;
  prNumber?: number;
  existing: boolean;
}

export type ReserveDeliveryResult =
  | { status: 'reserved'; reservation: DeliveryReservation }
  | { status: 'cap_reached' };

/** Persists a stable delivery intent before the first provider write. */
export async function reserveDelivery(
  errorGroupId: string,
  projectId: string,
  input: {
    operationKey: string;
    branchName: string;
    posture: 'ready' | 'draft';
    diffHash: string;
    candidateDiff: string;
  },
  lease: JobLease,
): Promise<ReserveDeliveryResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id FROM error_group_jobs
       WHERE id = $1 AND worker_id = $2 AND lease_generation = $3::bigint
         AND project_id = $4 AND error_group_id = $5
         AND status = 'claimed' AND lease_expires_at > now()
       FOR UPDATE`,
      [lease.id, lease.workerId, lease.leaseGeneration, projectId, errorGroupId],
    );
    if ((owned.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);

    const existing = await client.query<{
      operation_key: string;
      branch_name: string;
      posture: 'ready' | 'draft';
      candidate_diff: string;
      state: DeliveryReservation['state'];
      head_sha: string | null;
      pr_url: string | null;
      pr_number: number | null;
    }>(
      `SELECT operation_key, branch_name, posture, candidate_diff, state,
              head_sha, pr_url, pr_number
       FROM delivery_reservations
       WHERE error_group_id = $1 AND project_id = $2
       FOR UPDATE`,
      [errorGroupId, projectId],
    );
    const row = existing.rows[0];
    if (row) {
      await client.query('COMMIT');
      return {
        status: 'reserved',
        reservation: {
          operationKey: row.operation_key,
          branchName: row.branch_name,
          posture: row.posture,
          candidateDiff: row.candidate_diff,
          state: row.state,
          ...(row.head_sha ? { headSha: row.head_sha } : {}),
          ...(row.pr_url ? { prUrl: row.pr_url } : {}),
          ...(row.pr_number ? { prNumber: row.pr_number } : {}),
          existing: true,
        },
      };
    }

    const project = await client.query<{ draft_pr_cap: number }>(
      `SELECT draft_pr_cap FROM projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    if (!project.rows[0]) throw new Error(`Project ${projectId} not found`);
    if (input.posture === 'draft') {
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM delivery_reservations
         WHERE project_id = $1 AND posture = 'draft'
           AND state IN ('reserved', 'pushed', 'open')`,
        [projectId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= project.rows[0].draft_pr_cap) {
        await client.query('COMMIT');
        return { status: 'cap_reached' };
      }
    }

    await client.query(
      `INSERT INTO delivery_reservations
         (error_group_id, project_id, operation_key, branch_name, posture,
          diff_hash, candidate_diff)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        errorGroupId,
        projectId,
        input.operationKey,
        input.branchName,
        input.posture,
        input.diffHash,
        input.candidateDiff,
      ],
    );
    await client.query('COMMIT');
    return {
      status: 'reserved',
      reservation: {
        operationKey: input.operationKey,
        branchName: input.branchName,
        posture: input.posture,
        candidateDiff: input.candidateDiff,
        state: 'reserved',
        existing: false,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordDeliveryPushed(
  errorGroupId: string,
  projectId: string,
  headSha: string,
  lease: JobLease,
): Promise<void> {
  const result = await getPool().query(
    `UPDATE delivery_reservations r
     SET state = 'pushed', head_sha = $3, updated_at = now()
     WHERE r.error_group_id = $1 AND r.project_id = $2
       AND EXISTS (
         SELECT 1 FROM error_group_jobs j
         WHERE j.id = $4 AND j.worker_id = $5
           AND j.lease_generation = $6::bigint
           AND j.project_id = $2 AND j.error_group_id = $1
           AND j.status = 'claimed' AND j.lease_expires_at > now()
       )`,
    [errorGroupId, projectId, headSha, lease.id, lease.workerId, lease.leaseGeneration],
  );
  if ((result.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);
}

/** Atomically records the PR, transitions the incident, and starts CI watching. */
export async function finalizeDelivery(
  errorGroupId: string,
  projectId: string,
  input: {
    status: 'pr_created' | 'pr_draft';
    prUrl: string;
    prNumber: number;
    headSha: string;
    confidence: ConfidenceLevel;
    fixJobId: string;
    reason?: NeedsHumanReason;
    candidateDiff?: string;
    evidence?: EvidenceRecord;
  },
  lease: JobLease,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id FROM error_group_jobs
       WHERE id = $1 AND worker_id = $2 AND lease_generation = $3::bigint
         AND project_id = $4 AND error_group_id = $5
         AND status = 'claimed' AND lease_expires_at > now()
       FOR UPDATE`,
      [lease.id, lease.workerId, lease.leaseGeneration, projectId, errorGroupId],
    );
    if ((owned.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);

    const reason = input.reason;
    const updated = await client.query(
      `UPDATE error_groups
       SET status = $3::error_group_status, confidence = $4,
           pr_url = $5, pr_number = $6, pr_fix_job_id = $7,
           reason_code = $8, reason_message = $9, remediation = $10,
           candidate_diff = $11, verification_evidence = $12::jsonb,
           pr_created_at = CASE WHEN $3::error_group_status = 'pr_created'
                                THEN COALESCE(pr_created_at, now())
                                ELSE pr_created_at END,
           updated_at = now()
       WHERE id = $1 AND project_id = $2
         AND status IN ('fixing', 'pr_draft', 'pr_created')`,
      [
        errorGroupId,
        projectId,
        input.status,
        input.confidence,
        input.prUrl,
        input.prNumber,
        input.fixJobId,
        reason?.reason_code ?? null,
        reason?.reason_message ?? null,
        reason?.remediation ?? null,
        input.candidateDiff ?? null,
        input.evidence ? JSON.stringify(input.evidence) : null,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error(`Cannot finalize delivery for group ${errorGroupId}`);
    }

    await client.query(
      `UPDATE delivery_reservations
       SET state = 'open', head_sha = $3, pr_url = $4, pr_number = $5,
           updated_at = now()
       WHERE error_group_id = $1 AND project_id = $2`,
      [errorGroupId, projectId, input.headSha, input.prUrl, input.prNumber],
    );

    if (input.status === 'pr_draft') {
      const payload = {
        prNumber: input.prNumber,
        headSha: input.headSha,
        watchStartedAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO error_group_jobs
           (error_group_id, project_id, job_type, triggered_by, payload, available_at)
         SELECT $1, $2, 'ci_watch', 'auto', $3::jsonb, now()
         WHERE NOT EXISTS (
           SELECT 1 FROM error_group_jobs
           WHERE error_group_id = $1 AND project_id = $2
             AND job_type = 'ci_watch' AND status IN ('pending', 'claimed')
         )`,
        [errorGroupId, projectId, JSON.stringify(payload)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * System-level background query: resolves all merged groups across all tenants
 * that have had no new error events since merged_at and where merged_at is
 * older than 24 hours. Intentionally not tenant-scoped.
 * Returns the IDs of resolved groups.
 */
export async function resolveSilentMergedGroups(): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE error_groups g
     SET status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'merged',
         resolved_in_release = (
           SELECT release FROM error_events
           WHERE project_id = g.project_id AND release IS NOT NULL AND release <> ''
           GROUP BY release ORDER BY min(created_at) DESC LIMIT 1
         ),
         updated_at = now()
     WHERE g.status = 'merged'
       AND g.merged_at < now() - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1
         FROM error_events
         WHERE error_group_id = g.id
           AND created_at > g.merged_at
       )
       -- Ongoing linked friction blocks silence resolution (issue #56):
       -- an incident with active accepted friction after the merge is not
       -- silent even when no new error events arrive.
       AND NOT EXISTS (
         SELECT 1
         FROM friction_signals fs
         WHERE fs.incident_id = g.id
           AND fs.adjudication_status = 'accepted'
           AND fs.retracted_at IS NULL
           AND fs.superseded_by IS NULL
           AND fs.occurred_at > g.merged_at
       )
     RETURNING g.id`
  );
  return result.rows.map(r => r.id);
}

/**
 * System-level background query: auto-resolves stuck-open issues not seen in
 * `ageDays` days, independent of any fix. pr_created is intentionally excluded
 * because the PR webhook only processes groups that remain in that status.
 * Intentionally not tenant-scoped.
 */
export async function resolveInactiveGroups(ageDays: number): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE error_groups g
     SET status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'auto_resolved',
         resolved_in_release = (
           SELECT release FROM error_events
           WHERE project_id = g.project_id AND release IS NOT NULL AND release <> ''
           GROUP BY release ORDER BY min(created_at) DESC LIMIT 1
         ),
         updated_at = now()
     WHERE g.status IN ('needs_human', 'investigated')
       AND g.last_seen < now() - ($1 || ' days')::interval
     RETURNING g.id`,
    [String(ageDays)]
  );
  return result.rows.map(r => r.id);
}

// === GitHub installation query ===

export async function getProjectGitHubInstallation(projectId: string): Promise<{
  installationId: number | null;
  githubRepo: string | null;
} | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    github_installation_id: number | null;
    github_repo: string | null;
  }>(
    `SELECT o.github_installation_id, p.github_repo
     FROM projects p
     JOIN orgs o ON o.id = p.org_id
     WHERE p.id = $1`,
    [projectId],
  );
  if (!rows[0]) return null;
  return {
    installationId: rows[0].github_installation_id,
    githubRepo: rows[0].github_repo,
  };
}

// === Data fetch queries (used by processJob) ===
// Every query includes projectId for tenant isolation per CLAUDE.md rules.

export interface ErrorGroupData {
  id: string;
  title: string;
  fingerprint: string;
  sample_event_id: string;
  occurrence_count: number;
  status: string;
  kind: 'error' | 'friction';
  signal_type: string | null;
  element_selector: string | null;
  page_url_normalized: string | null;
  confidence: ConfidenceLevel | null;
  platform?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  reason_code?: string | null;
  reason_message?: string | null;
  remediation?: string | null;
  verification_evidence?: EvidenceRecord | null;
}

export async function getErrorGroup(groupId: string, projectId: string): Promise<ErrorGroupData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ErrorGroupData>(
    `SELECT id, title, fingerprint, sample_event_id, occurrence_count, status,
            kind, signal_type, element_selector, page_url_normalized, confidence, platform,
            pr_url, pr_number, reason_code, reason_message, remediation,
            verification_evidence
     FROM error_groups WHERE id = $1 AND project_id = $2`,
    [groupId, projectId],
  );
  return rows[0] ?? null;
}

export interface EnvironmentContext {
  names: string[];
  totalCount: number;
}

export async function getEnvironmentNamesForGroup(
  groupId: string,
  projectId: string,
  kind: 'error' | 'friction',
): Promise<EnvironmentContext> {
  if (kind === 'friction') {
    const { rows } = await getPool().query<{ name: string; total_count: number }>(
      `SELECT e.name, COUNT(*) OVER()::integer AS total_count
       FROM error_groups eg
       JOIN environments e
         ON e.id = eg.environment_id AND e.project_id = eg.project_id
       WHERE eg.id = $1 AND eg.project_id = $2 AND eg.kind = 'friction'
       LIMIT 20`,
      [groupId, projectId],
    );
    return {
      names: rows.map((row) => row.name),
      totalCount: rows[0]?.total_count ?? 0,
    };
  }

  const { rows } = await getPool().query<{ name: string; total_count: number }>(
    `SELECT e.name, COUNT(*) OVER()::integer AS total_count
     FROM error_groups eg
     JOIN error_group_environments ege ON ege.error_group_id = eg.id
     JOIN environments e
       ON e.id = ege.environment_id AND e.project_id = eg.project_id
     WHERE eg.id = $1 AND eg.project_id = $2 AND eg.kind = 'error'
     ORDER BY e.name, e.id
     LIMIT 20`,
    [groupId, projectId],
  );
  return {
    names: rows.map((row) => row.name),
    totalCount: rows[0]?.total_count ?? 0,
  };
}

/** Persist an external-CI observation, optionally promoting the draft. */
export async function saveExternalCIResult(
  errorGroupId: string,
  projectId: string,
  input: {
    evidence: EvidenceRecord;
    promote: boolean;
    remediation?: string;
  },
  lease: JobLease,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE error_groups g
     SET status = CASE WHEN $6 THEN 'pr_created'::error_group_status ELSE status END,
         confidence = CASE WHEN $6 THEN 'medium' ELSE confidence END,
         verification_evidence = $7::jsonb,
         remediation = CASE WHEN $6 THEN NULL ELSE COALESCE($8, remediation) END,
         reason_code = CASE WHEN $6 THEN NULL ELSE reason_code END,
         reason_message = CASE WHEN $6 THEN NULL ELSE reason_message END,
         candidate_diff = CASE WHEN $6 THEN NULL ELSE candidate_diff END,
         pr_created_at = CASE WHEN $6 THEN COALESCE(pr_created_at, now()) ELSE pr_created_at END,
         updated_at = now()
     WHERE g.id = $1 AND g.project_id = $2 AND g.status = 'pr_draft'
       AND EXISTS (
         SELECT 1 FROM error_group_jobs j
         WHERE j.id = $3 AND j.worker_id = $4
           AND j.lease_generation = $5::bigint
           AND j.project_id = $2 AND j.error_group_id = $1
           AND j.status = 'claimed' AND j.lease_expires_at > now()
       )`,
    [
      errorGroupId,
      projectId,
      lease.id,
      lease.workerId,
      lease.leaseGeneration,
      input.promote,
      JSON.stringify(input.evidence),
      input.remediation ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ErrorEventData {
  id: string;
  error_type: string;
  error_message: string;
  stack_trace_raw: string;
  stack_trace_resolved: unknown;
  debug_meta: string | null;
  breadcrumbs: string;
  context: string;
  release: string | null;
  session_id: string | null;
  platform?: string | null;
}

export async function getErrorEvent(eventId: string, projectId: string): Promise<ErrorEventData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ErrorEventData>(
    `SELECT id, error_type, error_message, stack_trace_raw, stack_trace_resolved,
            debug_meta::text AS debug_meta,
            breadcrumbs::text AS breadcrumbs, context::text AS context, release, session_id, platform
     FROM error_events WHERE id = $1 AND project_id = $2`,
    [eventId, projectId],
  );
  return rows[0] ?? null;
}

export type FrictionAutonomy = 'ask_first' | 'auto_fix' | 'auto_fix_ux';

export interface ProjectData {
  id: string;
  name: string;
  github_repo: string;
  /** NULL until learned from GitHub or resolved from a clone. Never guess. */
  default_branch: string | null;
  friction_autonomy: FrictionAutonomy;
  pr_posture?: PRPosture;
  draft_pr_cap?: number;
}

export async function getProject(projectId: string): Promise<ProjectData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ProjectData>(
    `SELECT id, name, github_repo, default_branch, friction_autonomy, pr_posture, draft_pr_cap
     FROM projects WHERE id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

/**
 * Refresh the cached default branch. Best-effort by contract: the column is a
 * cache, never an authority, so a failed write cannot fail a job that already
 * resolved the correct branch from its clone.
 */
export async function cacheProjectDefaultBranch(
  projectId: string,
  branch: string,
  targetPool: Pick<pg.Pool, 'query'> = getPool(),
): Promise<void> {
  try {
    await targetPool.query(
      `UPDATE projects SET default_branch = $2
       WHERE id = $1 AND default_branch IS DISTINCT FROM $2`,
      [projectId, branch],
    );
  } catch (err: unknown) {
    console.warn('[default-branch-cache] refresh failed', {
      projectId,
      branch,
      err,
    });
  }
}

export async function recordSetupPrResult(
  projectId: string,
  status: SetupPrStatus,
  fields: { pr_url?: string; pr_number?: number; error?: string } = {},
  lease?: JobLease,
): Promise<void> {
  const pool = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $6
           AND worker_id = $7
           AND lease_generation = $8::bigint
           AND project_id = $1
           AND error_group_id IS NOT DISTINCT FROM $9::uuid
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await pool.query(
    `${ownedCte}
     UPDATE projects
        SET setup_pr_status = $2,
            setup_pr_url = COALESCE($3, setup_pr_url),
            setup_pr_number = COALESCE($4, setup_pr_number),
            setup_pr_error = $5
      WHERE id = $1
        ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
      RETURNING id`,
    [
      projectId,
      status,
      fields.pr_url ?? null,
      fields.pr_number ?? null,
      fields.error ?? null,
      ...(lease
        ? [lease.id, lease.workerId, lease.leaseGeneration, lease.errorGroupId]
        : []),
    ],
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

export interface ReplayData {
  id: string;
  session_id: string;
  status: string;
  replay_signals: unknown;
  object_key: string | null;
  trigger_type: string | null;
  page_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  size_bytes: number | null;
}

/** Finds replay for error group -- joins via session_id on error_events when error_group_id is null. */
export async function getReplayForGroup(errorGroupId: string, projectId: string): Promise<ReplayData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ReplayData>(
    `SELECT sr.id, sr.session_id, sr.status, sr.replay_signals, sr.object_key,
            sr.trigger_type, sr.page_url, sr.started_at, sr.ended_at, sr.size_bytes
     FROM session_replays sr
     WHERE sr.project_id = $2
       AND sr.status = 'complete'
       AND (
         sr.error_group_id = $1
         OR sr.session_id IN (
           SELECT ee.session_id FROM error_events ee
           JOIN error_groups eg ON eg.sample_event_id = ee.id
           WHERE eg.id = $1 AND ee.session_id IS NOT NULL
         )
       )
     ORDER BY sr.created_at DESC LIMIT 1`,
    [errorGroupId, projectId],
  );
  return rows[0] ?? null;
}

export interface SessionPointer {
  session_id: string;
  error_at: string;
}

/** Resolves pointer identity independently from chunk readiness. */
export async function getSessionPointerForGroup(
  errorGroupId: string,
  projectId: string,
): Promise<SessionPointer | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ session_id: string; error_at: Date | string }>(
    `SELECT ee.session_id, ee.timestamp AS error_at
       FROM error_events ee
       JOIN sessions s ON s.id = ee.session_id AND s.project_id = $2
      WHERE ee.error_group_id = $1
        AND ee.project_id = $2
        AND ee.session_id IS NOT NULL
        AND s.status <> 'deleting'
      ORDER BY ee.created_at DESC, ee.id DESC
      LIMIT 1`,
    [errorGroupId, projectId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    session_id: row.session_id,
    error_at: row.error_at instanceof Date ? row.error_at.toISOString() : row.error_at,
  };
}

export interface SessionChunkMeta {
  seq: number;
  size_bytes: number | null;
  decoded_size_bytes: number | null;
  has_full_snapshot: boolean;
  first_event_ms: number | null;
  last_event_ms: number | null;
}

function nullableNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Returns only scrubbed chunks belonging to the requested project/session. */
export async function getPlayableChunkMetas(
  sessionId: string,
  projectId: string,
): Promise<SessionChunkMeta[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    seq: number;
    size_bytes: string | number | null;
    decoded_size_bytes: string | number | null;
    has_full_snapshot: boolean;
    first_event_ms: string | number | null;
    last_event_ms: string | number | null;
  }>(
    `SELECT c.seq, c.size_bytes, c.decoded_size_bytes, c.has_full_snapshot,
            c.first_event_ms, c.last_event_ms
       FROM session_chunks c
       JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id = $1
        AND s.project_id = $2
        AND s.status <> 'deleting'
        AND c.scrubbed_at IS NOT NULL
      ORDER BY c.seq ASC`,
    [sessionId, projectId],
  );
  return rows.map((row) => ({
    seq: row.seq,
    size_bytes: nullableNumber(row.size_bytes),
    decoded_size_bytes: nullableNumber(row.decoded_size_bytes),
    has_full_snapshot: row.has_full_snapshot,
    first_event_ms: nullableNumber(row.first_event_ms),
    last_event_ms: nullableNumber(row.last_event_ms),
  }));
}

export interface ReplayArtifactData {
  id: string;
  kind: string;
  object_key: string;
  content_type: string;
  width: number | null;
  height: number | null;
}

export async function getReplayArtifacts(replayId: string, projectId: string): Promise<ReplayArtifactData[]> {
  const pool = getPool();
  const { rows } = await pool.query<ReplayArtifactData>(
    `SELECT sra.id, sra.kind, sra.object_key, sra.content_type, sra.width, sra.height
     FROM session_replay_artifacts sra
     JOIN session_replays sr ON sr.id = sra.replay_id
     WHERE sra.replay_id = $1 AND sr.project_id = $2`,
    [replayId, projectId],
  );
  return rows;
}

export interface SourceMapRow {
  debug_id: string;
  object_key: string;
  content_sha256: string;
}

export async function getSourceMapRows(
  projectId: string,
  debugIds: string[],
): Promise<SourceMapRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SourceMapRow>(
    `SELECT debug_id, object_key, content_sha256
     FROM sourcemap_files WHERE project_id = $1 AND debug_id = ANY($2)`,
    [projectId, debugIds],
  );
  return rows;
}

export interface ResolvedStackEnvelope {
  version: 1;
  frames: {
    original_file: string;
    original_line: number;
    original_column: number;
    source_snippet: string | null;
    generated_file: string;
    generated_line: number;
    generated_column: number;
    debug_id: string;
  }[];
}

/**
 * Record one resolution outcome, without ever destroying a better one.
 *
 * Both the investigate and the fix job resolve the same sample event, so this
 * runs more than once per event and the two runs can disagree. Resolution
 * depends on object storage, so the disagreement is usually a transient fetch
 * failure rather than new information: a fix job running while MinIO blinks
 * would otherwise overwrite a stored envelope with NULL and downgrade a
 * `resolved` event to `resolution_failed`, losing frames nothing recomputes.
 *
 * A run that produced no envelope therefore leaves a stored one alone, and the
 * status stays with it so the pair can never describe different outcomes.
 */
export async function setEventResolution(
  eventId: string,
  projectId: string,
  status: string,
  envelope: ResolvedStackEnvelope | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE error_events
     SET resolution_status = CASE
           WHEN $4::jsonb IS NULL AND stack_trace_resolved IS NOT NULL
             THEN resolution_status
           ELSE $3
         END,
         stack_trace_resolved = COALESCE($4::jsonb, stack_trace_resolved)
     WHERE id = $1 AND project_id = $2`,
    [
      eventId,
      projectId,
      status,
      envelope === null ? null : JSON.stringify(envelope),
    ],
  );
}

// === Investigation lifecycle queries ===

/**
 * Stores investigation results (root_cause, suggested_mitigation) and sets
 * the error group to the given status. Used after investigation completes.
 */
export async function updateGroupInvestigation(
  errorGroupId: string,
  projectId: string,
  status: 'investigated' | 'fixing' | 'pr_created' | 'needs_human' | 'insight' | 'awaiting_approval',
  fields: {
    rootCause?: string;
    suggestedMitigation?: string;
    confidence?: ConfidenceLevel;
    reason?: NeedsHumanReason;
    decision?: DecisionRow;
  },
  lease?: JobLease,
): Promise<void> {
  if (status === 'needs_human') {
    const r = fields.reason;
    if (!r?.reason_code || !r?.reason_message || !r?.remediation) {
      throw new Error(
        `needs_human requires reason fields (reason_code, reason_message, remediation) for group ${errorGroupId}`
      );
    }
  }
  const reason = fields.reason;
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $10
           AND worker_id = $11
           AND lease_generation = $12::bigint
           AND project_id = $2
           AND error_group_id = $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `${ownedCte}
       UPDATE error_groups
     SET status = $3::error_group_status,
         root_cause = $4,
         suggested_mitigation = $5,
         confidence = $6,
         reason_code = $7,
         reason_message = $8,
         remediation = $9,
         pr_created_at = CASE
           WHEN $3::error_group_status = 'pr_created'
                AND status IS DISTINCT FROM 'pr_created' THEN now()
           ELSE pr_created_at
         END,
         needs_human_at = CASE
           WHEN $3::error_group_status = 'needs_human'
                AND status IS DISTINCT FROM 'needs_human' THEN now()
           ELSE needs_human_at
         END,
         updated_at = now()
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
       RETURNING id`,
      [
        errorGroupId,
        projectId,
        status,
        fields.rootCause ?? null,
        fields.suggestedMitigation ?? null,
        fields.confidence ?? null,
        reason?.reason_code ?? null,
        reason?.reason_message ?? null,
        reason?.remediation ?? null,
        ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
      ],
    );
    if (lease && (result.rowCount ?? 0) === 0) {
      throw new LeaseLostError(lease.id);
    }
    if ((result.rowCount ?? 0) > 0 && fields.decision) {
      await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
    }
    await client.query('COMMIT');
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates a fix job for an error group. Used when investigation has high
 * confidence and auto-triggers a fix.
 */
/** Result of an automatic investigate→fix transition attempt. Friction
 * incidents are refused at this layer by default (issue #56 defense in
 * depth): even a future caller that skips the route-level kind check cannot
 * auto-create a fix job for kind='friction'. The one sanctioned exception is
 * the autonomy ladder (issue #57), which must opt in explicitly via
 * allowFriction after checking projects.friction_autonomy — and the fix-job
 * gate in processFixJob re-checks autonomy at claim time as a second layer. */
export type FixJobResult =
  | { created: true; fixJobId: string }
  | { created: false; reason: 'kind_not_error' };

export async function updateGroupAndCreateFixJob(
  errorGroupId: string,
  projectId: string,
  fields: {
    rootCause?: string;
    suggestedMitigation?: string;
    diagnosis?: Diagnosis | null;
    confidence?: ConfidenceLevel;
    platform?: Platform;
    decision?: DecisionRow;
  },
  lease: JobLease,
  opts?: { allowFriction?: boolean },
): Promise<FixJobResult> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id
       FROM error_group_jobs
       WHERE id = $1
         AND worker_id = $2
         AND lease_generation = $3::bigint
         AND error_group_id = $4
         AND project_id = $5
         AND status = 'claimed'
         AND lease_expires_at > now()
       FOR UPDATE`,
      [
        lease.id,
        lease.workerId,
        lease.leaseGeneration,
        errorGroupId,
        projectId,
      ],
    );
    if ((owned.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);

    const group = await client.query<{ status: string; kind: string }>(
      `SELECT status, kind
       FROM error_groups
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [errorGroupId, projectId],
    );
    if ((group.rowCount ?? 0) !== 1) {
      throw new Error(`Cannot create fix job: group ${errorGroupId} was not found`);
    }
    const kind = group.rows[0]!.kind;
    if (kind !== 'error' && !(kind === 'friction' && opts?.allowFriction)) {
      // Typed no-transition result: nothing changed, nothing enqueued.
      // Friction passes only via the autonomy ladder's explicit opt-in.
      await client.query('COMMIT');
      return { created: false, reason: 'kind_not_error' };
    }

    const existingFix = await client.query<{ id: string }>(
      `SELECT id
       FROM error_group_jobs
       WHERE error_group_id = $1
         AND project_id = $2
         AND job_type IN ('fix', 'error_fix')
         AND status IN ('pending', 'claimed')
       ORDER BY created_at, id
       LIMIT 1`,
      [errorGroupId, projectId],
    );
    if (
      existingFix.rows[0]
      && ['analyzing', 'fixing'].includes(group.rows[0]!.status)
    ) {
      await client.query(
        `UPDATE error_group_jobs
         SET platform = COALESCE(platform, $2),
             payload = COALESCE(payload, $3::jsonb),
             updated_at = now()
         WHERE id = $1`,
        [
          existingFix.rows[0].id,
          fields.platform ?? 'javascript',
          fields.diagnosis === undefined ? null : JSON.stringify({ diagnosis: fields.diagnosis }),
        ],
      );
      await client.query(
        `UPDATE error_groups
         SET status = 'fixing', updated_at = now()
         WHERE id = $1 AND project_id = $2`,
        [errorGroupId, projectId],
      );
      if (fields.decision) {
        await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
      }
      await client.query('COMMIT');
      return { created: true, fixJobId: existingFix.rows[0].id };
    }

    const groupUpdate = await client.query(
      `UPDATE error_groups
       SET status = 'fixing',
           root_cause = $3,
           suggested_mitigation = $4,
           confidence = $5,
           updated_at = now()
       WHERE id = $1 AND project_id = $2 AND status = 'analyzing'`,
      [
        errorGroupId,
        projectId,
        fields.rootCause ?? null,
        fields.suggestedMitigation ?? null,
        fields.confidence ?? null,
      ]
    );
    if ((groupUpdate.rowCount ?? 0) !== 1) {
      throw new Error(
        `Cannot create fix job: group ${errorGroupId} is not in analyzing state`,
      );
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by, platform, payload)
       VALUES ($1, $2, 'fix', 'auto', $3, $4::jsonb)
       RETURNING id`,
      [
        errorGroupId,
        projectId,
        fields.platform ?? 'javascript',
        fields.diagnosis === undefined ? null : JSON.stringify({ diagnosis: fields.diagnosis }),
      ]
    );
    if (fields.decision) {
      await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
    }
    await client.query('COMMIT');
    return { created: true, fixJobId: result.rows[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface FrictionSignalRow {
  id: string;
  session_id: string;
  signal_type: 'rage_click' | 'dead_click' | 'form_abandon';
  fingerprint: string;
  element_selector: string | null;
  page_url_normalized: string;
  occurred_at: string;
  occurrence_count: number;
  rule_version: number;
}

export async function getFrictionSignalsForGroup(
  errorGroupId: string,
  projectId: string,
): Promise<FrictionSignalRow[]> {
  const db = getPool();
  const { rows } = await db.query<FrictionSignalRow>(
    `SELECT id, session_id, signal_type, fingerprint, element_selector,
            page_url_normalized, occurred_at, occurrence_count, rule_version
     FROM friction_signals
     WHERE incident_id = $1 AND project_id = $2
       AND superseded_by IS NULL AND retracted_at IS NULL
     ORDER BY occurred_at ASC`,
    [errorGroupId, projectId],
  );
  return rows;
}

export interface SessionChunkRow {
  session_id: string;
  seq: number;
  object_key: string;
  size_bytes: number | null;
  has_full_snapshot: boolean;
}

/** Only server-scrubbed, committed chunks are eligible for worker reads. */
export async function getScrubbedChunksForSession(
  sessionId: string,
  projectId: string,
): Promise<SessionChunkRow[]> {
  const db = getPool();
  const { rows } = await db.query<SessionChunkRow>(
    `SELECT session_id, seq, object_key, size_bytes, has_full_snapshot
     FROM session_chunks
     WHERE session_id = $1 AND project_id = $2 AND scrubbed_at IS NOT NULL
     ORDER BY seq ASC`,
    [sessionId, projectId],
  );
  return rows;
}

export interface SessionRow {
  id: string;
  project_id: string;
  environment_id: string;
  end_user_id: string | null;
  status: string;
}

export async function getSessionForAnalysis(
  sessionId: string,
  projectId: string,
): Promise<SessionRow | null> {
  const db = getPool();
  const { rows } = await db.query<SessionRow>(
    `SELECT id, project_id, environment_id, end_user_id, status
     FROM sessions
     WHERE id = $1 AND project_id = $2`,
    [sessionId, projectId],
  );
  return rows[0] ?? null;
}

export async function setSessionAnalysisStatus(
  sessionId: string,
  projectId: string,
  status: 'analyzing' | 'analyzed' | 'analysis_failed',
  ruleVersion?: number,
  lease?: JobLease,
): Promise<void> {
  const db = getPool();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $5
           AND worker_id = $6
           AND lease_generation = $7::bigint
           AND project_id = $2
           AND error_group_id IS NOT DISTINCT FROM $8::uuid
           AND session_id IS NOT DISTINCT FROM $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  const result = await db.query(
    `${ownedCte}
     UPDATE sessions
     SET status = $3,
         analyzer_rule_version = COALESCE($4, analyzer_rule_version)
     WHERE id = $1 AND project_id = $2
       ${lease ? 'AND EXISTS (SELECT 1 FROM owned)' : ''}
     RETURNING id`,
    [
      sessionId,
      projectId,
      status,
      ruleVersion ?? null,
      ...(lease
        ? [lease.id, lease.workerId, lease.leaseGeneration, lease.errorGroupId]
        : []),
    ],
  );
  if (lease && (result.rowCount ?? 0) === 0) {
    throw new LeaseLostError(lease.id);
  }
}

/**
 * Loads investigation results for a fix job.
 */
export async function getGroupInvestigation(
  errorGroupId: string,
  projectId: string,
): Promise<{ rootCause: string | null; suggestedMitigation: string | null }> {
  const db = getPool();
  const result = await db.query<{ root_cause: string | null; suggested_mitigation: string | null }>(
    `SELECT root_cause, suggested_mitigation
     FROM error_groups
     WHERE id = $1 AND project_id = $2`,
    [errorGroupId, projectId]
  );
  const row = result.rows[0];
  return {
    rootCause: row?.root_cause ?? null,
    suggestedMitigation: row?.suggested_mitigation ?? null,
  };
}
