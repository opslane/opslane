import type pg from 'pg';
import type { FrameVerification, SessionNarrative } from '@opslane/shared';
import * as db from '../db.js';
import {
  embedTexts,
  EmbeddingsUnavailable,
  ticketText,
} from '../embeddings.js';
import { PhaseMeter } from '../metered.js';
import { NarrativeClient } from '../narrative/client.js';
import {
  buildSignalRows,
  deriveNarrativeId,
  type CompactTimeline,
} from '../narrative/emit.js';
import { gradedObservations } from '../narrative/verify.js';
import { normalizePageUrl } from './fingerprint.js';
import { firstLook, type FirstLookDecision } from './first-look.js';
import { matchObservations, type MatchedObservationDecision } from './match.js';
import { writeObservationSignals } from './persist.js';
import * as tickets from './tickets-db.js';

export interface MatchJobDeps {
  cheap: Pick<NarrativeClient, 'complete' | 'modelName'>;
  strong: Pick<NarrativeClient, 'complete' | 'modelName'>;
  embed?: typeof embedTexts;
}
/** Lazily construct providers so empty/completed narratives need no model key. */
export function frictionMatchDepsFromEnv(): MatchJobDeps {
  const client = (modelName: string): MatchJobDeps['cheap'] => ({
    modelName,
    complete: async (args) => {
      const apiKey =
        process.env['NARRATIVE_API_KEY'] || process.env['ANTHROPIC_API_KEY'];
      if (!apiKey)
        throw new Error(
          'Friction matching requires NARRATIVE_API_KEY or ANTHROPIC_API_KEY',
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
  });
  return {
    cheap: client(
      process.env['FRICTION_MATCH_MODEL'] || 'claude-haiku-4-5-20251001',
    ),
    strong: client(
      process.env['FRICTION_FIRST_LOOK_MODEL'] || 'claude-sonnet-5',
    ),
  };
}

type MatchJob = db.ClaimedJob & { sessionId: string };
type Decision = MatchedObservationDecision | FirstLookDecision;

/** Invalid responses are retried once, before any decision state is persisted. */
async function validated<T>(
  phase: string,
  call: () => Promise<{ decisions: T[] } | { invalid: string }>,
): Promise<T[]> {
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call();
    if ('decisions' in result) return result.decisions;
    reason = result.invalid;
  }
  throw new Error(
    `${phase}: invalid response after two attempts: ${reason.slice(0, 300)}`,
  );
}

async function lockLease(client: pg.PoolClient, job: MatchJob): Promise<void> {
  const result = await client.query(
    `SELECT id FROM error_group_jobs WHERE id=$1 AND worker_id=$2 AND lease_generation=$3::bigint
      AND project_id=$4 AND session_id=$5 AND error_group_id IS NOT DISTINCT FROM $6::uuid
      AND job_type='friction_match' AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [
      job.id,
      job.workerId,
      job.leaseGeneration,
      job.projectId,
      job.sessionId,
      job.errorGroupId,
    ],
  );
  if (!result.rowCount) throw new db.LeaseLostError(job.id);
}

/** All model work precedes the fenced transaction. Only observation rows and
 * immutable usage can survive an invalid response or a lost lease. */
export async function processFrictionMatch(
  job: MatchJob,
  deps: MatchJobDeps,
  signal: AbortSignal,
): Promise<void> {
  const pool = db.getPool();
  const check = async () => {
    signal.throwIfAborted();
    await db.assertJobLease(job);
  };
  const abortable = (client: MatchJobDeps['cheap']): MatchJobDeps['cheap'] => ({
    modelName: client.modelName,
    complete: (args) => client.complete({ ...args, signal }),
  });
  await check();
  const loaded = await pool.query<{
    session: db.SessionRow;
    project_name: string;
    narrative: SessionNarrative;
    timeline: CompactTimeline;
    verification: FrameVerification | null;
    verification_state: string;
    created_at: string;
    prompt_version: number;
  }>(
    `SELECT jsonb_build_object('id',s.id,'project_id',s.project_id,'environment_id',s.environment_id,
      'end_user_id',s.end_user_id,'status',s.status,'started_at',s.started_at::text,'chunk_count',s.chunk_count) AS session,
      p.name AS project_name,n.narrative,n.timeline,n.verification,n.verification_state,n.created_at::text,n.prompt_version
    FROM sessions s JOIN projects p ON p.id=s.project_id
    JOIN session_narratives n ON n.session_id=s.id AND n.project_id=s.project_id AND n.environment_id=s.environment_id
    WHERE s.id=$1 AND s.project_id=$2 AND n.status='ok'
      AND n.verification_state IN ('ok','failed','unsupported','skipped_budget')`,
    [job.sessionId, job.projectId],
  );
  const row = loaded.rows[0];
  if (!row)
    throw new Error('Friction match requires a scoped, finalized narrative');
  if (
    !Array.isArray(row.narrative?.observations) ||
    !Array.isArray(row.timeline?.lines)
  )
    throw new Error('Friction match narrative or timeline is invalid');
  const scope = {
    projectId: job.projectId,
    environmentId: row.session.environment_id,
  };
  const narrativeId = deriveNarrativeId(
    job.sessionId,
    row.created_at,
    row.prompt_version,
  );
  const framesOk =
    row.verification_state === 'ok' &&
    Array.isArray(row.verification?.frames) &&
    row.verification.frames.length > 0;
  const observations = gradedObservations(
    row.narrative,
    row.verification?.grades ?? [],
    { framesOk },
  );
  const signalRows = buildSignalRows(
    row.timeline,
    observations,
    job.sessionId,
    narrativeId,
  );
  const client = await pool.connect();
  let written: Awaited<ReturnType<typeof writeObservationSignals>>;
  try {
    written = await writeObservationSignals(client, row.session, signalRows);
  } finally {
    client.release();
  }
  const committed = await pool.query<{ signal_id: string }>(
    `SELECT signal_id FROM friction_observation_decisions
    WHERE project_id=$1 AND environment_id=$2 AND session_id=$3 AND decision<>'reserved'`,
    [job.projectId, scope.environmentId, job.sessionId],
  );
  const completed = new Set(committed.rows.map((r) => r.signal_id));
  const pending = written.filter((r) => !completed.has(r.signalId));
  const pendingIds = new Set(pending.map((r) => r.observationId));
  const surviving = observations.filter((o) => pendingIds.has(o.id));
  const signals = new Map(written.map((r) => [r.observationId, r.signalId]));
  const screens = [
    ...new Set(
      row.timeline.lines
        .map((line) => normalizePageUrl(line.r))
        .filter(Boolean),
    ),
  ];
  const execution = Number(job.leaseGeneration);
  const cheapMeter = new PhaseMeter({
    jobId: job.id,
    execution,
    phase: 'friction_match',
  });
  const strongMeter = new PhaseMeter({
    jobId: job.id,
    execution,
    phase: 'friction_first_look',
  });
  const embeddingMeter = new PhaseMeter({
    jobId: job.id,
    execution,
    phase: 'embeddings',
  });
  const embed = async (texts: string[]): Promise<Array<number[] | null>> => {
    if (!texts.length) return [];
    await check();
    try {
      return (await (deps.embed ?? embedTexts)(texts, embeddingMeter, signal))
        .vectors;
    } catch (error) {
      if (error instanceof EmbeddingsUnavailable) return texts.map(() => null);
      throw error;
    }
  };
  try {
    let decisions: Decision[] = [];
    const finalVectors = new Map<string, number[] | null>();
    if (surviving.length) {
      const vectors = await embed(surviving.map((o) => o.what));
      const candidates = new Map<string, tickets.TicketRow>();
      for (const vector of vectors)
        for (const ticket of await tickets.shortlistTickets(
          pool,
          scope,
          screens,
          vector,
        ))
          candidates.set(ticket.id, ticket);
      const context = {
        projectName: row.project_name,
        screens,
        timelineText: row.timeline.lines
          .map((line, i) => `L${i + 1}: ${line.t}`)
          .join('\n'),
      };
      const cheap = await validated('friction_match', async () => {
        await check();
        return matchObservations(
          abortable(deps.cheap),
          {
            ...context,
            observations: surviving,
            candidates: [...candidates.values()],
          },
          cheapMeter,
        );
      });
      const drafts = cheap.filter((d) => d.kind === 'draft');
      decisions = cheap.filter((d) => d.kind === 'matched');
      if (drafts.length) {
        const draftVectors = await embed(
          drafts.map((d) =>
            ticketText({ ...d.draft, what_happened: d.observationWhat }),
          ),
        );
        const nearestPerDraft: Record<string, tickets.TicketRow[]> = {};
        for (const [i, draft] of drafts.entries()) {
          const vector = draftVectors[i];
          nearestPerDraft[draft.observationId] = vector
            ? await tickets.nearestTickets(pool, scope, vector)
            : await tickets.shortlistTickets(pool, scope, screens, null);
        }
        const strong = await validated('friction_first_look', async () => {
          await check();
          return firstLook(
            abortable(deps.strong),
            { ...context, drafts, nearestPerDraft },
            strongMeter,
          );
        });
        decisions.push(...strong);
        const creates = strong.filter((d) => d.kind === 'create');
        const embeddings = await embed(
          creates.map((d) => ticketText(d.ticket)),
        );
        creates.forEach((d, i) =>
          finalVectors.set(d.observationId, embeddings[i] ?? null),
        );
      }
    }
    await check();
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await lockLease(tx, job);
      const touched = new Map<string, tickets.TicketRow>();
      // Stable signal ordering avoids competing reservations taking inverted locks.
      for (const decision of decisions.sort((a, b) =>
        signals
          .get(a.observationId)!
          .localeCompare(signals.get(b.observationId)!),
      )) {
        const signalId = signals.get(decision.observationId)!;
        const reservation = await tickets.reserveDecision(tx, signalId, scope);
        let ticket: tickets.TicketRow | undefined;
        let source: 'cheap' | 'strong' =
          decision.kind === 'matched' ? 'cheap' : 'strong';
        if (!reservation.reserved) {
          if (
            !reservation.existing ||
            reservation.existing.decision === 'reserved'
          )
            throw new Error(
              'Observation decision is reserved; retry after its owner completes',
            );
          if (!reservation.existing.ticket_id) continue;
          ticket = await tickets.resolveMatchTicket(
            tx,
            scope,
            reservation.existing.ticket_id,
          );
          source =
            reservation.existing.decided_by === 'cheap' ? 'cheap' : 'strong';
        } else {
          if (decision.kind === 'create')
            ticket = await tickets.createTicket(
              tx,
              { ...scope, ...decision.ticket },
              finalVectors.get(decision.observationId),
            );
          else if (decision.kind !== 'not_a_problem')
            ticket = await tickets.resolveMatchTicket(
              tx,
              scope,
              decision.ticketId,
            );
          if (
            !(await tickets.commitDecision(tx, signalId, {
              decision:
                decision.kind === 'create'
                  ? 'created'
                  : decision.kind === 'not_a_problem'
                    ? 'not_a_problem'
                    : 'matched',
              ticketId: ticket?.id,
              decidedBy: source,
            }))
          )
            throw new Error('Observation decision could not be committed');
        }
        if (!ticket) continue;
        const backfill =
          typeof job.payload === 'object' &&
          job.payload !== null &&
          'backfill' in job.payload &&
          job.payload.backfill === true;
        await tickets.recordMatch(tx, {
          ticket,
          sessionId: job.sessionId,
          endUserId: row.session.end_user_id,
          occurredAt: row.session.started_at,
          source: backfill ? 'backfill' : source,
          signalIds: [signalId],
          screen:
            signalRows.find((r) => r.observationId === decision.observationId)
              ?.pageUrlNormalized ?? '',
        });
        touched.set(ticket.id, ticket);
      }
      for (const ticket of touched.values()) {
        const current = await tickets.resolveMatchTicket(tx, scope, ticket.id);
        if (
          current.matched_count >= 3 &&
          (current.arrival_boundary === 0n ||
            current.next_arrival_number - current.arrival_boundary >= 10n)
        )
          await db.enqueueJobTx(tx, 'friction_confirm', job.projectId, {
            ticketId: current.id,
          });
      }
      await tx.query(
        `INSERT INTO friction_session_processed(project_id,session_id,narrative_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [job.projectId, job.sessionId, narrativeId],
      );
      signal.throwIfAborted();
      await lockLease(tx, job);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  } finally {
    await Promise.all([
      cheapMeter.flush(),
      strongMeter.flush(),
      embeddingMeter.flush(),
    ]);
  }
}
