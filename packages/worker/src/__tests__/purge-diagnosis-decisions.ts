import type { Pool } from 'pg';

/**
 * Reset `diagnosis_decisions` for one project, which needs the immutability
 * trigger off for the statement.
 *
 * Migration 034 makes the table insert-only with a `BEFORE UPDATE OR DELETE`
 * row trigger, so a plain `DELETE` raises `2F004` — but only once a row
 * matches. A row-level trigger does not fire on an empty match, so a bare
 * `DELETE FROM diagnosis_decisions` in teardown passes for as long as the suite
 * never persists a decision, and starts failing the moment it does. Three
 * teardowns on this branch were written that way and were green only because
 * they had not yet reached a decision-writing path.
 *
 * Test setup only, and deliberately loud about it: production has no route to
 * disable this trigger, which is the property the table exists to have.
 */
export async function purgeDiagnosisDecisions(pool: Pool, projectId: string): Promise<void> {
  await pool.query('ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row');
  try {
    await pool.query('DELETE FROM diagnosis_decisions WHERE project_id = $1', [projectId]);
  } finally {
    await pool.query('ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row');
  }
}
