import type pg from 'pg';
import { NARRATIVE_RULE_VERSION } from '../narrative/emit.js';
import {
  countEligibleSupport,
  ensureCandidate,
  recomputeIncidentImpact,
  tupleLockKey,
  type BucketTuple,
} from './promotion-db.js';

export const PROMOTION_THRESHOLD_SESSIONS = 3;
export const PROMOTION_THRESHOLD_IDENTIFIED_USERS = 2;
export const EVIDENCE_WINDOW_DAYS = 7;

export function hasPromotionSupport(support: {
  sessions: number;
  identifiedUsers: number;
}): boolean {
  return support.sessions >= PROMOTION_THRESHOLD_SESSIONS
    || support.identifiedUsers >= PROMOTION_THRESHOLD_IDENTIFIED_USERS;
}

/**
 * Counts and promotes narrative observations inside the caller's transaction.
 * The per-bucket advisory lock makes concurrent third-session writers converge
 * on one incident and one optional investigation job.
 */
export async function runPromotionCheck(
  client: pg.PoolClient,
  projectId: string,
  environmentId: string,
  fingerprints: string[],
): Promise<void> {
  for (const fingerprint of [...new Set(fingerprints)].sort()) {
    const [key1, key2] = tupleLockKey(projectId, environmentId, fingerprint);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [key1, key2]);
    const tuple: BucketTuple = {
      projectId,
      environmentId,
      fingerprint,
      ruleVersion: NARRATIVE_RULE_VERSION,
      promptVersion: 1,
    };
    const descriptorResult = await client.query<{
      signal_type: string;
      page_url_normalized: string;
      element_selector: string | null;
    }>(
      `SELECT signal_type, page_url_normalized, element_selector
       FROM friction_signals
       WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
         AND rule_version = $4 AND adjudication_status = 'accepted'
         AND observation_text IS NOT NULL
         AND retracted_at IS NULL AND superseded_by IS NULL
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
      [projectId, environmentId, fingerprint, NARRATIVE_RULE_VERSION],
    );
    const descriptor = descriptorResult.rows[0];
    if (!descriptor || descriptor.signal_type === 'other') continue;

    const incidentId = await ensureCandidate(client, tuple, {
      signalType: descriptor.signal_type,
      pageUrlNormalized: descriptor.page_url_normalized,
      elementSelector: descriptor.element_selector,
    });
    const support = await countEligibleSupport(client, tuple);
    if (!hasPromotionSupport(support)) continue;

    const group = await client.query<{ status: string }>(
      `SELECT status FROM error_groups
       WHERE id = $1 AND project_id = $2
       FOR UPDATE`,
      [incidentId, projectId],
    );
    const wasCandidate = group.rows[0]?.status === 'candidate';
    await client.query(
      `UPDATE friction_signals
       SET incident_id = $5
       WHERE project_id = $1 AND environment_id = $2 AND fingerprint = $3
         AND rule_version = $4 AND signal_type <> 'other'
         AND adjudication_status = 'accepted'
         AND retracted_at IS NULL AND superseded_by IS NULL
         AND incident_id IS NULL`,
      [projectId, environmentId, fingerprint, NARRATIVE_RULE_VERSION, incidentId],
    );
    await recomputeIncidentImpact(client, incidentId, projectId);
    await client.query(
      `UPDATE sessions
       SET retain_until = GREATEST(COALESCE(retain_until, 'epoch'::timestamptz),
                                   started_at + interval '90 days')
       WHERE project_id = $1 AND id IN (
         SELECT session_id FROM friction_signals
         WHERE incident_id = $2 AND retracted_at IS NULL AND superseded_by IS NULL)`,
      [projectId, incidentId],
    );
    if (!wasCandidate) continue;

    const representative = await client.query<{ id: string; session_id: string }>(
      `SELECT id, session_id
       FROM friction_signals
       WHERE incident_id = $1 AND adjudication_status = 'accepted'
         AND observation_text IS NOT NULL
         AND retracted_at IS NULL AND superseded_by IS NULL
       ORDER BY occurrence_count DESC, occurred_at ASC, id ASC
       LIMIT 1`,
      [incidentId],
    );
    // Decision 2026-09-01: every promoted incident is investigated. The verdict
    // (processFrictionInvestigateJob) gates any fix, not signal severity.
    // `severity` stays as data for display and ranking.
    const promotedStatus = 'queued';
    await client.query(
      `UPDATE error_groups
       SET status = $5::error_group_status, environment_id = $2,
           representative_signal_id = $3,
           representative_session_id = $4,
           updated_at = now()
       WHERE id = $1 AND status = 'candidate'`,
      [
        incidentId,
        environmentId,
        representative.rows[0]?.id ?? null,
        representative.rows[0]?.session_id ?? null,
        promotedStatus,
      ],
    );
    // The insert sits inside the candidate→promoted transition (guarded by
    // `if (!wasCandidate) continue` above), so it runs exactly once per incident
    // lifetime. The NOT EXISTS guard stays as a belt against a concurrent
    // transition; promotion passes themselves never re-enqueue.
    await client.query(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
       SELECT $1, $2, 'investigate', 'auto'
       WHERE NOT EXISTS (
         SELECT 1 FROM error_group_jobs
         WHERE error_group_id = $1 AND project_id = $2 AND job_type = 'investigate'
           AND status IN ('pending','claimed'))`,
      [incidentId, projectId],
    );
  }
}
