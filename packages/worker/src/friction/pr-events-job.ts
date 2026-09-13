import type { ClaimedJob } from '../db.js';
import {
  applyPrEvent,
  lockJob,
  transaction,
  type PrEvent,
} from './fix-attempts.js';
export async function processPrEventJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload;
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('eventId' in payload) ||
    typeof payload.eventId !== 'string'
  )
    throw new Error('PR event job missing eventId');
  await transaction(async (tx) => {
    await lockJob(tx, job);
    const r = await tx.query<PrEvent>(
      `SELECT e.ticket_id AS "ticketId",e.error_group_id AS "errorGroupId",e.fix_attempt_id AS "attemptId",e.generation,e.event,e.delivery_id AS "deliveryId",e.occurred_at::text AS "occurredAt",e.pr_url AS "prUrl",e.pr_number AS "prNumber",e.github_repo AS "githubRepo"
      FROM friction_pr_events e JOIN friction_tickets t ON t.id=e.ticket_id WHERE e.id=$1 AND t.project_id=$2 AND e.ticket_id=$3 AND e.fix_attempt_id=$4 AND e.generation=$5`,
      [
        payload.eventId,
        job.projectId,
        job.ticketId,
        job.fixAttemptId,
        job.publicationGeneration,
      ],
    );
    if (r.rows[0]) await applyPrEvent(tx, job.projectId, r.rows[0]);
    await lockJob(tx, job);
  });
}
