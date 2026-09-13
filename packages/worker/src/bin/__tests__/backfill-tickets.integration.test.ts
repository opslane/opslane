import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as db from '../../db.js';
import { deriveNarrativeId, buildSignalRows } from '../../narrative/emit.js';
import { writeObservationSignals } from '../../friction/persist.js';
import { processFrictionMatch } from '../../friction/match-job.js';
import { backfillTickets, parseBackfillArgs } from '../backfill-tickets.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
const projectId = randomUUID();
const environmentId = randomUUID();
const otherEnvironment = randomUUID();
const otherProject = randomUUID();
const orgId = randomUUID();
const since = new Date('2026-09-01T00:00:00Z');
const createdAt = '2026-09-11 01:03:04.123456+00';
const timeline = { startTs: 0, lines: [{ t: 'Save failed', s: '#save', r: '/save', a: 1 }] };
const observations = ['o1', 'o2'].map(id => ({ id, what: 'Save failed', evidenceLines: ['L1'] }));

describe('backfill arguments', () => {
  it('parses the required scope, lookback and rate', () => {
    expect(parseBackfillArgs(['--project', projectId, '--environment', environmentId, '--since', '14d', '--rate', '60'], since)).toEqual({
      projectId, environmentId, since: new Date('2026-08-18T00:00:00Z'), rate: 60,
    });
  });
  it.each([
    [], ['--project', 'bad'],
    ['--project', projectId, '--environment', environmentId, '--since', 'yesterday', '--rate', '60'],
    ['--project', projectId, '--environment', environmentId, '--since', '14d', '--rate', '0'],
    ['--project', projectId, '--environment', environmentId, '--since', '14d', '--rate', 'NaN'],
    ['--project', projectId, '--environment', environmentId, '--since', '14d', '--rate', '60', '--typo', '1'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseBackfillArgs(args)).toThrow();
  });
});

describeDb('ticket backfill', () => {
  const pool = db.getPool();
  const options = { projectId, environmentId, since, rate: 60 };
  beforeAll(async () => {
    await pool.query('INSERT INTO orgs(id,name) VALUES($1,$2)', [orgId, `backfill-${orgId}`]);
    await pool.query("INSERT INTO projects(id,org_id,name) VALUES($1,$3,'backfill'),($2,$3,'other')", [projectId, otherProject, orgId]);
    await pool.query("INSERT INTO environments(id,project_id,name) VALUES($1,$3,'production'),($2,$3,'staging'),($4,$5,'production')", [environmentId, otherEnvironment, projectId, otherProject, otherProject]);
  });
  afterEach(async () => {
    await pool.query('DELETE FROM error_group_jobs WHERE project_id=ANY($1::uuid[])', [[projectId, otherProject]]);
    await pool.query('DELETE FROM friction_session_processed WHERE project_id=ANY($1::uuid[])', [[projectId, otherProject]]);
    await pool.query('DELETE FROM sessions WHERE project_id=ANY($1::uuid[])', [[projectId, otherProject]]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM environments WHERE project_id=ANY($1::uuid[])', [[projectId, otherProject]]);
    await pool.query('DELETE FROM projects WHERE org_id=$1', [orgId]);
    await pool.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await db.closePool();
  });
  async function seed(args: { environment?: string; project?: string; created?: string; status?: string; empty?: boolean } = {}) {
    const sessionId = randomUUID();
    const project = args.project ?? projectId;
    const environment = args.environment ?? environmentId;
    await pool.query('INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())', [sessionId, project, environment]);
    await pool.query(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,created_at,narrative,timeline,verification_state)
      VALUES($1,$2,$3,$4,2,$5,$6,$7,$8)`, [sessionId, project, environment, args.status ?? 'ok', args.created ?? createdAt,
      args.status === 'failed' ? null : JSON.stringify({ userGoal: 'save', narrative: 'save failed', notable: true, observations: args.empty ? [] : observations }), JSON.stringify(timeline), args.empty ? 'none' : 'unsupported']);
    return sessionId;
  }
  async function atomic(sessionId: string) {
    const tx = await pool.connect();
    try {
      const session = (await pool.query<db.SessionRow>('SELECT * FROM sessions WHERE id=$1', [sessionId])).rows[0];
      return await writeObservationSignals(tx, session, buildSignalRows(timeline, observations, sessionId, deriveNarrativeId(sessionId, createdAt, 2)));
    } finally { tx.release(); }
  }
  async function decide(signalId: string, sessionId: string, decision = 'not_a_problem') {
    await pool.query(`INSERT INTO friction_observation_decisions(signal_id,project_id,environment_id,session_id,decision,decided_by)
      VALUES($1,$2,$3,$4,$5,'strong')`, [signalId, projectId, environmentId, sessionId, decision]);
  }
  it('rejects an environment from another project without enqueueing work', async () => {
    await seed();
    await expect(backfillTickets(pool, { ...options, environmentId: otherProject })).rejects.toThrow(/does not belong/);
    expect((await pool.query('SELECT id FROM error_group_jobs WHERE project_id=$1', [projectId])).rows).toEqual([]);
  });
  it('scopes recent ok narratives, schedules one per second and deduplicates active jobs on rerun', async () => {
    const eligible = [await seed(), await seed(), await seed()];
    await seed({ environment: otherEnvironment });
    await seed({ project: otherProject, environment: otherProject });
    await seed({ created: '2026-08-01 00:00:00+00' });
    await seed({ status: 'failed' });
    expect(await backfillTickets(pool, options)).toBe(3);
    expect(await backfillTickets(pool, options)).toBe(0);
    const jobs = (await pool.query(`SELECT session_id,payload,extract(epoch FROM available_at-lag(available_at) OVER(ORDER BY available_at))::float AS spacing
      FROM error_group_jobs WHERE project_id=$1 ORDER BY available_at`, [projectId])).rows;
    expect(jobs.map(row => row.session_id).sort()).toEqual(eligible.sort());
    expect(jobs.map(row => row.payload)).toEqual(Array(3).fill({ backfill: true }));
    expect(jobs.map(row => row.spacing)).toEqual([null, 1, 1]);
  });
  it('skips completed decisions including not_a_problem and resumes a partial or reserved ledger', async () => {
    const complete = await seed();
    for (const row of await atomic(complete)) await decide(row.signalId, complete);
    const partial = await seed();
    const rows = await atomic(partial);
    await decide(rows[0].signalId, partial);
    const reserved = await seed();
    for (const row of await atomic(reserved)) await decide(row.signalId, reserved, 'reserved');
    expect(await backfillTickets(pool, options)).toBe(2);
    await pool.query("UPDATE error_group_jobs SET status='completed' WHERE project_id=$1", [projectId]);
    await decide(rows[1].signalId, partial);
    expect(await backfillTickets(pool, options)).toBe(1);
    expect((await pool.query("SELECT session_id FROM error_group_jobs WHERE project_id=$1 AND status='pending'", [projectId])).rows).toEqual([{ session_id: reserved }]);
  });
  it('processes a real none-state empty backfill through the production handler and skips its exact stored narrative marker', async () => {
    const sessionId = await seed({ empty: true });
    expect(await backfillTickets(pool, options)).toBe(1);
    const workerId = randomUUID();
    const result = await pool.query(`UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=1,lease_expires_at=now()+interval '5 minutes'
      WHERE project_id=$1 RETURNING id,payload`, [projectId, workerId]);
    const model = { modelName: 'unused', complete: vi.fn() };
    await processFrictionMatch({ id: result.rows[0].id, payload: result.rows[0].payload, projectId, sessionId, workerId, leaseGeneration: '1', errorGroupId: null, eventId: null, sourceId: null, jobType: 'friction_match', attempts: 0, guidance: null, triggeredBy: null }, { cheap: model, strong: model }, new AbortController().signal);
    await pool.query("UPDATE error_group_jobs SET status='completed' WHERE project_id=$1", [projectId]);
    expect(model.complete).not.toHaveBeenCalled();
    expect((await pool.query('SELECT narrative_id FROM friction_session_processed WHERE project_id=$1', [projectId])).rows).toEqual([{ narrative_id: deriveNarrativeId(sessionId, createdAt, 2) }]);
    expect(await backfillTickets(pool, options)).toBe(0);
  });

  it('queues the match job for an empty narrative when narration finalizes, so the backfill has nothing to add', async () => {
    const sessionId = randomUUID();
    await pool.query('INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())', [sessionId, projectId, environmentId]);
    await pool.query(`INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,created_at)
      VALUES($1,$2,$3,'narrating',2,$4)`, [sessionId, projectId, environmentId, createdAt]);
    const workerId = randomUUID();
    const jobId = (await pool.query(
      `INSERT INTO error_group_jobs(project_id,session_id,job_type,status,worker_id,lease_generation,lease_expires_at)
       VALUES($1,$2,'session_narrate','claimed',$3,1,now()+interval '5 minutes') RETURNING id`,
      [projectId, sessionId, workerId],
    )).rows[0].id as string;
    const job = { id: jobId, projectId, sessionId, workerId, leaseGeneration: '1', jobType: 'session_narrate', errorGroupId: null, payload: null, attempts: 0 } as unknown as db.ClaimedJob;
    const written = await db.finishNarrative(job, {
      sessionId, projectId, status: 'ok',
      narrative: { userGoal: 'browse', narrative: 'Nothing notable happened.', notable: false, observations: [] },
      timeline: { lines: [] },
      verificationState: 'none',
    });
    expect(written).toEqual({ written: true });
    const queued = await pool.query(`SELECT status FROM error_group_jobs WHERE project_id=$1 AND session_id=$2 AND job_type='friction_match'`, [projectId, sessionId]);
    expect(queued.rows).toEqual([{ status: 'pending' }]);

    // Run that job through the production handler: it writes the ledger row
    // without a model call, and the backfill then has nothing to enqueue.
    const claimed = await pool.query(`UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=1,lease_expires_at=now()+interval '5 minutes'
      WHERE project_id=$1 AND job_type='friction_match' RETURNING id,payload`, [projectId, workerId]);
    const model = { modelName: 'unused', complete: vi.fn() };
    await processFrictionMatch({ id: claimed.rows[0].id, payload: claimed.rows[0].payload, projectId, sessionId, workerId, leaseGeneration: '1', errorGroupId: null, eventId: null, sourceId: null, jobType: 'friction_match', attempts: 0, guidance: null, triggeredBy: null }, { cheap: model, strong: model }, new AbortController().signal);
    await pool.query("UPDATE error_group_jobs SET status='completed' WHERE project_id=$1", [projectId]);
    expect(model.complete).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS n FROM friction_session_processed WHERE project_id=$1 AND session_id=$2', [projectId, sessionId])).rows[0].n).toBe(1);
    expect(await backfillTickets(pool, options)).toBe(0);
  });
});
