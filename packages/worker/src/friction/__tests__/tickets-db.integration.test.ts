import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as store from '../tickets-db.js';
import {
  beginInvestigation,
  finishInvestigation,
  type TicketInvestigateJob,
} from '../investigate-ticket.js';
import {
  causeCoverage,
  requestFix,
  applyPrEvent,
  attemptFailed,
} from '../fix-attempts.js';
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from '../../embeddings.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
describeDb('ticket store', () => {
  let pool: pg.Pool;
  let db: pg.PoolClient;
  let scope: store.TicketScope;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    db = await pool.connect();
  });
  afterAll(async () => {
    db.release();
    await pool.end();
  });
  beforeEach(async () => {
    await db.query('BEGIN');
    const org = await db.query(`INSERT INTO orgs(name) VALUES ('ticket-store-test') RETURNING id`);
    const p = await db.query(
      `INSERT INTO projects(org_id,name,github_repo,default_branch) VALUES ($1,'tickets','test/repo','main') RETURNING id`,
      [org.rows[0].id],
    );
    const e = await db.query(
      `INSERT INTO environments(project_id,name) VALUES ($1,'production') RETURNING id`,
      [p.rows[0].id],
    );
    scope = { projectId: p.rows[0].id, environmentId: e.rows[0].id };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.query('ROLLBACK');
  });
  const ticket = (kind: 'defect' | 'ux_insight' = 'defect') =>
    store.createTicket(db, {
      ...scope,
      name: 'Save fails',
      control: 'Save',
      what_happened: 'Spinner never stops',
      kind,
    });
  async function recording(user: string | null = null, age = 0) {
    const sessionId = randomUUID();
    await db.query(
      `INSERT INTO sessions(id,project_id,environment_id,started_at,end_user_id) VALUES ($1,$2,$3,now()-$4*interval '1 day',$5)`,
      [sessionId, scope.projectId, scope.environmentId, age, user],
    );
    const s = await db.query(
      `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,'narrative',$4,'/save',now()-$5*interval '1 day',1) RETURNING id,occurred_at::text`,
      [sessionId, scope.projectId, scope.environmentId, randomUUID(), age],
    );
    return {
      sessionId,
      endUserId: user,
      signalIds: [s.rows[0].id as string],
      occurredAt: s.rows[0].occurred_at as string,
      screen: '/save',
      source: 'cheap' as const,
    };
  }
  async function user(account = 'account') {
    const r = await db.query(
      `INSERT INTO end_users(project_id,external_user_id,external_account_id,account_name) VALUES($1,$2,$3,$3) RETURNING id`,
      [scope.projectId, randomUUID(), account],
    );
    return r.rows[0].id as string;
  }
  async function matches(
    t: store.TicketRow,
    n: number,
    users: (string | null)[] = [null],
    age = 0,
  ) {
    const result = [];
    for (let i = 0; i < n; i++) {
      const r = await recording(users[i % users.length]!, age);
      await store.recordMatch(db, { ticket: t, ...r });
      result.push(r);
    }
    return result;
  }
  async function checked(t: store.TicketRow, outcomes: store.CheckResult['outcome'][], age = 0) {
    const rs = await matches(t, outcomes.length, [await user(), await user('other')], age);
    const b = (await store.selectBatch(db, t, randomUUID()))!;
    for (const [i, r] of rs.entries())
      await store.stageCheck(db, b.id, {
        ...r,
        outcome: outcomes[i]!,
        model: 'test',
        framesOk: true,
        costToUser: i === 0 ? 'annoyance' : 'lost_time',
      });
    await store.finalizeBatch(db, t, b.id);
    return rs;
  }
  it('admits the current recording identity after a model snapshot becomes stale', async () => {
    const t = await ticket();
    const oldUser = await user();
    const newUser = await user();
    const r = await recording(oldUser);
    await db.query('SELECT friction_set_session_identity($1,$2,$3)', [
      scope.projectId,
      r.sessionId,
      newUser,
    ]);
    await store.recordMatch(db, { ticket: t, ...r });
    expect(
      (
        await db.query(
          'SELECT end_user_id FROM friction_ticket_matches WHERE ticket_id=$1',
          [t.id],
        )
      ).rows[0].end_user_id,
    ).toBe(newUser);
  });
  it('invalidates surviving presentation and immediately unpublishes an identity collapse', async () => {
    const t = await ticket();
    const rs = await checked(t, [
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    const g = await store.activateGeneration(
      db,
      t,
      await store.cohortStats(db, t),
      'Cached steps',
    );
    await db.query(
      `UPDATE error_groups SET representative_session_id=$2,representative_signal_id=$3 WHERE id=$1`,
      [g.errorGroupId, rs[0]!.sessionId, rs[0]!.signalIds[0]],
    );
    await db.query(
      `INSERT INTO digest_card_copy(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version) VALUES($1,now(),'fp','Save','Cached quote','fix','test',1)`,
      [g.errorGroupId],
    );
    await db.query('DELETE FROM sessions WHERE id=$1', [rs[4]!.sessionId]);
    await db.query('SELECT friction_reconcile_after_delete($1)', [t.id]);
    expect(await store.getTicket(db, scope.projectId, t.id)).toMatchObject({
      status: 'published',
      matched_count: 4,
      steps: null,
      reconcile_needed: true,
    });
    expect(
      (
        await db.query(
          'SELECT representative_signal_id,representative_session_id FROM error_groups WHERE id=$1',
          [g.errorGroupId],
        )
      ).rows[0],
    ).toEqual({
      representative_signal_id: null,
      representative_session_id: null,
    });
    expect(
      (
        await db.query(
          'SELECT invalidated_at FROM digest_card_copy WHERE error_group_id=$1',
          [g.errorGroupId],
        )
      ).rows[0].invalidated_at,
    ).not.toBeNull();
    for (const r of rs.slice(0, 4))
      await db.query('SELECT friction_set_session_identity($1,$2,$3)', [
        scope.projectId,
        r.sessionId,
        rs[0]!.endUserId,
      ]);
    expect(await store.getTicket(db, scope.projectId, t.id)).toMatchObject({
      status: 'unpublished',
    });
    expect(
      (
        await db.query('SELECT status FROM error_groups WHERE id=$1', [
          g.errorGroupId,
        ])
      ).rows[0].status,
    ).toBe('archived');
    expect(
      (
        await db.query(
          'SELECT status FROM error_group_jobs WHERE error_group_id=$1',
          [g.errorGroupId],
        )
      ).rows,
    ).toEqual([{ status: 'failed' }]);
  });
  it('fences investigation executions, records stale results, and preserves an active fix', async () => {
    const t = await ticket();
    const rs = await checked(t, [
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    const p = await store.activateGeneration(
      db,
      t,
      await store.cohortStats(db, t),
      'Save',
    );
    const row = (
      await db.query(
        `UPDATE error_group_jobs SET status='claimed',worker_id='test',lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE error_group_id=$1 RETURNING id`,
        [p.errorGroupId],
      )
    ).rows[0];
    const job = {
      id: row.id,
      projectId: scope.projectId,
      ticketId: t.id,
      errorGroupId: p.errorGroupId,
      publicationGeneration: p.generation,
      workerId: 'test',
      leaseGeneration: '1',
      sessionId: null,
    } as TicketInvestigateJob;
    const first = (await beginInvestigation(db, job))!;
    const second = (await beginInvestigation(db, job))!;
    expect(BigInt(second.execution)).toBeGreaterThan(BigInt(first.execution));
    const result = {
      status: 'verdict' as const,
      investigatedCommit: 'abc',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      verdict: {
        codeCause: true,
        confidence: 'high' as const,
        reason: 'The save handler drops input.',
        explains: rs.slice(0, 2).flatMap((r) => r.signalIds),
        doesNotExplain: rs.slice(2).flatMap((r) => r.signalIds),
        evidence: [
          {
            path: 'src/save.ts',
            detail: 'Drops input',
            symptomLink: 'Data lost',
          },
        ],
        agentTaskBrief: 'Preserve input in the save handler.',
      },
    };
    expect(await finishInvestigation(db, job, first, result)).toBe(false);
    await db.query(
      `UPDATE error_groups SET fix_substate='fixing',status='fixing' WHERE id=$1`,
      [p.errorGroupId],
    );
    expect(await finishInvestigation(db, job, second, result)).toBe(true);
    expect(
      (
        await store.liveIncident(
          db,
          (await store.getTicket(db, scope.projectId, t.id))!,
        )
      )?.fix_substate,
    ).toBe('fixing');
    expect(
      (
        await db.query(
          `SELECT investigation_status,status FROM error_groups WHERE id=$1`,
          [p.errorGroupId],
        )
      ).rows[0],
    ).toEqual({ investigation_status: 'done', status: 'fixing' });
    expect(
      (
        await db.query(
          `SELECT applied FROM friction_investigation_results WHERE error_group_id=$1 ORDER BY execution`,
          [p.errorGroupId],
        )
      ).rows,
    ).toEqual([{ applied: false }, { applied: true }]);
    const third = {
      ...second,
      execution: String(BigInt(second.execution) + 1n),
    };
    await db.query(
      `UPDATE friction_tickets SET live_generation=live_generation+1 WHERE id=$1`,
      [t.id],
    );
    expect(await finishInvestigation(db, job, third, result)).toBe(false);
    expect(
      (
        await db.query(
          `SELECT count(*)::int n FROM friction_investigation_results WHERE error_group_id=$1`,
          [p.errorGroupId],
        )
      ).rows[0].n,
    ).toBe(3);
  });

  it('authorizes half-covered causes, caps automatic PRs, and resolves only the current attempt', async () => {
    const t = await ticket('defect');
    const rs = await checked(t, [
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    const publication = await store.activateGeneration(
      db,
      t,
      await store.cohortStats(db, t),
      'Save',
    );
    const current = (await store.getTicket(db, scope.projectId, t.id))!;
    const ids = rs.flatMap((r) => r.signalIds);
    expect(causeCoverage(ids.slice(0, 2), ids)).toBe(0.5);
    await db.query(
      `UPDATE error_groups SET investigation_status='done',root_cause='Save handler drops input',explained_signal_ids=$2::jsonb WHERE id=$1`,
      [publication.errorGroupId, JSON.stringify(ids.slice(0, 2))],
    );
    await db.query(
      `INSERT INTO diagnosis_decisions(error_group_id,project_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence) VALUES($1,$2,'code_fix','Save loses input','{"agentTaskBrief":"Preserve input"}','test','test','friction_classify','high')`,
      [publication.errorGroupId, scope.projectId],
    );
    await db.query(
      `UPDATE projects SET friction_autonomy='auto_fix' WHERE id=$1`,
      [scope.projectId],
    );
    vi.stubEnv('FRICTION_MAX_OPEN_FIX_PRS', '0');
    expect(
      (
        await requestFix(
          db,
          scope.projectId,
          t.id,
          publication.generation,
          'auto',
        )
      ).status,
    ).toBe('cap');
    const first = await requestFix(
      db,
      scope.projectId,
      t.id,
      publication.generation,
      'human',
    );
    expect(first.status).toBe('created');
    expect(
      (
        await requestFix(
          db,
          scope.projectId,
          t.id,
          publication.generation,
          'human',
        )
      ).status,
    ).toBe('outstanding');
    if (first.status !== 'created') throw new Error('Expected attempt');
    await attemptFailed(
      db,
      first.jobId,
      scope.projectId,
      'Verification failed',
    );
    expect((await store.liveIncident(db, current))?.fix_substate).toBe('none');
    await db.query(
      `UPDATE error_group_jobs SET status='completed' WHERE id=$1`,
      [first.jobId],
    );
    const retry = await requestFix(
      db,
      scope.projectId,
      t.id,
      publication.generation,
      'human',
    );
    if (retry.status !== 'created') throw new Error('Expected retry');
    const event = {
      ticketId: t.id,
      errorGroupId: publication.errorGroupId,
      generation: publication.generation,
      attemptId: retry.attemptId,
      event: 'merged' as const,
      deliveryId: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    expect(
      await applyPrEvent(db, scope.projectId, { ...event, generation: 0 }),
    ).toBe(false);
    expect(
      await applyPrEvent(db, scope.projectId, {
        ...event,
        attemptId: first.attemptId,
        deliveryId: randomUUID(),
      }),
    ).toBe(false);
    expect((await store.liveIncident(db, current))?.fix_substate).toBe(
      'fixing',
    );
    expect(
      await applyPrEvent(db, scope.projectId, {
        ...event,
        deliveryId: randomUUID(),
      }),
    ).toBe(true);
    expect((await store.liveIncident(db, current))?.fix_substate).toBe(
      'resolved',
    );
    expect(
      (await store.getTicket(db, scope.projectId, t.id))?.fixed_at,
    ).toBeTruthy();
  });

  it('a failed investigation refuses a manual fix without queueing reinvestigation', async () => {
    const t = await ticket();
    await checked(t, ['confirmed', 'confirmed', 'confirmed']);
    const p = await store.activateGeneration(
      db,
      t,
      await store.cohortStats(db, t),
      'Save',
    );
    await db.query(
      `UPDATE error_group_jobs SET status='completed' WHERE error_group_id=$1`,
      [p.errorGroupId],
    );
    await db.query(
      `UPDATE error_groups SET investigation_status='failed' WHERE id=$1`,
      [p.errorGroupId],
    );
    expect(
      (await requestFix(db, scope.projectId, t.id, p.generation, 'human'))
        .status,
    ).toBe('not_ready');
    expect(
      (
        await db.query(
          `SELECT id FROM error_group_jobs WHERE error_group_id=$1 AND job_type='investigate' AND status='pending'`,
          [p.errorGroupId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('counts a recording once, allocates strict arrivals from locked state, pins retention and keeps observation refs', async () => {
    const t = await ticket();
    const r = await recording();
    expect((await store.recordMatch(db, { ticket: t, ...r })).newRecording).toBe(true);
    expect((await store.recordMatch(db, { ticket: t, ...r })).newRecording).toBe(false);
    const extra = await db.query(
      `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,'narrative',$4,'/other',now(),1) RETURNING id`,
      [r.sessionId, scope.projectId, scope.environmentId, randomUUID()],
    );
    await store.recordMatch(db, {
      ticket: t,
      ...r,
      screen: '/other',
      signalIds: [extra.rows[0].id],
    });
    await matches(t, 2);
    const row = (
      await db.query(
        `SELECT matched_count,next_arrival_number::text,screens_proposed FROM friction_tickets WHERE id=$1`,
        [t.id],
      )
    ).rows[0];
    expect(row).toEqual({
      matched_count: 3,
      next_arrival_number: '3',
      screens_proposed: ['/other', '/save'],
    });
    expect(
      (
        await db.query(
          `SELECT arrival_number::text FROM friction_ticket_matches WHERE ticket_id=$1 ORDER BY arrival_number`,
          [t.id],
        )
      ).rows.map((r) => r.arrival_number),
    ).toEqual(['1', '2', '3']);
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM friction_ticket_match_observations WHERE ticket_id=$1 AND session_id=$2`,
          [t.id, r.sessionId],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await db.query(
          `SELECT retain_until=started_at+interval '90 days' AS pinned FROM sessions WHERE id=$1`,
          [r.sessionId],
        )
      ).rows[0].pinned,
    ).toBe(true);
    expect(t.next_arrival_number).toBe(0n);
  });
  it('reserves once and cannot replace a committed decision', async () => {
    const r = await recording();
    const t = await ticket();
    expect(await store.reserveDecision(db, r.signalIds[0]!, scope)).toEqual({ reserved: true });
    expect((await store.reserveDecision(db, r.signalIds[0]!, scope)).reserved).toBe(false);
    expect(
      await store.commitDecision(db, r.signalIds[0]!, {
        decision: 'created',
        ticketId: t.id,
        decidedBy: 'strong',
      }),
    ).toBe(true);
    expect(
      await store.commitDecision(db, r.signalIds[0]!, {
        decision: 'not_a_problem',
        decidedBy: 'cheap',
      }),
    ).toBe(false);
    expect((await store.reserveDecision(db, r.signalIds[0]!, scope)).existing?.ticket_id).toBe(
      t.id,
    );
    const other = await recording();
    await store.reserveDecision(db, other.signalIds[0]!, scope);
    await db.query(
      `UPDATE friction_observation_decisions SET decided_at=now()-interval '1 day' WHERE signal_id=$1`,
      other.signalIds,
    );
    await db.query(
      `INSERT INTO error_group_jobs(project_id,session_id,job_type,status,lease_expires_at) VALUES($1,$2,'friction_match','claimed',now()+interval '5 minutes')`,
      [scope.projectId, other.sessionId],
    );
    expect(
      (await store.reserveDecision(db, other.signalIds[0]!, scope)).reserved,
    ).toBe(true);
    expect(
      (
        await store.reserveDecision(db, r.signalIds[0]!, {
          ...scope,
          environmentId: randomUUID(),
        })
      ).reserved,
    ).toBe(false);
  });
  it('selects oldest recordings round-robin by identity and persists immutable selection boundaries', async () => {
    const t = await ticket();
    const a = await matches(t, 3, [await user()]);
    const b = await matches(t, 2, [await user()]);
    const batch = (await store.selectBatch(db, t, randomUUID()))!;
    expect(batch.manifest.map((m) => m.sessionId)).toEqual([
      a[0]!.sessionId,
      b[0]!.sessionId,
      a[1]!.sessionId,
      b[1]!.sessionId,
      a[2]!.sessionId,
    ]);
    expect(batch.arrival_boundary_at_select).toBe(0n);
    expect(
      (await db.query(`SELECT arrival_boundary::text FROM friction_tickets WHERE id=$1`, [t.id]))
        .rows[0].arrival_boundary,
    ).toBe('5');
    expect(batch.status_at_select).toBe('tracking');
  });
  it('uses 30 only on the first batch above 50 matches, otherwise 10', async () => {
    const t = await ticket();
    await matches(t, 51);
    const first = (await store.selectBatch(db, t, randomUUID()))!;
    expect(first.manifest).toHaveLength(30);
    expect(first.batchId).toBe(first.id);
    expect(first.sessionIds).toHaveLength(30);
    expect(
      (await db.query('SELECT arrival_boundary::text FROM friction_tickets WHERE id=$1', [t.id]))
        .rows[0].arrival_boundary,
    ).toBe('51');
    await store.discardBatch(db, first.id);
    expect((await store.selectBatch(db, t, randomUUID()))!.manifest).toHaveLength(10);
  });
  it('promotes only finalized non-unavailable checks exactly once, and excludes checked recordings', async () => {
    const t = await ticket();
    const rs = await matches(t, 4);
    const b = (await store.selectBatch(db, t, randomUUID()))!;
    for (const [i, r] of rs.entries())
      await store.stageCheck(db, b.id, {
        ...r,
        outcome: (['confirmed', 'refuted', 'inconclusive', 'unavailable'] as const)[i]!,
        model: 'test',
      });
    expect((await store.cohortStats(db, t)).counted).toBe(0);
    const f = await store.finalizeBatch(db, t, b.id);
    expect(f.evidenceVersion).toBe(1);
    expect(f.stats).toMatchObject({ counted: 3, confirmed: 1, refuted: 1, inconclusive: 1 });
    expect((await store.finalizeBatch(db, t, b.id)).evidenceVersion).toBe(1);
    expect(await store.selectBatch(db, t, randomUUID())).toBeNull();
    await db.query(
      `UPDATE friction_unavailable_retries SET retry_at=now()-interval '1 minute' WHERE ticket_id=$1`,
      [t.id],
    );
    expect(
      (await store.selectBatch(db, t, randomUUID()))!.manifest.map((m) => m.sessionId),
    ).toEqual([rs[3]!.sessionId]);
  });
  it('increments unavailable retries only for a new staged attempt and makes the third permanent', async () => {
    const t = await ticket();
    const [r] = await matches(t, 1);
    for (let i = 1; i <= 3; i++) {
      const b = (await store.selectBatch(db, t, randomUUID()))!;
      const check = { ...r!, outcome: 'unavailable' as const, model: 'test' };
      await store.stageCheck(db, b.id, check);
      await store.stageCheck(db, b.id, check);
      const retry = (
        await db.query(
          `SELECT *,round(extract(epoch from retry_at-now())/3600)::int AS hours FROM friction_unavailable_retries WHERE ticket_id=$1`,
          [t.id],
        )
      ).rows[0];
      expect(retry.attempts).toBe(i);
      expect(retry.hours).toBe([1, 6, 24][i - 1]);
      expect(retry.permanent).toBe(i === 3);
      await store.finalizeBatch(db, t, b.id);
      await db.query(
        `UPDATE friction_unavailable_retries SET retry_at=now()-interval '1 minute' WHERE ticket_id=$1`,
        [t.id],
      );
    }
    expect(await store.selectBatch(db, t, randomUUID())).toBeNull();
  });
  it('retains discarded attempts without evidence and allows the recording to be selected again', async () => {
    const t = await ticket();
    const [r] = await matches(t, 1);
    const b = (await store.selectBatch(db, t, randomUUID()))!;
    await store.stageCheck(db, b.id, { ...r!, outcome: 'confirmed', model: 'test' });
    await store.discardBatch(db, b.id);
    expect((await store.cohortStats(db, t)).counted).toBe(0);
    expect(
      (
        await db.query(`SELECT count(*)::int AS n FROM friction_check_attempts WHERE batch_id=$1`, [
          b.id,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await store.selectBatch(db, t, randomUUID()))!.manifest[0]!.sessionId,
    ).toBe(r!.sessionId);
    expect(
      (
        await db.query(
          `SELECT reconcile_needed FROM friction_tickets WHERE id=$1`,
          [t.id],
        )
      ).rows[0].reconcile_needed,
    ).toBe(true);
  });
  it('counts all finalized cohort recordings, including older than seven days, but excludes the fixed prefix', async () => {
    const t = await ticket();
    await checked(t, ['confirmed', 'confirmed', 'refuted'], 8);
    expect(await store.cohortStats(db, t)).toMatchObject({
      counted: 3,
      confirmed: 2,
      confirmedUsers: 2,
      identityKnown: true,
    });
    await db.query(
      `UPDATE friction_tickets SET cohort_cutoff=now()-interval '7 days' WHERE id=$1`,
      [t.id],
    );
    expect((await store.cohortStats(db, t)).counted).toBe(0);
  });
  it('uses only finalized confirmed exact observation evidence within the window', async () => {
    const t = await ticket();
    const old = await checked(t, ['confirmed'], 8);
    const fresh = await checked(t, ['confirmed', 'confirmed', 'refuted']);
    const added = await db.query(
      `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,'narrative',$4,'/save',now(),1) RETURNING id`,
      [fresh[0]!.sessionId, scope.projectId, scope.environmentId, randomUUID()],
    );
    await store.recordMatch(db, { ticket: t, ...fresh[0]!, signalIds: [added.rows[0].id] });
    const staged = await matches(t, 1);
    const b = (await store.selectBatch(db, t, randomUUID()))!;
    await store.stageCheck(db, b.id, { ...staged[0]!, outcome: 'confirmed', model: 'test' });
    const e = await store.verifiedEvidence(db, t);
    expect(e.sessions).toBe(2);
    expect(e.users).toBe(2);
    expect(e.accounts).toEqual(['account', 'other']);
    expect(e.signalIds.sort()).toEqual(
      fresh
        .slice(0, 2)
        .flatMap((r) => r.signalIds)
        .sort(),
    );
    expect(e.sessionIds).not.toContain(old[0]!.sessionId);
    expect(e.representative).not.toBeNull();
    await db.query(
      `UPDATE friction_tickets SET cohort_cutoff=now()+interval '1 second' WHERE id=$1`,
      [t.id],
    );
    expect((await store.verifiedEvidence(db, t)).sessions).toBe(0);
  });
  it('lists nonblank account names without requiring or exposing account IDs', async () => {
    const t = await ticket();
    const [nameOnly] = await checked(t, ['confirmed']);
    const [idOnly] = await checked(t, ['confirmed']);
    const [blankName] = await checked(t, ['confirmed']);
    await db.query(
      `UPDATE end_users SET external_account_id=NULL,account_name='Acme' WHERE id=$1`,
      [nameOnly!.endUserId],
    );
    await db.query(
      `UPDATE end_users SET external_account_id='private-account-id',account_name=NULL WHERE id=$1`,
      [idOnly!.endUserId],
    );
    await db.query(
      `UPDATE end_users SET external_account_id='blank-name-account',account_name='   ' WHERE id=$1`,
      [blankName!.endUserId],
    );
    expect((await store.verifiedEvidence(db, t)).accounts).toEqual(['Acme']);
  });
  it('excludes future recordings from the display window while keeping the full cohort unbounded', async () => {
    const t = await ticket();
    const [present] = await checked(t, ['confirmed']);
    const [future] = await checked(t, ['confirmed'], -1);
    const recent = await store.verifiedEvidence(db, t);
    expect(recent.sessionIds).toEqual([present!.sessionId]);
    expect(recent.signalIds).toEqual(present!.signalIds);
    expect((await store.verifiedEvidence(db, t, { days: null })).sessionIds).toContain(
      future!.sessionId,
    );
    expect((await store.cohortStats(db, t)).counted).toBe(2);
  });
  it('publishes distinct generations, preserves old memberships, and unpublishes jobs and attempts', async () => {
    const t = await ticket();
    const rs = await checked(t, ['confirmed', 'confirmed', 'confirmed']);
    const stats = await store.cohortStats(db, t);
    const first = await store.activateGeneration(db, t, stats, 'Click Save');
    const second = await store.activateGeneration(db, t, stats, 'Click Save again');
    expect(second.generation).toBe(2);
    expect(second.errorGroupId).not.toBe(first.errorGroupId);
    const groups = (
      await db.query(
        `SELECT id,fingerprint,status,actionable_since FROM error_groups WHERE ticket_id=$1 ORDER BY publication_generation`,
        [t.id],
      )
    ).rows;
    expect(groups[0].status).toBe('archived');
    expect(groups[1].actionable_since).not.toBeNull();
    expect(groups[0].fingerprint).not.toBe(groups[1].fingerprint);
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM friction_incident_evidence WHERE ticket_id=$1`,
          [t.id],
        )
      ).rows[0].n,
    ).toBe(6);
    expect(
      (
        await db.query(
          `SELECT DISTINCT incident_id FROM friction_signals WHERE id=ANY($1::uuid[])`,
          [rs.flatMap((r) => r.signalIds)],
        )
      ).rows,
    ).toEqual([{ incident_id: second.errorGroupId }]);
    const job = (
      await db.query(
        `SELECT source_id,publication_generation FROM error_group_jobs WHERE error_group_id=$1`,
        [second.errorGroupId],
      )
    ).rows[0];
    expect(job).toEqual({ source_id: second.errorGroupId, publication_generation: 2 });
    await db.query(
      `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status) VALUES($1,$2,2,'active')`,
      [t.id, second.errorGroupId],
    );
    await store.unpublish(db, t);
    expect(
      (await db.query(`SELECT status FROM friction_fix_attempts WHERE ticket_id=$1`, [t.id]))
        .rows[0].status,
    ).toBe('superseded');
    expect(
      (
        await db.query(`SELECT status FROM error_group_jobs WHERE error_group_id=$1`, [
          second.errorGroupId,
        ])
      ).rows[0].status,
    ).toBe('failed');
  });
  it('folds matches and decisions with fresh target arrivals but never copies checks', async () => {
    const source = await ticket();
    const target = await ticket();
    await checked(target, ['confirmed', 'confirmed', 'confirmed']);
    await store.activateGeneration(db, target, await store.cohortStats(db, target), 'Save');
    const rs = await checked(source, ['confirmed', 'confirmed', 'confirmed']);
    await store.reserveDecision(db, rs[0]!.signalIds[0]!, scope);
    await store.commitDecision(db, rs[0]!.signalIds[0]!, {
      decision: 'created',
      ticketId: source.id,
      decidedBy: 'strong',
    });
    await store.foldInto(db, source, target);
    expect((await store.cohortStats(db, target)).counted).toBe(3);
    expect(
      (
        await db.query(
          `SELECT matched_count,next_arrival_number::text FROM friction_tickets WHERE id=$1`,
          [target.id],
        )
      ).rows[0],
    ).toEqual({ matched_count: 6, next_arrival_number: '6' });
    expect(
      (await db.query(`SELECT status,merged_into FROM friction_tickets WHERE id=$1`, [source.id]))
        .rows[0],
    ).toEqual({ status: 'merged', merged_into: target.id });
    expect(
      (
        await db.query(
          `SELECT ticket_id,decided_by FROM friction_observation_decisions WHERE signal_id=$1`,
          rs[0]!.signalIds,
        )
      ).rows[0],
    ).toEqual({ ticket_id: target.id, decided_by: 'fold' });
    expect((await store.verifiedEvidence(db, target)).signalIds.sort()).not.toEqual(
      rs.flatMap((r) => r.signalIds).sort(),
    );
  });
  it('keeps resolved generations published', async () => {
    const t = await ticket();
    await checked(t, ['confirmed', 'confirmed', 'confirmed']);
    const g = await store.activateGeneration(db, t, await store.cohortStats(db, t), 'Save');
    await db.query(`UPDATE error_groups SET fix_substate='resolved' WHERE id=$1`, [g.errorGroupId]);
    await store.unpublish(db, t);
    expect(
      (await db.query(`SELECT status FROM friction_tickets WHERE id=$1`, [t.id])).rows[0].status,
    ).toBe('published');
  });
  it('preserves the claimed fold job lease while triggering target confirmation', async () => {
    const source = await ticket();
    const target = await ticket();
    await checked(target, ['confirmed', 'confirmed', 'confirmed']);
    await store.activateGeneration(db, target, await store.cohortStats(db, target), 'Save');
    await matches(source, 10);
    const job = await db.query(
      `INSERT INTO error_group_jobs(project_id,ticket_id,job_type,status,worker_id,lease_expires_at)
      VALUES($1,$2,'friction_confirm','claimed','test-worker',now()+interval '5 minutes') RETURNING id`,
      [scope.projectId, source.id],
    );
    expect((await store.foldInto(db, source, target)).confirmNeeded).toBe(true);
    expect(
      (
        await db.query(`SELECT status,worker_id FROM error_group_jobs WHERE id=$1`, [
          job.rows[0].id,
        ])
      ).rows[0],
    ).toEqual({ status: 'claimed', worker_id: 'test-worker' });
    expect(
      (
        await db.query(
          `SELECT status FROM error_group_jobs WHERE ticket_id=$1 AND job_type='friction_confirm'`,
          [target.id],
        )
      ).rows,
    ).toEqual([{ status: 'pending' }]);
    expect(
      (
        await db.query(
          `SELECT evidence_version,reconcile_needed FROM friction_tickets WHERE id=$1`,
          [target.id],
        )
      ).rows[0],
    ).toEqual({ evidence_version: 2, reconcile_needed: true });
  });
  it('publishes the complete confirmed cohort and preserves its cutoff', async () => {
    const t = await ticket();
    const rs = await checked(t, ['confirmed', 'confirmed', 'confirmed'], 8);
    await db.query(
      `UPDATE friction_tickets SET fixed_at=now()-interval '10 days',cohort_cutoff=now()-interval '10 days' WHERE id=$1`,
      [t.id],
    );
    expect((await store.verifiedEvidence(db, t)).sessions).toBe(0);
    const generation = await store.activateGeneration(
      db,
      t,
      await store.cohortStats(db, t),
      'Save',
    );
    expect(
      (
        await db.query(
          `SELECT signal_id FROM friction_incident_evidence WHERE error_group_id=$1 ORDER BY signal_id`,
          [generation.errorGroupId],
        )
      ).rows.map((r) => r.signal_id),
    ).toEqual(rs.flatMap((r) => r.signalIds).sort());
    expect(
      (
        await db.query(
          `SELECT fixed_at IS NULL AS cleared,cohort_cutoff=now()-interval '10 days' AS kept FROM friction_tickets WHERE id=$1`,
          [t.id],
        )
      ).rows[0],
    ).toEqual({ cleared: true, kept: true });
  });
  it('rejects observations outside the immutable batch manifest and keeps discarded batches closed', async () => {
    const t = await ticket();
    const [r] = await matches(t, 1);
    const b = (await store.selectBatch(db, t, randomUUID()))!;
    expect(
      await store.stageCheck(db, b.id, {
        ...r!,
        signalIds: [randomUUID()],
        outcome: 'confirmed',
        model: 'test',
      }),
    ).toBe(false);
    expect(
      await store.stageCheck(db, b.id, {
        ...r!,
        sessionId: randomUUID(),
        outcome: 'confirmed',
        model: 'test',
      }),
    ).toBe(false);
    await store.discardBatch(db, b.id);
    expect(await store.stageCheck(db, b.id, { ...r!, outcome: 'confirmed', model: 'test' })).toBe(
      false,
    );
    expect((await store.finalizeBatch(db, t, b.id)).finalized).toBe(false);
  });
  it('retains microsecond precision when filtering the fixed cohort', async () => {
    const t = await ticket();
    const rs = await checked(t, ['confirmed', 'confirmed']);
    await db.query(
      `UPDATE friction_tickets SET cohort_cutoff='2026-01-01 00:00:00.123456+00' WHERE id=$1`,
      [t.id],
    );
    await db.query(
      `UPDATE friction_ticket_matches SET occurred_at='2026-01-01 00:00:00.123456+00' WHERE ticket_id=$1 AND session_id=$2`,
      [t.id, rs[0]!.sessionId],
    );
    await db.query(
      `UPDATE friction_ticket_matches SET occurred_at='2026-01-01 00:00:00.123457+00' WHERE ticket_id=$1 AND session_id=$2`,
      [t.id, rs[1]!.sessionId],
    );
    expect((await store.cohortStats(db, t)).counted).toBe(1);
    expect((await store.verifiedEvidence(db, t, { days: null })).signalIds).toEqual(
      rs[1]!.signalIds,
    );
  });
  it('shortlists scoped live tickets and searches only matching embedding models deterministically', async () => {
    const vector = Array.from({ length: EMBEDDING_DIMS }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const t = await store.createTicket(
      db,
      { ...scope, name: 'Save', control: 'Save', what_happened: 'Fails', kind: 'defect' },
      vector,
    );
    await db.query(`UPDATE friction_tickets SET screens_confirmed=ARRAY['/save'] WHERE id=$1`, [
      t.id,
    ]);
    const wrong = await store.createTicket(
      db,
      { ...scope, name: 'Other', control: 'Other', what_happened: 'Other', kind: 'ux_insight' },
      vector,
    );
    await db.query(`UPDATE friction_tickets SET embedding_model='other' WHERE id=$1`, [wrong.id]);
    expect(t.embedding_model).toBe(EMBEDDING_MODEL);
    expect(
      (await store.nearestTickets(db, scope, vector, 10, ['tracking'])).map((r) => r.id),
    ).toEqual([t.id]);
    expect(
      (await store.shortlistTickets(db, scope, ['/save'], null)).map(
        (r) => r.id,
      ),
    ).toContain(t.id);
    await db.query(
      `UPDATE friction_tickets SET status='archived' WHERE id=$1`,
      [t.id],
    );
    expect(
      await store.nearestTickets(db, scope, vector, 10, ['tracking', 'archived', 'merged']),
    ).toEqual([]);
    expect(
      (await store.shortlistTickets(db, scope, ['/save'], vector)).map((r) => r.id),
    ).not.toContain(t.id);
    expect(
      await store.shortlistTickets(
        db,
        { ...scope, environmentId: randomUUID() },
        ['/save'],
        vector,
      ),
    ).toEqual([]);
  });
});

describe('ticket publication bar', () => {
  const stats = (
    counted: number,
    confirmed: number,
    confirmedUsers = 2,
    identityKnown = true,
  ): store.CohortStats => ({
    counted,
    confirmed,
    confirmedUsers,
    identityKnown,
    refuted: counted - confirmed,
    inconclusive: 0,
  });
  it('passes at forty percent with three confirmations and diverse known identities', () => {
    expect(
      store.evaluateBar(stats(7, 3), { status: 'tracking', fixSubstate: null }),
    ).toBe('passes');
    expect(
      store.evaluateBar(stats(7, 3, 0, false), {
        status: 'tracking',
        fixSubstate: null,
      }),
    ).toBe('passes');
    expect(
      store.evaluateBar(stats(7, 3, 1), {
        status: 'tracking',
        fixSubstate: null,
      }),
    ).toBe('undecided');
  });
  it('uses the lower failure bar only for published unresolved tickets', () => {
    expect(store.evaluateBar(stats(16, 4), { status: 'published', fixSubstate: 'none' })).toBe(
      'undecided',
    );
    expect(store.evaluateBar(stats(15, 3), { status: 'published', fixSubstate: 'none' })).toBe(
      'fails',
    );
    expect(store.evaluateBar(stats(15, 3), { status: 'published', fixSubstate: 'resolved' })).toBe(
      'undecided',
    );
    expect(store.evaluateBar(stats(3, 2), { status: 'published', fixSubstate: 'none' })).toBe(
      'fails',
    );
  });
});
