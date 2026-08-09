import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, recordJobUsage } from '../db.js';
import { purgeJobUsage } from './purge-job-usage.js';

describe.skipIf(!process.env['DATABASE_URL'])('recordJobUsage', () => {
  let orgId: string;
  let projectId: string;
  const jobIds: string[] = [];

  beforeAll(async () => {
    const org = await getPool().query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`job-usage-${crypto.randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    const project = await getPool().query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, $2, 'test/repo') RETURNING id`,
      [orgId, `job-usage-${crypto.randomUUID()}`],
    );
    projectId = project.rows[0]!.id;
  });

  afterAll(async () => {
    await purgeJobUsage(getPool(), jobIds);
    await getPool().query('DELETE FROM error_group_jobs WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM error_groups WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await getPool().query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await closePool();
  });

  async function createFixtureJob(): Promise<string> {
    const group = await getPool().query<{ id: string }>(
      `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen)
       VALUES ($1, $2, 'usage test', now(), now()) RETURNING id`,
      [projectId, `usage-${crypto.randomUUID()}`],
    );
    const job = await getPool().query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id) VALUES ($1, $2) RETURNING id`,
      [group.rows[0]!.id, projectId],
    );
    jobIds.push(job.rows[0]!.id);
    return job.rows[0]!.id;
  }

  it('inserts once and is idempotent per job execution, phase, and model', async () => {
    const jobId = await createFixtureJob();
    const entry = {
      jobId,
      execution: 0,
      phase: 'investigation' as const,
      model: 'claude-sonnet-5',
      usage: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 200 },
      costUsd: 0.0731,
    };
    await recordJobUsage(entry);
    await recordJobUsage(entry);

    const { rows } = await getPool().query(
      `SELECT execution, phase, model, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd::float8 AS cost_usd
       FROM job_usage WHERE job_id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      execution: 0,
      phase: 'investigation',
      model: 'claude-sonnet-5',
      input_tokens: '1200',
      output_tokens: '340',
      cache_read_tokens: '9000',
      cache_write_tokens: '200',
      cost_usd: 0.0731,
    });
  });

  it('swallows insert failures', async () => {
    await expect(recordJobUsage({
      jobId: '00000000-0000-4000-8000-000000000000',
      execution: 0,
      phase: 'fix',
      model: 'claude-sonnet-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.0001,
    })).resolves.toBeUndefined();
  });
});
