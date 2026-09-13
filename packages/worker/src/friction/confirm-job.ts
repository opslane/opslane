import type pg from 'pg';
import type { SessionChunkEnvelope } from '@opslane/shared';
import * as db from '../db.js';
import { NarrativeClient } from '../narrative/client.js';
import type { CompactTimeline } from '../narrative/emit.js';
import { readChunksBounded } from './chunk-reader.js';
import { captureFrames } from '../narrative/frames/capture.js';
import { PhaseMeter } from '../metered.js';
import { logger, safeErrorMessage } from '../logger.js';
import {
  confirmRead,
  ticketSteps,
  type ConfirmClient,
  type ConfirmMeter,
  type ConfirmResult,
} from './confirm.js';
import { judgeOneFix } from './one-fix.js';
import * as store from './tickets-db.js';

export interface ConfirmJobDeps {
  client: ConfirmClient;
  loadRecording(
    sessionId: string,
    projectId: string,
    signalIds: string[],
  ): Promise<{
    timelineText: string;
    offsetsMs: number[];
    envelopes: SessionChunkEnvelope[];
  }>;
  capture: typeof captureFrames;
  dailyCap: number;
}
/** Changed neighbor snapshots a classification may retry before publishing
 * without the one-fix gate. */
export const FOLD_RETRY_LIMIT = 3;
/** The recording itself is missing or incomplete, so its check is unavailable.
 * Any other loading failure is infrastructure and retries the job. */
export class RecordingUnavailableError extends Error {
  override readonly name = 'RecordingUnavailableError';
}
type ConfirmJob = db.ClaimedJob & { ticketId: string };
export interface TransitionPlan {
  ticket: store.TicketRow;
  incident: store.LiveIncident | null;
  steps: string;
  neighbors: { id: string; similarity: number }[] | null;
  targetId: string | null;
  /** The one-fix gate answered for every planned neighbor. */
  judged: boolean;
}
/** Production transition table, shared with reconciliation and property tests. */
export function confirmationTransition(
  status: store.TicketStatus,
  fixSubstate: string | null,
  bar: 'passes' | 'fails' | 'undecided',
): 'none' | 'activate' | 'classify' | 'refresh' | 'unpublish' {
  if (status === 'merged' || status === 'archived') return 'none';
  if (status === 'published') {
    if (fixSubstate === 'resolved')
      return bar === 'passes' ? 'activate' : 'none';
    return bar === 'fails' ? 'unpublish' : 'refresh';
  }
  return bar === 'passes' ? 'classify' : 'none';
}
export function confirmationSnapshotCurrent(
  current: store.TicketRow,
  saved: Pick<
    store.TicketRow,
    'status' | 'live_generation' | 'evidence_version' | 'fixed_at'
  >,
  savedIncident: store.LiveIncident | null,
  live: store.LiveIncident | null,
): boolean {
  return (
    current.status === saved.status &&
    current.live_generation === saved.live_generation &&
    current.evidence_version === saved.evidence_version &&
    current.fixed_at === saved.fixed_at &&
    (live?.fix_substate === 'resolved') ===
      (savedIncident?.fix_substate === 'resolved')
  );
}
/** Evidence mutations invalidate a batch even when publication stays live. */
export function confirmationBatchCurrent(
  current: store.TicketRow,
  batch: store.ConfirmBatch,
  plan: TransitionPlan,
  live: store.LiveIncident | null,
): boolean {
  return confirmationSnapshotCurrent(
    current,
    {
      status: batch.status_at_select,
      live_generation: batch.live_generation_at_select,
      evidence_version: batch.evidence_version_at_select,
      fixed_at: plan.ticket.fixed_at,
    },
    plan.incident,
    live,
  );
}
/** No locks: models classify the complete ordered publication snapshot here. */
export async function prepareConfirmationTransition(
  database: store.TicketDb,
  ticket: store.TicketRow,
  batchId: string | null,
  client: ConfirmClient,
  meter: ConfirmMeter,
): Promise<TransitionPlan> {
  const incident = await store.liveIncident(database, ticket);
  const preview = await store.previewCohort(database, ticket, batchId);
  const resolvedNote =
    incident?.fix_substate === 'resolved' && ticket.fixed_at
      ? [
          `Fix merged on ${ticket.fixed_at}, seen again since${
            incident.pr_url ? ` (${incident.pr_url})` : ''
          }.`,
        ]
      : [];
  const plan: TransitionPlan = {
    ticket,
    incident,
    steps: ticketSteps([...resolvedNote, ...preview.notes]),
    neighbors: null,
    targetId: null,
    judged: false,
  };
  // Plan neighbors for every classifiable status, not only when the preview
  // passes: the locked cohort can pass when the preview did not, and a missing
  // snapshot would read as a changed one and spend a fold retry.
  if (
    !['tracking', 'unpublished'].includes(ticket.status) ||
    ticket.fold_retries >= FOLD_RETRY_LIMIT
  )
    return plan;
  const neighbors = await store.publishedNeighbors(database, ticket);
  plan.neighbors = neighbors.map(({ id, similarity }) => ({ id, similarity }));
  if (
    confirmationTransition(
      ticket.status,
      incident?.fix_substate ?? null,
      store.evaluateBar(preview.stats, {
        status: ticket.status,
        fixSubstate: incident?.fix_substate ?? null,
      }),
    ) !== 'classify'
  )
    return plan;
  plan.judged = true;
  for (const neighbor of neighbors) {
    let oneFix = await store.latestGateDecision(database, ticket.id, neighbor.id);
    if (oneFix === null) {
      let result = await judgeOneFix(client, ticket, neighbor, meter);
      if ('invalid' in result)
        result = await judgeOneFix(client, ticket, neighbor, meter);
      if ('invalid' in result)
        throw new Error(`One-fix classification invalid: ${result.invalid}`);
      // Every one-fix answer is kept as a fact so a duplicate card can be traced
      // to the question that let it through, not guessed at afterwards.
      await store.recordGateDecision(database, {
        ticketId: ticket.id,
        batchId,
        candidateId: neighbor.id,
        similarity: neighbor.similarity,
        oneFix: result.oneFix,
        reason: result.reason,
        model: client.modelName,
      });
      oneFix = result.oneFix;
    }
    if (oneFix) {
      plan.targetId = neighbor.id;
      break;
    }
  }
  return plan;
}
/** Caller owns the current job lease and environment publication lock. Models
 * must have finished before entering this shared confirmation/reconcile path. */
export async function applyConfirmationTransition(
  tx: pg.PoolClient,
  ticket: store.TicketRow,
  plan: TransitionPlan,
): Promise<void> {
  const stats = await store.cohortStats(tx, ticket);
  const incident = await store.liveIncident(tx, ticket);
  const transition = confirmationTransition(
    ticket.status,
    incident?.fix_substate ?? null,
    store.evaluateBar(stats, {
      status: ticket.status,
      fixSubstate: incident?.fix_substate ?? null,
    }),
  );
  if (transition === 'classify') {
    if (ticket.fold_retries < FOLD_RETRY_LIMIT) {
      const candidates = await store.publishedNeighbors(tx, ticket);
      const snapshot = candidates.map(({ id, similarity }) => ({
        id,
        similarity,
      }));
      // Include empty/no-match snapshots: concurrent first publications must also reclassify.
      if (JSON.stringify(snapshot) !== JSON.stringify(plan.neighbors)) {
        await tx.query(
          `UPDATE friction_tickets SET reconcile_needed=true,fold_retries=fold_retries+1 WHERE id=$1`,
          [ticket.id],
        );
        return;
      }
      // The preview missed the bar, so the gate was never asked about these
      // candidates. Replan from the passing cohort instead of publishing past them.
      if (!plan.judged && snapshot.length) {
        await tx.query(
          `UPDATE friction_tickets SET reconcile_needed=true WHERE id=$1`,
          [ticket.id],
        );
        return;
      }
      const target = candidates.find((t) => t.id === plan.targetId);
      if (target) {
        await store.foldInto(tx, ticket, target);
        await tx.query(
          'UPDATE friction_tickets SET reconcile_needed=false WHERE id=$1',
          [ticket.id],
        );
        return;
      }
    }
    await store.activateGeneration(tx, ticket, plan.steps);
  } else if (transition === 'activate') {
    await store.activateGeneration(tx, ticket, plan.steps);
  } else if (transition === 'unpublish') {
    await store.unpublish(tx, ticket);
  } else if (transition === 'refresh' && incident) {
    const evidence = await store.verifiedEvidence(tx, ticket, { days: null });
    await tx.query(
      `INSERT INTO friction_incident_evidence(error_group_id,ticket_id,generation,signal_id)
      SELECT $1,$2,$3,unnest($4::uuid[]) ON CONFLICT DO NOTHING`,
      [incident.id, ticket.id, ticket.live_generation, evidence.signalIds],
    );
    await tx.query(
      `UPDATE friction_signals SET incident_id=$1 WHERE id=ANY($2::uuid[]) AND project_id=$3 AND environment_id=$4`,
      [
        incident.id,
        evidence.signalIds,
        ticket.project_id,
        ticket.environment_id,
      ],
    );
    await tx.query(
      `UPDATE error_groups SET occurrence_count=$2,affected_users_count=$3,updated_at=now() WHERE id=$1`,
      [incident.id, evidence.sessions, evidence.users],
    );
    await tx.query(
      `UPDATE friction_tickets SET steps=$2 WHERE id=$1 AND NOT EXISTS(
      SELECT 1 FROM digest_card_copy WHERE error_group_id=$3 AND invalidated_at IS NULL AND authored_at >= (SELECT created_at FROM error_groups WHERE id=$3))`,
      [ticket.id, plan.steps, incident.id],
    );
    await tx.query(
      `UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id=$1 AND invalidated_at IS NULL`,
      [incident.id],
    );
    const allowed = store.investigationAllowed(ticket, evidence.users);
    if (
      allowed &&
      ticket.reinvestigate_needed &&
      ticket.evidence_version > (incident.evidence_version_used ?? -1)
    ) {
      await store.enqueueTicketInvestigation(tx, ticket, incident.id);
      await tx.query(
        `UPDATE friction_tickets SET reinvestigate_needed=false WHERE id=$1`,
        [ticket.id],
      );
    }
    // An insight published below the user threshold has an incident with no
    // investigation status. Its first investigation starts from the batch that
    // carries it over the threshold; queueing sets the status to pending.
    if (allowed && ticket.kind === 'ux_insight' && incident.investigation_status === null)
      await store.enqueueTicketInvestigation(tx, ticket, incident.id);
  }
  await tx.query(
    `UPDATE friction_tickets SET reconcile_needed=false WHERE id=$1`,
    [ticket.id],
  );
}
async function lockLease(tx: pg.PoolClient, job: ConfirmJob): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND project_id=$2 AND ticket_id=$3
    AND worker_id=$4 AND lease_generation=$5::bigint AND job_type='friction_confirm'
    AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [job.id, job.projectId, job.ticketId, job.workerId, job.leaseGeneration],
  );
  if (!r.rowCount) throw new db.LeaseLostError(job.id);
}
async function completeTx(tx: pg.PoolClient, job: ConfirmJob): Promise<void> {
  await lockLease(tx, job);
  await tx.query(
    `UPDATE error_group_jobs SET status='completed',lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
    [job.id],
  );
}
async function transaction<T>(
  job: ConfirmJob,
  signal: AbortSignal,
  action: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await db.getPool().connect();
  try {
    await tx.query('BEGIN');
    signal.throwIfAborted();
    await store.lockTicketPublication(tx, job.projectId, job.ticketId);
    await lockLease(tx, job);
    const result = await action(tx);
    signal.throwIfAborted();
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
export async function processFrictionConfirm(
  job: ConfirmJob,
  deps: ConfirmJobDeps,
  signal: AbortSignal,
): Promise<void> {
  if (store.publicationPaused()) {
    await db.rescheduleJob(job, new Date(Date.now() + 15 * 60_000));
    throw new db.JobRescheduledError(job.id);
  }
  const pool = db.getPool();
  const initial = await transaction(job, signal, async (tx) => {
    const ticket = await store.getTicket(tx, job.projectId, job.ticketId, true);
    if (!ticket || ticket.status === 'merged' || ticket.status === 'archived') {
      if (ticket) {
        const pendingBatch = await tx.query<{ batch_id: string | null }>(
          'SELECT batch_id FROM error_group_jobs WHERE id=$1',
          [job.id],
        );
        if (pendingBatch.rows[0]?.batch_id)
          await store.discardBatch(tx, pendingBatch.rows[0].batch_id);
        await tx.query(
          `UPDATE friction_tickets SET reconcile_needed=false WHERE id=$1`,
          [ticket.id],
        );
      }
      await completeTx(tx, job);
      return null;
    }
    const row = await tx.query<{ batch_id: string | null }>(
      `SELECT batch_id FROM error_group_jobs WHERE id=$1`,
      [job.id],
    );
    const batch = row.rows[0]!.batch_id
      ? await store.getBatch(tx, ticket.id, row.rows[0]!.batch_id!)
      : await store.selectBatch(tx, ticket, job.id);
    if (!batch) {
      await completeTx(tx, job);
      return null;
    }
    if (batch.job_id !== job.id)
      throw new Error('Confirmation batch belongs to another job');
    await tx.query(`UPDATE error_group_jobs SET batch_id=$2 WHERE id=$1`, [
      job.id,
      batch.id,
    ]);
    return { ticket, batch };
  });
  if (!initial) throw new db.JobCompletedInTransaction(job.id);
  const { ticket, batch } = initial;
  const meter = new PhaseMeter({
    jobId: job.id,
    execution: Number(job.leaseGeneration),
    phase: `friction_confirm:${batch.id}`,
  });
  const check = async () => {
    signal.throwIfAborted();
    await db.assertJobLease(job);
  };
  const client: ConfirmClient = {
    modelName: deps.client.modelName,
    complete: async (args) => {
      await check();
      return deps.client.complete({ ...args, signal });
    },
  };
  try {
    const staged = new Set(
      (
        await pool.query<{ session_id: string }>(
          'SELECT session_id FROM friction_check_attempts WHERE batch_id=$1',
          [batch.id],
        )
      ).rows.map((r) => r.session_id),
    );
    for (const member of batch.manifest) {
      if (staged.has(member.sessionId)) continue;
      await check();
      if (!(await store.batchIntact(pool, batch))) break;
      let result: ConfirmResult;
      let frames: Awaited<ReturnType<typeof captureFrames>> = {
        frames: [],
        assetsMissing: true,
      };
      let recording: Awaited<
        ReturnType<ConfirmJobDeps['loadRecording']>
      > | null = null;
      const context = {
        job_id: job.id,
        ticket_id: ticket.id,
        session_id: member.sessionId,
      };
      try {
        recording = await deps.loadRecording(
          member.sessionId,
          job.projectId,
          member.signalIds,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof db.LeaseLostError) throw error;
        // Only a missing recording is evidence about the recording. A database
        // or storage failure retries the job instead of counting toward the
        // permanent unavailable cap.
        const missing = error instanceof RecordingUnavailableError;
        logger.warn(
          missing
            ? 'Recording unavailable for confirmation'
            : 'Recording load failed; confirmation will retry',
          { ...context, error: safeErrorMessage(error) },
        );
        if (!missing) throw error;
      }
      if (recording) {
        await check();
        try {
          frames = await deps.capture(recording.envelopes, recording.offsetsMs, {
            maxOffsets: 4,
          });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof db.LeaseLostError) throw error;
          logger.warn('Replay capture failed for confirmation', {
            ...context,
            error: safeErrorMessage(error),
          });
        }
      }
      // The daily budget counts strong-model reads. A capture that produced no
      // frames is staged as unavailable without a model call, so it must not
      // consume a unit; reserving before capture let 94 unavailable attempts
      // exhaust a day's budget in a production replay.
      if (frames.frames.length > 0) {
        const budget = await transaction(job, signal, (tx) =>
          store.reserveConfirmationBudget(tx, job.projectId, deps.dailyCap),
        );
        if (!budget.reserved) {
          await db.rescheduleJob(job, budget.nextWindow);
          throw new db.JobRescheduledError(job.id);
        }
      }
      const signals = (
        await pool.query<{ id: string; what: string }>(
          `SELECT f.id,coalesce(f.observation_text,'') AS what FROM friction_signals f
        JOIN friction_ticket_match_observations o ON o.signal_id=f.id WHERE o.ticket_id=$1 AND o.session_id=$2 AND f.id=ANY($3::uuid[]) ORDER BY f.id`,
          [ticket.id, member.sessionId, member.signalIds],
        )
      ).rows;
      const input = {
        ticket: {
          name: ticket.name,
          control: ticket.control,
          what_happened: ticket.what_happened,
          kind: ticket.kind,
        },
        timelineText: recording?.timelineText ?? '',
        frames: frames.frames,
        framesOk: frames.frames.length > 0, // external assets are aborted by design; the DOM still renders
        assetsMissing: frames.assetsMissing,
        signals,
      };
      result = await confirmRead(client, input, meter);
      if ('invalid' in result) result = await confirmRead(client, input, meter);
      if ('invalid' in result)
        throw new Error(`Confirmation invalid: ${result.invalid}`);
      const validResult = result;
      const intact = await transaction(job, signal, async (tx) => {
        // Lock the ticket before checking the manifest to serialize with purges.
        await store.getTicket(tx, job.projectId, job.ticketId, true);
        if (!(await store.batchIntact(tx, batch))) return false;
        await store.stageCheck(tx, batch.id, {
          ...validResult,
          sessionId: member.sessionId,
          framesOk: input.framesOk,
          frameManifest: frames.frames.map(({ offsetMs, pair }) => ({
            offsetMs,
            pair,
            ...(frames.assetsMissing ? { assetsMissing: true } : {}),
          })),
          model: client.modelName,
        });
        await lockLease(tx, job);
        return true;
      });
      if (!intact) break;
    }
    await check();
    const plan = await prepareConfirmationTransition(
      pool,
      ticket,
      batch.id,
      client,
      meter,
    );
    await transaction(job, signal, async (tx) => {
      // This lock precedes every ticket lock in finalizers, including no-fold paths.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext('friction_publish|'||$1))`,
        [ticket.environment_id],
      );
      const current = await store.getTicket(tx, job.projectId, ticket.id, true);
      if (!current) {
        await completeTx(tx, job);
        return;
      }
      const live = await store.liveIncident(tx, current);
      if (
        !confirmationBatchCurrent(current, batch, plan, live) ||
        !(await store.batchIntact(tx, batch))
      ) {
        await store.discardBatch(tx, batch.id);
        if (current.status === 'merged' || current.status === 'archived')
          await tx.query(
            `UPDATE friction_tickets SET reconcile_needed=false WHERE id=$1`,
            [current.id],
          );
        await completeTx(tx, job);
        return;
      }
      const final = await store.finalizeBatch(tx, current, batch.id);
      if (final.finalized) {
        current.evidence_version = final.evidenceVersion;
        await applyConfirmationTransition(tx, current, plan);
      }
      await completeTx(tx, job);
      const updated = await store.getTicket(tx, job.projectId, ticket.id);
      if (updated && !['merged', 'archived'].includes(updated.status)) {
        const next = await store.nextConfirmationAt(tx, ticket.id);
        if (next)
          await db.enqueueJobTx(tx, 'friction_confirm', job.projectId, {
            ticketId: ticket.id,
            availableAt: next,
          });
      }
    });
    throw new db.JobCompletedInTransaction(job.id);
  } finally {
    await meter.flush();
  }
}

/** Lazy provider construction keeps unavailable recordings independent of keys. */
export function frictionConfirmDepsFromEnv(): ConfirmJobDeps {
  const modelName = process.env['FRICTION_CONFIRM_MODEL'] || 'claude-sonnet-5';
  const cap = Number(process.env['FRICTION_CONFIRM_DAILY_CAP'] ?? 2000);
  return {
    client: {
      modelName,
      complete: async (args) => {
        const apiKey =
          process.env['NARRATIVE_API_KEY'] || process.env['ANTHROPIC_API_KEY'];
        if (!apiKey)
          throw new Error(
            'Confirmation requires NARRATIVE_API_KEY or ANTHROPIC_API_KEY',
          );
        return new NarrativeClient({
          model: modelName,
          apiKey,
          maxTokens: 8192,
          reasoning: 'off',
          baseURL:
            process.env['NARRATIVE_BASE_URL'] ||
            process.env['ANTHROPIC_BASE_URL'] ||
            undefined,
        }).complete(args);
      },
    },
    dailyCap: Number.isSafeInteger(cap) && cap >= 0 ? cap : 2000,
    capture: captureFrames,
    loadRecording: async (sessionId, projectId, signalIds) => {
      const result = await db
        .getPool()
        .query<{
          timeline: CompactTimeline;
        }>(`SELECT n.timeline FROM session_narratives n JOIN sessions s ON s.id=n.session_id AND s.project_id=n.project_id AND s.environment_id=n.environment_id WHERE n.session_id=$1 AND n.project_id=$2 AND n.status='ok'`, [sessionId, projectId]);
      const timeline = result.rows[0]?.timeline;
      if (!timeline || !Array.isArray(timeline.lines))
        throw new RecordingUnavailableError('Recording timeline unavailable');
      const chunks = await db.getScrubbedChunksForSession(sessionId, projectId);
      // Corrupt chunk data counts as unreadable; a storage fetch failure throws.
      const read = await readChunksBounded(chunks, { skipUnreadable: true });
      if (!read.envelopes.length || read.truncated || read.unreadableCount)
        throw new RecordingUnavailableError(
          'Recording chunks unavailable or incomplete',
        );
      const anchors = await db
        .getPool()
        .query<{
          evidence_lines: string[] | null;
        }>(`SELECT evidence_lines FROM friction_signals WHERE id=ANY($1::uuid[]) AND session_id=$2 AND project_id=$3 ORDER BY id`, [signalIds, sessionId, projectId]);
      const cited = anchors.rows.flatMap((row) =>
        (row.evidence_lines ?? []).flatMap((line) => {
          const index = /^L(\d+)$/.exec(line);
          const entry = index
            ? timeline.lines[Number(index[1]) - 1]
            : undefined;
          return entry && entry.a !== null && entry.k !== 'idle'
            ? [Math.max(0, entry.a - timeline.startTs)]
            : [];
        }),
      );
      const moments = [
        ...new Set(
          cited.length
            ? cited
            : timeline.lines.flatMap((line) =>
                line.a === null || line.k === 'idle'
                  ? []
                  : [Math.max(0, line.a - timeline.startTs)],
              ),
        ),
      ];
      const offsetsMs =
        moments.length <= 4
          ? moments
          : [0, 1, 2, 3].map(
              (i) => moments[Math.floor((i * (moments.length - 1)) / 3)]!,
            );
      return {
        timelineText: timeline.lines
          .map((line, i) => `L${i + 1}: ${line.t}`)
          .join('\n'),
        offsetsMs: offsetsMs.length ? offsetsMs : [0],
        envelopes: read.envelopes,
      };
    },
  };
}
