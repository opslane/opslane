import { runContextFromJob } from '../run-logs/context.js';
import type pg from 'pg';
import * as db from '../db.js';
import { PhaseMeter } from '../metered.js';
import type { ConfirmClient } from './confirm.js';
import {
  applyConfirmationTransition,
  prepareConfirmationTransition,
  confirmationSnapshotCurrent,
} from './confirm-job.js';
import { CAUSE_COVERAGE_MIN, causeCoverage } from './fix-attempts.js';
import * as store from './tickets-db.js';

type ReconcileJob = db.ClaimedJob & { ticketId: string };

/** A durable decision retry is independent of whether another batch is selectable. */
export async function scheduleFrictionReconciliation(): Promise<number> {
  if (store.publicationPaused()) return 0;
  const result = await db.getPool()
    .query(`INSERT INTO error_group_jobs(project_id,ticket_id,job_type,status)
    SELECT project_id,id,'friction_reconcile','pending' FROM friction_tickets
    WHERE reconcile_needed AND status NOT IN ('merged','archived')
    ON CONFLICT DO NOTHING RETURNING id`);
  return result.rowCount ?? 0;
}
/** Re-investigate published incidents whose cause coverage fell below half as
 *  explained recordings aged out of the seven-day window without new evidence
 *  arriving. Runs on the same periodic timer as scheduleFrictionReconciliation.
 *
 *  For each candidate the function acquires the ticket publication lock, re-reads
 *  current evidence, and calls enqueueTicketInvestigation (which enforces the
 *  per-generation cap and pending/claimed deduplication). */
export async function reconcileDilutedCoverage(): Promise<number> {
  if (store.publicationPaused()) return 0;
  const pool = db.getPool();
  // Find published incidents where the investigation finished, no fix is in
  // flight, and no investigation is already pending or claimed.
  const candidates = await pool.query<{
    ticket_id: string;
    project_id: string;
  }>(`SELECT DISTINCT t.id AS ticket_id, t.project_id
      FROM friction_tickets t
      JOIN error_groups g ON g.ticket_id = t.id
        AND g.publication_generation = t.live_generation
      WHERE t.status = 'published'
        AND g.status <> 'archived'
        AND g.investigation_status = 'done'
        AND g.fix_substate = 'none'
        AND NOT EXISTS (
          SELECT 1 FROM error_group_jobs j
          WHERE j.error_group_id = g.id
            AND j.job_type = 'investigate'
            AND j.status IN ('pending', 'claimed')
        )`);
  let queued = 0;
  for (const row of candidates.rows) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await store.lockTicketPublication(tx, row.project_id, row.ticket_id);
      const ticket = await store.getTicket(tx, row.project_id, row.ticket_id, true);
      if (!ticket || ticket.status !== 'published') {
        await tx.query('ROLLBACK');
        continue;
      }
      const incident = await store.liveIncident(tx, ticket);
      if (
        !incident ||
        incident.fix_substate !== 'none' ||
        incident.investigation_status !== 'done'
      ) {
        await tx.query('ROLLBACK');
        continue;
      }
      const recent = await store.verifiedEvidence(tx, ticket);
      // Empty window: no evidence to investigate — skip silently.
      if (recent.signalIds.length === 0) {
        await tx.query('ROLLBACK');
        continue;
      }
      const coverage = causeCoverage(
        incident.explained_signal_ids ?? [],
        recent.signalIds,
      );
      if (coverage >= CAUSE_COVERAGE_MIN) {
        await tx.query('ROLLBACK');
        continue;
      }
      if (!store.investigationAllowed(ticket, recent.users)) {
        await tx.query('ROLLBACK');
        continue;
      }
      if (await store.enqueueTicketInvestigation(tx, ticket, incident.id)) {
        queued++;
      }
      await tx.query('COMMIT');
    } catch {
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
  }
  return queued;
}
async function lockLease(tx: pg.PoolClient, job: ReconcileJob): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND project_id=$2 AND ticket_id=$3
    AND worker_id=$4 AND lease_generation=$5::bigint AND job_type='friction_reconcile'
    AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [job.id, job.projectId, job.ticketId, job.workerId, job.leaseGeneration],
  );
  if (!r.rowCount) throw new db.LeaseLostError(job.id);
}
export async function processFrictionReconcile(
  job: ReconcileJob,
  deps: { client: ConfirmClient },
  signal: AbortSignal,
): Promise<void> {
  if (store.publicationPaused()) {
    await db.rescheduleJob(job, new Date(Date.now() + 15 * 60_000));
    throw new db.JobRescheduledError(job.id);
  }
  const pool = db.getPool();
  const ticket = await store.getTicket(pool, job.projectId, job.ticketId);
  const meter = new PhaseMeter({
    jobId: job.id,
    execution: Number(job.leaseGeneration),
    phase: `friction_reconcile:${job.id}`,
  });
  const check = async () => {
    signal.throwIfAborted();
    await db.assertJobLease(job);
  };
  try {
    await check();
    const plan =
      ticket && !['merged', 'archived'].includes(ticket.status)
        ? await prepareConfirmationTransition(
            pool,
            ticket,
            null,
            {
              modelName: deps.client.modelName,
              settings: deps.client.settings?.bind(deps.client),
              complete: async (args) => {
                await check();
                return deps.client.complete({ ...args, signal });
              },
            },
            meter,
            runContextFromJob(job),
          )
        : null;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await store.lockTicketPublication(tx, job.projectId, job.ticketId);
      await lockLease(tx, job);
      signal.throwIfAborted();
      const current = await store.getTicket(
        tx,
        job.projectId,
        job.ticketId,
        true,
      );
      if (current) {
        const counts = await tx.query<{ matched_count: number }>(
          `UPDATE friction_tickets SET matched_count=(SELECT count(*) FROM friction_ticket_matches WHERE ticket_id=$1),updated_at=now() WHERE id=$1 RETURNING matched_count`,
          [current.id],
        );
        current.matched_count = counts.rows[0]!.matched_count;
        if (['merged', 'archived'].includes(current.status)) {
          await tx.query(
            'UPDATE friction_tickets SET reconcile_needed=false WHERE id=$1',
            [current.id],
          );
        } else if (
          plan &&
          confirmationSnapshotCurrent(
            current,
            plan.ticket,
            plan.incident,
            await store.liveIncident(tx, current),
          )
        ) {
          await applyConfirmationTransition(tx, current, plan);
        } else {
          await tx.query(
            'UPDATE friction_tickets SET reconcile_needed=true WHERE id=$1',
            [current.id],
          );
        }
      }
      await lockLease(tx, job);
      signal.throwIfAborted();
      await tx.query(
        `UPDATE error_group_jobs SET status='completed',lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
        [job.id],
      );
      const updated = await store.getTicket(tx, job.projectId, job.ticketId);
      if (updated && !['merged', 'archived'].includes(updated.status)) {
        const next = await store.nextConfirmationAt(tx, updated.id);
        if (next)
          await db.enqueueJobTx(tx, 'friction_confirm', job.projectId, {
            ticketId: updated.id,
            availableAt: next,
          });
      }
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    throw new db.JobCompletedInTransaction(job.id);
  } finally {
    await meter.flush();
  }
}
