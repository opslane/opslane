import pg from 'pg';
import { deriveNarrativeId } from '../emit.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimVerifyingNarrative, closePool, finalizeVerification, sweepNarratives, type ClaimedJob } from '../../db.js';

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
    await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM environments WHERE id = $1`, [environmentId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  it('claims a deterministic identity using the stored version and full timestamp precision', async () => {
    const createdAt = '2026-09-11 12:34:56.123456+00';
    await pool.query(
      `UPDATE session_narratives SET verification_state = 'pending', created_at = $2::timestamptz
       WHERE session_id = $1`, [sessionId, createdAt],
    );
    const claimed = await claimVerifyingNarrative(sessionId, projectId);
    expect(claimed).toMatchObject({ narrativeId: deriveNarrativeId(sessionId, createdAt, 1) });
  });

  it('rolls back both verification and the match handoff when evidence cannot be written', async () => {
    await resetToVerifying();
    const count = await pool.query(`SELECT count(*)::int AS n FROM error_group_jobs WHERE project_id=$1 AND job_type='friction_match'`,[projectId]);
    await expect(finalizeVerification(job, {
      sessionId,projectId,state:'failed',claimedPromptVersion:1,verifyPromptVersion:1,
      signalRows:[{signalType:'narrative',observationId:'o1',narrativeId:'bad-uuid',evidenceLines:['L1'],
        fingerprint:null as unknown as string,elementSelector:null,pageUrlNormalized:'/',occurredAts:[1],occurrenceCount:1,what:'Error shown'}],
    })).rejects.toThrow();
    expect((await pool.query('SELECT verification_state FROM session_narratives WHERE session_id=$1',[sessionId])).rows[0].verification_state).toBe('verifying');
    expect((await pool.query(`SELECT count(*)::int AS n FROM error_group_jobs WHERE project_id=$1 AND job_type='friction_match'`,[projectId])).rows).toEqual(count.rows);
  });

  it('atomically hands finalized narratives to matching with no legacy promotion', async () => {
    await resetToVerifying();
    await finalizeVerification(job,{sessionId,projectId,state:'unsupported',claimedPromptVersion:1,verifyPromptVersion:1,signalRows:[]});
    expect((await pool.query(`SELECT job_type FROM error_group_jobs WHERE project_id=$1 AND job_type='friction_match'`,[projectId])).rows).toEqual([{job_type:'friction_match'}]);
  });

  it('sanitizes and bounds a huge reason, and a later success clears it', async () => {
    await resetToVerifying();
    // Chromium and provider failures arrive with control characters and
    // kilobytes of path noise; neither may reach the column or a UI.
    const noisy = `chromium\u0000 crashed\u0007: SIGTRAP\u2028${'x'.repeat(2_000)}`;
    await finalizeVerification(job, {
      sessionId,
      projectId,
      state: 'failed',
      claimedPromptVersion: 1,
      verifyPromptVersion: 1,
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
      verifyPromptVersion: 1,
      verification: { grades: [], frames: [] },
      signalRows: [],
    });
    expect(await storedReason()).toBeNull();
  });

  it('drops absence claims when the stale verification sweep emits unverified observations', async () => {
    await pool.query(
      `UPDATE session_narratives
       SET narrative = $2::jsonb, timeline = $3::jsonb,
           verification_state = 'pending', verification = NULL,
           created_at = now() - interval '25 hours'
       WHERE session_id = $1`,
      [
        sessionId,
        JSON.stringify({
          userGoal: 'Submit', narrative: 'The user submitted.', notable: true,
          observations: [
            { id: 'absence', what: 'Clicking submit does nothing', evidenceLines: ['L1'] },
            { id: 'positive', what: 'A validation message appeared', evidenceLines: ['L2'] },
          ],
        }),
        JSON.stringify({ startTs: 1_000, lines: [
          { t: 'click', s: 'button', r: '/form', a: 1_000 },
          { t: 'validation', s: '.error', r: '/form', a: 2_000 },
        ] }),
      ],
    );
    const oldNarrativeKey = process.env['NARRATIVE_API_KEY'];
    const oldAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['NARRATIVE_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await sweepNarratives();
    } finally {
      if (oldNarrativeKey !== undefined) process.env['NARRATIVE_API_KEY'] = oldNarrativeKey;
      if (oldAnthropicKey !== undefined) process.env['ANTHROPIC_API_KEY'] = oldAnthropicKey;
    }
    const emitted = await pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM friction_signals WHERE session_id = $1 ORDER BY observation_id`,
      [sessionId],
    );
    expect(emitted.rows.map((row) => row.observation_id)).toEqual(['positive']);
  });
});
