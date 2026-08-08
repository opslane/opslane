import { getPool, type SessionRow } from '../db.js';
import type { DetectedSignal } from './analyzer.js';
import { recomputeIncidentImpact } from './promotion-db.js';

/** Writes one whole-session analysis pass at a single rule version. */
export async function writeFrictionSignals(
  session: SessionRow,
  signals: DetectedSignal[],
  ruleVersion: number,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Signals may already be attached from an earlier analysis pass. Lock all
    // affected groups in deterministic UUID order before changing source rows,
    // then rebuild each group exactly once from the final source snapshot.
    const attached = await client.query<{ incident_id: string }>(
      `SELECT DISTINCT incident_id
       FROM friction_signals
       WHERE session_id = $1 AND project_id = $2
         AND incident_id IS NOT NULL
       ORDER BY incident_id`,
      [session.id, session.project_id],
    );
    const affectedIncidents = [...new Set(
      attached.rows.flatMap((row) => row.incident_id ? [row.incident_id] : []),
    )].sort();
    if (affectedIncidents.length > 0) {
      await client.query(
        `SELECT id FROM error_groups
         WHERE project_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [session.project_id, affectedIncidents],
      );
    }
    for (const signal of signals) {
      await client.query(
        `INSERT INTO friction_signals
           (session_id, project_id, environment_id, end_user_id, rule_version,
            signal_type, fingerprint, element_selector, page_url_normalized,
            occurred_at, occurred_ats, occurrence_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0),$11::jsonb,$12)
         ON CONFLICT (session_id, fingerprint, rule_version)
         DO UPDATE SET occurrence_count = EXCLUDED.occurrence_count,
                       occurred_at = EXCLUDED.occurred_at,
                       occurred_ats = EXCLUDED.occurred_ats,
                       retracted_at = NULL`,
        [
          session.id,
          session.project_id,
          session.environment_id,
          session.end_user_id,
          ruleVersion,
          signal.signalType,
          signal.fingerprint,
          signal.elementSelector,
          signal.pageUrlNormalized,
          signal.occurredAt,
          JSON.stringify(signal.occurredAts),
          signal.occurrenceCount,
        ],
      );
    }

    await client.query(
      `UPDATE friction_signals old SET superseded_by = new.id
       FROM friction_signals new
       WHERE old.session_id = $1 AND old.project_id = $2
         AND old.rule_version < $3
         AND old.retracted_at IS NULL AND old.superseded_by IS NULL
         AND new.session_id = old.session_id AND new.project_id = old.project_id
         AND new.fingerprint = old.fingerprint AND new.rule_version = $3`,
      [session.id, session.project_id, ruleVersion],
    );
    await client.query(
      `UPDATE friction_signals SET retracted_at = now()
       WHERE session_id = $1 AND project_id = $2
         AND rule_version < $3
         AND retracted_at IS NULL AND superseded_by IS NULL`,
      [session.id, session.project_id, ruleVersion],
    );

    await client.query(
      `UPDATE friction_signals SET retracted_at = now()
       WHERE session_id = $1 AND project_id = $2 AND rule_version = $3
         AND retracted_at IS NULL AND superseded_by IS NULL
         AND fingerprint <> ALL($4::text[])`,
      [session.id, session.project_id, ruleVersion, signals.map((signal) => signal.fingerprint)],
    );
    for (const incidentId of affectedIncidents) {
      await recomputeIncidentImpact(client, incidentId, session.project_id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
