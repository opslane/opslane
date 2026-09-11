import type pg from 'pg';
import type { SessionRow } from '../db.js';
import { NARRATIVE_RULE_VERSION } from '../narrative/emit.js';

export interface ObservationSignalRow {
  signalType: 'narrative';
  observationId: string;
  narrativeId: string;
  evidenceLines: string[];
  fingerprint: string;
  elementSelector: string | null;
  pageUrlNormalized: string;
  occurredAts: number[];
  occurrenceCount: number;
  what: string;
  severity?: 'low' | 'medium' | 'high';
}

export async function writeObservationSignals(
  client: pg.PoolClient,
  session: SessionRow,
  rows: ObservationSignalRow[],
): Promise<Array<{ signalId: string; observationId: string }>> {
  const written: Array<{ signalId: string; observationId: string }> = [];
  for (const row of rows) {
    const occurredAt = row.occurredAts[0] ?? Date.parse(session.started_at);
    const result = await client.query<{ id: string; observation_id: string }>(
      `INSERT INTO friction_signals
         (session_id, project_id, environment_id, end_user_id, rule_version,
          signal_type, fingerprint, element_selector, page_url_normalized,
          occurred_at, occurred_ats, occurrence_count, adjudication_status,
          adjudicated_at, observation_text, severity, observation_id, narrative_id, evidence_lines)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0),$11::jsonb,$12,
               'accepted',now(),$13,$14,$15,$16,$17::jsonb)
       ON CONFLICT (session_id, narrative_id, observation_id) WHERE observation_id IS NOT NULL DO NOTHING
       RETURNING id, observation_id`,
      [
        session.id,
        session.project_id,
        session.environment_id,
        session.end_user_id,
        NARRATIVE_RULE_VERSION,
        row.signalType,
        row.fingerprint,
        row.elementSelector,
        row.pageUrlNormalized,
        occurredAt,
        JSON.stringify(row.occurredAts),
        row.occurrenceCount,
        row.what,
        row.severity ?? null,
        row.observationId,
        row.narrativeId,
        JSON.stringify(row.evidenceLines),
      ],
    );
    // A second statement sees a concurrent winner after INSERT has waited for it.
    const stored = result.rows[0] ?? (await client.query<{ id: string; observation_id: string }>(
      `SELECT id, observation_id FROM friction_signals
       WHERE session_id = $1 AND narrative_id = $2 AND observation_id = $3 AND project_id = $4`,
      [session.id, row.narrativeId, row.observationId, session.project_id],
    )).rows[0];
    if (!stored) throw new Error(`Observation signal ${row.observationId} missing after insert`);
    written.push({ signalId: stored.id, observationId: stored.observation_id });
  }
  return written;
}
