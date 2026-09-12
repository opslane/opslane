import type pg from 'pg';
import * as db from '../db.js';
import * as store from './tickets-db.js';

export function causeCoverage(
  explained: readonly string[],
  confirmed: readonly string[],
): number {
  const current = new Set(confirmed);
  return current.size
    ? new Set(explained.filter((id) => current.has(id))).size / current.size
    : 0;
}
export async function lockJob(
  tx: pg.PoolClient,
  job: db.ClaimedJob,
): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND project_id=$2 AND worker_id=$3
    AND lease_generation=$4::bigint AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [job.id, job.projectId, job.workerId, job.leaseGeneration],
  );
  if (!r.rowCount) throw new db.LeaseLostError(job.id);
}
export async function transaction<T>(
  action: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await db.getPool().connect();
  try {
    await tx.query('BEGIN');
    const result = await action(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
export type FixRequest =
  | { status: 'created'; attemptId: string; jobId: string }
  | { status: 'not_ready' | 'stale' | 'outstanding' | 'cap' | 'disabled' };
export async function requestFix(
  tx: pg.PoolClient,
  projectId: string,
  ticketId: string,
  generation: number,
  requestedBy: 'human' | 'auto',
  guidance?: string,
): Promise<FixRequest> {
  const project = await tx.query<{ friction_autonomy: string }>(
    `SELECT friction_autonomy FROM projects WHERE id=$1 FOR UPDATE`,
    [projectId],
  );
  const ticket = await store.getTicket(tx, projectId, ticketId, true);
  if (
    !ticket ||
    ticket.status !== 'published' ||
    ticket.live_generation !== generation
  )
    return { status: 'stale' };
  const r = await tx.query<{
    id: string;
    fix_substate: string;
    investigation_status: string;
    explained_signal_ids: string[] | null;
    root_cause: string | null;
  }>(
    `SELECT id,fix_substate,investigation_status,explained_signal_ids,root_cause FROM error_groups
     WHERE ticket_id=$1 AND publication_generation=$2 AND status<>'archived' FOR UPDATE`,
    [ticketId, generation],
  );
  const group = r.rows[0];
  if (!group || group.fix_substate === 'resolved') return { status: 'stale' };
  if (
    (
      await tx.query(
        `SELECT id FROM friction_fix_attempts WHERE ticket_id=$1 AND generation=$2 AND status IN('active','pr_open')`,
        [ticketId, generation],
      )
    ).rowCount
  )
    return { status: 'outstanding' };
  if (
    (
      await tx.query(
        `SELECT id FROM error_group_jobs WHERE error_group_id=$1 AND project_id=$2 AND job_type='fix' AND status IN('pending','claimed')`,
        [group.id, projectId],
      )
    ).rowCount
  )
    return { status: 'outstanding' };
  const diagnosis = await tx.query<{ job_id: string; diagnosis: unknown }>(
    `SELECT job_id,diagnosis FROM diagnosis_decisions WHERE error_group_id=$1 AND project_id=$2 AND outcome='code_fix' ORDER BY decided_at DESC,id DESC LIMIT 1`,
    [group.id, projectId],
  );
  const diagnosisBody = diagnosis.rows[0]?.diagnosis;
  const brief =
    diagnosisBody &&
    typeof diagnosisBody === 'object' &&
    'agentTaskBrief' in diagnosisBody
      ? diagnosisBody.agentTaskBrief
      : null;
  const confirmed = await store.verifiedEvidence(tx, ticket);
  if (
    group.investigation_status !== 'done' ||
    !group.root_cause?.trim() ||
    typeof brief !== 'string' ||
    !brief.trim() ||
    causeCoverage(group.explained_signal_ids ?? [], confirmed.signalIds) < 0.5
  ) {
    if (requestedBy === 'human') {
      await db.enqueueJobTx(tx, 'investigate', projectId, {
        errorGroupId: group.id,
        sourceId: group.id,
        ticketId,
        publicationGeneration: generation,
        triggeredBy: 'human',
      });
      await tx.query(
        `UPDATE error_groups SET investigation_status='pending',updated_at=now() WHERE id=$1`,
        [group.id],
      );
    }
    return { status: 'not_ready' };
  }
  if (requestedBy === 'auto') {
    if (project.rows[0]?.friction_autonomy !== 'auto_fix')
      return { status: 'disabled' };
    const count = await tx.query<{ n: number }>(
      `SELECT count(*)::int n FROM friction_fix_attempts a JOIN friction_tickets t ON t.id=a.ticket_id WHERE t.project_id=$1 AND a.status='pr_open'`,
      [projectId],
    );
    if (count.rows[0]!.n >= maxOpenFixPrs()) return { status: 'cap' };
  }
  const attempt = await tx.query<{ id: string }>(
    `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,requested_by) VALUES($1,$2,$3,'active',$4) RETURNING id`,
    [ticketId, group.id, generation, requestedBy],
  );
  const attemptId = attempt.rows[0]!.id;
  const jobId = await db.enqueueJobTx(tx, 'fix', projectId, {
    errorGroupId: group.id,
    sourceId: group.id,
    ticketId,
    publicationGeneration: generation,
    fixAttemptId: attemptId,
    triggeredBy: requestedBy,
    guidance,
    sourceJobId: diagnosis.rows[0]?.job_id,
    payload: { diagnosis: diagnosis.rows[0]?.diagnosis ?? null },
  });
  await tx.query(
    `UPDATE error_groups SET fix_substate='fixing',status='fixing',terminal_fix_job_id=NULL,updated_at=now() WHERE id=$1`,
    [group.id],
  );
  return { status: 'created', attemptId, jobId: jobId! };
}
export function maxOpenFixPrs(): number {
  const n = Number(process.env['FRICTION_MAX_OPEN_FIX_PRS'] ?? 5);
  return Number.isInteger(n) && n >= 0 ? n : 5;
}
export interface PrEvent {
  ticketId: string;
  errorGroupId: string;
  generation: number;
  attemptId: string;
  event: 'opened' | 'closed' | 'merged' | 'orphan';
  deliveryId: string;
  occurredAt: string;
  prUrl?: string | null;
  prNumber?: number | null;
  githubRepo?: string | null;
}
export async function applyPrEvent(
  tx: pg.PoolClient,
  projectId: string,
  event: PrEvent,
): Promise<boolean> {
  await tx.query(`SELECT id FROM projects WHERE id=$1 FOR UPDATE`, [projectId]);
  const ticket = await store.getTicket(tx, projectId, event.ticketId, true);
  if (!ticket) return false;
  const fact = await tx.query<{ id: string; processed_at: string | null }>(
    `INSERT INTO friction_pr_events(ticket_id,error_group_id,fix_attempt_id,generation,event,delivery_id,occurred_at,pr_url,pr_number,github_repo)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(delivery_id) DO UPDATE SET delivery_id=excluded.delivery_id RETURNING id,processed_at`,
    [
      event.ticketId,
      event.errorGroupId,
      event.attemptId,
      event.generation,
      event.event,
      event.deliveryId,
      event.occurredAt,
      event.prUrl ?? null,
      event.prNumber ?? null,
      event.githubRepo ?? null,
    ],
  );
  if (fact.rows[0]!.processed_at) return false;
  const state = await tx.query<{
    status: string;
    fix_substate: string;
    attempt_status: string;
    generation: number;
  }>(
    `SELECT g.status,g.fix_substate,a.status AS attempt_status,a.generation FROM friction_fix_attempts a JOIN error_groups g ON g.id=a.error_group_id
    WHERE a.id=$1 AND a.ticket_id=$2 AND g.id=$3 AND g.project_id=$4 FOR UPDATE OF g,a`,
    [event.attemptId, event.ticketId, event.errorGroupId, projectId],
  );
  const s = state.rows[0];
  const current =
    !!s &&
    fixEventCurrent({
      ticketStatus: ticket.status,
      liveGeneration: ticket.live_generation,
      generation: event.generation,
      attemptGeneration: s.generation,
      groupStatus: s.status,
      fixSubstate: s.fix_substate,
      attemptStatus: s.attempt_status,
      event: event.event,
    });
  if (current) {
    const status =
      event.event === 'opened'
        ? 'pr_open'
        : event.event === 'merged'
          ? 'merged'
          : 'closed';
    await tx.query(
      `UPDATE friction_fix_attempts SET status=$2,pr_url=coalesce($3,pr_url),pr_number=coalesce($4,pr_number),github_repo=coalesce($5,github_repo),updated_at=now() WHERE id=$1`,
      [
        event.attemptId,
        status,
        event.prUrl ?? null,
        event.prNumber ?? null,
        event.githubRepo ?? null,
      ],
    );
    await tx.query(
      `UPDATE error_groups SET fix_substate=$2,status=$3,pr_url=CASE WHEN $2='none' THEN NULL ELSE coalesce($4,pr_url) END,pr_number=CASE WHEN $2='none' THEN NULL ELSE coalesce($5,pr_number) END,merged_at=CASE WHEN $2='resolved' THEN $6::timestamptz ELSE merged_at END,updated_at=now() WHERE id=$1`,
      [
        event.errorGroupId,
        event.event === 'opened'
          ? 'pr_open'
          : event.event === 'merged'
            ? 'resolved'
            : 'none',
        event.event === 'opened'
          ? 'pr_created'
          : event.event === 'merged'
            ? 'merged'
            : 'awaiting_approval',
        event.prUrl ?? null,
        event.prNumber ?? null,
        event.occurredAt,
      ],
    );
    if (event.event !== 'opened') {
      await tx.query(
        `UPDATE delivery_reservations SET state='closed',updated_at=now()
         WHERE project_id=$1 AND error_group_id=$2 AND operation_key=$3`,
        [projectId, event.errorGroupId, `fix:${event.attemptId}`],
      );
    }
    if (event.event === 'merged')
      await tx.query(
        `UPDATE friction_tickets SET fixed_at=$2,cohort_cutoff=$2,updated_at=now() WHERE id=$1`,
        [ticket.id, event.occurredAt],
      );
  } else if (
    event.event === 'orphan' &&
    s &&
    (ticket.status !== 'published' ||
      s.generation !== ticket.live_generation ||
      s.status === 'archived')
  ) {
    // Losing a job lease does not retire its attempt: a newer worker may own
    // that same attempt. Only retired publication lineage can be superseded.
    await tx.query(
      `UPDATE friction_fix_attempts SET status=CASE WHEN status IN('active','pr_open') THEN 'superseded' ELSE status END,pr_url=coalesce($2,pr_url),pr_number=coalesce($3,pr_number),github_repo=coalesce($4,github_repo),updated_at=now() WHERE id=$1 AND ticket_id=$5`,
      [
        event.attemptId,
        event.prUrl ?? null,
        event.prNumber ?? null,
        event.githubRepo ?? null,
        event.ticketId,
      ],
    );
  }
  await tx.query(
    `UPDATE friction_pr_events SET applied=$2,processed_at=now() WHERE id=$1`,
    [fact.rows[0]!.id, current],
  );
  return current;
}

/** Re-read immediately before each provider write. Auto delivery reserves one cap
 * slot under the project lock, so two active workers cannot both take its last slot. */
export async function assertFixAttemptCurrent(
  job: db.ClaimedJob,
  delivery = false,
): Promise<void> {
  await transaction(async (tx) => {
    await lockJob(tx, job);
    await tx.query(`SELECT id FROM projects WHERE id=$1 FOR UPDATE`, [
      job.projectId,
    ]);
    const ticket = job.ticketId
      ? await store.getTicket(tx, job.projectId, job.ticketId, true)
      : null;
    const r = await tx.query<{
      status: string;
      requested_by: string;
      delivery_reserved_at: string | null;
    }>(
      `SELECT a.status,a.requested_by,a.delivery_reserved_at FROM friction_fix_attempts a JOIN error_groups g ON g.id=a.error_group_id
      WHERE a.id=$1 AND a.ticket_id=$2 AND a.generation=$3 AND g.id=$4 AND g.project_id=$5 AND g.status<>'archived' AND g.fix_substate='fixing' FOR UPDATE OF a,g`,
      [
        job.fixAttemptId,
        job.ticketId,
        job.publicationGeneration,
        job.errorGroupId,
        job.projectId,
      ],
    );
    const a = r.rows[0];
    if (
      !ticket ||
      ticket.status !== 'published' ||
      ticket.live_generation !== job.publicationGeneration ||
      a?.status !== 'active'
    )
      throw new Error('Stale ticket fix attempt');
    if (delivery && a.requested_by === 'auto') {
      const p = await tx.query<{ friction_autonomy: string }>(
        `SELECT friction_autonomy FROM projects WHERE id=$1`,
        [job.projectId],
      );
      if (p.rows[0]?.friction_autonomy !== 'auto_fix')
        throw new Error('Automatic fixes disabled');
      if (!a.delivery_reserved_at) {
        const count = await tx.query<{ n: number }>(
          `SELECT count(*)::int n FROM friction_fix_attempts a JOIN friction_tickets t ON t.id=a.ticket_id
          WHERE t.project_id=$1 AND (a.status='pr_open' OR (a.status='active' AND a.delivery_reserved_at IS NOT NULL))`,
          [job.projectId],
        );
        if (count.rows[0]!.n >= maxOpenFixPrs())
          throw new Error('Automatic fix PR cap reached');
        await tx.query(
          `UPDATE friction_fix_attempts SET delivery_reserved_at=now() WHERE id=$1`,
          [job.fixAttemptId],
        );
      }
    }
    await lockJob(tx, job);
  });
}
/** Called after provider creation even if the job was cancelled meanwhile. The
 * durable artifact is retained; only a current, owned execution may apply it. */
export async function recordAttemptPr(
  job: db.ClaimedJob,
  repo: string,
  url: string,
  number: number,
): Promise<boolean> {
  return transaction(async (tx) => {
    const owned = await tx.query(
      `SELECT id FROM error_group_jobs WHERE id=$1 AND worker_id=$2 AND lease_generation=$3::bigint AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
      [job.id, job.workerId, job.leaseGeneration],
    );
    await tx.query(`SELECT id FROM projects WHERE id=$1 FOR UPDATE`, [
      job.projectId,
    ]);
    if (job.ticketId)
      await store.getTicket(tx, job.projectId, job.ticketId, true);
    const current = await tx.query(
      `SELECT 1 FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id JOIN friction_fix_attempts a ON a.error_group_id=g.id
      WHERE t.id=$1 AND t.project_id=$2 AND t.status='published' AND t.live_generation=$3 AND g.publication_generation=$3 AND g.id=$4 AND g.status<>'archived' AND g.fix_substate IN('fixing','pr_open') AND a.id=$5 AND a.status IN('active','pr_open') AND EXISTS(SELECT 1 FROM error_group_jobs j WHERE j.id=$6 AND j.worker_id=$7 AND j.lease_generation=$8::bigint AND j.status='claimed' AND j.lease_expires_at>clock_timestamp())`,
      [
        job.ticketId,
        job.projectId,
        job.publicationGeneration,
        job.errorGroupId,
        job.fixAttemptId,
        job.id,
        job.workerId,
        job.leaseGeneration,
      ],
    );
    if (
      !job.ticketId ||
      job.publicationGeneration == null ||
      !job.fixAttemptId ||
      !job.errorGroupId
    )
      throw new Error('Missing ticket PR identity');
    const applied = await applyPrEvent(tx, job.projectId, {
      ticketId: job.ticketId,
      errorGroupId: job.errorGroupId,
      attemptId: job.fixAttemptId,
      generation: job.publicationGeneration,
      event: owned.rowCount && current.rowCount ? 'opened' : 'orphan',
      deliveryId: `worker:${job.id}:${job.leaseGeneration}:${number}`,
      occurredAt: new Date().toISOString(),
      prUrl: url,
      prNumber: number,
      githubRepo: repo,
    });
    if (applied) {
      await tx.query(
        `UPDATE error_groups SET terminal_fix_job_id=$2,pr_fix_job_id=$2,pr_created_at=coalesce(pr_created_at,now()) WHERE id=$1`,
        [job.errorGroupId, job.id],
      );
      await tx.query(
        `UPDATE delivery_reservations SET state='open',pr_url=$2,pr_number=$3,updated_at=now() WHERE error_group_id=$1 AND project_id=$4 AND operation_key=$5`,
        [
          job.errorGroupId,
          url,
          number,
          job.projectId,
          `fix:${job.fixAttemptId}`,
        ],
      );
    }
    return applied;
  });
}
/** Same-transaction cleanup for normal failure, dead letters, and expired jobs.
 * The durable job row provides generation and attempt identity even to the reaper. */
export async function attemptFailed(
  tx: pg.PoolClient,
  jobId: string,
  projectId: string,
  reason: string,
): Promise<boolean> {
  const r = await tx.query<{
    ticket_id: string;
    publication_generation: number;
    fix_attempt_id: string | null;
    error_group_id: string;
    job_type: string;
    investigation_execution: string | null;
    investigation_evidence_version: number | null;
  }>(
    `SELECT ticket_id,publication_generation,fix_attempt_id,error_group_id,job_type,investigation_execution::text,investigation_evidence_version FROM error_group_jobs WHERE id=$1 AND project_id=$2 AND ticket_id IS NOT NULL`,
    [jobId, projectId],
  );
  const job = r.rows[0];
  if (!job?.ticket_id) return false;
  const ticket = await store.getTicket(tx, projectId, job.ticket_id, true);
  if (!ticket) return true;
  const current =
    ticket.status === 'published' &&
    ticket.live_generation === job.publication_generation;
  if (job.fix_attempt_id)
    await tx.query(
      `INSERT INTO friction_fix_failures(job_id,fix_attempt_id,reason) VALUES($1,$2,$3) ON CONFLICT(job_id) DO NOTHING`,
      [jobId, job.fix_attempt_id, reason],
    );
  if (job.job_type === 'fix') {
    const a = await tx.query(
      `UPDATE friction_fix_attempts SET status=CASE WHEN $2 THEN 'failed' ELSE 'superseded' END,updated_at=now() WHERE id=$1 AND ticket_id=$3 AND generation=$4 AND status='active' RETURNING id`,
      [job.fix_attempt_id, current, job.ticket_id, job.publication_generation],
    );
    if (current && a.rowCount)
      await tx.query(
        `UPDATE error_groups SET fix_substate='none',status='awaiting_approval',updated_at=now() WHERE id=$1 AND project_id=$2 AND publication_generation=$3 AND status<>'archived' AND fix_substate='fixing'`,
        [job.error_group_id, projectId, job.publication_generation],
      );
  } else if (job.job_type === 'investigate') {
    if (job.investigation_execution)
      await tx.query(
        `INSERT INTO friction_investigation_results(ticket_id,error_group_id,generation,execution,evidence_version,job_id,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(error_group_id,execution) DO NOTHING`,
        [
          job.ticket_id,
          job.error_group_id,
          job.publication_generation,
          job.investigation_execution,
          job.investigation_evidence_version ?? ticket.evidence_version,
          jobId,
          JSON.stringify({ status: 'failed', reason }),
        ],
      );
    if (!current) return true;
    // An older job cannot fail a newer running investigation.
    const newer = await tx.query(
      `SELECT 1 FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' AND id<>$2 AND status IN('pending','claimed')`,
      [job.error_group_id, jobId],
    );
    const execution = await tx.query<{ investigation_execution: string }>(
      `SELECT investigation_execution::text FROM error_groups WHERE id=$1 FOR UPDATE`,
      [job.error_group_id],
    );
    const latest =
      execution.rows[0]?.investigation_execution ===
      (job.investigation_execution ?? '0');
    if (!newer.rowCount && latest) {
      await tx.query(
        `UPDATE error_groups SET investigation_status='failed',evidence_version_used=coalesce($3,evidence_version_used),updated_at=now() WHERE id=$1 AND project_id=$2 AND status<>'archived' AND fix_substate<>'resolved' AND investigation_status='pending'`,
        [job.error_group_id, projectId, job.investigation_evidence_version],
      );
      await tx.query(
        `UPDATE friction_tickets SET reinvestigate_needed=true,updated_at=now() WHERE id=$1`,
        [ticket.id],
      );
    }
  }
  return true;
}

/** Shared admission predicate for durable PR transitions and randomized histories. */
export function fixEventCurrent(s: {
  ticketStatus: string;
  liveGeneration: number;
  generation: number;
  attemptGeneration: number;
  groupStatus: string;
  fixSubstate: string;
  attemptStatus: string;
  event: string;
}): boolean {
  return (
    s.ticketStatus === 'published' &&
    s.liveGeneration === s.generation &&
    s.attemptGeneration === s.generation &&
    s.groupStatus !== 'archived' &&
    s.fixSubstate !== 'resolved' &&
    ['active', 'pr_open'].includes(s.attemptStatus) &&
    s.event !== 'orphan'
  );
}
