import type { FrictionCategory } from '@opslane/shared';
import type pg from 'pg';
import type { SessionRow } from '../db.js';
import { NARRATIVE_RULE_VERSION } from '../narrative/emit.js';

export interface ObservationSignalRow {
  signalType: FrictionCategory;
  fingerprint: string;
  elementSelector: string | null;
  pageUrlNormalized: string;
  occurredAts: number[];
  occurrenceCount: number;
  what: string;
  severity: 'low' | 'medium' | 'high';
}

export async function writeObservationSignals(
  client: pg.PoolClient,
  session: SessionRow,
  rows: ObservationSignalRow[],
): Promise<string[]> {
  const written: string[] = [];
  for (const row of rows) {
    const occurredAt = row.occurredAts[0] ?? Date.parse(session.started_at);
    const result = await client.query<{ fingerprint: string }>(
      `INSERT INTO friction_signals
         (session_id, project_id, environment_id, end_user_id, rule_version,
          signal_type, fingerprint, element_selector, page_url_normalized,
          occurred_at, occurred_ats, occurrence_count, adjudication_status,
          adjudicated_at, observation_text, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0),$11::jsonb,$12,
               'accepted',now(),$13,$14)
       ON CONFLICT (session_id, fingerprint, rule_version) DO NOTHING
       RETURNING fingerprint`,
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
        row.severity,
      ],
    );
    if (result.rows[0]) written.push(result.rows[0].fingerprint);
  }
  return [...new Set(written)];
}
