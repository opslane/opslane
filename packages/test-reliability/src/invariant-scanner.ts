import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type PgQueryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export type ReliabilityInvariantCode =
  | 'terminal_fields_incomplete'
  | 'terminal_fields_incompatible'
  | 'active_group_without_live_job'
  | 'terminal_group_with_live_job'
  | 'expired_claimed_job';

interface BaseViolation {
  code: ReliabilityInvariantCode;
  projectId: string;
  message: string;
}

export interface TerminalFieldsIncompleteViolation extends BaseViolation {
  code: 'terminal_fields_incomplete';
  entity: 'error_group';
  errorGroupId: string;
  status: 'needs_human' | 'pr_created' | 'pr_draft';
  missingFields: Array<
    | 'reason_code'
    | 'reason_message'
    | 'remediation'
    | 'pr_url'
    | 'pr_number'
    | 'confidence'
    | 'external_ci'
  >;
}

export interface ActiveGroupWithoutLiveJobViolation extends BaseViolation {
  code: 'active_group_without_live_job';
  entity: 'error_group';
  errorGroupId: string;
  status: 'queued' | 'analyzing' | 'fixing';
}

export interface TerminalFieldsIncompatibleViolation extends BaseViolation {
  code: 'terminal_fields_incompatible';
  entity: 'error_group';
  errorGroupId: string;
  status: 'needs_human' | 'pr_created' | 'pr_draft';
  incompatibleFields: Array<'pr_url' | 'pr_number'>;
  invalidFields: Array<'pr_url'>;
}

export interface TerminalGroupWithLiveJobViolation extends BaseViolation {
  code: 'terminal_group_with_live_job';
  entity: 'error_group';
  errorGroupId: string;
  status: 'pr_created' | 'needs_human' | 'resolved' | 'merged' | 'archived';
  liveJobIds: string[];
}

export interface ExpiredClaimedJobViolation extends BaseViolation {
  code: 'expired_claimed_job';
  entity: 'error_group_job';
  jobId: string;
  errorGroupId: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
}

export type InvariantViolation =
  | TerminalFieldsIncompleteViolation
  | TerminalFieldsIncompatibleViolation
  | ActiveGroupWithoutLiveJobViolation
  | TerminalGroupWithLiveJobViolation
  | ExpiredClaimedJobViolation;

interface TerminalFieldsRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: TerminalFieldsIncompleteViolation['status'];
  reason_code: string | null;
  reason_message: string | null;
  remediation: string | null;
  pr_url: string | null;
  pr_number: number | null;
  confidence: string | null;
  verification_evidence: unknown;
}

interface GroupWithoutJobRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: ActiveGroupWithoutLiveJobViolation['status'];
}

interface TerminalFieldsIncompatibleRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: TerminalFieldsIncompatibleViolation['status'];
  pr_url: string | null;
  pr_number: number | null;
}

interface TerminalGroupWithJobRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: TerminalGroupWithLiveJobViolation['status'];
  live_job_ids: string[];
}

interface ExpiredJobRow extends QueryResultRow {
  id: string;
  error_group_id: string | null;
  project_id: string;
  worker_id: string | null;
  lease_expires_at: Date | string | null;
}

const TERMINAL_FIELDS_QUERY = `
  SELECT id, project_id, status, reason_code, reason_message, remediation,
         pr_url, pr_number, confidence, verification_evidence
  FROM error_groups
  WHERE (
    status = 'needs_human'
    AND (
      NULLIF(BTRIM(reason_code), '') IS NULL
      OR NULLIF(BTRIM(reason_message), '') IS NULL
      OR NULLIF(BTRIM(remediation), '') IS NULL
    )
  ) OR (
    status IN ('pr_created', 'pr_draft')
    AND (
      NULLIF(BTRIM(pr_url), '') IS NULL
      OR pr_number IS NULL
      OR pr_number <= 0
      OR confidence IS NULL
      OR (status = 'pr_created' AND confidence = 'medium'
          AND verification_evidence #>> '{external_ci,outcome}' IS DISTINCT FROM 'passed')
    )
  )
  ORDER BY project_id, id
`;

const ACTIVE_GROUPS_WITHOUT_LIVE_JOBS_QUERY = `
  SELECT eg.id, eg.project_id, eg.status
  FROM error_groups eg
  WHERE eg.status IN ('queued', 'analyzing', 'fixing')
    AND NOT EXISTS (
      SELECT 1
      FROM error_group_jobs job
      WHERE job.error_group_id = eg.id
        AND job.status IN ('pending', 'claimed')
    )
  ORDER BY eg.project_id, eg.id
`;

const TERMINAL_FIELDS_INCOMPATIBLE_QUERY = `
  SELECT id, project_id, status, pr_url, pr_number
  FROM error_groups
  WHERE (
    status = 'needs_human'
    AND (pr_url IS NOT NULL OR pr_number IS NOT NULL)
  ) OR (
    status IN ('pr_created', 'pr_draft')
    AND NULLIF(BTRIM(pr_url), '') IS NOT NULL
    AND pr_url !~ '^https://'
  )
  ORDER BY project_id, id
`;

// score_sync is post-terminal bookkeeping by design: the PR webhook enqueues
// it in the same transaction that makes the group terminal, so a pending
// score_sync on a merged group is the contract working, not a violation.
const TERMINAL_GROUPS_WITH_LIVE_JOBS_QUERY = `
  SELECT eg.id, eg.project_id, eg.status,
         ARRAY_AGG(job.id ORDER BY job.created_at, job.id) AS live_job_ids
  FROM error_groups eg
  JOIN error_group_jobs job ON job.error_group_id = eg.id
  WHERE eg.status IN ('pr_created', 'needs_human', 'resolved', 'merged', 'archived')
    AND job.status IN ('pending', 'claimed')
    AND job.job_type <> 'score_sync'
  GROUP BY eg.id, eg.project_id, eg.status
  ORDER BY eg.project_id, eg.id
`;

const EXPIRED_CLAIMED_JOBS_QUERY = `
  SELECT id, error_group_id, project_id, worker_id, lease_expires_at
  FROM error_group_jobs
  WHERE status = 'claimed'
    AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
  ORDER BY project_id, id
`;

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function missingTerminalFields(
  row: TerminalFieldsRow,
): TerminalFieldsIncompleteViolation['missingFields'] {
  if (row.status === 'needs_human') {
    const missing: TerminalFieldsIncompleteViolation['missingFields'] = [];
    if (isBlank(row.reason_code)) missing.push('reason_code');
    if (isBlank(row.reason_message)) missing.push('reason_message');
    if (isBlank(row.remediation)) missing.push('remediation');
    return missing;
  }

  const missing: TerminalFieldsIncompleteViolation['missingFields'] = [];
  if (isBlank(row.pr_url)) missing.push('pr_url');
  if (row.pr_number === null || row.pr_number <= 0) missing.push('pr_number');
  if (row.confidence === null) missing.push('confidence');
  const evidence = row.verification_evidence;
  const externalOutcome = evidence && typeof evidence === 'object'
    && 'external_ci' in evidence
    && typeof (evidence as { external_ci?: unknown }).external_ci === 'object'
    && (evidence as { external_ci?: { outcome?: unknown } }).external_ci?.outcome;
  if (row.status === 'pr_created' && row.confidence === 'medium' && externalOutcome !== 'passed') {
    missing.push('external_ci');
  }
  return missing;
}

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Performs read-only checks of the error-group lifecycle and queue. Run this
 * against a quiescent test stack or interpret momentary transition violations
 * with care: group and job terminal writes are not currently atomic.
 */
export async function scanReliabilityInvariants(
  db: PgQueryable,
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const terminalFields = await db.query<TerminalFieldsRow>(TERMINAL_FIELDS_QUERY);
  for (const row of terminalFields.rows) {
    const missingFields = missingTerminalFields(row);
    violations.push({
      code: 'terminal_fields_incomplete',
      entity: 'error_group',
      errorGroupId: row.id,
      projectId: row.project_id,
      status: row.status,
      missingFields,
      message: `Error group ${row.id} is ${row.status} but is missing: ${missingFields.join(', ')}`,
    });
  }

  const incompatibleTerminalFields = await db.query<TerminalFieldsIncompatibleRow>(
    TERMINAL_FIELDS_INCOMPATIBLE_QUERY,
  );
  for (const row of incompatibleTerminalFields.rows) {
    const incompatibleFields: TerminalFieldsIncompatibleViolation['incompatibleFields'] = [];
    const invalidFields: TerminalFieldsIncompatibleViolation['invalidFields'] = [];
    if (row.status === 'needs_human') {
      if (row.pr_url !== null) incompatibleFields.push('pr_url');
      if (row.pr_number !== null) incompatibleFields.push('pr_number');
    } else if (row.pr_url !== null && !row.pr_url.startsWith('https://')) {
      invalidFields.push('pr_url');
    }
    violations.push({
      code: 'terminal_fields_incompatible',
      entity: 'error_group',
      errorGroupId: row.id,
      projectId: row.project_id,
      status: row.status,
      incompatibleFields,
      invalidFields,
      message: `Error group ${row.id} has incompatible or invalid terminal fields`,
    });
  }

  const activeWithoutJobs = await db.query<GroupWithoutJobRow>(
    ACTIVE_GROUPS_WITHOUT_LIVE_JOBS_QUERY,
  );
  for (const row of activeWithoutJobs.rows) {
    violations.push({
      code: 'active_group_without_live_job',
      entity: 'error_group',
      errorGroupId: row.id,
      projectId: row.project_id,
      status: row.status,
      message: `Active error group ${row.id} (${row.status}) has no pending or claimed job`,
    });
  }

  const terminalWithJobs = await db.query<TerminalGroupWithJobRow>(
    TERMINAL_GROUPS_WITH_LIVE_JOBS_QUERY,
  );
  for (const row of terminalWithJobs.rows) {
    violations.push({
      code: 'terminal_group_with_live_job',
      entity: 'error_group',
      errorGroupId: row.id,
      projectId: row.project_id,
      status: row.status,
      liveJobIds: row.live_job_ids,
      message: `Terminal error group ${row.id} (${row.status}) still has live jobs: ${row.live_job_ids.join(', ')}`,
    });
  }

  const expiredJobs = await db.query<ExpiredJobRow>(EXPIRED_CLAIMED_JOBS_QUERY);
  for (const row of expiredJobs.rows) {
    violations.push({
      code: 'expired_claimed_job',
      entity: 'error_group_job',
      jobId: row.id,
      errorGroupId: row.error_group_id,
      projectId: row.project_id,
      workerId: row.worker_id,
      leaseExpiresAt: isoTimestamp(row.lease_expires_at),
      message: row.lease_expires_at === null
        ? `Claimed job ${row.id} has no lease expiry`
        : `Claimed job ${row.id} has an expired lease (${isoTimestamp(row.lease_expires_at)})`,
    });
  }

  return violations;
}
