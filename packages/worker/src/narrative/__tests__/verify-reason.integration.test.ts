import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, finalizeVerification, type ClaimedJob } from '../../db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('finalizeVerification stores a bounded verification reason', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const sessionId = `verif-reason-${crypto.randomUUID()}`;
  let orgId: string;
  let projectId: string;
  let environmentId: string;
  let job: ClaimedJob;

  async function claimFreshJob(): Promise<ClaimedJob> {
    const workerId = `worker-${crypto.randomUUID()}`;
    const row = (await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (project_id, job_type, session_id, status, worker_id, lease_generation,
          claimed_at, lease_expires_at)
       VALUES ($1, 'session_verify_frames', $2, 'claimed', $3, 1, now(), now() + interval '10 minutes')
       RETURNING id, lease_generation::text AS lease_generation`,
      [projectId, sessionId, workerId],
    )).rows[0]!;
    return {
      id: row.id,
      projectId,
      workerId,
      leaseGeneration: row.lease_generation,
      sessionId,
    } as unknown as ClaimedJob;
  }

  async function resetToVerifying(): Promise<void> {
    await pool.query(
      `UPDATE session_narratives SET verification_state = 'verifying', verification = NULL
       WHERE session_id = $1`,
      [sessionId],
    );
  }

  async function storedReason(): Promise<string | null> {
    const { rows } = await pool.query<{ verification_reason: string | null }>(
      `SELECT verification_reason FROM session_narratives WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0]!.verification_reason;
  }

  beforeAll(async () => {
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [`verif-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, 'verif') RETURNING id`, [orgId],
    )).rows[0]!.id;
    environmentId = (await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, [projectId],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
       VALUES ($1,$2,$3,'2026-08-01T00:00:00Z','analyzed')`,
      [sessionId, projectId, environmentId],
    );
    await pool.query(
      `INSERT INTO session_narratives
         (session_id, project_id, environment_id, status, narrative, timeline,
          prompt_version, verification_state)
       VALUES ($1,$2,$3,'ok','{"userGoal":"g","narrative":"n","notable":false,"observations":[]}'::jsonb,
               '{"startTs":0,"lines":[]}'::jsonb, 1, 'verifying')`,
      [sessionId, projectId, environmentId],
    );
    job = await claimFreshJob();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM session_narratives WHERE session_id = $1`, [sessionId]);
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    await pool.query(`DELETE FROM environments WHERE id = $1`, [environmentId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  it('sanitizes and bounds a huge reason, and a later success clears it', async () => {
    // Chromium and provider failures arrive with control characters and
    // kilobytes of path noise; neither may reach the column or a UI.
    const noisy = `chromium\u0000 crashed\u0007: SIGTRAP\u2028${'x'.repeat(2_000)}`;
    await finalizeVerification(job, {
      sessionId,
      projectId,
      state: 'failed',
      claimedPromptVersion: 1,
      reason: noisy,
      signalRows: [],
    });
    const stored = await storedReason();
    expect(stored).not.toBeNull();
    expect(stored).toHaveLength(500);
    expect(stored).toContain('chromium crashed: SIGTRAP');
    expect(stored).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/);

    await resetToVerifying();
    job = await claimFreshJob();
    await finalizeVerification(job, {
      sessionId,
      projectId,
      state: 'ok',
      claimedPromptVersion: 1,
      verification: { grades: [], frames: [] },
      signalRows: [],
    });
    expect(await storedReason()).toBeNull();
  });
});
