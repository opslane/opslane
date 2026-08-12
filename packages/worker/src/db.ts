import pg from 'pg';
import type { Diagnosis, DiagnosisOutcome, ErrorGroupStatus, NeedsHumanReason, ConfidenceLevel, JobType, SetupPrStatus, EvidenceRecord, PRPosture } from '@opslane/shared';
import {
  reconcileDeadLetteredSessionAnalysis,
  releaseUnfinishedGeneration,
} from './friction/dead-letter.js';
import type { Platform } from './platform.js';
import type { DerivedDecision } from './classify.js';
import type { RouteMapRow } from './route-map.js';
import { logger, safeErrorMessage } from './logger.js';
import type { LedgerEntry } from './verification-ledger.js';

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

export interface DecisionRow {
  outcome: DiagnosisOutcome;
  decisionReason: string;
  causeLocation?: string | null;
  diagnosis: Diagnosis | Record<string, unknown> | null;
  model: string;
  promptVersion: string;
  jobId?: string | null;
  /**
   * Why the outcome was reached, and how strong the evidence was. Both are
   * required: the fix job reads this row to decide whether it may run, and a
   * decision that cannot answer that is not a decision it can act on.
   */
  basis: DerivedDecision['basis'];
  confidence: ConfidenceLevel;
  policyEligible?: boolean | null;
  policyBasis?: { v: 1; identified_users: number; recent_anon_sessions: number } | null;
}

export type ReadinessStatus = 'eligible' | 'ineligible' | 'pending';
export interface ReadinessWrite {
  status: ReadinessStatus;
  reason: string;
}

/** What a fix job needs from a persisted decision to know whether it may run. */
export interface PersistedDecision {
  outcome: DiagnosisOutcome;
  basis: DerivedDecision['basis'];
  confidence: ConfidenceLevel;
}

export interface LoadedDecision extends PersistedDecision {
  id: string;
  policyEligible: boolean | null;
  policyBasis: { v: 1; identified_users: number; recent_anon_sessions: number } | null;
}

/**
 * Append one decision. Deliberately not idempotent per job: a requeued job keeps
 * its id (requeueStaleJobs updates in place), so the `ON CONFLICT (job_id) DO
 * NOTHING` this used to carry silently discarded every retry's conclusion, and
 * left the fix gate reading a superseded one. See migration 037.
 *
 * Always called inside the transaction that writes the status it accompanies, so
 * a partial replay cannot commit a decision without its status.
 */
async function insertDiagnosisDecision(
  queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  errorGroupId: string,
  projectId: string,
  row: DecisionRow,
): Promise<void> {
  await queryable.query(
    `INSERT INTO diagnosis_decisions
       (error_group_id, project_id, job_id, outcome, decision_reason, cause_location, diagnosis,
        model, prompt_version, basis, confidence, policy_eligible, policy_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)`,
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
      row.basis,
      row.confidence,
      row.policyEligible ?? null,
      row.policyBasis ? JSON.stringify(row.policyBasis) : null,
    ],
  );
}

async function upsertDigestReadiness(
  queryable: Pick<pg.PoolClient, 'query'>,
  errorGroupId: string,
  projectId: string,
  readiness: ReadinessWrite,
): Promise<void> {
  await queryable.query(
    `INSERT INTO digest_readiness (incident_id, project_id, status, reason, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (incident_id) DO UPDATE
     SET status = EXCLUDED.status,
         reason = EXCLUDED.reason,
         updated_at = CASE
           WHEN digest_readiness.status IS DISTINCT FROM EXCLUDED.status
             OR digest_readiness.reason IS DISTINCT FROM EXCLUDED.reason
           THEN now()
           ELSE digest_readiness.updated_at
         END`,
    [errorGroupId, projectId, readiness.status, readiness.reason],
  );
}

/**
 * The most recent decision for a group, or null.
 *
 * Fix jobs read this rather than trusting an in-memory value, so a requeued or
 * retried job is tied to the immutable decision it was created from. Scoped by
 * project as well as group, per the worker's contract that database operations
 * are scoped to the project.
 *
 * A row missing `basis` or `confidence` predates migration 035 and cannot
 * answer whether a fix is authorised, so it reads as no decision at all.
 */
export async function loadDiagnosisDecision(
  errorGroupId: string,
  projectId: string,
): Promise<LoadedDecision | null> {
  const { rows } = await getPool().query<{
    id: string;
    outcome: DiagnosisOutcome;
    basis: string | null;
    confidence: string | null;
    policy_eligible: boolean | null;
    policy_basis: LoadedDecision['policyBasis'];
  }>(
    `SELECT id, outcome, basis, confidence, policy_eligible, policy_basis
     FROM diagnosis_decisions
     WHERE error_group_id = $1 AND project_id = $2
     ORDER BY decided_at DESC, id DESC
     LIMIT 1`,
    [errorGroupId, projectId],
  );
  const row = rows[0];
  if (!row || !row.basis || !row.confidence) return null;
  return {
    id: row.id,
    outcome: row.outcome,
    basis: row.basis as DerivedDecision['basis'],
    confidence: row.confidence as ConfidenceLevel,
    policyEligible: row.policy_eligible,
    policyBasis: row.policy_basis,
  };
}

export async function loadDiagnosisDecisionForSource(
  errorGroupId: string,
  projectId: string,
  sourceJobId: string | null,
): Promise<LoadedDecision | null> {
  if (sourceJobId === null) return loadDiagnosisDecision(errorGroupId, projectId);
  const { rows } = await getPool().query<{
    id: string;
    outcome: DiagnosisOutcome;
    basis: string | null;
    confidence: string | null;
    policy_eligible: boolean | null;
    policy_basis: LoadedDecision['policyBasis'];
  }>(
    `SELECT id, outcome, basis, confidence, policy_eligible, policy_basis
     FROM diagnosis_decisions
     WHERE error_group_id = $1 AND project_id = $2 AND job_id = $3
     ORDER BY decided_at DESC, id DESC
     LIMIT 1`,
    [errorGroupId, projectId, sourceJobId],
  );
  const row = rows[0];
  if (!row || !row.basis || !row.confidence) return null;
  return {
    id: row.id,
    outcome: row.outcome,
    basis: row.basis as DerivedDecision['basis'],
    confidence: row.confidence as ConfidenceLevel,
    policyEligible: row.policy_eligible,
    policyBasis: row.policy_basis,
  };
}

export interface ImpactBar {
  identifiedUsers: number;
  recentAnonSessions: number;
  eligible: boolean;
}

export function impactBarEligible(identifiedUsers: number, recentAnonSessions: number): boolean {
  return identifiedUsers >= 1 || recentAnonSessions >= 3;
}

/** The one place the persisted policy stamp is shaped: both lanes' decision
 * rows must serialize the same policy_basis record or per-lane consumers of
 * the versioned shape silently diverge. */
export function policyFields(bar: ImpactBar | null): { policyEligible: boolean | null; policyBasis: { v: 1; identified_users: number; recent_anon_sessions: number } | null } {
  if (!bar) {
    return { policyEligible: null, policyBasis: null };
  }
  return {
    policyEligible: bar.eligible,
    policyBasis: {
      v: 1,
      identified_users: bar.identifiedUsers,
      recent_anon_sessions: bar.recentAnonSessions,
    },
  };
}

export async function getGroupImpactBar(errorGroupId: string, projectId: string): Promise<ImpactBar> {
  const { rows } = await getPool().query<{
    identified_users: string;
    recent_anon_sessions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM error_group_affected_users u
         WHERE u.error_group_id = $1) AS identified_users,
       (SELECT count(*) FROM (
          SELECT ee.session_id FROM error_events ee
          WHERE ee.project_id = $2 AND ee.error_group_id = $1
            AND ee.session_id IS NOT NULL
            AND ee.timestamp > now() - interval '7 days'
          GROUP BY ee.session_id HAVING bool_and(ee.end_user_id IS NULL)
        ) anon) AS recent_anon_sessions
     WHERE EXISTS (SELECT 1 FROM error_groups eg WHERE eg.id = $1 AND eg.project_id = $2)`,
    [errorGroupId, projectId],
  );
  const identifiedUsers = Number(rows[0]?.identified_users ?? 0);
  const recentAnonSessions = Number(rows[0]?.recent_anon_sessions ?? 0);
  return {
    identifiedUsers,
    recentAnonSessions,
    eligible: impactBarEligible(identifiedUsers, recentAnonSessions),
  };
}

/** Live impact bar over accepted, active sessions for a friction incident.
 * The authorization window uses server-observed created_at; occurred_at is a
 * client clock and is reserved for playback arithmetic. */
export async function getFrictionGroupImpactBar(errorGroupId: string, projectId: string): Promise<ImpactBar> {
  const { rows } = await getPool().query<{
    identified_users: string;
    recent_anon_sessions: string;
  }>(
    `WITH active AS (
       -- One definition of "the incident's live reach": both aggregates below
       -- must count over the same signal population.
       SELECT fs.session_id, fs.end_user_id
         FROM friction_signals fs
        WHERE fs.incident_id = $1 AND fs.project_id = $2
          AND fs.adjudication_status = 'accepted'
          AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
          AND fs.created_at > now() - interval '7 days'
     )
     SELECT
       (SELECT count(DISTINCT end_user_id) FROM active WHERE end_user_id IS NOT NULL) AS identified_users,
       (SELECT count(*) FROM (
          SELECT session_id FROM active GROUP BY session_id HAVING bool_and(end_user_id IS NULL)
        ) anon) AS recent_anon_sessions`,
    [errorGroupId, projectId],
  );
  const identifiedUsers = Number(rows[0]?.identified_users ?? 0);
  const recentAnonSessions = Number(rows[0]?.recent_anon_sessions ?? 0);
  return {
    identifiedUsers,
    recentAnonSessions,
    eligible: impactBarEligible(identifiedUsers, recentAnonSessions),
  };
}

/** Append a diagnosis decision. A retried job is idempotent, never overwritten. */
export async function recordDiagnosisDecision(
  errorGroupId: string,
  projectId: string,
  row: DecisionRow,
): Promise<void> {
  await insertDiagnosisDecision(getPool(), errorGroupId, projectId, row);
}

export type UsagePhase = 'investigation' | 'fix' | 'judge';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Best-effort append to the immutable job usage ledger. Spend analytics must
 * never turn an otherwise successful job into a failure; duplicate phase
 * writes for the same execution and model are collapsed by the database key.
 */
export async function recordJobUsage(entry: {
  jobId: string;
  execution: number;
  phase: UsagePhase;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO job_usage
         (job_id, execution, phase, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_id, execution, phase, model) DO NOTHING`,
      [
        entry.jobId,
        entry.execution,
        entry.phase,
        entry.model,
        Math.round(entry.usage.input),
        Math.round(entry.usage.output),
        Math.round(entry.usage.cacheRead),
        Math.round(entry.usage.cacheWrite),
        Math.max(0, entry.costUsd).toFixed(4),
      ],
    );
  } catch (err: unknown) {
    logger.error('job_usage insert failed', {
      job_id: entry.jobId,
      phase: entry.phase,
      error: safeErrorMessage(err),
    });
  }
}

export async function insertFixRunLedger(entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const params: unknown[] = [];
  const values = entries.map((entry, index) => {
    const offset = index * 14;
    params.push(
      entry.jobId,
      entry.projectId,
      entry.runId,
      entry.entrySeq,
      entry.command,
      entry.commitSha,
      entry.workdirDirty,
      entry.discovered,
      entry.passed,
      entry.failed,
      entry.skipped,
      entry.truncated,
      entry.timedOut,
      JSON.stringify(entry.notRun),
    );
    return `(${Array.from({ length: 14 }, (_, column) => `$${offset + column + 1}`).join(', ')})`;
  });
  await getPool().query(
    `INSERT INTO fix_run_ledger
       (job_id, project_id, run_id, entry_seq, command, commit_sha, workdir_dirty,
        discovered, passed, failed, skipped, truncated, timed_out, not_run)
     VALUES ${values.join(', ')}
     ON CONFLICT (run_id, entry_seq) DO NOTHING`,
    params,
  );
}

export interface ClaimedJob {
  id: string;
  workerId: string;
  errorGroupId: string | null;
  sourceId: string | null;
  sourceJobId?: string | null;
  projectId: string;
  jobType: JobType;
  attempts: number;
  /** Maximum failed executions before the job dead-letters. Populated by claimJob. */
  maxAttempts?: number;
  guidance: string | null;
  /** Monotonically increasing fencing token for this claim. */
  leaseGeneration: string;
  triggeredBy: 'auto' | 'human' | 'reinvestigate_report_only' | null;
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
  triggeredBy?: 'auto' | 'human' | 'reinvestigate_report_only' | null;
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
    source_job_id: string | null;
    project_id: string;
    job_type: JobType;
    attempts: number;
    max_attempts: number;
    guidance: string | null;
    worker_id: string;
    lease_generation: string;
    triggered_by: 'auto' | 'human' | 'reinvestigate_report_only' | null;
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
         -- Route classification is background enrichment. Keep it behind every
         -- incident/session lane even when its rows are older.
         WHEN job_type = 'route_map' THEN 4
         WHEN job_type <> 'session_analysis' THEN 2
         ELSE 3
       END, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, error_group_id, source_id, source_job_id, project_id, job_type, attempts, max_attempts, guidance,
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
    sourceJobId: row.source_job_id,
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
    } else if (row && row.job_type === 'session_analysis') {
      // Non-terminal failure: the job is going back on the queue, so it must
      // not keep the in-flight adjudication slot. Same transaction as the flip.
      await releaseUnfinishedGeneration(client, jobId, row.project_id);
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
      } else if (row.job_type === 'session_analysis') {
        // Lease expired and the job is going back to pending. A worker that
        // died mid-adjudication never ran its own cleanup, so release the
        // in-flight generation here or the bucket stays wedged.
        await releaseUnfinishedGeneration(client, row.id, row.project_id);
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
    terminalFixJobId?: string;
    readiness?: ReadinessWrite;
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
  const client = await getPool().connect();
  const ownedCte = lease
    ? `WITH owned AS (
         SELECT id FROM error_group_jobs
         WHERE id = $14
           AND worker_id = $15
           AND lease_generation = $16::bigint
           AND project_id = $2
           AND error_group_id = $1
           AND status = 'claimed'
           AND lease_expires_at > now()
         FOR UPDATE
       )`
    : '';
  try {
    await client.query('BEGIN');
    const result = await client.query(
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
         terminal_fix_job_id = COALESCE($13, terminal_fix_job_id),
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
      fields?.terminalFixJobId ?? null,
      ...(lease ? [lease.id, lease.workerId, lease.leaseGeneration] : []),
    ]
    );
    if (lease && (result.rowCount ?? 0) === 0) throw new LeaseLostError(lease.id);

  // A failure-path park must not leave the incident invisible forever: a
  // requeue may have set digest_readiness to 'pending', and the terminal
  // transitions that come through here (no-app-frames, clone failure,
  // verification-infra exits) never reach the investigation-completion writes
  // that would resolve it. Demote only an existing pending row — legacy
  // absent-row groups stay absent-row (C1 interim policy), and completion
  // paths go through updateGroupInvestigation, which writes readiness itself.
    if ((result.rowCount ?? 0) > 0 && fields?.readiness) {
      await upsertDigestReadiness(client, errorGroupId, projectId, fields.readiness);
    } else if (status === 'needs_human' && (result.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE digest_readiness
         SET status = 'ineligible', reason = $3, updated_at = now()
         WHERE incident_id = $1 AND project_id = $2 AND status = 'pending'`,
        [errorGroupId, projectId, fields?.reason?.reason_code ?? 'investigation_failed'],
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
    readiness?: ReadinessWrite;
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
           terminal_fix_job_id = $7,
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
    if (input.readiness) {
      await upsertDigestReadiness(client, errorGroupId, projectId, input.readiness);
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
  terminal_fix_job_id?: string | null;
  pr_fix_triggered_by?: 'auto' | 'human' | 'reinvestigate_report_only' | null;
}

export async function getErrorGroup(groupId: string, projectId: string): Promise<ErrorGroupData | null> {
  const pool = getPool();
  const { rows } = await pool.query<ErrorGroupData>(
    `SELECT id, title, fingerprint, sample_event_id, occurrence_count, status,
            kind, signal_type, element_selector, page_url_normalized, confidence, platform,
            pr_url, pr_number, reason_code, reason_message, remediation,
            verification_evidence, terminal_fix_job_id,
            (SELECT j.triggered_by FROM error_group_jobs j
             WHERE j.id = error_groups.pr_fix_job_id AND j.project_id = error_groups.project_id) AS pr_fix_triggered_by
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

/** Mirrors priority.MaxPatternBytes in packages/ingestion/priority/urlnorm.go. */
export const MAX_ROUTE_PATTERN_BYTES = 512;

/**
 * Normalized routes on open groups that do not yet have a classification.
 * Exact matching is intentional, and a row from any source (including
 * llm-unresolved) resolves a pattern permanently until an operator changes it.
 *
 * Both kinds are stamped onto error_groups by the ingestion sweeper, which
 * runs every URL through one normalizer, so an error and a friction incident
 * on the same page share a pattern. Do not assume the upstream values agree:
 * ./friction/fingerprint.ts still writes an origin-prefixed, less-templated
 * value onto friction_signals, and the sweeper re-normalizes it on the way in.
 *
 * The length filter is defence in depth for anything that reaches the column
 * by another route. An oversized pattern is unindexable by route_map's
 * (project_id, pattern) btree, and since every route is written in one
 * transaction, one such row would abort the whole project's classification on
 * every run. Dropping it here leaves that route unclassified at weight 1.0,
 * which is the degradation we want.
 */
export async function listUnmappedPatterns(projectId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ pattern: string }>(
    `SELECT DISTINCT eg.page_url_normalized AS pattern
       FROM error_groups eg
      WHERE eg.project_id = $1
        AND eg.page_url_normalized IS NOT NULL
        AND eg.page_url_normalized <> ''
        AND octet_length(eg.page_url_normalized) <= $2
        AND eg.status NOT IN ('resolved', 'merged', 'archived')
        AND NOT EXISTS (
          SELECT 1
            FROM route_map rm
           WHERE rm.project_id = eg.project_id
             AND rm.pattern = eg.page_url_normalized
        )
      ORDER BY pattern`,
    [projectId, MAX_ROUTE_PATTERN_BYTES],
  );
  return rows.map((row) => row.pattern);
}

/**
 * Persist one route-classification result while holding the job row lock.
 *
 * The lease check and route writes share a transaction so an expired or
 * reclaimed worker can never overwrite the newer owner's classifications.
 * Human-authored rows are authoritative and are never overwritten by either
 * model output or the neutral unresolved placeholder.
 */
export async function upsertRouteMapRows(args: {
  projectId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: string;
  rows: RouteMapRow[];
  unresolved: string[];
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const lease = await client.query(
      `SELECT 1
         FROM error_group_jobs
        WHERE id = $1
          AND project_id = $2
          AND worker_id = $3
          AND lease_generation = $4::bigint
          AND status = 'claimed'
          AND lease_expires_at > now()
        FOR UPDATE`,
      [args.jobId, args.projectId, args.workerId, args.leaseGeneration],
    );
    if ((lease.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const write = async (
      row: RouteMapRow,
      source: 'llm' | 'llm-unresolved',
    ): Promise<void> => {
      await client.query(
        `INSERT INTO route_map (project_id, pattern, name, purpose, tier, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id, pattern) DO UPDATE
         SET name = EXCLUDED.name,
             purpose = EXCLUDED.purpose,
             tier = EXCLUDED.tier,
             source = EXCLUDED.source,
             updated_at = now()
         WHERE route_map.source <> 'human'`,
        [args.projectId, row.pattern, row.name, row.purpose, row.tier, source],
      );
    };

    for (const row of args.rows) await write(row, 'llm');
    for (const pattern of args.unresolved) {
      await write({
        pattern,
        name: pattern,
        purpose: 'unclassified',
        tier: 'standard',
      }, 'llm-unresolved');
    }

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

/** Resolves pointer identity independently from chunk readiness. This mirror
 * serves both error and friction fix evidence, so it matches the Go reader's
 * representative-first friction fallback. */
export async function getSessionPointerForGroup(
  errorGroupId: string,
  projectId: string,
): Promise<SessionPointer | null> {
  const pool = getPool();
  const kindResult = await pool.query<{ kind: 'error' | 'friction' }>(
    `SELECT kind FROM error_groups WHERE id = $1 AND project_id = $2`,
    [errorGroupId, projectId],
  );
  const kind = kindResult.rows[0]?.kind;
  if (!kind) return null;
  const query = kind === 'friction'
    ? `SELECT fs.session_id, fs.occurred_at AS error_at
         FROM friction_signals fs
         JOIN sessions s ON s.id = fs.session_id AND s.project_id = fs.project_id
         JOIN error_groups g ON g.id = $1 AND g.project_id = $2
        WHERE fs.incident_id = $1 AND fs.project_id = $2
          AND fs.adjudication_status = 'accepted'
          AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
          AND s.status <> 'deleting'
        ORDER BY (fs.id = g.representative_signal_id) DESC, fs.occurred_at ASC, fs.id ASC
        LIMIT 1`
    : `SELECT ee.session_id, ee.timestamp AS error_at
         FROM error_events ee
         JOIN sessions s ON s.id = ee.session_id AND s.project_id = $2
        WHERE ee.error_group_id = $1
          AND ee.project_id = $2
          AND ee.session_id IS NOT NULL
          AND s.status <> 'deleting'
        ORDER BY ee.created_at DESC, ee.id DESC
        LIMIT 1`;
  const { rows } = await pool.query<{ session_id: string; error_at: Date | string }>(
    query,
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
    rootCause?: string | null;
    suggestedMitigation?: string | null;
    confidence?: ConfidenceLevel;
    reason?: NeedsHumanReason;
    decision?: DecisionRow;
    readiness?: ReadinessWrite;
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
    if ((result.rowCount ?? 0) > 0 && fields.readiness) {
      await upsertDigestReadiness(client, errorGroupId, projectId, fields.readiness);
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
  | { created: false; reason: 'kind_not_error' | 'report_only' | 'pending_human_job' };

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
    sourceJobId?: string;
    readiness?: ReadinessWrite;
  },
  lease: JobLease,
  opts?: { allowFriction?: boolean },
): Promise<FixJobResult> {
  if (lease.triggeredBy === 'reinvestigate_report_only') {
    return { created: false, reason: 'report_only' };
  }
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

    const humanFix = await client.query<{ id: string }>(
      `SELECT id
       FROM error_group_jobs
       WHERE error_group_id = $1
         AND project_id = $2
         AND job_type IN ('fix', 'error_fix')
         AND status IN ('pending', 'claimed')
         AND triggered_by = 'human'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
      [errorGroupId, projectId],
    );
    if (humanFix.rows[0]) {
      if (fields.decision) await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
      if (fields.readiness) await upsertDigestReadiness(client, errorGroupId, projectId, fields.readiness);
      await client.query('COMMIT');
      return { created: false, reason: 'pending_human_job' };
    }

    const existingFix = await client.query<{ id: string; status: 'pending' | 'claimed' }>(
      `SELECT id, status
       FROM error_group_jobs
       WHERE error_group_id = $1
         AND project_id = $2
         AND job_type IN ('fix', 'error_fix')
         AND status IN ('pending', 'claimed')
         AND triggered_by IS DISTINCT FROM 'human'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
      [errorGroupId, projectId],
    );
    if (
      existingFix.rows[0]
      && ['analyzing', 'fixing'].includes(group.rows[0]!.status)
    ) {
      if (existingFix.rows[0].status === 'pending') {
        // Atomic repoint (CP2/AC2.9): a pending fix job reused by a newer
        // investigation must take the NEW decision's source and payload — this
        // overwrite is deliberate and must NOT be COALESCE'd back (that would
        // strand the job on the stale decision). Safe because both create and
        // repoint default the same fields per lane: the error caller always
        // passes platform+diagnosis, the friction caller never does, and a
        // group's kind fixes which lane creates AND repoints it, so the values
        // written here always match what the create branch wrote.
        await client.query(
          `UPDATE error_group_jobs
           SET platform = $2,
               payload = $3::jsonb,
               source_job_id = $4,
               updated_at = now()
           WHERE id = $1`,
          [
            existingFix.rows[0].id,
            fields.platform ?? 'javascript',
            fields.diagnosis === undefined ? null : JSON.stringify({ diagnosis: fields.diagnosis }),
            fields.sourceJobId ?? null,
          ],
        );
      }
      await client.query(
        `UPDATE error_groups
         SET status = 'fixing', updated_at = now()
         WHERE id = $1 AND project_id = $2`,
        [errorGroupId, projectId],
      );
      if (fields.decision) {
        await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
      }
      if (fields.readiness) {
        await upsertDigestReadiness(client, errorGroupId, projectId, fields.readiness);
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
      `INSERT INTO error_group_jobs
         (error_group_id, project_id, job_type, triggered_by, platform, payload, source_job_id)
       VALUES ($1, $2, 'fix', 'auto', $3, $4::jsonb, $5)
       RETURNING id`,
      [
        errorGroupId,
        projectId,
        fields.platform ?? 'javascript',
        fields.diagnosis === undefined ? null : JSON.stringify({ diagnosis: fields.diagnosis }),
        fields.sourceJobId ?? null,
      ]
    );
    if (fields.decision) {
      await insertDiagnosisDecision(client, errorGroupId, projectId, fields.decision);
    }
    if (fields.readiness) {
      await upsertDigestReadiness(client, errorGroupId, projectId, fields.readiness);
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

export async function getScrubbedChunksInRange(
  sessionId: string,
  projectId: string,
  fromMs: number,
  toMs: number,
): Promise<SessionChunkRow[]> {
  const { rows } = await getPool().query<SessionChunkRow>(
    `SELECT session_id, seq, object_key, size_bytes, has_full_snapshot
     FROM session_chunks
     WHERE session_id = $1 AND project_id = $2 AND scrubbed_at IS NOT NULL
       AND first_event_ms IS NOT NULL AND last_event_ms IS NOT NULL
       AND first_event_ms <= $4 AND last_event_ms >= $3
     ORDER BY seq ASC`,
    [sessionId, projectId, fromMs, toMs],
  );
  return rows;
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
  started_at: string;
  chunk_count: number;
}

export async function getSessionForAnalysis(
  sessionId: string,
  projectId: string,
): Promise<SessionRow | null> {
  const db = getPool();
  const { rows } = await db.query<SessionRow>(
    `SELECT id, project_id, environment_id, end_user_id, status,
            started_at::text AS started_at, chunk_count
     FROM sessions
     WHERE id = $1 AND project_id = $2`,
    [sessionId, projectId],
  );
  return rows[0] ?? null;
}

export interface SessionAnalysisUpsert {
  sessionId: string;
  projectId: string;
  environmentId: string | null;
  sessionStartedAt: string;
  coverage: 'complete' | 'partial' | 'no_replay';
  activityClass: 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';
  entryPath: string | null;
  clickCount: number;
  inputEventCount: number;
  pageEventCount: number;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  unattributedFailedRequestCount: number;
  successfulWriteCount: number;
  failedWriteCount: number;
  ruleVersion: number;
}

export async function upsertSessionAnalysis(row: SessionAnalysisUpsert): Promise<void> {
  await getPool().query(
    `INSERT INTO session_analysis
       (session_id, project_id, environment_id, session_started_at, coverage,
        activity_class, entry_path, click_count, input_event_count, page_event_count,
        failed_request_4xx_count, failed_request_5xx_count,
        unattributed_failed_request_count, successful_write_count, failed_write_count,
        rule_version, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (session_id) DO UPDATE SET
       coverage = EXCLUDED.coverage,
       activity_class = EXCLUDED.activity_class,
       entry_path = EXCLUDED.entry_path,
       click_count = EXCLUDED.click_count,
       input_event_count = EXCLUDED.input_event_count,
       page_event_count = EXCLUDED.page_event_count,
       failed_request_4xx_count = EXCLUDED.failed_request_4xx_count,
       failed_request_5xx_count = EXCLUDED.failed_request_5xx_count,
       unattributed_failed_request_count = EXCLUDED.unattributed_failed_request_count,
       successful_write_count = EXCLUDED.successful_write_count,
       failed_write_count = EXCLUDED.failed_write_count,
       rule_version = EXCLUDED.rule_version,
       analyzed_at = now()`,
    [row.sessionId, row.projectId, row.environmentId, row.sessionStartedAt, row.coverage,
      row.activityClass, row.entryPath, row.clickCount, row.inputEventCount, row.pageEventCount,
      row.failedRequest4xxCount, row.failedRequest5xxCount, row.unattributedFailedRequestCount,
      row.successfulWriteCount, row.failedWriteCount, row.ruleVersion],
  );
}

export async function getSessionAnalysis(
  sessionId: string,
  projectId: string,
): Promise<(SessionAnalysisUpsert & { analyzedAt: string }) | null> {
  const { rows } = await getPool().query<{
    session_id: string; project_id: string; environment_id: string | null;
    session_started_at: string; coverage: SessionAnalysisUpsert['coverage'];
    activity_class: SessionAnalysisUpsert['activityClass']; entry_path: string | null;
    click_count: number; input_event_count: number; page_event_count: number;
    failed_request_4xx_count: number; failed_request_5xx_count: number;
    unattributed_failed_request_count: number; successful_write_count: number;
    failed_write_count: number; rule_version: number; analyzed_at: string;
  }>(
    `SELECT session_id, project_id, environment_id, session_started_at::text,
            coverage, activity_class, entry_path, click_count, input_event_count,
            page_event_count, failed_request_4xx_count, failed_request_5xx_count,
            unattributed_failed_request_count, successful_write_count, failed_write_count,
            rule_version, analyzed_at::text
       FROM session_analysis WHERE session_id = $1 AND project_id = $2`,
    [sessionId, projectId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id, projectId: row.project_id, environmentId: row.environment_id,
    sessionStartedAt: row.session_started_at, coverage: row.coverage,
    activityClass: row.activity_class, entryPath: row.entry_path, clickCount: row.click_count,
    inputEventCount: row.input_event_count, pageEventCount: row.page_event_count,
    failedRequest4xxCount: row.failed_request_4xx_count,
    failedRequest5xxCount: row.failed_request_5xx_count,
    unattributedFailedRequestCount: row.unattributed_failed_request_count,
    successfulWriteCount: row.successful_write_count, failedWriteCount: row.failed_write_count,
    ruleVersion: row.rule_version, analyzedAt: row.analyzed_at,
  };
}

export async function enqueueSessionAnalysisForBudgetRetry(
  sessionId: string,
  projectId: string,
): Promise<void> {
  // The current analysis row is still claimed when this runs, so only a
  // future pending row can be the idempotence guard. Including claimed rows
  // would suppress the retry every time.
  await getPool().query(
    `INSERT INTO error_group_jobs (project_id, job_type, session_id, available_at)
     SELECT $2, 'session_analysis', $1, date_trunc('day', now()) + interval '1 day'
     WHERE NOT EXISTS (
       SELECT 1 FROM error_group_jobs
       WHERE session_id = $1 AND project_id = $2 AND job_type = 'session_analysis'
         AND status = 'pending')`,
    [sessionId, projectId],
  );
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
