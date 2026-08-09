import type pg from 'pg';

/**
 * Test-only: job_usage is insert-only by trigger, but integration tests must
 * remove their fixtures. Never use this trigger bypass in product code.
 */
export async function purgeJobUsage(pool: pg.Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE job_usage DISABLE TRIGGER job_usage_immutable_row');
    await client.query('DELETE FROM job_usage WHERE job_id = ANY($1::uuid[])', [jobIds]);
  } finally {
    try {
      await client.query('ALTER TABLE job_usage ENABLE TRIGGER job_usage_immutable_row');
    } finally {
      client.release();
    }
  }
}
