import type { Pool } from 'pg';

/** Remove the RESTRICT-FK audit rows before test teardown deletes fix jobs. */
export async function purgeFixRunLedger(pool: Pool, projectId: string): Promise<void> {
  await pool.query('DELETE FROM fix_run_ledger WHERE project_id = $1', [projectId]);
}
