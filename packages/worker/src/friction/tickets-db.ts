import { createHash } from 'node:crypto';
import type pg from 'pg';
import { enqueueJobTx } from '../db.js';
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from '../embeddings.js';

export type TicketDb = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
export interface TicketScope {
  projectId: string;
  environmentId: string;
}
export type TicketStatus = 'tracking' | 'published' | 'unpublished' | 'merged' | 'archived';
export interface TicketRow {
  id: string;
  project_id: string;
  environment_id: string;
  name: string;
  control: string;
  what_happened: string;
  steps: string | null;
  kind: 'defect' | 'ux_insight';
  screens_confirmed: string[];
  screens_proposed: string[];
  status: TicketStatus;
  embedding: number[] | null;
  embedding_model: string | null;
  matched_count: number;
  next_arrival_number: bigint;
  arrival_boundary: bigint;
  evidence_version: number;
  live_generation: number;
  fold_retries: number;
  fixed_at: string | null;
  cohort_cutoff: string | null;
  reconcile_needed: boolean;
  reinvestigate_needed: boolean;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}
export interface NewTicket extends TicketScope {
  name: string;
  control: string;
  what_happened: string;
  kind: TicketRow['kind'];
  steps?: string | null;
}
export interface CohortStats {
  counted: number;
  confirmed: number;
  refuted: number;
  inconclusive: number;
  confirmedUsers: number;
  identityKnown: boolean;
}
export interface DecisionRow {
  signal_id: string;
  project_id: string;
  environment_id: string;
  session_id: string;
  decision: 'reserved' | 'matched' | 'created' | 'not_a_problem';
  ticket_id: string | null;
  decided_by: 'cheap' | 'strong' | 'fold';
  decided_at: Date;
}
export interface MatchInput {
  ticket: TicketRow;
  sessionId: string;
  endUserId: string | null;
  source: 'cheap' | 'strong' | 'backfill' | 'fold';
  occurredAt: string;
  screen: string;
  signalIds: string[];
}
/** Arrival strings are JSON safe and retain PostgreSQL bigint precision. */
export interface BatchMember {
  sessionId: string;
  endUserId: string | null;
  arrivalNumber: string;
  signalIds: string[];
}
export interface ConfirmBatch {
  id: string;
  batchId: string;
  sessionIds: string[];
  ticket_id: string;
  job_id: string;
  manifest: BatchMember[];
  arrival_boundary_at_select: bigint;
  live_generation_at_select: number;
  status_at_select: TicketStatus;
  evidence_version_at_select: number;
  status: 'staging' | 'finalized' | 'discarded';
  created_at: Date;
  finalized_at: Date | null;
}
export interface CheckResult {
  sessionId: string;
  outcome: 'confirmed' | 'refuted' | 'inconclusive' | 'unavailable';
  signalIds?: string[];
  evidenceLines?: string[];
  note?: string;
  costToUser?: 'none' | 'annoyance' | 'lost_time' | 'abandoned_task' | null;
  framesOk?: boolean;
  frameManifest?: unknown[]; // {offsetMs,pair,assetsMissing?}[]
  model: string;
}
export interface FinalizedBatch {
  finalized: boolean;
  evidenceVersion: number;
  stats: CohortStats;
}
export interface EvidenceRepresentative {
  sessionId: string;
  signalIds: string[];
  note: string;
  costToUser: CheckResult['costToUser'];
}
export interface VerifiedEvidence {
  users: number;
  sessions: number;
  accounts: string[];
  sessionIds: string[];
  signalIds: string[];
  representative: EvidenceRepresentative | null;
}
/** Omit for seven days; null selects the entire post-fix cohort for publication. */
export interface EvidenceWindow {
  days: number | null;
}

// Helpers taking dbtx require a caller-owned transaction. Locks are reacquired
// so stale TicketRow snapshots cannot overwrite counters or bypass lifecycle checks.
// stageCheck is one atomic statement and can also run outside a transaction.
type RawTicket = Omit<TicketRow, 'next_arrival_number' | 'arrival_boundary' | 'embedding'> & {
  next_arrival_number: string;
  arrival_boundary: string;
  embedding: string | null;
};
const ticketColumns = `t.*, t.fixed_at::text, t.cohort_cutoff::text, t.created_at::text, t.updated_at::text`;
function decodeTicket(row: RawTicket): TicketRow {
  return {
    ...row,
    next_arrival_number: BigInt(row.next_arrival_number),
    arrival_boundary: BigInt(row.arrival_boundary),
    embedding: row.embedding === null ? null : (JSON.parse(row.embedding) as number[]),
  };
}
function vectorValue(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMS || !vector.every(Number.isFinite))
    throw new Error('Invalid ticket embedding');
  return JSON.stringify(vector);
}
async function lockTicket(db: TicketDb, ticket: TicketRow): Promise<TicketRow> {
  const r = await db.query<RawTicket>(
    `SELECT ${ticketColumns} FROM friction_tickets t
    WHERE id=$1 AND project_id=$2 AND environment_id=$3 FOR UPDATE`,
    [ticket.id, ticket.project_id, ticket.environment_id],
  );
  if (!r.rows[0]) throw new Error('Ticket outside scope or missing');
  return decodeTicket(r.rows[0]);
}
/** Resolve a model snapshot through folds while holding the current ticket lock. */
export async function resolveMatchTicket(
  dbtx: pg.PoolClient,
  scope: TicketScope,
  id: string,
): Promise<TicketRow> {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const result = await dbtx.query<RawTicket>(
      `SELECT ${ticketColumns} FROM friction_tickets t WHERE id=$1 AND project_id=$2 AND environment_id=$3 FOR UPDATE`,
      [id, scope.projectId, scope.environmentId],
    );
    const row = result.rows[0];
    if (!row || row.status === 'archived')
      throw new Error(
        'Match target missing, archived, or outside scope; retry lookup',
      );
    if (row.status !== 'merged') return decodeTicket(row);
    if (!row.merged_into) break;
    id = row.merged_into;
  }
  throw new Error('Invalid match target fold chain');
}

export async function createTicket(
  dbtx: pg.PoolClient,
  t: NewTicket,
  embedding?: number[] | null,
): Promise<TicketRow> {
  const r = await dbtx.query<RawTicket>(
    `INSERT INTO friction_tickets AS t
    (project_id,environment_id,name,control,what_happened,kind,steps,embedding,embedding_model)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::vector,$9 FROM environments WHERE id=$2 AND project_id=$1
    RETURNING ${ticketColumns}`,
    [
      t.projectId,
      t.environmentId,
      t.name,
      t.control,
      t.what_happened,
      t.kind,
      t.steps ?? null,
      embedding ? vectorValue(embedding) : null,
      embedding ? EMBEDDING_MODEL : null,
    ],
  );
  if (!r.rows[0]) throw new Error('Environment outside project');
  return decodeTicket(r.rows[0]);
}
export async function nearestTickets(
  db: TicketDb,
  scope: TicketScope,
  embedding: number[],
  k = 10,
  statuses: TicketStatus[] = ['tracking', 'published', 'unpublished'],
): Promise<(TicketRow & { similarity: number })[]> {
  const r = await db.query<RawTicket & { similarity: number }>(
    `SELECT ${ticketColumns},
    1-(embedding <=> $3::vector) AS similarity FROM friction_tickets t
    WHERE project_id=$1 AND environment_id=$2 AND status=ANY($4::text[])
    AND status NOT IN ('merged','archived') AND embedding_model=$5 AND embedding IS NOT NULL
    ORDER BY embedding <=> $3::vector,id LIMIT $6`,
    [scope.projectId, scope.environmentId, vectorValue(embedding), statuses, EMBEDDING_MODEL, k],
  );
  return r.rows.map((row) => ({ ...decodeTicket(row), similarity: row.similarity }));
}
export async function shortlistTickets(
  db: TicketDb,
  scope: TicketScope,
  screensVisited: string[],
  embedding: number[] | null,
  k = 10,
): Promise<TicketRow[]> {
  const r = await db.query<RawTicket>(
    `WITH eligible AS (
      SELECT * FROM friction_tickets WHERE project_id=$1 AND environment_id=$2 AND status NOT IN ('merged','archived')
    ), candidates AS (
      (SELECT id FROM eligible WHERE screens_confirmed && $3::text[] ORDER BY id LIMIT 20)
      UNION (SELECT e.id FROM eligible e LEFT JOIN friction_checks c ON c.ticket_id=e.id AND c.outcome='confirmed'
        GROUP BY e.id ORDER BY count(c.session_id) DESC,e.id LIMIT 10)
      UNION (SELECT id FROM eligible WHERE $4::vector IS NOT NULL AND embedding_model=$5 AND embedding IS NOT NULL
        ORDER BY embedding <=> $4::vector,id LIMIT $6)
    ) SELECT ${ticketColumns} FROM friction_tickets t JOIN candidates USING(id) ORDER BY t.id`,
    [
      scope.projectId,
      scope.environmentId,
      screensVisited,
      embedding ? vectorValue(embedding) : null,
      EMBEDDING_MODEL,
      k,
    ],
  );
  return r.rows.map(decodeTicket);
}
export async function reserveDecision(
  dbtx: pg.PoolClient,
  signalId: string,
  scope: TicketScope,
): Promise<{ reserved: boolean; existing?: DecisionRow }> {
  const lease = Number(process.env['LEASE_DURATION_MS'] ?? 300_000);
  const r = await dbtx.query(
    `INSERT INTO friction_observation_decisions AS d
    (signal_id,project_id,environment_id,session_id,decision,decided_by)
    SELECT f.id,f.project_id,f.environment_id,f.session_id,'reserved','cheap'
      FROM friction_signals f JOIN sessions s ON s.id=f.session_id AND s.project_id=f.project_id AND s.environment_id=f.environment_id
      WHERE f.id=$1 AND f.project_id=$2 AND f.environment_id=$3
    ON CONFLICT(signal_id) DO UPDATE SET decided_at=now()
      WHERE d.decision='reserved' AND d.decided_at < now()-$4*interval '1 millisecond'

    RETURNING signal_id`,
    [signalId, scope.projectId, scope.environmentId, Number.isFinite(lease) ? lease : 300_000],
  );
  if (r.rowCount) return { reserved: true };
  const existing = await dbtx.query<DecisionRow>(
    `SELECT * FROM friction_observation_decisions WHERE signal_id=$1 AND project_id=$2 AND environment_id=$3`,
    [signalId, scope.projectId, scope.environmentId],
  );
  return existing.rows[0] ? { reserved: false, existing: existing.rows[0] } : { reserved: false };
}
export async function commitDecision(
  dbtx: pg.PoolClient,
  signalId: string,
  decision: {
    decision: 'matched' | 'created' | 'not_a_problem';
    ticketId?: string;
    decidedBy: DecisionRow['decided_by'];
  },
): Promise<boolean> {
  const r = await dbtx.query(
    `UPDATE friction_observation_decisions d SET decision=$2,ticket_id=$3,decided_by=$4,decided_at=now()
    WHERE signal_id=$1 AND decision='reserved' AND
    ($2='not_a_problem' OR EXISTS(SELECT 1 FROM friction_tickets t WHERE t.id=$3 AND t.project_id=d.project_id AND t.environment_id=d.environment_id))
    RETURNING signal_id`,
    [signalId, decision.decision, decision.ticketId ?? null, decision.decidedBy],
  );
  return Boolean(r.rowCount);
}
export function publicationPaused(): boolean {
  return [
    'FRICTION_CONFIRM_MAX_CONCURRENT',
    'FRICTION_MATCH_MAX_CONCURRENT',
  ].some((key) => {
    const raw = process.env[key];
    return raw !== undefined && raw !== '' && Number(raw) === 0;
  });
}
/** Acquire before job/project/ticket/session rows in a ticket mutation. */
export async function lockPublication(
  dbtx: pg.PoolClient,
  environmentId: string,
): Promise<void> {
  await dbtx.query(
    `SELECT pg_advisory_xact_lock(hashtext('friction_publish|'||$1))`,
    [environmentId],
  );
}
export async function lockTicketPublication(
  dbtx: pg.PoolClient,
  projectId: string,
  ticketId: string,
): Promise<void> {
  const result = await dbtx.query<{ environment_id: string }>(
    'SELECT environment_id FROM friction_tickets WHERE id=$1 AND project_id=$2',
    [ticketId, projectId],
  );
  if (result.rows[0])
    await lockPublication(dbtx, result.rows[0].environment_id);
}
/** Bulk terminal operations lock environments in stable order before job rows. */
export async function lockJobPublications(
  dbtx: pg.PoolClient,
  jobIds: string[],
): Promise<void> {
  const environments = await dbtx.query<{ environment_id: string }>(
    `SELECT DISTINCT t.environment_id FROM error_group_jobs j JOIN friction_tickets t ON t.id=j.ticket_id WHERE j.id=ANY($1::uuid[]) ORDER BY t.environment_id`,
    [jobIds],
  );
  for (const row of environments.rows)
    await lockPublication(dbtx, row.environment_id);
}
export async function recordMatch(
  dbtx: pg.PoolClient,
  input: MatchInput,
): Promise<{ newRecording: boolean; arrivalNumber: bigint }> {
  await lockPublication(dbtx, input.ticket.environment_id);
  const t = await lockTicket(dbtx, input.ticket);
  if (t.status === 'merged' || t.status === 'archived')
    throw new Error('Cannot match a terminal ticket');
  const valid = await dbtx.query<{ end_user_id: string | null }>(
    `SELECT s.end_user_id FROM sessions s WHERE id=$1 AND project_id=$2 AND environment_id=$3
    AND (s.end_user_id IS NULL OR EXISTS (SELECT 1 FROM end_users WHERE id=s.end_user_id AND project_id=$2))
    AND NOT EXISTS (SELECT 1 FROM unnest($4::uuid[]) x(id) LEFT JOIN friction_signals f
      ON f.id=x.id AND f.session_id=s.id AND f.project_id=s.project_id AND f.environment_id=s.environment_id WHERE f.id IS NULL)`,
    [input.sessionId, t.project_id, t.environment_id, input.signalIds],
  );
  if (!valid.rowCount) throw new Error('Match evidence outside ticket scope');
  const r = await dbtx.query<{ arrival_number: string }>(
    `INSERT INTO friction_ticket_matches
    (ticket_id,session_id,project_id,environment_id,end_user_id,arrival_number,source,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(ticket_id,session_id) DO NOTHING RETURNING arrival_number`,
    [
      t.id,
      input.sessionId,
      t.project_id,
      t.environment_id,
      valid.rows[0]!.end_user_id,
      (t.next_arrival_number + 1n).toString(),
      input.source,
      input.occurredAt,
    ],
  );
  await dbtx.query(
    `UPDATE friction_tickets SET matched_count=matched_count+$2,next_arrival_number=next_arrival_number+$2,
    screens_proposed=ARRAY(SELECT DISTINCT x FROM unnest(screens_proposed||$3::text[]) x ORDER BY x),updated_at=now() WHERE id=$1`,
    [t.id, r.rowCount ? 1 : 0, input.screen ? [input.screen] : []],
  );
  await dbtx.query(
    `INSERT INTO friction_ticket_match_observations(ticket_id,session_id,signal_id)
    SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
    [t.id, input.sessionId, input.signalIds],
  );
  await dbtx.query(
    `UPDATE sessions SET retain_until=greatest(retain_until,started_at+interval '90 days') WHERE id=$1`,
    [input.sessionId],
  );
  const arrival =
    r.rows[0] ??
    (
      await dbtx.query<{ arrival_number: string }>(
        `SELECT arrival_number FROM friction_ticket_matches WHERE ticket_id=$1 AND session_id=$2`,
        [t.id, input.sessionId],
      )
    ).rows[0]!;
  return { newRecording: Boolean(r.rowCount), arrivalNumber: BigInt(arrival.arrival_number) };
}
export async function selectBatch(
  dbtx: pg.PoolClient,
  ticket: TicketRow,
  jobId: string,
): Promise<ConfirmBatch | null> {
  const t = await lockTicket(dbtx, ticket);
  if (t.status === 'merged' || t.status === 'archived') return null;
  const selected = await dbtx.query<BatchMember>(
    `WITH ranked AS (
    SELECT m.*,row_number() OVER(PARTITION BY end_user_id ORDER BY arrival_number) AS turn
      FROM friction_ticket_matches m LEFT JOIN friction_checks c USING(ticket_id,session_id)
      LEFT JOIN friction_unavailable_retries r USING(ticket_id,session_id)
      WHERE m.ticket_id=$1 AND c.session_id IS NULL AND (r.session_id IS NULL OR (NOT r.permanent AND r.retry_at<=now()))
  ) SELECT session_id AS "sessionId",end_user_id AS "endUserId",arrival_number::text AS "arrivalNumber",
    ARRAY(SELECT signal_id::text FROM friction_ticket_match_observations o WHERE o.ticket_id=$1 AND o.session_id=ranked.session_id ORDER BY signal_id) AS "signalIds"
    FROM ranked ORDER BY turn,arrival_number LIMIT $2`,
    [t.id, t.arrival_boundary === 0n && t.matched_count > 50 ? 30 : 10],
  );
  if (!selected.rows.length) return null;
  const b = await dbtx.query<
    Omit<ConfirmBatch, 'batchId' | 'sessionIds' | 'arrival_boundary_at_select'> & {
      arrival_boundary_at_select: string;
    }
  >(
    `INSERT INTO friction_confirm_batches
    (ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select,evidence_version_at_select)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      t.id,
      jobId,
      JSON.stringify(selected.rows),
      t.arrival_boundary.toString(),
      t.live_generation,
      t.status,
      t.evidence_version,
    ],
  );
  // The watermark covers arrivals present at selection, including unsampled backlog.
  const boundary = t.next_arrival_number;
  await dbtx.query(`UPDATE friction_tickets SET arrival_boundary=$2,updated_at=now() WHERE id=$1`, [
    t.id,
    boundary.toString(),
  ]);
  return {
    ...b.rows[0]!,
    batchId: b.rows[0]!.id,
    sessionIds: selected.rows.map((m) => m.sessionId),
    arrival_boundary_at_select: BigInt(b.rows[0]!.arrival_boundary_at_select),
  };
}
/** One statement serializes against finalization and makes retry accounting atomic. */
export async function stageCheck(db: TicketDb, batchId: string, r: CheckResult): Promise<boolean> {
  const result = await db.query(
    `WITH batch AS (
    SELECT * FROM friction_confirm_batches WHERE id=$1 AND status='staging' FOR UPDATE
  ), inserted AS (
    INSERT INTO friction_check_attempts(batch_id,ticket_id,session_id,outcome,evidence_lines,signal_ids,note,cost_to_user,frames_ok,frame_manifest,model)
    SELECT b.id,b.ticket_id,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM batch b
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(b.manifest) member WHERE member->>'sessionId'=$2
        AND (member->'signalIds') @> $5::jsonb)
    ON CONFLICT(batch_id,session_id) DO NOTHING RETURNING *
  ), retry AS (
    INSERT INTO friction_unavailable_retries AS r(ticket_id,session_id,attempts,retry_at,permanent)
    SELECT ticket_id,session_id,1,now()+interval '1 hour',false FROM inserted WHERE outcome='unavailable'
    ON CONFLICT(ticket_id,session_id) DO UPDATE SET attempts=r.attempts+1,
      retry_at=now()+CASE WHEN r.attempts=0 THEN interval '1 hour' WHEN r.attempts=1 THEN interval '6 hours' ELSE interval '24 hours' END,
      permanent=r.attempts+1>=3 RETURNING ticket_id
  ) SELECT id FROM inserted`,
    [
      batchId,
      r.sessionId,
      r.outcome,
      JSON.stringify(r.evidenceLines ?? []),
      JSON.stringify(r.signalIds ?? []),
      r.note ?? '',
      r.costToUser ?? null,
      r.framesOk ?? false,
      JSON.stringify(r.frameManifest ?? []),
      r.model,
    ],
  );
  return Boolean(result.rowCount);
}
export async function finalizeBatch(
  dbtx: pg.PoolClient,
  ticket: TicketRow,
  batchId: string,
): Promise<FinalizedBatch> {
  const t = await lockTicket(dbtx, ticket);
  const result = await dbtx.query<ConfirmBatch>(
    `SELECT * FROM friction_confirm_batches WHERE id=$1 AND ticket_id=$2 FOR UPDATE`,
    [batchId, t.id],
  );
  const batch = result.rows[0];
  if (!batch) throw new Error('Batch outside ticket');
  if (batch.status !== 'staging')
    return {
      finalized: false,
      evidenceVersion: t.evidence_version,
      stats: await cohortStats(dbtx, t),
    };
  const count = await dbtx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM friction_check_attempts WHERE batch_id=$1`,
    [batchId],
  );
  if (count.rows[0]!.count !== batch.manifest.length)
    throw new Error('Cannot finalize an incomplete batch');
  await dbtx.query(
    `INSERT INTO friction_checks(ticket_id,session_id,attempt_id,outcome)
    SELECT ticket_id,session_id,id,outcome FROM friction_check_attempts WHERE batch_id=$1 AND outcome<>'unavailable'
    ON CONFLICT(ticket_id,session_id) DO NOTHING`,
    [batchId],
  );
  await dbtx.query(
    `DELETE FROM friction_unavailable_retries r USING friction_check_attempts a
    WHERE a.batch_id=$1 AND a.outcome<>'unavailable' AND r.ticket_id=a.ticket_id AND r.session_id=a.session_id`,
    [batchId],
  );
  await dbtx.query(
    `UPDATE friction_confirm_batches SET status='finalized',finalized_at=now() WHERE id=$1`,
    [batchId],
  );
  await dbtx.query(
    `UPDATE friction_tickets SET evidence_version=evidence_version+1,updated_at=now() WHERE id=$1`,
    [t.id],
  );
  return {
    finalized: true,
    evidenceVersion: t.evidence_version + 1,
    stats: await cohortStats(dbtx, t),
  };
}
export async function discardBatch(dbtx: pg.PoolClient, batchId: string): Promise<void> {
  // Acquire ticket before batch, matching finalizeBatch's lock order.
  await dbtx.query(
    `SELECT t.id FROM friction_tickets t JOIN friction_confirm_batches b ON b.ticket_id=t.id WHERE b.id=$1 FOR UPDATE OF t`,
    [batchId],
  );
  await dbtx.query(
    `WITH discarded AS (UPDATE friction_confirm_batches SET status='discarded'
    WHERE id=$1 AND status='staging' RETURNING ticket_id)
    UPDATE friction_tickets SET reconcile_needed=true,updated_at=now() WHERE id IN(SELECT ticket_id FROM discarded)`,
    [batchId],
  );
}
export async function cohortStats(db: TicketDb, ticket: TicketRow): Promise<CohortStats> {
  const r = await db.query<CohortStats>(
    `SELECT count(*)::int AS counted,
    count(*) FILTER(WHERE c.outcome='confirmed')::int AS confirmed,
    count(*) FILTER(WHERE c.outcome='refuted')::int AS refuted,
    count(*) FILTER(WHERE c.outcome='inconclusive')::int AS inconclusive,
    count(DISTINCT m.end_user_id) FILTER(WHERE c.outcome='confirmed')::int AS "confirmedUsers",
    coalesce(bool_or(c.outcome='confirmed' AND m.end_user_id IS NOT NULL),false) AS "identityKnown"
    FROM friction_checks c JOIN friction_ticket_matches m USING(ticket_id,session_id)
    JOIN friction_tickets t ON t.id=c.ticket_id
    JOIN friction_check_attempts a ON a.id=c.attempt_id JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized'
    WHERE t.id=$1 AND t.project_id=$2 AND t.environment_id=$3 AND(t.cohort_cutoff IS NULL OR m.occurred_at>t.cohort_cutoff)`,
    [ticket.id, ticket.project_id, ticket.environment_id],
  );
  return r.rows[0]!;
}
export function evaluateBar(
  stats: CohortStats,
  ticket: { status: TicketStatus; fixSubstate: string | null },
): 'passes' | 'fails' | 'undecided' {
  const ratio = stats.counted ? stats.confirmed / stats.counted : 0;
  const diverse = !stats.identityKnown || stats.confirmedUsers >= 2;
  if (stats.confirmed >= 3 && diverse && ratio >= 0.4) return 'passes';
  if (
    ticket.status === 'published' &&
    ticket.fixSubstate !== 'resolved' &&
    (stats.confirmed < 3 || !diverse || (stats.counted >= 10 && ratio < 0.25))
  )
    return 'fails';
  return 'undecided';
}

interface EvidenceRow {
  session_id: string;
  end_user_id: string | null;
  account_name: string | null;
  signal_ids: string[];
  note: string;
  cost_to_user: CheckResult['costToUser'];
  screens: string[];
}
/** This is the canonical evidence query for display, investigation and generation
 * membership. Only IDs actually checked in the finalized attempt can escape it.
 * The cutoff stays in SQL: JS Date would truncate PostgreSQL microseconds. */
async function evidenceRows(
  db: TicketDb,
  ticket: TicketRow,
  window: EvidenceWindow,
): Promise<EvidenceRow[]> {
  const r = await db.query<EvidenceRow>(
    `SELECT m.session_id,m.end_user_id,u.account_name,
    verified.signal_ids,verified.screens,a.note,a.cost_to_user
    FROM friction_tickets t JOIN friction_ticket_matches m ON m.ticket_id=t.id
    JOIN friction_checks c USING(ticket_id,session_id)
    JOIN friction_check_attempts a ON a.id=c.attempt_id AND a.ticket_id=t.id AND a.session_id=m.session_id
    JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized'
    LEFT JOIN end_users u ON u.id=m.end_user_id AND u.project_id=t.project_id
    CROSS JOIN LATERAL (
      SELECT array_agg(DISTINCT o.signal_id::text ORDER BY o.signal_id::text) AS signal_ids,
        array_agg(DISTINCT f.page_url_normalized ORDER BY f.page_url_normalized) AS screens
      FROM friction_ticket_match_observations o JOIN friction_signals f ON f.id=o.signal_id
      WHERE o.ticket_id=t.id AND o.session_id=m.session_id AND a.signal_ids ? o.signal_id::text
    ) verified
    WHERE t.id=$1 AND t.project_id=$2 AND t.environment_id=$3 AND c.outcome='confirmed'
      AND(t.cohort_cutoff IS NULL OR m.occurred_at>t.cohort_cutoff)
      AND($4::int IS NULL OR (m.occurred_at>=now()-$4*interval '1 day' AND m.occurred_at<=now()))
    ORDER BY CASE a.cost_to_user WHEN 'none' THEN 0 WHEN 'annoyance' THEN 1 WHEN 'lost_time' THEN 2 WHEN 'abandoned_task' THEN 3 ELSE 0 END,
      m.arrival_number,m.session_id`,
    [ticket.id, ticket.project_id, ticket.environment_id, window.days],
  );
  return r.rows.map((row) => ({
    ...row,
    signal_ids: row.signal_ids ?? [],
    screens: row.screens ?? [],
  }));
}
function summarizeEvidence(rows: EvidenceRow[]): VerifiedEvidence {
  const median = rows[Math.floor((rows.length - 1) / 2)];
  return {
    users: new Set(rows.flatMap((r) => (r.end_user_id ? [r.end_user_id] : []))).size,
    sessions: rows.length,
    accounts: [
      ...new Set(rows.flatMap((r) => (r.account_name?.trim() ? [r.account_name] : []))),
    ].sort(),
    sessionIds: rows.map((r) => r.session_id),
    signalIds: [...new Set(rows.flatMap((r) => r.signal_ids))].sort(),
    representative: median
      ? {
          sessionId: median.session_id,
          signalIds: median.signal_ids,
          note: median.note,
          costToUser: median.cost_to_user,
        }
      : null,
  };
}
export async function verifiedEvidence(
  db: TicketDb,
  ticket: TicketRow,
  window: EvidenceWindow = { days: 7 },
): Promise<VerifiedEvidence> {
  return summarizeEvidence(await evidenceRows(db, ticket, window));
}

async function retireLiveGeneration(dbtx: pg.PoolClient, t: TicketRow): Promise<void> {
  const groups = await dbtx.query<{ id: string }>(
    `UPDATE error_groups SET status_before_archive=status,status='archived',archived_at=now(),updated_at=now()
    WHERE ticket_id=$1 AND status<>'archived' RETURNING id`,
    [t.id],
  );
  const ids = groups.rows.map((g) => g.id);
  await dbtx.query(
    `UPDATE error_group_jobs SET status='failed',last_error='unpublished',lease_expires_at=NULL,updated_at=now()
    WHERE error_group_id=ANY($1::uuid[]) AND status IN('pending','claimed') AND job_type IN('investigate','fix')`,
    [ids],
  );
  await dbtx.query(
    `UPDATE friction_fix_attempts SET status='superseded',updated_at=now()
    WHERE error_group_id=ANY($1::uuid[]) AND status IN('active','pr_open')`,
    [ids],
  );
  await dbtx.query(
    `UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id=ANY($1::uuid[]) AND invalidated_at IS NULL`,
    [ids],
  );
}
export async function activateGeneration(
  dbtx: pg.PoolClient,
  ticket: TicketRow,
  _cohort: CohortStats,
  steps: string,
): Promise<{ errorGroupId: string; generation: number }> {
  const t = await lockTicket(dbtx, ticket);
  if (t.status === 'merged' || t.status === 'archived')
    throw new Error('Cannot publish a terminal ticket');
  // Caller statistics are a presentation snapshot; publication uses locked evidence.
  const cohort = await cohortStats(dbtx, t);
  if (evaluateBar(cohort, { status: t.status, fixSubstate: null }) !== 'passes')
    throw new Error('Ticket does not meet publication bar');
  const rows = await evidenceRows(dbtx, t, { days: null });
  const evidence = summarizeEvidence(rows);
  await retireLiveGeneration(dbtx, t);
  const generation = t.live_generation + 1;
  const fingerprint = createHash('sha256').update(`ticket|${t.id}|${generation}`).digest('hex');
  const screens = [...new Set(rows.flatMap((r) => r.screens))].sort();
  const g = await dbtx.query<{ id: string }>(
    `INSERT INTO error_groups
    (project_id,environment_id,fingerprint,title,first_seen,last_seen,occurrence_count,affected_users_count,status,kind,
      ticket_id,publication_generation,fix_substate,investigation_status,evidence_version_used,actionable_since,page_url_normalized)
    VALUES($1,$2,$3,$4,now(),now(),$5,$6,'queued','friction',$7,$8,'none','pending',$9,now(),$10) RETURNING id`,
    [
      t.project_id,
      t.environment_id,
      fingerprint,
      t.name,
      evidence.sessions,
      evidence.users,
      t.id,
      generation,
      t.evidence_version,
      screens[0] ?? null,
    ],
  );
  const errorGroupId = g.rows[0]!.id;
  await dbtx.query(
    `INSERT INTO friction_incident_evidence(error_group_id,ticket_id,generation,signal_id)
    SELECT $1,$2,$3,unnest($4::uuid[]) ON CONFLICT DO NOTHING`,
    [errorGroupId, t.id, generation, evidence.signalIds],
  );
  await dbtx.query(
    `UPDATE friction_signals SET incident_id=$1 WHERE id=ANY($2::uuid[]) AND project_id=$3 AND environment_id=$4`,
    [errorGroupId, evidence.signalIds, t.project_id, t.environment_id],
  );
  await dbtx.query(
    `UPDATE friction_tickets SET status='published',live_generation=$2,steps=$3,screens_confirmed=$4,
    fixed_at=NULL,updated_at=now() WHERE id=$1`,
    [t.id, generation, steps, screens],
  );
  await enqueueJobTx(dbtx, 'investigate', t.project_id, {
    errorGroupId,
    sourceId: errorGroupId,
    ticketId: t.id,
    publicationGeneration: generation,
  });
  return { errorGroupId, generation };
}
export async function unpublish(dbtx: pg.PoolClient, ticket: TicketRow): Promise<void> {
  const t = await lockTicket(dbtx, ticket);
  if (t.status !== 'published') return;
  const resolved = await dbtx.query(
    `SELECT id FROM error_groups WHERE ticket_id=$1 AND status<>'archived' AND fix_substate='resolved'`,
    [t.id],
  );
  if (resolved.rowCount) return;
  await retireLiveGeneration(dbtx, t);
  await dbtx.query(
    `UPDATE friction_tickets SET status='unpublished',updated_at=now() WHERE id=$1`,
    [t.id],
  );
}
export async function foldInto(
  dbtx: pg.PoolClient,
  source: TicketRow,
  target: TicketRow,
): Promise<{ confirmNeeded: boolean }> {
  if (
    source.id === target.id ||
    source.project_id !== target.project_id ||
    source.environment_id !== target.environment_id
  )
    throw new Error('Invalid fold scope');
  // Stable lock order also works when two reconciliation jobs propose inverse folds.
  const first = source.id < target.id ? source : target;
  await lockTicket(dbtx, first);
  const s = await lockTicket(dbtx, source);
  const t = await lockTicket(dbtx, target);
  if (!['tracking', 'unpublished'].includes(s.status) || t.status !== 'published')
    throw new Error('Invalid fold lifecycle');
  const live = await dbtx.query(
    `SELECT id FROM error_groups WHERE ticket_id=$1 AND status<>'archived' AND fix_substate IS DISTINCT FROM 'resolved'`,
    [t.id],
  );
  if (!live.rowCount) throw new Error('Cannot fold into a resolved ticket');
  const matches = await dbtx.query<{
    session_id: string;
    end_user_id: string | null;
    occurred_at: string;
    signal_ids: string[];
  }>(
    `SELECT m.session_id,m.end_user_id,m.occurred_at::text,
    ARRAY(SELECT o.signal_id::text FROM friction_ticket_match_observations o WHERE o.ticket_id=m.ticket_id AND o.session_id=m.session_id ORDER BY signal_id) AS signal_ids
    FROM friction_ticket_matches m WHERE ticket_id=$1 ORDER BY arrival_number`,
    [s.id],
  );
  for (const m of matches.rows)
    await recordMatch(dbtx, {
      ticket: t,
      sessionId: m.session_id,
      endUserId: m.end_user_id,
      occurredAt: m.occurred_at,
      signalIds: m.signal_ids,
      screen: '',
      source: 'fold',
    });
  await dbtx.query(
    `UPDATE friction_tickets SET screens_proposed=ARRAY(SELECT DISTINCT x FROM unnest(screens_proposed||$2::text[]) x ORDER BY x),
    evidence_version=evidence_version+1,reconcile_needed=true,updated_at=now() WHERE id=$1`,
    [t.id, s.screens_proposed],
  );
  await dbtx.query(
    `UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id IN(SELECT id FROM error_groups WHERE ticket_id=$1) AND invalidated_at IS NULL`,
    [t.id],
  );
  await dbtx.query(
    `UPDATE friction_observation_decisions SET ticket_id=$2,decided_by='fold',decided_at=now() WHERE ticket_id=$1`,
    [s.id, t.id],
  );
  await dbtx.query(
    `UPDATE friction_tickets SET status='merged',merged_into=$2,updated_at=now() WHERE id=$1`,
    [s.id, t.id],
  );
  await dbtx.query(
    `UPDATE error_group_jobs SET status='failed',last_error='ticket merged',updated_at=now() WHERE ticket_id=$1 AND job_type='friction_confirm' AND status='pending'`,
    [s.id],
  );
  const updated = await lockTicket(dbtx, t);
  const confirmNeeded =
    updated.arrival_boundary === 0n
      ? updated.matched_count >= 3
      : updated.next_arrival_number - updated.arrival_boundary >= 10n;
  if (confirmNeeded)
    await enqueueJobTx(dbtx, 'friction_confirm', t.project_id, {
      ticketId: t.id,
    });
  return { confirmNeeded };
}

/** Scoped reader shared by confirmation and reconciliation. */
export async function getTicket(
  db: TicketDb,
  projectId: string,
  id: string,
  lock = false,
): Promise<TicketRow | null> {
  const r = await db.query<RawTicket>(
    `SELECT ${ticketColumns} FROM friction_tickets t WHERE id=$1 AND project_id=$2 ${
      lock ? 'FOR UPDATE' : ''
    }`,
    [id, projectId],
  );
  return r.rows[0] ? decodeTicket(r.rows[0]) : null;
}
export async function getBatch(
  db: TicketDb,
  ticketId: string,
  batchId: string,
): Promise<ConfirmBatch | null> {
  const r = await db.query<
    Omit<ConfirmBatch, 'arrival_boundary_at_select'> & {
      arrival_boundary_at_select: string;
    }
  >(`SELECT * FROM friction_confirm_batches WHERE id=$1 AND ticket_id=$2`, [
    batchId,
    ticketId,
  ]);
  const row = r.rows[0];
  return row
    ? {
        ...row,
        batchId: row.id,
        sessionIds: row.manifest.map((m) => m.sessionId),
        arrival_boundary_at_select: BigInt(row.arrival_boundary_at_select),
      }
    : null;
}
/** Retrieval floor for publish-gate duplicate candidates. Recall is cheap here
 * because the one-fix question is the precision gate: a production replay saw
 * two tickets for one bug sit at 0.775, under the 0.80 the spike chose. */
export function foldMinSimilarity(): number {
  const raw = Number(process.env['FRICTION_FOLD_MIN_SIMILARITY'] ?? '0.75');
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
}
export async function publishedNeighbors(
  db: TicketDb,
  ticket: TicketRow,
): Promise<(TicketRow & { similarity: number })[]> {
  if (!ticket.embedding || ticket.embedding_model !== EMBEDDING_MODEL)
    return [];
  const r = await db.query<RawTicket & { similarity: number }>(
    `SELECT ${ticketColumns},1-(t.embedding <=> $4::vector) AS similarity
    FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id AND g.publication_generation=t.live_generation
    WHERE t.project_id=$1 AND t.environment_id=$2 AND t.id<>$3 AND t.status='published' AND g.status<>'archived'
      AND g.fix_substate IS DISTINCT FROM 'resolved' AND t.embedding_model=$5 AND t.embedding IS NOT NULL
      AND 1-(t.embedding <=> $4::vector)>=$6 ORDER BY similarity DESC,t.id LIMIT 10`,
    [
      ticket.project_id,
      ticket.environment_id,
      ticket.id,
      vectorValue(ticket.embedding),
      EMBEDDING_MODEL,
      foldMinSimilarity(),
    ],
  );
  return r.rows.map((r) => ({ ...decodeTicket(r), similarity: r.similarity }));
}
export interface LiveIncident {
  id: string;
  fix_substate: string | null;
  evidence_version_used: number | null;
  pr_url: string | null;
}
export async function liveIncident(
  db: TicketDb,
  t: TicketRow,
): Promise<LiveIncident | null> {
  const r = await db.query<LiveIncident>(
    `SELECT g.id,g.fix_substate,g.evidence_version_used,
    (SELECT pr_url FROM friction_fix_attempts a WHERE a.ticket_id=g.ticket_id AND a.generation=g.publication_generation AND a.pr_url IS NOT NULL ORDER BY a.created_at DESC LIMIT 1) AS pr_url
    FROM error_groups g WHERE g.ticket_id=$1 AND g.publication_generation=$2 AND g.status<>'archived'`,
    [t.id, t.live_generation],
  );
  return r.rows[0] ?? null;
}
/** Includes this batch's staged checks for planning only; never used for display. */
export async function previewCohort(
  db: TicketDb,
  t: TicketRow,
  batchId: string | null,
): Promise<{ stats: CohortStats; notes: string[] }> {
  const r = await db.query<{
    outcome: string;
    end_user_id: string | null;
    note: string;
  }>(
    `WITH checks AS (
      SELECT c.session_id,c.outcome,a.note FROM friction_checks c JOIN friction_check_attempts a ON a.id=c.attempt_id
        JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized' WHERE c.ticket_id=$1
      UNION ALL SELECT a.session_id,a.outcome,a.note FROM friction_check_attempts a JOIN friction_confirm_batches b ON b.id=a.batch_id
        WHERE a.batch_id=$2 AND a.ticket_id=$1 AND b.status='staging' AND a.outcome<>'unavailable'
          AND NOT EXISTS(SELECT 1 FROM friction_checks c WHERE c.ticket_id=a.ticket_id AND c.session_id=a.session_id)
    ) SELECT c.outcome,m.end_user_id,c.note FROM checks c JOIN friction_ticket_matches m ON m.ticket_id=$1 AND m.session_id=c.session_id
      JOIN friction_tickets t ON t.id=m.ticket_id WHERE t.cohort_cutoff IS NULL OR m.occurred_at>t.cohort_cutoff
      ORDER BY m.arrival_number`,
    [t.id, batchId],
  );
  const confirmed = r.rows.filter((r) => r.outcome === 'confirmed');
  const users = new Set(
    confirmed.flatMap((r) => (r.end_user_id ? [r.end_user_id] : [])),
  );
  return {
    stats: {
      counted: r.rows.length,
      confirmed: confirmed.length,
      refuted: r.rows.filter((r) => r.outcome === 'refuted').length,
      inconclusive: r.rows.filter((r) => r.outcome === 'inconclusive').length,
      confirmedUsers: users.size,
      identityKnown: users.size > 0,
    },
    notes: [...new Set(confirmed.map((r) => r.note).filter(Boolean))],
  };
}
/** Null means no remaining selectable or retryable work. */
export async function nextConfirmationAt(
  db: TicketDb,
  ticketId: string,
): Promise<Date | null> {
  const r = await db.query<{ available_at: Date | null }>(
    `SELECT min(CASE WHEN r.session_id IS NULL THEN now() ELSE greatest(now(),r.retry_at) END) AS available_at
    FROM friction_ticket_matches m LEFT JOIN friction_checks c USING(ticket_id,session_id)
      LEFT JOIN friction_unavailable_retries r USING(ticket_id,session_id)
    WHERE m.ticket_id=$1 AND c.session_id IS NULL AND (r.session_id IS NULL OR NOT r.permanent)`,
    [ticketId],
  );
  return r.rows[0]?.available_at ?? null;
}
export async function batchIntact(
  db: TicketDb,
  batch: ConfirmBatch,
): Promise<boolean> {
  const r = await db.query<{ intact: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM friction_confirm_batches b,
    jsonb_array_elements(b.manifest) member WHERE b.id=$1 AND NOT EXISTS(
      SELECT 1 FROM friction_ticket_matches m JOIN sessions s ON s.id=m.session_id
      WHERE m.ticket_id=b.ticket_id AND m.session_id=member->>'sessionId'
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(member->'signalIds') signal(id)
          WHERE NOT EXISTS(SELECT 1 FROM friction_ticket_match_observations o WHERE o.ticket_id=m.ticket_id AND o.session_id=m.session_id AND o.signal_id::text=signal.id)))) AS intact`,
    [batch.id],
  );
  return r.rows[0]!.intact;
}
/** Fleet-wide project/day counter. Reserve only for an unstaged recording. */
export async function reserveConfirmationBudget(
  dbtx: pg.PoolClient,
  projectId: string,
  cap: number,
): Promise<{ reserved: boolean; nextWindow: Date }> {
  const r = await dbtx.query(
    `INSERT INTO friction_confirmation_budget AS b(project_id,budget_day,used)
    SELECT $1,(clock_timestamp() AT TIME ZONE 'UTC')::date,1 WHERE $2::int>0
    ON CONFLICT(project_id,budget_day) DO UPDATE SET used=b.used+1 WHERE b.used<$2 RETURNING used`,
    [projectId, cap],
  );
  const window = await dbtx.query<{ next_window: Date }>(
    `SELECT (((clock_timestamp() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC') AS next_window`,
  );
  return {
    reserved: Boolean(r.rowCount),
    nextWindow: window.rows[0]!.next_window,
  };
}

/** One row per one-fix question asked at the publish gate. Audit only: it
 * never changes a decision, it lets a later reader see why two cards exist. */
export async function recordGateDecision(
  db: TicketDb,
  d: { ticketId: string; batchId: string | null; candidateId: string; similarity: number; oneFix: boolean; reason: string; model: string },
): Promise<void> {
  await db.query(
    `INSERT INTO friction_gate_decisions(ticket_id,batch_id,candidate_id,similarity,one_fix,reason,model) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [d.ticketId, d.batchId, d.candidateId, d.similarity, d.oneFix, d.reason, d.model],
  );
}
