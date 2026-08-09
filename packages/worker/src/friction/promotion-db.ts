import { createHash } from 'node:crypto';
import type pg from 'pg';
import { getPool } from '../db.js';
import type { AdjudicationVerdict } from './adjudicator.js';

export async function tryReserveAdjudicationCall(
  client: pg.PoolClient,
  projectId: string,
  dailyCap: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO adjudication_call_budget (project_id, day, calls)
     SELECT $1, CURRENT_DATE, 1 WHERE $2 > 0
     ON CONFLICT (project_id, day)
     DO UPDATE SET calls = adjudication_call_budget.calls + 1
     WHERE adjudication_call_budget.calls < $2`,
    [projectId, dailyCap],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * DB primitives for Batch 4 fold/promotion (issue #56). Every function takes
 * a checked-out client so callers control transaction boundaries; the
 * orchestration in promotion.ts owns BEGIN/COMMIT and advisory locking.
 */

/** Atomically claims signals for one adjudication attempt: records the owning
 * session_analysis job and increments the per-signal attempt counter. Only
 * 'pending' rows are claimable — accepted/rejected/unchecked are terminal for
 * claiming purposes. Returns how many rows were claimed. */
export async function claimSignalsForAdjudication(
  client: pg.PoolClient,
  signalIds: string[],
  jobId: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE friction_signals
     SET adjudication_job_id = $2,
         adjudication_attempts = adjudication_attempts + 1
     WHERE id = ANY($1::uuid[]) AND adjudication_status = 'pending'`,
    [signalIds, jobId],
  );
  return res.rowCount ?? 0;
}

export interface FoldTarget {
  errorGroupId: string;
  status: string;
  title: string;
  secondsAway: number;
}

/** Finds the fold target for a signal: the nearest same-session error event
 * (client time, inclusive ±30s) whose group is a non-archived error incident.
 * Ties break on event recency distance first, then group id, so retries pick
 * the same target. Archived groups are permanent dismissals and friction
 * incidents are never fold targets. */
export async function findFoldTarget(
  client: pg.PoolClient,
  projectId: string,
  sessionId: string,
  occurredAt: string,
): Promise<FoldTarget | null> {
  const { rows } = await client.query<{
    error_group_id: string;
    status: string;
    title: string;
    seconds_away: number;
  }>(
    `SELECT eg.id AS error_group_id, eg.status, eg.title,
            abs(extract(epoch FROM (ee."timestamp" - $3::timestamptz)))::float8 AS seconds_away
       FROM error_events ee
       JOIN error_groups eg ON eg.id = ee.error_group_id
      WHERE ee.session_id = $2
        AND ee.project_id = $1
        AND eg.kind = 'error'
        AND eg.status <> 'archived'
        AND ee."timestamp" BETWEEN $3::timestamptz - interval '30 seconds'
                                AND $3::timestamptz + interval '30 seconds'
      ORDER BY abs(extract(epoch FROM (ee."timestamp" - $3::timestamptz))), eg.id
      LIMIT 1`,
    [projectId, sessionId, occurredAt],
  );
  const row = rows[0];
  return row
    ? {
        errorGroupId: row.error_group_id,
        status: row.status,
        title: row.title,
        secondsAway: row.seconds_away,
      }
    : null;
}

/** Ids and total session-level occurrences of the bucket's evidence at this
 * rule version: active, identified, in-window, whatever the verdict. A verdict
 * must not delete the evidence it judged, or the bucket refills from zero and
 * asks the model the same question again. `unchecked` alone is excluded: it
 * means the owning job dead-lettered before a verdict (dead-letter.ts:14). */
export async function listEligibleSignals(
  client: pg.PoolClient,
  tuple: Pick<BucketTuple, 'projectId' | 'environmentId' | 'fingerprint' | 'ruleVersion'>,
): Promise<{ ids: string[]; totalOccurrences: number }> {
  const { rows } = await client.query<{ id: string; occurrence_count: number }>(
    `SELECT id, occurrence_count
     FROM friction_signals
     WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
       AND rule_version = $4
       AND end_user_id IS NOT NULL
       AND adjudication_status <> 'unchecked'
       AND retracted_at IS NULL AND superseded_by IS NULL
       AND occurred_at > now() - interval '7 days'`,
    [tuple.projectId, tuple.environmentId, tuple.fingerprint, tuple.ruleVersion],
  );
  return {
    ids: rows.map((r) => r.id),
    totalOccurrences: rows.reduce((sum, r) => sum + r.occurrence_count, 0),
  };
}

/** Row shape consumed by the fold path (matches friction_signals columns). */
export interface FoldSignal {
  id: string;
  project_id: string;
  environment_id: string;
  end_user_id: string | null;
  session_id: string;
  fingerprint: string;
  occurred_at: string;
}

export interface FoldMeta {
  modelId: string;
  promptVersion: number;
  jobId: string;
}

export type FoldOutcome = 'attached' | 'rejected' | 'no_target' | 'noop';

/** Stable 2×int32 advisory-lock key for a (project, environment, fingerprint)
 * tuple, shared by fold and bucket paths so they serialize with each other. */
export function tupleLockKey(
  projectId: string,
  environmentId: string,
  fingerprint: string,
): [number, number] {
  const digest = createHash('sha256')
    .update(`${projectId}:${environmentId}:${fingerprint}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * One transaction that persists an eager-fold verdict and applies its visible
 * outcome atomically (plan: atomic promotion and impact).
 *
 * - Serialized per tuple with an advisory transaction lock.
 * - Re-checks the row under lock: active, not superseded, not attached.
 * - Idempotent: `incident_id` is the attachment guard; a retry that finds an
 *   accepted-but-unattached row resumes attachment (crash recovery), while
 *   rejected/unchecked and accepted-and-attached rows are terminal no-ops.
 * - Terminal fold behavior (plan D6): impact updates on resolved/merged
 *   targets without a status change and without enqueueing anything.
 */
export async function applyFoldOutcome(opts: {
  signal: FoldSignal;
  verdict: AdjudicationVerdict;
  meta: FoldMeta;
}): Promise<FoldOutcome> {
  const { signal, verdict, meta } = opts;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const [k1, k2] = tupleLockKey(signal.project_id, signal.environment_id, signal.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

    const { rows } = await client.query<{
      adjudication_status: string;
      incident_id: string | null;
    }>(
      `SELECT adjudication_status, incident_id
       FROM friction_signals
       WHERE id = $1 AND project_id = $2
         AND retracted_at IS NULL AND superseded_by IS NULL
       FOR UPDATE`,
      [signal.id, signal.project_id],
    );
    const current = rows[0];
    if (
      !current ||
      current.incident_id !== null ||
      current.adjudication_status === 'rejected' ||
      current.adjudication_status === 'unchecked'
    ) {
      await client.query('COMMIT');
      return 'noop';
    }

    // Persist the verdict audit. Also runs on crash-resume (status already
    // 'accepted'): the audit fields are refreshed, the outcome is re-applied.
    await client.query(
      `UPDATE friction_signals
       SET adjudication_status = $2,
           adjudication_scope = 'fold',
           adjudicated_at = now(),
           adjudication_model = $3,
           adjudication_prompt_version = $4,
           adjudication_reason = $5
       WHERE id = $1`,
      [
        signal.id,
        verdict.accepted ? 'accepted' : 'rejected',
        meta.modelId,
        meta.promptVersion,
        verdict.reason,
      ],
    );
    if (!verdict.accepted) {
      await client.query('COMMIT');
      return 'rejected';
    }

    const target = await findFoldTarget(
      client,
      signal.project_id,
      signal.session_id,
      signal.occurred_at,
    );
    if (!target) {
      // Verdict stays persisted; the caller continues down the bucket path.
      await client.query('COMMIT');
      return 'no_target';
    }

    // Attach exactly once with incremental impact and the 90-day evidence
    // pin; preserve the target's status and never enqueue work on a fold.
    await attachSignalIncrementally(client, signal, target.errorGroupId);

    await client.query('COMMIT');
    return 'attached';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// === Bucket path (plan D1: one adjudication per threshold crossing) ===

export interface BucketTuple {
  projectId: string;
  environmentId: string;
  fingerprint: string;
  ruleVersion: number;
  promptVersion: number;
}

export interface GenerationRow {
  id: string;
  status: string;
  claim_job_id: string | null;
  model_id: string | null;
  prompt_version: number;
  promoted_incident_id: string | null;
}

export type BucketOutcome = 'promoted' | 'updated' | 'rejected' | 'noop';

/** Friction incidents reuse UNIQUE(project_id, fingerprint) by deriving an
 * environment-scoped grouping key, so production and staging never combine. */
export function frictionIncidentFingerprint(environmentId: string, signalFingerprint: string): string {
  return `friction:${environmentId}:${signalFingerprint}`;
}

const SIGNAL_TYPE_TITLES: Record<string, string> = {
  rage_click: 'Rage clicks',
  dead_click: 'Dead clicks',
  form_abandon: 'Form abandonment',
};

export interface CandidateDescriptor {
  signalType: string;
  pageUrlNormalized: string;
  elementSelector: string | null;
}

/** Upserts the hidden candidate row (plan D2): a pure workflow record with
 * zero impact — no occurrence, no affected users, no junction rows — until
 * promotion. Returns the candidate/incident id for the tuple. */
export async function ensureCandidate(
  client: pg.PoolClient,
  tuple: Pick<BucketTuple, 'projectId' | 'environmentId' | 'fingerprint'>,
  descriptor: CandidateDescriptor,
): Promise<string> {
  const incidentFp = frictionIncidentFingerprint(tuple.environmentId, tuple.fingerprint);
  const title = `${SIGNAL_TYPE_TITLES[descriptor.signalType] ?? 'Friction'} on ${descriptor.pageUrlNormalized}`;
  await client.query(
    `INSERT INTO error_groups
       (project_id, fingerprint, title, first_seen, last_seen,
        occurrence_count, affected_users_count, status, kind,
        environment_id, signal_type, element_selector, page_url_normalized)
     VALUES ($1, $2, $3, now(), now(), 0, 0, 'candidate', 'friction', $4, $5, $6, $7)
     ON CONFLICT (project_id, fingerprint) DO NOTHING`,
    [
      tuple.projectId,
      incidentFp,
      title,
      tuple.environmentId,
      descriptor.signalType,
      descriptor.elementSelector,
      descriptor.pageUrlNormalized,
    ],
  );
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM error_groups WHERE project_id = $1 AND fingerprint = $2`,
    [tuple.projectId, incidentFp],
  );
  return rows[0]!.id;
}

/** Distinct identified users behind the bucket's active evidence at this rule
 * version, in the rolling seven-day window. Adjudicated rows stay evidence:
 * counting only 'pending' made every verdict delete what it had just judged,
 * so the bucket refilled from zero and re-asked the same question. Anonymous
 * signals never count (plan D3); retracted and superseded signals never count
 * (plan D5); `unchecked` never counts, because it marks a job that
 * dead-lettered before reaching a verdict (dead-letter.ts:14). Rule version is
 * part of the key: signals from different detector generations must not pool
 * into one threshold that is then stamped with a single version. */
export async function countEligibleUsers(
  client: pg.PoolClient,
  tuple: Pick<BucketTuple, 'projectId' | 'environmentId' | 'fingerprint' | 'ruleVersion'>,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT COUNT(DISTINCT end_user_id)::int AS n
     FROM friction_signals
     WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
       AND rule_version = $4
       AND end_user_id IS NOT NULL
       AND adjudication_status <> 'unchecked'
       AND retracted_at IS NULL AND superseded_by IS NULL
       AND occurred_at > now() - interval '7 days'`,
    [tuple.projectId, tuple.environmentId, tuple.fingerprint, tuple.ruleVersion],
  );
  return rows[0]!.n;
}

/** Distinct identified users present the last time this bucket was judged by
 * this rule and prompt version. Returns null when never judged, or when the
 * last judgement is older than the evidence window: a bucket whose evidence
 * decayed must not stay frozen behind a stale high-water mark (a bucket judged
 * at 100 users whose evidence falls to 5 would otherwise need 150 forever).
 * Takes the full tuple because prompt_version is part of the watermark key: a
 * new prompt must be able to re-judge what an older prompt already judged. */
export async function readBucketState(
  client: pg.PoolClient,
  tuple: BucketTuple,
): Promise<{ evaluatedUsers: number } | null> {
  const { rows } = await client.query<{ evaluated_users: number }>(
    `SELECT evaluated_users
     FROM friction_bucket_state
     WHERE project_id = $1 AND environment_id = $2
       AND fingerprint = $3 AND rule_version = $4 AND prompt_version = $5
       AND evaluated_at IS NOT NULL
       AND evaluated_at > now() - interval '7 days'`,
    [
      tuple.projectId, tuple.environmentId, tuple.fingerprint,
      tuple.ruleVersion, tuple.promptVersion,
    ],
  );
  const row = rows[0];
  return row ? { evaluatedUsers: row.evaluated_users } : null;
}

/** The watermark upsert itself. Callers own the transaction and must already
 * hold the bucket advisory lock, so evaluated_users, evaluated_at and
 * last_generation_id always describe the same evaluation. Last-write-wins, not
 * GREATEST: under the lock the last writer is the one that actually judged the
 * bucket, and a monotonic maximum is exactly what freezes a decayed bucket. */
async function writeBucketState(
  client: pg.PoolClient,
  tuple: BucketTuple,
  opts: { evaluatedUsers: number; generationId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO friction_bucket_state
       (project_id, environment_id, fingerprint, rule_version, prompt_version,
        evaluated_users, evaluated_at, last_generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (project_id, environment_id, fingerprint, rule_version, prompt_version)
     DO UPDATE SET
       evaluated_users = EXCLUDED.evaluated_users,
       evaluated_at = EXCLUDED.evaluated_at,
       last_generation_id = EXCLUDED.last_generation_id,
       updated_at = now()`,
    [
      tuple.projectId, tuple.environmentId, tuple.fingerprint,
      tuple.ruleVersion, tuple.promptVersion,
      opts.evaluatedUsers, opts.generationId,
    ],
  );
}

/** Standalone watermark write for callers outside applyBucketOutcome's
 * transaction (none in production today — the outcome path writes the
 * watermark atomically with the verdict). Takes the bucket advisory lock in
 * its own transaction. */
export async function recordBucketEvaluation(
  client: pg.PoolClient,
  tuple: BucketTuple,
  opts: { evaluatedUsers: number; generationId: string | null },
): Promise<void> {
  await client.query('BEGIN');
  try {
    const [k1, k2] = tupleLockKey(tuple.projectId, tuple.environmentId, tuple.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
    await writeBucketState(client, tuple, opts);
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Which signals this generation was shown. Re-running is a no-op. The insert
 * joins back to friction_signals on project_id so a signal id belonging to
 * another tenant can never be recorded as this generation's evidence. */
export async function recordGenerationEvidence(
  client: pg.PoolClient,
  generationId: string,
  projectId: string,
  signalIds: string[],
): Promise<void> {
  if (signalIds.length === 0) return;
  await client.query(
    `INSERT INTO friction_generation_evidence (generation_id, signal_id, project_id)
     SELECT $1, s.id, $3
     FROM friction_signals s
     WHERE s.id = ANY($2::uuid[]) AND s.project_id = $3
     ON CONFLICT (generation_id, signal_id) DO NOTHING`,
    [generationId, signalIds, projectId],
  );
}

/** Creates the durable in-flight generation for a threshold crossing. The
 * partial unique index arbitrates: concurrent fifth-user claimers get null
 * and skip their model call — exactly one adjudication per crossing. Runs
 * outside any transaction so the claim survives a later crash. */
export async function claimGeneration(
  tuple: BucketTuple,
  claimJobId: string,
): Promise<GenerationRow | null> {
  const { rows } = await getPool().query<GenerationRow>(
    `INSERT INTO friction_adjudication_generations
       (project_id, environment_id, fingerprint, rule_version, prompt_version,
        status, window_start, window_end, claim_job_id, attempts)
     VALUES ($1, $2, $3, $4, $5, 'adjudicating', now() - interval '7 days', now(), $6, 1)
     ON CONFLICT (project_id, environment_id, fingerprint, rule_version, prompt_version)
       WHERE status = 'adjudicating'
     DO NOTHING
     RETURNING id, status, claim_job_id, model_id, prompt_version, promoted_incident_id`,
    [
      tuple.projectId,
      tuple.environmentId,
      tuple.fingerprint,
      tuple.ruleVersion,
      tuple.promptVersion,
      claimJobId,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Frees the in-flight slot held by a generation this job claimed but never
 * adjudicated — the budget-exhausted path, where the claim succeeds and the
 * model call never happens. Without it the row stays 'adjudicating' and
 * `uq_friction_generation_inflight` blocks every future claim for that bucket
 * permanently.
 *
 * Deletes rather than terminalizing to 'unchecked': that status specifically
 * means a job exhausted its retries before reaching a verdict (007 migration,
 * dead-letter.ts), and dead-letter reconciliation only writes a diagnostic
 * candidate for generations it transitions itself — so a budget-released row
 * marked 'unchecked' would sit there forever with a misleading status and no
 * diagnostic. A generation that was never adjudicated has no audit value.
 *
 * Scoped to the claiming job and to rows with no verdict, so it can never
 * delete another worker's in-flight claim or destroy a finished generation.
 * `friction_generation_evidence.generation_id` cascades and
 * `friction_bucket_state.last_generation_id` nulls, so the delete orphans
 * neither. `friction_signals.generation_id` has no cascade, but no signal can
 * reference this generation yet: the release runs before
 * `claimSignalsForAdjudication`.
 */
export async function releaseGeneration(
  generationId: string,
  projectId: string,
  claimJobId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM friction_adjudication_generations
      WHERE id = $1 AND project_id = $2 AND claim_job_id = $3
        AND status = 'adjudicating' AND adjudicated_at IS NULL`,
    [generationId, projectId, claimJobId],
  );
}

/** An accepted generation whose verdict is still valid; later matching
 * signals inherit it instead of triggering a new model call. */
export async function findValidAcceptedGeneration(
  client: pg.PoolClient,
  tuple: BucketTuple,
): Promise<GenerationRow | null> {
  const { rows } = await client.query<GenerationRow>(
    `SELECT id, status, claim_job_id, model_id, prompt_version, promoted_incident_id
     FROM friction_adjudication_generations
     WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
       AND rule_version = $4 AND prompt_version = $5
       AND status = 'accepted' AND valid_until > now()
     ORDER BY adjudicated_at DESC
     LIMIT 1`,
    [
      tuple.projectId,
      tuple.environmentId,
      tuple.fingerprint,
      tuple.ruleVersion,
      tuple.promptVersion,
    ],
  );
  return rows[0] ?? null;
}

/** Incremental single-signal attachment shared by inheritance (and mirrored
 * by the fold path): occurrence +1, seen-guards, junction upsert, recount,
 * evidence pin. Caller owns the transaction. */
async function attachSignalIncrementally(
  client: pg.PoolClient,
  signal: FoldSignal,
  incidentId: string,
): Promise<void> {
  await client.query(`UPDATE friction_signals SET incident_id = $2 WHERE id = $1`, [
    signal.id,
    incidentId,
  ]);
  // The signal's own occurrence_count (repeats within its session) is the
  // increment, read under the row lock the caller already holds.
  await client.query(
    `UPDATE error_groups
     SET occurrence_count = occurrence_count +
           (SELECT occurrence_count FROM friction_signals WHERE id = $3),
         first_seen = LEAST(first_seen, $2::timestamptz),
         last_seen = GREATEST(last_seen, $2::timestamptz),
         updated_at = now()
     WHERE id = $1`,
    [incidentId, signal.occurred_at, signal.id],
  );
  // Error-kind groups span environments, so folded signals participate in
  // the same per-environment rollup maintained by error ingestion. The kind
  // predicate deliberately keeps friction-kind groups out of this table.
  await client.query(
    `INSERT INTO error_group_environments
       (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
     SELECT eg.id, $2, $3::timestamptz, $3::timestamptz, fs.occurrence_count::bigint
     FROM error_groups eg
     JOIN friction_signals fs ON fs.id = $5
     WHERE eg.id = $1 AND eg.project_id = $4 AND eg.kind = 'error'
     ON CONFLICT (error_group_id, environment_id) DO UPDATE
       SET first_seen = LEAST(error_group_environments.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(error_group_environments.last_seen, EXCLUDED.last_seen),
           occurrence_count = error_group_environments.occurrence_count + EXCLUDED.occurrence_count`,
    [incidentId, signal.environment_id, signal.occurred_at, signal.project_id, signal.id],
  );
  if (signal.end_user_id) {
    await client.query(
      `INSERT INTO error_group_affected_users
         (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
       VALUES ($1, $2, $3, $3,
               (SELECT occurrence_count FROM friction_signals WHERE id = $4))
       ON CONFLICT (error_group_id, end_user_id) DO UPDATE
         SET first_seen = LEAST(error_group_affected_users.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(error_group_affected_users.last_seen, EXCLUDED.last_seen),
             occurrence_count = error_group_affected_users.occurrence_count + EXCLUDED.occurrence_count`,
      [incidentId, signal.end_user_id, signal.occurred_at, signal.id],
    );
    await client.query(
      `UPDATE error_groups
       SET affected_users_count =
         (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
       WHERE id = $1`,
      [incidentId],
    );
  }
  await client.query(
    `UPDATE sessions
     SET retain_until = GREATEST(COALESCE(retain_until, 'epoch'::timestamptz),
                                 started_at + interval '90 days')
     WHERE id = $1 AND project_id = $2`,
    [signal.session_id, signal.project_id],
  );
}

/**
 * One transaction that persists a bucket verdict and applies its visible
 * outcome atomically. Serialized per tuple with the same advisory lock as
 * the fold path. Resume semantics: an 'accepted' generation with unattached
 * claimed signals re-applies the outcome; terminal generations with nothing
 * left to attach are no-ops.
 */
export async function applyBucketOutcome(opts: {
  tuple: BucketTuple;
  generationId: string;
  verdict: AdjudicationVerdict;
  /** Distinct eligible users the threshold check counted for this call; the
   * watermark is written at this level in the same transaction as the verdict,
   * so a crash can never leave a judged bucket without its gate (duplicate
   * paid call) or a gated bucket without its judgement. */
  evaluatedUsers: number;
  meta: FoldMeta;
}): Promise<BucketOutcome> {
  const { tuple, generationId, verdict, meta } = opts;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const [k1, k2] = tupleLockKey(tuple.projectId, tuple.environmentId, tuple.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

    const genRes = await client.query<{
      status: string;
      claim_job_id: string | null;
      adjudicated_at: string | null;
    }>(
      `SELECT status, claim_job_id, adjudicated_at::text AS adjudicated_at
       FROM friction_adjudication_generations
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [generationId, tuple.projectId],
    );
    const generation = genRes.rows[0];
    if (!generation || generation.status === 'rejected' || generation.status === 'unchecked') {
      await client.query('COMMIT');
      return 'noop';
    }
    const isResume = generation.status === 'accepted';
    const claimJobId = generation.claim_job_id ?? meta.jobId;

    // Signals this outcome owns: pending rows claimed for this call, plus
    // accepted-but-unattached rows from a crash between verdict and outcome.
    const signalRes = await client.query<FoldSignal & { signal_type: string; page_url_normalized: string; element_selector: string | null; occurrence_count: number }>(
      `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
              occurred_at::text AS occurred_at, signal_type, page_url_normalized,
              element_selector, occurrence_count
       FROM friction_signals
       WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
         AND end_user_id IS NOT NULL
         AND retracted_at IS NULL AND superseded_by IS NULL
         AND ((adjudication_status = 'pending' AND adjudication_job_id = $4)
              OR (adjudication_status = 'accepted' AND generation_id = $5 AND incident_id IS NULL))
       ORDER BY occurred_at ASC
       FOR UPDATE`,
      [tuple.projectId, tuple.environmentId, tuple.fingerprint, claimJobId, generationId],
    );
    const signals = signalRes.rows;
    if (signals.length === 0) {
      // Resume with nothing left to attach, or every claimed row was
      // retracted, superseded, or expired between claim and outcome. An
      // accepted verdict over vanished evidence must not build a candidate
      // from `signals[0]`, and the generation must not stay 'adjudicating'
      // or uq_friction_generation_inflight wedges the bucket: terminalize
      // as rejected. No watermark: the count this verdict was formed at no
      // longer describes the bucket.
      if (!isResume) {
        await client.query(
          `UPDATE friction_adjudication_generations
           SET status = 'rejected',
               verdict_reason = 'evidence disappeared before the outcome applied',
               model_id = $2, adjudicated_at = now(), finished_at = now()
           WHERE id = $1`,
          [generationId, meta.modelId],
        );
      }
      await client.query('COMMIT');
      return 'noop';
    }

    // Persist the generation verdict (idempotent on resume).
    if (!isResume) {
      await client.query(
        `UPDATE friction_adjudication_generations
         SET status = $2, verdict_reason = $3, model_id = $4,
             adjudicated_at = now(),
             valid_until = CASE WHEN $2 = 'accepted' THEN now() + interval '7 days' END,
             finished_at = now()
         WHERE id = $1`,
        [generationId, verdict.accepted ? 'accepted' : 'rejected', verdict.reason, meta.modelId],
      );
    }
    // Persist per-signal verdicts and audit.
    await client.query(
      `UPDATE friction_signals
       SET adjudication_status = $2,
           adjudication_scope = 'bucket',
           generation_id = $3,
           adjudicated_at = now(),
           adjudication_model = $4,
           adjudication_prompt_version = $5,
           adjudication_reason = $6
       WHERE id = ANY($1::uuid[])`,
      [
        signals.map((s) => s.id),
        verdict.accepted ? 'accepted' : 'rejected',
        generationId,
        meta.modelId,
        meta.promptVersion,
        verdict.reason,
      ],
    );
    if (!verdict.accepted) {
      await writeBucketState(client, tuple, { evaluatedUsers: opts.evaluatedUsers, generationId });
      await client.query('COMMIT');
      return 'rejected';
    }

    // Candidate row (create defensively on resume if the orchestration's
    // ensureCandidate never ran).
    const first = signals[0]!;
    const incidentId = await ensureCandidate(client, tuple, {
      signalType: first.signal_type,
      pageUrlNormalized: first.page_url_normalized,
      elementSelector: first.element_selector,
    });
    const groupRes = await client.query<{ status: string }>(
      `SELECT status FROM error_groups WHERE id = $1 FOR UPDATE`,
      [incidentId],
    );
    const wasCandidate = groupRes.rows[0]!.status === 'candidate';

    // Attach every owned signal, then the generation's wider recorded
    // evidence (incident_id only — verdicts on previously judged rows are
    // never rewritten), then materialize impact once from source rows. Doing
    // the attach here rather than after commit means a crash can never leave
    // an accepted incident undercounting the evidence the model was shown,
    // and the retention-pin below covers the attached evidence's sessions.
    await client.query(
      `UPDATE friction_signals SET incident_id = $2 WHERE id = ANY($1::uuid[])`,
      [signals.map((s) => s.id), incidentId],
    );
    await attachEvidenceRows(client, generationId, tuple, incidentId);
    await recomputeIncidentImpact(client, incidentId, tuple.projectId);
    await client.query(
      `UPDATE sessions
       SET retain_until = GREATEST(COALESCE(retain_until, 'epoch'::timestamptz),
                                   started_at + interval '90 days')
       WHERE project_id = $1 AND id IN (
         SELECT session_id FROM friction_signals
         WHERE incident_id = $2 AND retracted_at IS NULL AND superseded_by IS NULL)`,
      [tuple.projectId, incidentId],
    );

    let outcome: BucketOutcome = 'updated';
    if (wasCandidate) {
      // Deterministic representative (plan criterion 15).
      const rep = await client.query<{ id: string; session_id: string }>(
        `SELECT id, session_id FROM friction_signals
         WHERE incident_id = $1 AND adjudication_status = 'accepted'
           AND retracted_at IS NULL AND superseded_by IS NULL
         ORDER BY occurrence_count DESC, occurred_at ASC, id ASC
         LIMIT 1`,
        [incidentId],
      );
      await client.query(
        `UPDATE error_groups
         SET status = 'queued',
             environment_id = $2,
             representative_signal_id = $3,
             representative_session_id = $4,
             updated_at = now()
         WHERE id = $1`,
        [incidentId, tuple.environmentId, rep.rows[0]?.id ?? null, rep.rows[0]?.session_id ?? null],
      );
      // Exactly one investigate job on first promotion.
      await client.query(
        `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
         VALUES ($1, $2, 'investigate', 'auto')`,
        [incidentId, tuple.projectId],
      );
      outcome = 'promoted';
    }
    await client.query(
      `UPDATE friction_adjudication_generations SET promoted_incident_id = $2 WHERE id = $1`,
      [generationId, incidentId],
    );

    await writeBucketState(client, tuple, { evaluatedUsers: opts.evaluatedUsers, generationId });
    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Attaches one later matching signal under a still-valid accepted
 * generation: no model call, incremental impact, same tuple lock. */
export async function attachInheritedSignal(
  signal: FoldSignal,
  generation: GenerationRow,
): Promise<'attached' | 'noop'> {
  if (!generation.promoted_incident_id) return 'noop';
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const [k1, k2] = tupleLockKey(signal.project_id, signal.environment_id, signal.fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

    const { rows } = await client.query<{ adjudication_status: string; incident_id: string | null }>(
      `SELECT adjudication_status, incident_id FROM friction_signals
       WHERE id = $1 AND retracted_at IS NULL AND superseded_by IS NULL
       FOR UPDATE`,
      [signal.id],
    );
    const current = rows[0];
    if (!current || current.incident_id !== null || current.adjudication_status !== 'pending') {
      await client.query('COMMIT');
      return 'noop';
    }
    await client.query(
      `UPDATE friction_signals
       SET adjudication_status = 'accepted',
           adjudication_scope = 'bucket',
           generation_id = $2,
           adjudicated_at = now(),
           adjudication_model = $3,
           adjudication_prompt_version = $4,
           adjudication_reason = 'inherited from accepted generation'
       WHERE id = $1`,
      [signal.id, generation.id, generation.model_id, generation.prompt_version],
    );
    await attachSignalIncrementally(client, signal, generation.promoted_incident_id);
    await client.query('COMMIT');
    return 'attached';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Full impact rebuild from active source rows: the incident's own error
 * events plus attached, non-retracted, non-superseded friction signals.
 * Reserved for promotion materialization and supersession/retraction (plan:
 * normal folds stay incremental); reversibility requires recomputation here.
 */
export async function recomputeIncidentImpact(
  client: pg.PoolClient,
  incidentId: string,
  projectId: string,
): Promise<void> {
  // Serialize the source snapshot and absolute replacements with error ingest
  // and incremental friction folds, both of which hold this group-row lock.
  const locked = await client.query(
    `SELECT id FROM error_groups
     WHERE id = $1 AND project_id = $2
     FOR UPDATE`,
    [incidentId, projectId],
  );
  if ((locked.rowCount ?? 0) !== 1) {
    throw new Error(`incident ${incidentId} does not belong to project ${projectId}`);
  }
  // Keep this aggregate aligned with the ingestion backfill recompute in
  // packages/ingestion/db/rollup_backfill.go. Retraction and supersession
  // rebuild absolute values from source instead of decrementing stale rows.
  // The delete and rebuild run as two sequential statements (not one CTE that
  // both deletes and inserts the same rows) because Postgres leaves the outcome
  // of modifying the same row twice in a single command unspecified; the
  // enclosing transaction and the group-row lock above keep them atomic.
  await client.query(
    `DELETE FROM error_group_environments ege
     USING error_groups scoped_group
     WHERE ege.error_group_id = $1
       AND scoped_group.id = ege.error_group_id
       AND scoped_group.project_id = $2`,
    [incidentId, projectId],
  );
  await client.query(
    `WITH source_rows AS (
       SELECT environment_id, "timestamp" AS at, 1::bigint AS occurrences
       FROM error_events
       WHERE error_group_id = $1 AND project_id = $2
       UNION ALL
       SELECT environment_id, occurred_at AS at, occurrence_count::bigint AS occurrences
       FROM friction_signals
       WHERE incident_id = $1 AND project_id = $2
         AND retracted_at IS NULL AND superseded_by IS NULL
     ), aggregate_rows AS (
       SELECT environment_id, MIN(at) AS first_seen, MAX(at) AS last_seen,
              SUM(occurrences)::bigint AS occurrence_count
       FROM source_rows
       GROUP BY environment_id
     )
     INSERT INTO error_group_environments
       (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
     SELECT eg.id, aggregate_rows.environment_id, aggregate_rows.first_seen,
            aggregate_rows.last_seen, aggregate_rows.occurrence_count
     FROM aggregate_rows
     JOIN error_groups eg ON eg.id = $1 AND eg.project_id = $2 AND eg.kind = 'error'
     ON CONFLICT (error_group_id, environment_id) DO UPDATE
       SET first_seen = EXCLUDED.first_seen,
           last_seen = EXCLUDED.last_seen,
           occurrence_count = EXCLUDED.occurrence_count`,
    [incidentId, projectId],
  );
  // Signals carry occurrence_count (repeats within one session), so impact
  // sums those; each error event counts once.
  await client.query(
    `UPDATE error_groups eg
     SET occurrence_count = src.n,
         first_seen = COALESCE(src.first_at, eg.first_seen),
         last_seen = COALESCE(src.last_at, eg.last_seen),
         updated_at = now()
     FROM (
       SELECT COALESCE(SUM(cnt), 0)::int AS n, MIN(at) AS first_at, MAX(at) AS last_at
       FROM (
         SELECT "timestamp" AS at, 1 AS cnt FROM error_events
          WHERE error_group_id = $1 AND project_id = $2
         UNION ALL
         SELECT occurred_at, occurrence_count FROM friction_signals
          WHERE incident_id = $1 AND project_id = $2
            AND retracted_at IS NULL AND superseded_by IS NULL
       ) source_rows
     ) src
     WHERE eg.id = $1 AND eg.project_id = $2`,
    [incidentId, projectId],
  );
  await client.query(
    `DELETE FROM error_group_affected_users eau
     USING error_groups scoped_group
     WHERE eau.error_group_id = $1
       AND scoped_group.id = eau.error_group_id
       AND scoped_group.project_id = $2`,
    [incidentId, projectId],
  );
  await client.query(
    `INSERT INTO error_group_affected_users
       (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
     SELECT $1, end_user_id, MIN(at), MAX(at), SUM(cnt)::int
     FROM (
       SELECT end_user_id, "timestamp" AS at, 1 AS cnt FROM error_events
        WHERE error_group_id = $1 AND project_id = $2 AND end_user_id IS NOT NULL
       UNION ALL
       SELECT end_user_id, occurred_at, occurrence_count FROM friction_signals
        WHERE incident_id = $1 AND project_id = $2 AND end_user_id IS NOT NULL
          AND retracted_at IS NULL AND superseded_by IS NULL
     ) source_rows
     GROUP BY end_user_id`,
    [incidentId, projectId],
  );
  await client.query(
    `UPDATE error_groups
     SET affected_users_count =
       (SELECT COUNT(*) FROM error_group_affected_users WHERE error_group_id = $1)
     WHERE id = $1 AND project_id = $2`,
    [incidentId, projectId],
  );
}

/**
 * Attaches this generation's recorded evidence to the incident it produced.
 *
 * `applyBucketOutcome` only owns the rows it claimed for this call, so once
 * evidence survives verdicts the model is shown 32 users while the incident
 * reports 4. This closes that gap from the other side, deliberately as a
 * separate statement rather than by widening the outcome's selection: those
 * rows also receive the verdict and audit columns, so a wider selection would
 * rewrite the history of every previously judged signal — and would do it on
 * rejections too, since that update runs before the rejected early return.
 *
 * Sets `incident_id` ONLY. `adjudication_status`, `generation_id` and the
 * audit columns belong to whichever generation actually judged each signal.
 *
 * Skips rows already attached anywhere, so a signal folded onto an error
 * incident keeps that incident rather than being moved onto the friction one.
 * Returns the number of rows newly attached.
 *
 * The production accept path runs this attach inside applyBucketOutcome's
 * transaction; this standalone wrapper exists for repair tooling and tests.
 */
export async function attachGenerationEvidenceToIncident(
  generationId: string,
  projectId: string,
  incidentId: string,
  ruleVersion: number,
): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const attached = await attachEvidenceRows(
      client,
      generationId,
      { projectId, ruleVersion },
      incidentId,
    );
    // Rebuild impact from source rows: the newly attached evidence has to show
    // up in occurrence and affected-user counts, and the recompute takes the
    // group-row lock that serializes this with folds and error ingest.
    await recomputeIncidentImpact(client, incidentId, projectId);
    await client.query('COMMIT');
    return attached;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The attach itself: incident_id only, scoped to the tenant, the generation's
 * recorded membership, and the bucket's rule version. Callers own the
 * transaction and the follow-up impact recompute. */
async function attachEvidenceRows(
  client: pg.PoolClient,
  generationId: string,
  tuple: Pick<BucketTuple, 'projectId' | 'ruleVersion'>,
  incidentId: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE friction_signals s
        SET incident_id = $3
       FROM friction_generation_evidence e
      WHERE e.generation_id = $1
        AND e.signal_id = s.id
        AND e.project_id = $2
        AND s.project_id = $2
        AND s.rule_version = $4
        AND s.incident_id IS NULL
        AND s.adjudication_status <> 'unchecked'
        AND s.retracted_at IS NULL AND s.superseded_by IS NULL`,
    [generationId, tuple.projectId, incidentId, tuple.ruleVersion],
  );
  return res.rowCount ?? 0;
}
