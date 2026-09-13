import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { purgeJobUsage } from '../../__tests__/purge-job-usage.js';
import * as db from '../../db.js';
import * as store from '../tickets-db.js';
import { deriveNarrativeId } from '../../narrative/emit.js';
import { EmbeddingsUnavailable } from '../../embeddings.js';
import type { NarrativeModelResult } from '../../narrative/client.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
describeDb('friction match job', () => {
  const pool = db.getPool();
  let projectId: string;
  let environmentId: string;
  let orgId: string;
  beforeAll(async () => {
    const stale = await pool.query(
      `SELECT id FROM projects WHERE org_id IN(SELECT id FROM orgs WHERE name='match-job-test')`,
    );
    for (const row of stale.rows) {
      projectId = row.id;
      await cleanup();
    }
    await pool.query(
      `DELETE FROM environments WHERE project_id IN(SELECT id FROM projects WHERE org_id IN(SELECT id FROM orgs WHERE name='match-job-test'))`,
    );
    await pool.query(
      `DELETE FROM projects WHERE org_id IN(SELECT id FROM orgs WHERE name='match-job-test')`,
    );
    await pool.query(`DELETE FROM orgs WHERE name='match-job-test'`);
    orgId = (
      await pool.query(
        `INSERT INTO orgs(name) VALUES ('match-job-test') RETURNING id`,
      )
    ).rows[0].id;
    projectId = (
      await pool.query(
        `INSERT INTO projects(org_id,name) VALUES ($1,'match-test') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    environmentId = (
      await pool.query(
        `INSERT INTO environments(project_id,name) VALUES ($1,'production') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
  });
  async function cleanup() {
    const jobs = await pool.query(
      'SELECT id FROM error_group_jobs WHERE project_id=$1',
      [projectId],
    );
    await purgeJobUsage(
      pool,
      jobs.rows.map((row) => row.id as string),
    );
    await pool.query('DELETE FROM error_group_jobs WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query(
      'DELETE FROM friction_session_processed WHERE project_id=$1',
      [projectId],
    );
    await pool.query(
      'DELETE FROM friction_observation_decisions WHERE project_id=$1',
      [projectId],
    );
    await pool.query('DELETE FROM friction_tickets WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query('DELETE FROM sessions WHERE project_id=$1', [projectId]);
  }
  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanup();
  });
  afterAll(async () => {
    await pool.query('DELETE FROM environments WHERE id=$1', [environmentId]);
    await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await pool.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await db.closePool();
  });
  async function session() {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,'2026-09-11 01:02:03.123456+00')`,
      [id, projectId, environmentId],
    );
    return id;
  }
  it('enqueues in the caller transaction, deduplicates active match jobs and honors zero match cap', async () => {
    const sessionId = await session();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await db.enqueueJobTx(client, 'friction_match', projectId, { sessionId });
      await client.query('ROLLBACK');
      expect(
        (
          await pool.query(
            'SELECT id FROM error_group_jobs WHERE project_id=$1',
            [projectId],
          )
        ).rows,
      ).toEqual([]);
      await client.query('BEGIN');
      await db.enqueueJobTx(client, 'friction_match', projectId, { sessionId });
      await db.enqueueJobTx(client, 'friction_match', projectId, { sessionId });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    vi.stubEnv('FRICTION_MATCH_MAX_CONCURRENT', '0');
    expect(await db.claimJob('match-test', 60_000)).toBeNull();
    vi.stubEnv('FRICTION_MATCH_MAX_CONCURRENT', '2');
    expect(await db.claimJob('match-test', 60_000)).toMatchObject({
      sessionId,
      jobType: 'friction_match',
      ticketId: null,
      batchId: null,
      publicationGeneration: null,
      fixAttemptId: null,
    });
  });
  const observations = [
    { id: 'o1', what: 'Save displayed an error', evidenceLines: ['L1'] },
    {
      id: 'o2',
      what: 'Search displayed duplicate results',
      evidenceLines: ['L2'],
    },
  ];
  const definition = (id: string) => ({
    name: `Problem ${id}`,
    control: id,
    what_happened: `Failure ${id}`,
    steps: `Use ${id}`,
    kind: 'defect',
  });
  function model(decisions: unknown | (() => Promise<unknown>)) {
    return {
      modelName: 'claude-haiku-4-5-20251001',
      complete: vi.fn(
        async (): Promise<NarrativeModelResult> => ({
          text: JSON.stringify({
            decisions:
              typeof decisions === 'function' ? await decisions() : decisions,
          }),
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stopReason: 'end_turn',
        }),
      ),
    };
  }
  const unavailable = async () => {
    throw new EmbeddingsUnavailable();
  };
  async function seed(obs = observations) {
    const sessionId = await session();
    await pool.query(
      `INSERT INTO session_narratives(session_id,project_id,environment_id,status,prompt_version,narrative,timeline,verification_state,created_at)
      VALUES($1,$2,$3,'ok',2,$4,$5,'unsupported','2026-09-11 01:03:04.123456+00')`,
      [
        sessionId,
        projectId,
        environmentId,
        JSON.stringify({
          userGoal: 'finish',
          narrative: 'test',
          notable: true,
          observations: obs,
        }),
        JSON.stringify({
          startTs: 0,
          lines: [
            { t: 'Save error', s: '#save', r: '/save/123?a=1', a: 1 },
            { t: 'Search duplicate', s: '#search', r: '/search', a: 2 },
          ],
        }),
      ],
    );
    const workerId = randomUUID();
    const row = (
      await pool.query(
        `INSERT INTO error_group_jobs(project_id,session_id,job_type,status,worker_id,lease_generation,lease_expires_at)
      VALUES($1,$2,'friction_match','claimed',$3,7,now()+interval '5 minutes') RETURNING id`,
        [projectId, sessionId, workerId],
      )
    ).rows[0];
    return {
      payload: undefined as unknown,
      id: row.id,
      projectId,
      sessionId,
      workerId,
      leaseGeneration: '7',
      errorGroupId: null,
      eventId: null,
      sourceId: null,
      jobType: 'friction_match',
      attempts: 0,
      guidance: null,
      triggeredBy: null,
    } satisfies db.ClaimedJob & { sessionId: string };
  }
  const drafts = observations.map((o) => ({
    kind: 'draft',
    observation_id: o.id,
    draft: { name: o.id, control: o.id, steps: 'Click' },
  }));
  const creates = observations.map((o) => ({
    kind: 'create',
    observation_id: o.id,
    ticket: definition(o.id),
  }));
  async function run(
    job: db.ClaimedJob & { sessionId: string },
    cheap = model(drafts),
    strong = model(creates),
    embed = unavailable,
  ) {
    const { processFrictionMatch } = await import('../match-job.js');
    await processFrictionMatch(
      job,
      { cheap, strong, embed },
      new AbortController().signal,
    );
  }
  async function decisionCounts() {
    return (
      await pool.query(
        `SELECT
      (SELECT count(*)::int FROM friction_tickets WHERE project_id=$1) AS tickets,
      (SELECT count(*)::int FROM friction_observation_decisions WHERE project_id=$1) AS decisions,
      (SELECT count(*)::int FROM friction_ticket_matches WHERE project_id=$1) AS matches`,
        [projectId],
      )
    ).rows[0];
  }
  it('turns two problems from one recording into two tickets and preserves v2 identity and recording time', async () => {
    const job = await seed();
    await run(job);
    expect(await decisionCounts()).toEqual({
      tickets: 2,
      decisions: 2,
      matches: 2,
    });
    const refs = await pool.query(
      `SELECT t.matched_count,m.occurred_at::text,f.narrative_id FROM friction_tickets t
      JOIN friction_ticket_matches m ON m.ticket_id=t.id JOIN friction_ticket_match_observations o USING(ticket_id,session_id)
      JOIN friction_signals f ON f.id=o.signal_id WHERE t.project_id=$1`,
      [projectId],
    );
    expect(refs.rows).toHaveLength(2);
    for (const row of refs.rows)
      expect(row).toMatchObject({
        matched_count: 1,
        occurred_at: '2026-09-11 01:02:03.123456+00',
        narrative_id: deriveNarrativeId(
          job.sessionId,
          '2026-09-11 01:03:04.123456+00',
          2,
        ),
      });
    const cheap = model(drafts);
    await run(job, cheap);
    expect(cheap.complete).not.toHaveBeenCalled();
    expect(await decisionCounts()).toEqual({
      tickets: 2,
      decisions: 2,
      matches: 2,
    });
  });
  it('invalid output twice writes no decisions, matches or tickets and meters both billed calls', async () => {
    const job = await seed();
    const cheap = model([]);
    await expect(run(job, cheap)).rejects.toThrow(
      /friction_match.*every observation/,
    );
    expect(cheap.complete).toHaveBeenCalledTimes(2);
    expect(await decisionCounts()).toEqual({
      tickets: 0,
      decisions: 0,
      matches: 0,
    });
    expect(
      (
        await pool.query(
          'SELECT phase,execution,input_tokens,output_tokens FROM job_usage WHERE job_id=$1',
          [job.id],
        )
      ).rows,
    ).toEqual([
      {
        phase: 'friction_match',
        execution: 7,
        input_tokens: '22',
        output_tokens: '14',
      },
    ]);
  });
  it('records an empty surviving narrative under lease without billing', async () => {
    const job = await seed([]);
    await pool.query("UPDATE session_narratives SET verification_state='none' WHERE session_id=$1", [job.sessionId]);
    const cheap = model([]);
    await run(job, cheap);
    expect(cheap.complete).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          'SELECT narrative_id FROM friction_session_processed WHERE project_id=$1 AND session_id=$2',
          [projectId, job.sessionId],
        )
      ).rows,
    ).toEqual([
      {
        narrative_id: deriveNarrativeId(
          job.sessionId,
          '2026-09-11 01:03:04.123456+00',
          2,
        ),
      },
    ]);
    expect(
      (await pool.query('SELECT * FROM job_usage WHERE job_id=$1', [job.id]))
        .rows,
    ).toEqual([]);
  });
  it('rejects a nonempty narrative that has not been verified', async () => {
    const job = await seed();
    await pool.query("UPDATE session_narratives SET verification_state='none' WHERE session_id=$1", [job.sessionId]);
    await expect(run(job)).rejects.toThrow(/finalized narrative/);
    expect(await decisionCounts()).toEqual({ tickets: 0, decisions: 0, matches: 0 });
  });
  it('rejects lease loss during model work before any decision state mutation', async () => {
    const job = await seed();
    const strong = model(async () => {
      await pool.query(
        'UPDATE error_group_jobs SET lease_generation=lease_generation+1 WHERE id=$1',
        [job.id],
      );
      return creates;
    });
    await expect(run(job, model(drafts), strong)).rejects.toThrow(/lease lost/);
    expect(await decisionCounts()).toEqual({
      tickets: 0,
      decisions: 0,
      matches: 0,
    });
  });
  it('serializes concurrent decisions on the same signal without duplicate creation', async () => {
    const job = await seed();
    await Promise.all([run(job), run(job)]);
    expect(await decisionCounts()).toEqual({
      tickets: 2,
      decisions: 2,
      matches: 2,
    });
  });
  it('allows concurrent new-problem proposals from different recordings with consistent ledgers', async () => {
    const jobs = await Promise.all([seed(), seed()]);
    await Promise.all(jobs.map((job) => run(job)));
    expect(await decisionCounts()).toEqual({
      tickets: 4,
      decisions: 4,
      matches: 4,
    });
  });

  async function existingTicket() {
    const tx = await pool.connect();
    try {
      return await store.createTicket(tx, {
        projectId,
        environmentId,
        ...definition('existing'),
        kind: 'defect',
      });
    } finally {
      tx.release();
    }
  }
  it('counts multiple observations once per recording and enqueues confirmation on the third recording', async () => {
    const ticket = await existingTicket();
    const cheap = model(
      observations.map((o) => ({
        kind: 'matched',
        observation_id: o.id,
        ticket_id: ticket.id,
      })),
    );
    for (let i = 0; i < 3; i++) {
      const job = await seed();
      job.payload = { backfill: true };
      await run(job, cheap);
      const expected = i === 2 ? [{ ticket_id: ticket.id }] : [];
      expect(
        (
          await pool.query(
            `SELECT ticket_id FROM error_group_jobs WHERE project_id=$1 AND job_type='friction_confirm'`,
            [projectId],
          )
        ).rows,
      ).toEqual(expected);
    }
    expect(
      (
        await pool.query(
          'SELECT matched_count,next_arrival_number::text FROM friction_tickets WHERE id=$1',
          [ticket.id],
        )
      ).rows,
    ).toEqual([{ matched_count: 3, next_arrival_number: '3' }]);
    expect(
      (
        await pool.query(
          'SELECT source FROM friction_ticket_matches WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows.every((r) => r.source === 'backfill'),
    ).toBe(true);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM friction_ticket_match_observations WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows[0].n,
    ).toBe(6);
  });
  it('does not treat a fresh reserved decision as complete, then reclaims its expired reservation', async () => {
    const job = await seed();
    await expect(run(job, model([]))).rejects.toThrow(); // Materialize atomic observations only.
    const signalId = (
      await pool.query(
        'SELECT id FROM friction_signals WHERE session_id=$1 ORDER BY id LIMIT 1',
        [job.sessionId],
      )
    ).rows[0].id;
    const tx = await pool.connect();
    try {
      await store.reserveDecision(tx, signalId, { projectId, environmentId });
    } finally {
      tx.release();
    }
    await expect(run(job)).rejects.toThrow(/reserved/);
    expect(await decisionCounts()).toEqual({
      tickets: 0,
      decisions: 1,
      matches: 0,
    });
    await pool.query(
      `UPDATE friction_observation_decisions SET decided_at=now()-interval '1 day' WHERE signal_id=$1`,
      [signalId],
    );
    await run(job);
    expect(await decisionCounts()).toEqual({
      tickets: 2,
      decisions: 2,
      matches: 2,
    });
  });
  it('rolls back every decision when a shortlisted target is archived during model work', async () => {
    const ticket = await existingTicket();
    const job = await seed();
    const cheap = model(async () => {
      await pool.query(
        `UPDATE friction_tickets SET status='archived' WHERE id=$1`,
        [ticket.id],
      );
      return observations.map((o) => ({
        kind: 'matched',
        observation_id: o.id,
        ticket_id: ticket.id,
      }));
    });
    await expect(run(job, cheap)).rejects.toThrow(/archived/);
    expect(await decisionCounts()).toEqual({
      tickets: 1,
      decisions: 0,
      matches: 0,
    });
  });
  it('resolves a shortlisted ticket folded during model work to its current scoped target', async () => {
    const old = await existingTicket();
    const target = await existingTicket();
    const job = await seed();
    const cheap = model(async () => {
      await pool.query(
        `UPDATE friction_tickets SET status='merged',merged_into=$2 WHERE id=$1`,
        [old.id, target.id],
      );
      return observations.map((o) => ({
        kind: 'matched',
        observation_id: o.id,
        ticket_id: old.id,
      }));
    });
    await run(job, cheap);
    expect(
      (
        await pool.query(
          'SELECT ticket_id FROM friction_observation_decisions WHERE project_id=$1',
          [projectId],
        )
      ).rows,
    ).toEqual([{ ticket_id: target.id }, { ticket_id: target.id }]);
    expect(
      (
        await pool.query(
          'SELECT ticket_id FROM friction_ticket_matches WHERE project_id=$1',
          [projectId],
        )
      ).rows,
    ).toEqual([{ ticket_id: target.id }]);
  });
  it('applies matching and confirmation caps fleet-wide while admitting lifecycle jobs', async () => {
    const tx = await pool.connect();
    try {
      for (let i = 0; i < 4; i++)
        await db.enqueueJobTx(tx, 'friction_match', projectId, {
          sessionId: await session(),
        });
      const ticket = await existingTicket();
      await db.enqueueJobTx(tx, 'friction_confirm', projectId, {
        ticketId: ticket.id,
      });
      await db.enqueueJobTx(tx, 'friction_reconcile', projectId, {
        ticketId: ticket.id,
      });
      await db.enqueueJobTx(tx, 'friction_pr_event', projectId, {
        ticketId: ticket.id,
      });
    } finally {
      tx.release();
    }
    vi.stubEnv('FRICTION_MATCH_MAX_CONCURRENT', '2');
    const claimed = await Promise.all(
      Array.from({ length: 5 }, (_, i) => db.claimJob(`fleet-${i}`, 60_000)),
    );
    expect(claimed.filter((j) => j?.jobType === 'friction_match')).toHaveLength(2);
    expect(claimed.filter((j) => j?.jobType === 'friction_confirm')).toHaveLength(1);
    const future = await pool.query(
      `SELECT status FROM error_group_jobs WHERE project_id=$1 AND job_type IN ('friction_reconcile','friction_pr_event')`,
      [projectId],
    );
    expect(future.rows).toEqual([
      { status: 'claimed' },
      { status: 'claimed' },
    ]);
  });
});
