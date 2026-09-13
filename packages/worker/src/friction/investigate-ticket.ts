import type pg from 'pg';
import * as db from '../db.js';
import * as store from './tickets-db.js';
import {
  causeCoverage,
  lockJob,
  requestFix,
  transaction,
} from './fix-attempts.js';
import { gatherFrictionEvidence } from './friction-evidence.js';
import {
  investigateFriction,
  FRICTION_INVESTIGATION_MODEL,
  type FrictionInvestigationResult,
} from './investigate-friction.js';
import { PhaseMeter } from '../metered.js';
import type { ReadOnlyCheckout } from '../harness/readonly-sandbox.js';

export type TicketInvestigateJob = db.ClaimedJob & {
  ticketId: string;
  errorGroupId: string;
  publicationGeneration: number;
};
export interface InvestigationSnapshot {
  ticket: store.TicketRow;
  execution: string;
  signalIds: string[];
}
export async function beginInvestigation(
  tx: pg.PoolClient,
  job: TicketInvestigateJob,
): Promise<InvestigationSnapshot | null> {
  await lockJob(tx, job);
  const adopted = await tx.query(
    `SELECT 1 FROM friction_investigation_results WHERE job_id=$1 AND applied`,
    [job.id],
  );
  if (adopted.rowCount) return null;
  const ticket = await store.getTicket(tx, job.projectId, job.ticketId, true);
  if (
    !ticket ||
    ticket.status !== 'published' ||
    ticket.live_generation !== job.publicationGeneration
  )
    return null;
  const r = await tx.query<{ execution: string }>(
    `UPDATE error_groups SET investigation_execution=investigation_execution+1,
    investigation_status='pending',status=CASE WHEN fix_substate='none' THEN 'analyzing'::error_group_status ELSE status END,updated_at=now()
    WHERE id=$1 AND ticket_id=$2 AND publication_generation=$3 AND status<>'archived' AND fix_substate<>'resolved'
    RETURNING investigation_execution::text AS execution`,
    [job.errorGroupId, job.ticketId, job.publicationGeneration],
  );
  if (!r.rows[0]) return null;
  await tx.query(
    `UPDATE error_group_jobs SET investigation_execution=$2,investigation_evidence_version=$3 WHERE id=$1`,
    [job.id, r.rows[0].execution, ticket.evidence_version],
  );
  return {
    ticket,
    execution: r.rows[0].execution,
    signalIds: (await store.verifiedEvidence(tx, ticket)).signalIds,
  };
}
export async function finishInvestigation(
  tx: pg.PoolClient,
  job: TicketInvestigateJob,
  snapshot: InvestigationSnapshot,
  result: FrictionInvestigationResult,
): Promise<boolean> {
  await store.lockJobPublications(tx, [job.id]);
  const owned = await tx.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND project_id=$2 AND worker_id=$3 AND lease_generation=$4::bigint AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [job.id, job.projectId, job.workerId, job.leaseGeneration],
  );
  const ticket = await store.getTicket(tx, job.projectId, job.ticketId, true);
  if (!ticket) return false;
  const fact = await tx.query<{ id: string }>(
    `INSERT INTO friction_investigation_results(ticket_id,error_group_id,generation,execution,evidence_version,job_id,result)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(error_group_id,execution) DO NOTHING RETURNING id`,
    [
      job.ticketId,
      job.errorGroupId,
      job.publicationGeneration,
      snapshot.execution,
      snapshot.ticket.evidence_version,
      job.id,
      JSON.stringify(result),
    ],
  );
  if (!fact.rowCount) return false;
  const group = await tx.query<{
    investigation_execution: string;
    investigation_result_execution: string;
    fix_substate: string;
    status: string;
  }>(
    `SELECT investigation_execution::text,investigation_result_execution::text,fix_substate,status FROM error_groups WHERE id=$1 AND project_id=$2 FOR UPDATE`,
    [job.errorGroupId, job.projectId],
  );
  const g = group.rows[0];
  const stillOwned = await tx.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND worker_id=$2 AND lease_generation=$3::bigint AND status='claimed' AND lease_expires_at>clock_timestamp()`,
    [job.id, job.workerId, job.leaseGeneration],
  );
  if (
    !stillOwned.rowCount ||
    !owned.rowCount ||
    !g ||
    ticket.status !== 'published' ||
    ticket.live_generation !== job.publicationGeneration ||
    g.status === 'archived' ||
    g.fix_substate === 'resolved' ||
    BigInt(snapshot.execution) < BigInt(g.investigation_execution) ||
    BigInt(snapshot.execution) <= BigInt(g.investigation_result_execution)
  )
    return false;
  const verdict = result.status === 'verdict' ? result.verdict : null;
  const partition = verdict
    ? [...verdict.explains, ...verdict.doesNotExplain]
    : [];
  const valid =
    !!verdict &&
    new Set(partition).size === partition.length &&
    partition.length === snapshot.signalIds.length &&
    partition.every((id) => snapshot.signalIds.includes(id));
  const done = valid && verdict.codeCause && !!verdict.agentTaskBrief;
  const explained = done ? verdict.explains : [];
  const coverage = causeCoverage(
    explained,
    (await store.verifiedEvidence(tx, ticket)).signalIds,
  );
  await tx.query(
    `UPDATE error_groups SET investigation_status=$2,investigation_result_execution=$3,evidence_version_used=$4,
    explained_signal_ids=$5::jsonb,root_cause=$6,confidence=$7,status=CASE WHEN fix_substate='none' THEN 'awaiting_approval'::error_group_status ELSE status END,updated_at=now() WHERE id=$1`,
    [
      job.errorGroupId,
      done ? 'done' : 'failed',
      snapshot.execution,
      snapshot.ticket.evidence_version,
      JSON.stringify(explained),
      done ? verdict.reason : null,
      verdict?.confidence ?? 'low',
    ],
  );
  await tx.query(
    `UPDATE friction_tickets SET reinvestigate_needed=$2,updated_at=now() WHERE id=$1`,
    [job.ticketId, !done || coverage < 0.5],
  );
  await tx.query(
    `INSERT INTO diagnosis_decisions(error_group_id,project_id,job_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'friction-ticket-v1','friction_classify',$8)`,
    [
      job.errorGroupId,
      job.projectId,
      job.id,
      done ? 'code_fix' : 'incomplete',
      verdict?.reason ??
        (result.status === 'incomplete'
          ? result.reason
          : 'Investigation failed'),
      JSON.stringify({
        evidence: verdict?.evidence ?? [],
        agentTaskBrief: done ? verdict.agentTaskBrief : null,
        investigatedCommit: result.investigatedCommit,
        verdict,
      }),
      FRICTION_INVESTIGATION_MODEL,
      verdict?.confidence ?? 'low',
    ],
  );
  await tx.query(
    `UPDATE friction_investigation_results SET applied=true WHERE id=$1`,
    [fact.rows[0]!.id],
  );
  await tx.query(
    `UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id=$1 AND invalidated_at IS NULL`,
    [job.errorGroupId],
  );
  await lockJob(tx, job);
  return done && coverage >= 0.5;
}
export interface TicketInvestigationDeps {
  checkout(): Promise<
    Pick<ReadOnlyCheckout, 'reader' | 'tree' | 'headSha' | 'close'>
  >;
  investigate: typeof investigateFriction;
  apiKey: string;
}
/** Production handler seam: callers may provide a local reader and a deterministic verdict. */
export async function processTicketInvestigation(
  job: TicketInvestigateJob,
  group: db.ErrorGroupData,
  signal: AbortSignal,
  deps: TicketInvestigationDeps,
): Promise<void> {
  const snapshot = await transaction((tx) => beginInvestigation(tx, job));
  if (!snapshot) {
    await transaction(async (tx) => {
      await lockJob(tx, job);
      await tx.query(
        `UPDATE error_group_jobs SET status='completed',lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
        [job.id],
      );
    });
    await transaction((tx) =>
      requestFix(
        tx,
        job.projectId,
        job.ticketId,
        job.publicationGeneration,
        'auto',
      ),
    );
    throw new db.JobCompletedInTransaction(job.id);
  }
  let checkout:
    | Pick<ReadOnlyCheckout, 'reader' | 'tree' | 'headSha' | 'close'>
    | undefined;
  const meter = new PhaseMeter({
    jobId: job.id,
    execution: Number(job.leaseGeneration),
    phase: 'investigation',
  });
  try {
    signal.throwIfAborted();
    checkout = await deps.checkout();
    const evidence = await gatherFrictionEvidence(
      job.errorGroupId,
      job.projectId,
      snapshot.signalIds,
    );
    const result = await deps.investigate(deps.apiKey, {
      group,
      evidence,
      confirmedSignalIds: snapshot.signalIds,
      ticketDefinition: {
        name: snapshot.ticket.name,
        control: snapshot.ticket.control,
        what_happened: snapshot.ticket.what_happened,
        kind: snapshot.ticket.kind,
      },
      reader: checkout.reader,
      tree: checkout.tree,
      sessionContext: null,
      investigatedCommit: checkout.headSha,
    });
    meter.add(FRICTION_INVESTIGATION_MODEL, result.usage);
    const fix = await transaction(async (tx) => {
      const ready = await finishInvestigation(tx, job, snapshot, result);
      await tx.query(
        `UPDATE error_group_jobs SET status='completed',lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2 AND lease_generation=$3::bigint AND status='claimed' AND lease_expires_at>clock_timestamp()`,
        [job.id, job.workerId, job.leaseGeneration],
      );
      return ready;
    });
    if (fix)
      await transaction((tx) =>
        requestFix(
          tx,
          job.projectId,
          job.ticketId,
          job.publicationGeneration,
          'auto',
        ),
      );
    throw new db.JobCompletedInTransaction(job.id);
  } finally {
    await meter.flush();
    await checkout?.close();
  }
}
