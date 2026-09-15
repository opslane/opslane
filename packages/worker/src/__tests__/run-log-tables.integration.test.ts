import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db.js';

describe.skipIf(!process.env['DATABASE_URL'])('agent run log tables', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    const org = await getPool().query<{ id: string }>(`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [`runlog-${crypto.randomUUID()}`]);
    orgId = org.rows[0]!.id;
    const project = await getPool().query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, $2) RETURNING id`, [orgId, `runlog-${crypto.randomUUID()}`]);
    projectId = project.rows[0]!.id;
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM agent_run_started WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM error_group_jobs WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await getPool().query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await closePool();
  });

  async function insertJob(status: 'claimed' | 'completed', leaseGeneration: number, expiresInSeconds: number): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO error_group_jobs (project_id, job_type, status, worker_id, lease_generation, lease_expires_at)
       VALUES ($1, 'session_narrate', $2, 'w1', $3, now() + make_interval(secs => $4)) RETURNING id`,
      [projectId, status, leaseGeneration, expiresInSeconds]);
    return rows[0]!.id;
  }

  async function insertStarted(jobId: string, leaseGeneration: number): Promise<string> {
    const runId = crypto.randomUUID();
    await getPool().query(
      `INSERT INTO agent_run_started (run_id, job_id, job_type, project_id, phase, entry_point, attempts, lease_generation,
         object_prefix, models, worker_build_sha, bundle_written, bundle_bytes, recorded_at)
       VALUES ($1, $2, 'session_narrate', $3, 'narrate', 'narrative/job#processNarration', 0, $4,
         $5, ARRAY['claude-sonnet-5'], 'abc', true, 120, now())`,
      [runId, jobId, projectId, leaseGeneration, `agent-runs/${projectId}/2026-09-15/${runId}/`]);
    return runId;
  }

  async function stopOf(runId: string): Promise<string> {
    const { rows } = await getPool().query<{ stop: string }>(`SELECT stop FROM agent_runs_v WHERE run_id = $1`, [runId]);
    return rows[0]!.stop;
  }

  it('derives running, unfinished and finished stops from the lease', async () => {
    const live = await insertStarted(await insertJob('claimed', 7, 300), 7);
    const expired = await insertStarted(await insertJob('claimed', 7, -5), 7);
    const reclaimed = await insertStarted(await insertJob('claimed', 8, 300), 7);
    const done = await insertStarted(await insertJob('completed', 7, -5), 7);
    const missingJob = await insertStarted(crypto.randomUUID(), 1);
    const finished = await insertStarted(await insertJob('claimed', 3, 300), 3);
    await getPool().query(
      `INSERT INTO agent_run_finished (run_id, stop, model_requests, turns, usage, cost_usd, transcript_written, transcript_bytes, finished_at)
       VALUES ($1, 'invalid_output', 2, 2, '{}'::jsonb, 0.01, true, 900, now())`, [finished]);

    expect(await stopOf(live)).toBe('running');
    expect(await stopOf(expired)).toBe('unfinished');
    expect(await stopOf(reclaimed)).toBe('unfinished');
    expect(await stopOf(done)).toBe('unfinished');
    expect(await stopOf(missingJob)).toBe('unfinished');
    expect(await stopOf(finished)).toBe('invalid_output');
  });

  it('rejects UPDATE on both tables and allows DELETE with cascade', async () => {
    const runId = await insertStarted(crypto.randomUUID(), 1);
    await getPool().query(
      `INSERT INTO agent_run_finished (run_id, stop, model_requests, turns, usage, cost_usd, transcript_written, transcript_bytes, finished_at)
       VALUES ($1, 'completed', 1, 1, '{}'::jsonb, 0, true, 10, now())`, [runId]);
    await expect(getPool().query(`UPDATE agent_run_started SET phase = 'x' WHERE run_id = $1`, [runId])).rejects.toThrow(/insert-only/);
    await expect(getPool().query(`UPDATE agent_run_finished SET stop = 'threw' WHERE run_id = $1`, [runId])).rejects.toThrow(/insert-only/);
    await getPool().query(`DELETE FROM agent_run_started WHERE run_id = $1`, [runId]);
    const { rows } = await getPool().query(`SELECT 1 FROM agent_run_finished WHERE run_id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });

  it('rejects TRUNCATE on both tables', async () => {
    const client = await getPool().connect();
    try {
      for (const statement of ['TRUNCATE agent_run_finished', 'TRUNCATE agent_run_started CASCADE']) {
        await client.query('BEGIN');
        try {
          await expect(client.query(statement)).rejects.toThrow(/insert-only/);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });
});
