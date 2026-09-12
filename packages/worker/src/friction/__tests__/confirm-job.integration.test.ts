import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as db from '../../db.js';
import * as store from '../tickets-db.js';
import {
  processFrictionReconcile,
  scheduleFrictionReconciliation,
} from '../reconcile-job.js';
import {
  requestFix,
  transaction,
  assertFixAttemptCurrent,
  recordAttemptPr,
  applyPrEvent,
} from '../fix-attempts.js';
import {
  processTicketInvestigation,
  beginInvestigation,
  type TicketInvestigateJob,
} from '../investigate-ticket.js';
import {
  processFrictionConfirm,
  prepareConfirmationTransition,
  applyConfirmationTransition,
  type ConfirmJobDeps,
} from '../confirm-job.js';
import { purgeDiagnosisDecisions } from '../../__tests__/purge-diagnosis-decisions.js';
import { purgeJobUsage } from '../../__tests__/purge-job-usage.js';
const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
describeDb('confirmation job', () => {
  const pool = db.getPool();
  let orgId: string;
  let projectId: string;
  let environmentId: string;
  beforeEach(async () => {
    orgId = (
      await pool.query(
        `INSERT INTO orgs(name) VALUES('confirm-job-test') RETURNING id`,
      )
    ).rows[0].id;
    projectId = (
      await pool.query(
        `INSERT INTO projects(org_id,name) VALUES($1,'confirm') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    environmentId = (
      await pool.query(
        `INSERT INTO environments(project_id,name) VALUES($1,'production') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await purgeJobUsage(
      pool,
      (
        await pool.query(
          'SELECT id FROM error_group_jobs WHERE project_id=$1',
          [projectId],
        )
      ).rows.map((r) => r.id),
    );
    await pool.query(
      `DELETE FROM friction_pr_events WHERE ticket_id IN(SELECT id FROM friction_tickets WHERE project_id=$1)`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM friction_fix_failures WHERE job_id IN(SELECT id FROM error_group_jobs WHERE project_id=$1)`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM friction_investigation_results WHERE ticket_id IN(SELECT id FROM friction_tickets WHERE project_id=$1)`,
      [projectId],
    );
    await purgeDiagnosisDecisions(pool, projectId);
    await pool.query('DELETE FROM error_group_jobs WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query(
      'DELETE FROM friction_incident_evidence WHERE ticket_id IN(SELECT id FROM friction_tickets WHERE project_id=$1)',
      [projectId],
    );
    await pool.query(
      'UPDATE friction_signals SET incident_id=NULL WHERE project_id=$1',
      [projectId],
    );
    await pool.query(
      'DELETE FROM friction_fix_attempts WHERE ticket_id IN(SELECT id FROM friction_tickets WHERE project_id=$1)',
      [projectId],
    );
    await pool.query('DELETE FROM error_groups WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query('DELETE FROM friction_tickets WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query('DELETE FROM sessions WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM environments WHERE project_id=$1', [
      projectId,
    ]);
    await pool.query('DELETE FROM end_users WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await pool.query('DELETE FROM orgs WHERE id=$1', [orgId]);
  });
  afterAll(() => db.closePool());
  const ticket = async () => {
    const tx = await pool.connect();
    try {
      return await store.createTicket(tx, {
        projectId,
        environmentId,
        name: 'Save error',
        control: 'Save',
        what_happened: 'Error appeared',
        kind: 'defect',
        steps: 'Unverified draft',
      });
    } finally {
      tx.release();
    }
  };
  async function matches(t: store.TicketRow, count: number) {
    const tx = await pool.connect();
    const ids = [];
    try {
      for (let i = 0; i < count; i++) {
        const sessionId = randomUUID();
        await tx.query('BEGIN');
        await tx.query(
          `INSERT INTO sessions(id,project_id,environment_id,started_at) VALUES($1,$2,$3,now())`,
          [sessionId, projectId, environmentId],
        );
        const signalId = (
          await tx.query(
            `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,'narrative',$4,'/save',now(),1) RETURNING id`,
            [sessionId, projectId, environmentId, randomUUID()],
          )
        ).rows[0].id as string;
        await store.recordMatch(tx, {
          ticket: t,
          sessionId,
          endUserId: null,
          signalIds: [signalId],
          source: 'cheap',
          occurredAt: new Date().toISOString(),
          screen: '/save',
        });
        await tx.query('COMMIT');
        ids.push({ sessionId, signalId });
      }
      return ids;
    } finally {
      tx.release();
    }
  }
  async function claim(t: store.TicketRow, type = 'friction_confirm') {
    const r = (
      await pool.query(
        `INSERT INTO error_group_jobs(project_id,ticket_id,job_type,status,worker_id,lease_generation,lease_expires_at) VALUES($1,$2,$3,'claimed','confirm-test',1,now()+interval '5 minutes') RETURNING id`,
        [projectId, t.id, type],
      )
    ).rows[0];
    return {
      id: r.id,
      projectId,
      ticketId: t.id,
      jobType: type,
      workerId: 'confirm-test',
      leaseGeneration: '1',
      errorGroupId: null,
      sessionId: null,
      batchId: null,
      attempts: 0,
    } as db.ClaimedJob & { ticketId: string };
  }
  function deps(outcomes: string[]): ConfirmJobDeps {
    let index = 0;
    return {
      client: {
        modelName: 'test',
        complete: async ({ user }) => {
          const id = /"id":"([a-f0-9-]{36})"/.exec(user)![1];
          return {
            text: JSON.stringify({
              outcome: outcomes[index++] ?? 'confirmed',
              evidenceLines: ['L1'],
              signalIds: [id],
              note: 'Click Save; error appears.',
              costToUser: 'lost_time',
            }),
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            stopReason: 'end_turn',
          };
        },
      },
      loadRecording: async () => ({
        timelineText: 'L1: Click Save',
        offsetsMs: [0, 1, 2, 3],
        envelopes: [],
      }),
      capture: async () => ({
        frames: [
          {
            offsetMs: 0,
            pair: 'a',
            png: Buffer.from('png'),
            modelPng: Buffer.from('png'),
          },
        ],
        assetsMissing: false,
      }),
      dailyCap: 200,
    };
  }
  it('reconciles a discarded batch from finalized evidence without selecting another batch', async () => {
    const t = await ticket();
    const rs = await matches(t, 3);
    await transaction(async (tx) => {
      const batch = (await store.selectBatch(tx, t, randomUUID()))!;
      for (const r of rs)
        await store.stageCheck(tx, batch.id, {
          sessionId: r.sessionId,
          signalIds: [r.signalId],
          outcome: 'confirmed',
          note: 'Save shows an error.',
          model: 'test',
          framesOk: true,
        });
      await store.finalizeBatch(tx, t, batch.id);
      // A saved batch may be discarded after another mutation. Only finalized
      // evidence can justify publication when the scheduler retries the decision.
      const saved = (
        await tx.query(
          `INSERT INTO friction_confirm_batches(ticket_id,job_id,manifest,arrival_boundary_at_select,live_generation_at_select,status_at_select) VALUES($1,$2,'[]',0,0,'tracking') RETURNING id`,
          [t.id, randomUUID()],
        )
      ).rows[0];
      await store.discardBatch(tx, saved.id);
    });
    const job = await claim(t, 'friction_reconcile');
    await expect(
      processFrictionReconcile(
        job,
        { client: deps([]).client },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.getTicket(pool, projectId, t.id)).toMatchObject({
      status: 'published',
      live_generation: 1,
      matched_count: 3,
      reconcile_needed: false,
    });
    expect(
      (
        await pool.query(
          `SELECT job_type,status FROM error_group_jobs WHERE ticket_id=$1 ORDER BY job_type`,
          [t.id],
        )
      ).rows,
    ).toEqual([
      { job_type: 'friction_reconcile', status: 'completed' },
      { job_type: 'investigate', status: 'pending' },
    ]);
  });
  it('schedules a fully checked decision once and pauses queued reconciliation with either kill switch', async () => {
    const t = await ticket();
    await pool.query(
      'UPDATE friction_tickets SET reconcile_needed=true WHERE id=$1',
      [t.id],
    );
    expect(await scheduleFrictionReconciliation()).toBe(1);
    expect(await scheduleFrictionReconciliation()).toBe(0);
    vi.stubEnv('FRICTION_CONFIRM_MAX_CONCURRENT', '0');
    expect(await db.claimJob('reconcile-test', 60_000)).toBeNull();
    vi.stubEnv('FRICTION_CONFIRM_MAX_CONCURRENT', '1');
    vi.stubEnv('FRICTION_MATCH_MAX_CONCURRENT', '0');
    expect(await db.claimJob('reconcile-test', 60_000)).toBeNull();
    vi.stubEnv('FRICTION_MATCH_MAX_CONCURRENT', '2');
    expect(await db.claimJob('reconcile-test', 60_000)).toMatchObject({
      jobType: 'friction_reconcile',
      ticketId: t.id,
    });
  });
  it('lets retirement cancel a waiting investigator before it holds the job lease row', async () => {
    const t = await publish(await ticket());
    const row = (
      await pool.query(
        `UPDATE error_group_jobs SET status='claimed',worker_id='cancel-test',lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE ticket_id=$1 AND job_type='investigate' RETURNING id,error_group_id`,
        [t.id],
      )
    ).rows[0];
    const job = {
      ...(await store.getTicket(pool, projectId, t.id)),
      id: row.id,
      projectId,
      ticketId: t.id,
      errorGroupId: row.error_group_id,
      publicationGeneration: 1,
      workerId: 'cancel-test',
      leaseGeneration: '1',
    } as TicketInvestigateJob;
    const owner = await pool.connect();
    const worker = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await owner.query('BEGIN');
      await store.lockPublication(owner, environmentId);
      await store.getTicket(owner, projectId, t.id, true);
      await worker.query('BEGIN');
      const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      running = beginInvestigation(worker, job).then(
        (value) => value,
        (error) => error,
      );
      for (let i = 0; i < 100; i++) {
        if (
          (
            await pool.query(
              'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
              [pid],
            )
          ).rows[0].blocked
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // NOWAIT proves the waiter did not grab the lease before the environment.
      await owner.query(
        'SELECT id FROM error_group_jobs WHERE id=$1 FOR UPDATE NOWAIT',
        [job.id],
      );
      await store.unpublish(owner, t);
      await owner.query('COMMIT');
      expect(await running).toMatchObject({ name: 'LeaseLostError' });
    } finally {
      await owner.query('ROLLBACK');
      await running;
      await worker.query('ROLLBACK');
      owner.release();
      worker.release();
    }
  });
  it('cancels a delivery reservation waiting behind retirement without locking its lease first', async () => {
    const t = await publish(await ticket());
    const incident = (await store.liveIncident(pool, t))!;
    const attempt = (
      await pool.query(
        `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status) VALUES($1,$2,1,'active') RETURNING id`,
        [t.id, incident.id],
      )
    ).rows[0];
    await pool.query(
      `UPDATE error_groups SET fix_substate='fixing',status='fixing' WHERE id=$1`,
      [incident.id],
    );
    const row = (
      await pool.query(
        `INSERT INTO error_group_jobs(project_id,ticket_id,error_group_id,fix_attempt_id,publication_generation,job_type,status,worker_id,lease_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,'fix','claimed','delivery-cancel',1,now()+interval '5 minutes') RETURNING id`,
        [projectId, t.id, incident.id, attempt.id],
      )
    ).rows[0];
    const lease = {
      id: row.id,
      workerId: 'delivery-cancel',
      leaseGeneration: '1',
      projectId,
      errorGroupId: incident.id,
      sessionId: null,
    };
    const owner = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await owner.query('BEGIN');
      await store.lockPublication(owner, environmentId);
      await store.getTicket(owner, projectId, t.id, true);
      const pid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      running = db
        .reserveDelivery(
          incident.id,
          projectId,
          {
            operationKey: `fix:${attempt.id}`,
            branchName: 'fix/save',
            posture: 'ready',
            diffHash: 'hash',
            candidateDiff: 'diff',
          },
          lease,
        )
        .then(
          (value) => value,
          (error) => error,
        );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (
          await pool.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',
            [pid],
          )
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await owner.query(
        'SELECT id FROM error_group_jobs WHERE id=$1 FOR UPDATE NOWAIT',
        [lease.id],
      );
      await store.unpublish(owner, t);
      await owner.query('COMMIT');
      expect(await running).toMatchObject({ name: 'LeaseLostError' });
      expect(
        (
          await pool.query(
            'SELECT status FROM friction_fix_attempts WHERE id=$1',
            [attempt.id],
          )
        ).rows[0].status,
      ).toBe('superseded');
      expect(
        (
          await pool.query(
            'SELECT 1 FROM delivery_reservations WHERE error_group_id=$1',
            [incident.id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await owner.query('ROLLBACK');
      await running;
      owner.release();
    }
  });
  it.each(['failure', 'reservation', 'status'] as const)(
    'rejects %s writes when the lease expires while waiting for publication',
    async (operation) => {
      const t = await publish(await ticket());
      const incident = (await store.liveIncident(pool, t))!;
      const attempt = (
        await pool.query(
          `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status) VALUES($1,$2,1,'active') RETURNING id`,
          [t.id, incident.id],
        )
      ).rows[0];
      await pool.query(
        `UPDATE error_groups SET fix_substate='fixing',status='fixing' WHERE id=$1`,
        [incident.id],
      );
      const row = (
        await pool.query(
          `INSERT INTO error_group_jobs(project_id,ticket_id,error_group_id,fix_attempt_id,publication_generation,job_type,status,worker_id,lease_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,'fix','claimed','expired-waiter',1,now()+interval '5 minutes') RETURNING id`,
          [projectId, t.id, incident.id, attempt.id],
        )
      ).rows[0];
      const lease = {
        id: row.id,
        projectId,
        errorGroupId: incident.id,
        sessionId: null,
        workerId: 'expired-waiter',
        leaseGeneration: '1',
      };
      const owner = await pool.connect();
      let running: Promise<unknown> | undefined;
      try {
        await owner.query('BEGIN');
        await store.lockPublication(owner, environmentId);
        const pid = (await owner.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        await pool.query(
          `UPDATE error_group_jobs SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`,
          [lease.id],
        );
        const write =
          operation === 'failure'
            ? db.failJob(
                lease.id,
                lease.workerId,
                lease.leaseGeneration,
                'Model failed',
              )
            : operation === 'reservation'
              ? db.reserveDelivery(
                  incident.id,
                  projectId,
                  {
                    operationKey: `fix:${attempt.id}`,
                    branchName: 'fix/save',
                    posture: 'ready',
                    diffHash: 'hash',
                    candidateDiff: 'diff',
                  },
                  lease,
                )
              : db.updateGroupStatus(
                  incident.id,
                  projectId,
                  'awaiting_approval',
                  undefined,
                  lease,
                );
        running = write.then(
          (value) => value,
          (error) => error,
        );
        let blockedWhileOwned = false;
        for (let i = 0; i < 100; i++) {
          blockedWhileOwned = (
            await pool.query(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a,error_group_jobs j WHERE j.id=$2 AND $1=ANY(pg_blocking_pids(a.pid)) AND a.xact_start<j.lease_expires_at) blocked`,
              [pid, lease.id],
            )
          ).rows[0].blocked;
          if (blockedWhileOwned) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blockedWhileOwned).toBe(true);
        let expired = false;
        for (let i = 0; i < 300; i++) {
          expired = (
            await pool.query(
              'SELECT lease_expires_at<clock_timestamp() expired FROM error_group_jobs WHERE id=$1',
              [lease.id],
            )
          ).rows[0].expired;
          if (expired) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(expired).toBe(true);
        await owner.query('COMMIT');
        const result = await running;
        if (operation === 'failure') expect(result).toBe(false);
        else expect(result).toMatchObject({ name: 'LeaseLostError' });
        expect(
          (
            await pool.query(
              'SELECT status,attempts FROM error_group_jobs WHERE id=$1',
              [lease.id],
            )
          ).rows[0],
        ).toEqual({ status: 'claimed', attempts: 0 });
        expect(
          (
            await pool.query('SELECT status FROM error_groups WHERE id=$1', [
              incident.id,
            ])
          ).rows[0].status,
        ).toBe('fixing');
        expect(
          (
            await pool.query(
              'SELECT 1 FROM delivery_reservations WHERE error_group_id=$1',
              [incident.id],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await owner.query('ROLLBACK');
        await running;
        owner.release();
      }
    },
  );
  it('retries a changed fold target without another batch, preserving the unresolved marker', async () => {
    const source = await publish(await ticket());
    await embed(source);
    await transaction((tx) => store.unpublish(tx, source));
    const target = await publish(await ticket());
    await embed(target);
    const client = {
      modelName: 'test',
      complete: async () => {
        // This transaction must finish during classification: models own no locks.
        await transaction(async (tx) => {
          await store.lockPublication(tx, environmentId);
          await store.unpublish(tx, target);
        });
        return {
          text: JSON.stringify({ oneFix: true, reason: 'Same Save handler' }),
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stopReason: 'end_turn',
        };
      },
    };
    await expect(
      processFrictionReconcile(
        await claim(source, 'friction_reconcile'),
        { client },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.getTicket(pool, projectId, source.id)).toMatchObject({
      status: 'unpublished',
      reconcile_needed: true,
      fold_retries: 1,
    });
    expect(await store.nextConfirmationAt(pool, source.id)).toBeNull();
    await expect(
      processFrictionReconcile(
        await claim(source, 'friction_reconcile'),
        { client: deps([]).client },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.getTicket(pool, projectId, source.id)).toMatchObject({
      status: 'published',
      live_generation: 2,
      reconcile_needed: false,
    });
  });
  it('fences a stale reconciliation decision after evidence changes during classification', async () => {
    const source = await publish(await ticket());
    await embed(source);
    await transaction((tx) => store.unpublish(tx, source));
    await embed(await publish(await ticket()));
    const client = {
      modelName: 'test',
      complete: async () => {
        await pool.query(
          'UPDATE friction_tickets SET evidence_version=evidence_version+1 WHERE id=$1',
          [source.id],
        );
        return {
          text: JSON.stringify({ oneFix: false, reason: 'Different handler' }),
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stopReason: 'end_turn',
        };
      },
    };
    await expect(
      processFrictionReconcile(
        await claim(source, 'friction_reconcile'),
        { client },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.getTicket(pool, projectId, source.id)).toMatchObject({
      status: 'unpublished',
      live_generation: 1,
      reconcile_needed: true,
    });
  });
  it('serializes first-match admission with an in-flight recording identity change', async () => {
    const t = await ticket();
    const users = (
      await pool.query(
        `INSERT INTO end_users(project_id,external_user_id) VALUES($1,$2),($1,$3) RETURNING id`,
        [projectId, randomUUID(), randomUUID()],
      )
    ).rows;
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions(id,project_id,environment_id,end_user_id,started_at) VALUES($1,$2,$3,$4,now())`,
      [sessionId, projectId, environmentId, users[0].id],
    );
    const signalId = (
      await pool.query(
        `INSERT INTO friction_signals(session_id,project_id,environment_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,'narrative',$4,'/save',now(),1) RETURNING id`,
        [sessionId, projectId, environmentId, randomUUID()],
      )
    ).rows[0].id;
    const identity = await pool.connect();
    const admission = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await identity.query('BEGIN');
      await identity.query('SELECT friction_set_session_identity($1,$2,$3)', [
        projectId,
        sessionId,
        users[1].id,
      ]);
      await admission.query('BEGIN');
      const pid = (await admission.query('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      running = store
        .recordMatch(admission, {
          ticket: t,
          sessionId,
          endUserId: users[0].id,
          signalIds: [signalId],
          occurredAt: new Date().toISOString(),
          screen: '/save',
          source: 'cheap',
        })
        .then(
          (value) => value,
          (error) => error,
        );
      for (let i = 0; i < 100; i++) {
        if (
          (
            await pool.query(
              'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
              [pid],
            )
          ).rows[0].blocked
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await identity.query('COMMIT');
      expect(await running).toMatchObject({ newRecording: true });
      await admission.query('COMMIT');
      expect(
        (
          await pool.query(
            'SELECT end_user_id FROM friction_ticket_matches WHERE ticket_id=$1',
            [t.id],
          )
        ).rows[0].end_user_id,
      ).toBe(users[1].id);
    } finally {
      await identity.query('ROLLBACK');
      await running;
      await admission.query('ROLLBACK');
      identity.release();
      admission.release();
    }
  });
  it.each(['unpublish', 'regress'] as const)(
    'reconciliation applies the %s transition over finalized evidence',
    async (transition) => {
      const t = await publish(await ticket());
      if (transition === 'regress') {
        await pool.query(
          `UPDATE friction_tickets SET fixed_at=now(),cohort_cutoff=now() WHERE id=$1`,
          [t.id],
        );
        await pool.query(
          `UPDATE error_groups SET fix_substate='resolved' WHERE ticket_id=$1`,
          [t.id],
        );
      }
      const rs = await matches(t, transition === 'regress' ? 3 : 10);
      await transaction(async (tx) => {
        const current = (await store.getTicket(tx, projectId, t.id))!;
        const batch = (await store.selectBatch(tx, current, randomUUID()))!;
        for (const r of rs)
          await store.stageCheck(tx, batch.id, {
            sessionId: r.sessionId,
            signalIds: [r.signalId],
            outcome: transition === 'regress' ? 'confirmed' : 'refuted',
            note: 'Save error returned',
            model: 'test',
            framesOk: true,
          });
        await store.finalizeBatch(tx, current, batch.id);
        await tx.query(
          'UPDATE friction_tickets SET reconcile_needed=true WHERE id=$1',
          [t.id],
        );
      });
      await expect(
        processFrictionReconcile(
          await claim(t, 'friction_reconcile'),
          { client: deps([]).client },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
      expect(await store.getTicket(pool, projectId, t.id)).toMatchObject({
        status: transition === 'regress' ? 'published' : 'unpublished',
        live_generation: transition === 'regress' ? 2 : 1,
        reconcile_needed: false,
      });
      if (transition === 'regress') {
        const generation = (
          await pool.query(
            'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 AND generation=2',
            [t.id],
          )
        ).rows;
        expect(generation.map((r) => r.signal_id).sort()).toEqual(
          rs.map((r) => r.signalId).sort(),
        );
      }
    },
  );
  it('runs the ticket investigator on confirmed input, serializes fix requests, and keeps stale delivery as an orphan', async () => {
    const t = await ticket();
    const recordings = await matches(t, 4);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps(['confirmed', 'confirmed', 'confirmed', 'refuted']),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const j = (
      await pool.query(
        `UPDATE error_group_jobs SET status='claimed',worker_id='ticket-test',lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE ticket_id=$1 AND job_type='investigate' RETURNING id,error_group_id`,
        [t.id],
      )
    ).rows[0];
    const job = {
      id: j.id,
      projectId,
      ticketId: t.id,
      errorGroupId: j.error_group_id,
      publicationGeneration: 1,
      workerId: 'ticket-test',
      leaseGeneration: '1',
      sessionId: null,
    } as TicketInvestigateJob;
    let supplied: string[] = [];
    await expect(
      processTicketInvestigation(
        job,
        (await db.getErrorGroup(j.error_group_id, projectId))!,
        new AbortController().signal,
        {
          apiKey: 'test',
          checkout: async () => ({
            reader: {
              readFile: async () => '',
              grep: async () => '',
              list: async () => '',
              exists: async () => [],
            },
            tree: 'src/save.ts',
            headSha: 'abc',
            close: async () => {},
          }),
          investigate: async (_key, input) => {
            supplied = input.confirmedSignalIds!;
            return {
              status: 'verdict',
              investigatedCommit: 'abc',
              costUsd: 0,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              verdict: {
                codeCause: true,
                confidence: 'high',
                reason: 'The save handler drops input.',
                explains: supplied.slice(0, 2),
                doesNotExplain: supplied.slice(2),
                evidence: [
                  {
                    path: 'src/save.ts',
                    detail: 'Drops input',
                    symptomLink: 'Data lost',
                  },
                ],
                agentTaskBrief: 'Preserve input.',
              },
            };
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(supplied.sort()).toEqual(
      recordings
        .slice(0, 3)
        .map((r) => r.signalId)
        .sort(),
    );
    const requests = await Promise.all([
      transaction((tx) => requestFix(tx, projectId, t.id, 1, 'human')),
      transaction((tx) => requestFix(tx, projectId, t.id, 1, 'human')),
    ]);
    expect(requests.map((r) => r.status).sort()).toEqual([
      'created',
      'outstanding',
    ]);
    const first = requests.find((r) => r.status === 'created');
    if (first?.status !== 'created') throw new Error('Missing fix');
    await pool.query(
      `UPDATE error_group_jobs SET status='claimed',worker_id='ticket-test',lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`,
      [first.jobId],
    );
    const fixJob = { ...job, id: first.jobId, fixAttemptId: first.attemptId };
    await pool.query(
      `UPDATE projects SET friction_autonomy='auto_fix' WHERE id=$1`,
      [projectId],
    );
    await pool.query(
      `UPDATE friction_fix_attempts SET requested_by='auto' WHERE id=$1`,
      [first.attemptId],
    );
    vi.stubEnv('FRICTION_MAX_OPEN_FIX_PRS', '0');
    await expect(assertFixAttemptCurrent(fixJob, true)).rejects.toThrow('cap');
    vi.stubEnv('FRICTION_MAX_OPEN_FIX_PRS', '1');
    await assertFixAttemptCurrent(fixJob, true);
    await transaction(async (tx) => {
      await store.unpublish(tx, (await store.getTicket(tx, projectId, t.id))!);
    });
    await expect(assertFixAttemptCurrent(fixJob, true)).rejects.toThrow();
    expect(
      await recordAttemptPr(
        fixJob,
        'test/repo',
        'https://github.com/test/repo/pull/3',
        3,
      ),
    ).toBe(false);
    expect(
      (
        await pool.query(
          `SELECT event,applied FROM friction_pr_events WHERE fix_attempt_id=$1`,
          [first.attemptId],
        )
      ).rows,
    ).toEqual([{ event: 'orphan', applied: false }]);
    expect(
      (
        await pool.query(`SELECT status FROM error_groups WHERE id=$1`, [
          job.errorGroupId,
        ])
      ).rows[0].status,
    ).toBe('archived');
  });

  async function insightTicket() {
    const tx = await pool.connect();
    try {
      return await store.createTicket(tx, {
        projectId,
        environmentId,
        name: 'Export needs many clicks',
        control: 'Export',
        what_happened: 'Export required repeated clicks',
        kind: 'ux_insight',
        steps: 'Unverified draft',
      });
    } finally {
      tx.release();
    }
  }
  /** Like matches(), but every recording belongs to its own identified user. */
  async function identifiedMatches(t: store.TicketRow, count: number) {
    const tx = await pool.connect();
    try {
      for (let i = 0; i < count; i++) {
        const sessionId = randomUUID();
        await tx.query('BEGIN');
        const endUserId = (
          await tx.query(
            `INSERT INTO end_users(project_id,external_user_id) VALUES($1,$2) RETURNING id`,
            [projectId, `user-${sessionId}`],
          )
        ).rows[0].id as string;
        await tx.query(
          `INSERT INTO sessions(id,project_id,environment_id,end_user_id,started_at) VALUES($1,$2,$3,$4,now())`,
          [sessionId, projectId, environmentId, endUserId],
        );
        const signalId = (
          await tx.query(
            `INSERT INTO friction_signals(session_id,project_id,environment_id,end_user_id,signal_type,fingerprint,page_url_normalized,occurred_at,rule_version) VALUES($1,$2,$3,$4,'narrative',$5,'/export',now(),1) RETURNING id`,
            [sessionId, projectId, environmentId, endUserId, randomUUID()],
          )
        ).rows[0].id as string;
        await store.recordMatch(tx, {
          ticket: t,
          sessionId,
          endUserId,
          signalIds: [signalId],
          source: 'cheap',
          occurredAt: new Date().toISOString(),
          screen: '/export',
        });
        await tx.query('COMMIT');
      }
    } finally {
      tx.release();
    }
  }
  const investigateJobs = async (t: store.TicketRow) =>
    (
      await pool.query<{ generation: number; status: string }>(
        `SELECT publication_generation AS generation, status FROM error_group_jobs WHERE ticket_id=$1 AND job_type='investigate' ORDER BY created_at`,
        [t.id],
      )
    ).rows;

  it('refuses a fix for an insight even with a finished investigation, on every path', async () => {
    const t = await insightTicket();
    await identifiedMatches(t, 3);
    await expect(
      processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    await pool.query(
      `UPDATE error_groups SET investigation_status='done', root_cause='The export button offers no bulk action.',
       explained_signal_ids=(SELECT jsonb_agg(signal_id) FROM friction_incident_evidence WHERE ticket_id=$1) WHERE ticket_id=$1`,
      [t.id],
    );
    for (const requestedBy of ['human', 'auto'] as const) {
      await expect(transaction((tx) => requestFix(tx, projectId, t.id, 1, requestedBy))).resolves.toEqual({ status: 'not_fixable' });
    }
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM error_group_jobs WHERE ticket_id=$1 AND job_type IN ('fix','investigate')`, [t.id])).rows[0].n,
    ).toBe(0);
  });

  it('rejects a queued fix job for an insight before any provider write', async () => {
    const t = await insightTicket();
    await identifiedMatches(t, 3);
    await expect(
      processFrictionConfirm(await claim(t), deps([]), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const group = (await pool.query(`SELECT id FROM error_groups WHERE ticket_id=$1`, [t.id])).rows[0].id as string;
    const attempt = (await pool.query(
      `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,requested_by) VALUES($1,$2,1,'active','auto') RETURNING id`,
      [t.id, group],
    )).rows[0].id as string;
    await pool.query(`UPDATE error_groups SET fix_substate='fixing' WHERE id=$1`, [group]);
    const jobId = (await pool.query(
      `INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,ticket_id,publication_generation,fix_attempt_id,source_id,worker_id,lease_generation,lease_expires_at)
       VALUES($1,$2,'fix','claimed',$3,1,$4,$2,'fix-test',1,now()+interval '5 minutes') RETURNING id`,
      [projectId, group, t.id, attempt],
    )).rows[0].id as string;
    await expect(
      assertFixAttemptCurrent({ id: jobId, projectId, ticketId: t.id, publicationGeneration: 1, errorGroupId: group, fixAttemptId: attempt, workerId: 'fix-test', leaseGeneration: '1', jobType: 'fix', attempts: 0 } as never),
    ).rejects.toThrow(/Stale ticket fix attempt/);
  });

  async function deliveryFixture(
    requestedBy: 'human' | 'auto' = 'human',
  ): Promise<TicketInvestigateJob & { fixAttemptId: string }> {
    const t = await ticket();
    const recordings = await matches(t, 3);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps(['confirmed', 'confirmed', 'confirmed']),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const group = (
      await pool.query(
        `UPDATE error_groups SET investigation_status='done',root_cause='Save drops input',explained_signal_ids=$2::jsonb WHERE ticket_id=$1 RETURNING id`,
        [t.id, JSON.stringify(recordings.map((r) => r.signalId))],
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO diagnosis_decisions(error_group_id,project_id,outcome,decision_reason,diagnosis,model,prompt_version,basis,confidence) VALUES($1,$2,'code_fix','Save drops input','{"agentTaskBrief":"Preserve save input"}','test','test','friction_classify','high')`,
      [group.id, projectId],
    );
    if (requestedBy === 'auto')
      await pool.query(
        `UPDATE projects SET friction_autonomy='auto_fix' WHERE id=$1`,
        [projectId],
      );
    const request = await transaction((tx) =>
      requestFix(tx, projectId, t.id, 1, requestedBy),
    );
    if (request.status !== 'created') throw new Error('Expected fix attempt');
    const job = {
      id: request.jobId,
      projectId,
      ticketId: t.id,
      errorGroupId: group.id,
      publicationGeneration: 1,
      fixAttemptId: request.attemptId,
      workerId: 'delivery-test',
      leaseGeneration: '1',
      sessionId: null,
    } as TicketInvestigateJob & { fixAttemptId: string };
    await pool.query(
      `UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`,
      [job.id, job.workerId],
    );
    await db.reserveDelivery(
      job.errorGroupId,
      projectId,
      {
        operationKey: `fix:${job.fixAttemptId}`,
        branchName: `opslane/fix-${job.fixAttemptId}`,
        posture: 'draft',
        diffHash: 'test',
        candidateDiff: 'test',
      },
      job,
    );
    return job;
  }

  it('uses the ticket PR cap when the legacy draft cap is exhausted', async () => {
    await pool.query(`UPDATE projects SET draft_pr_cap=0 WHERE id=$1`, [
      projectId,
    ]);
    vi.stubEnv('FRICTION_MAX_OPEN_FIX_PRS', '1');
    const job = await deliveryFixture('auto');
    await expect(assertFixAttemptCurrent(job, true)).resolves.toBeUndefined();
    expect(
      (
        await pool.query(
          `SELECT state FROM delivery_reservations WHERE error_group_id=$1`,
          [job.errorGroupId],
        )
      ).rows,
    ).toEqual([{ state: 'reserved' }]);
  });

  it('a reclaimed fix keeps its active attempt and delivery slot when the older worker returns a PR', async () => {
    const job = await deliveryFixture();
    await pool.query(
      `UPDATE projects SET friction_autonomy='auto_fix' WHERE id=$1`,
      [projectId],
    );
    await pool.query(
      `UPDATE friction_fix_attempts SET requested_by='auto' WHERE id=$1`,
      [job.fixAttemptId],
    );
    await assertFixAttemptCurrent(job, true);
    await pool.query(
      `UPDATE error_group_jobs SET worker_id='new-worker',lease_generation=2 WHERE id=$1`,
      [job.id],
    );
    expect(
      await recordAttemptPr(
        job,
        'test/repo',
        'https://github.com/test/repo/pull/11',
        11,
      ),
    ).toBe(false);
    expect(
      (
        await pool.query(
          `SELECT status,pr_url,delivery_reserved_at IS NOT NULL AS reserved FROM friction_fix_attempts WHERE id=$1`,
          [job.fixAttemptId],
        )
      ).rows[0],
    ).toEqual({ status: 'active', pr_url: null, reserved: true });
    expect(
      (
        await pool.query(
          `SELECT event,applied FROM friction_pr_events WHERE fix_attempt_id=$1`,
          [job.fixAttemptId],
        )
      ).rows,
    ).toEqual([{ event: 'orphan', applied: false }]);
    const reclaimed = { ...job, workerId: 'new-worker', leaseGeneration: '2' };
    await expect(
      assertFixAttemptCurrent(reclaimed, true),
    ).resolves.toBeUndefined();
    expect(
      await recordAttemptPr(
        reclaimed,
        'test/repo',
        'https://github.com/test/repo/pull/11',
        11,
      ),
    ).toBe(true);
  });

  it.each(['closed', 'merged'] as const)(
    'releases a ticket delivery reservation when its current PR is %s',
    async (event) => {
      const job = await deliveryFixture();
      expect(
        await recordAttemptPr(
          job,
          'test/repo',
          'https://github.com/test/repo/pull/12',
          12,
        ),
      ).toBe(true);
      expect(
        await transaction((tx) =>
          applyPrEvent(tx, projectId, {
            ticketId: job.ticketId,
            errorGroupId: job.errorGroupId,
            attemptId: job.fixAttemptId,
            generation: 1,
            event,
            deliveryId: randomUUID(),
            occurredAt: new Date().toISOString(),
          }),
        ),
      ).toBe(true);
      expect(
        (
          await pool.query(
            `SELECT state FROM delivery_reservations WHERE error_group_id=$1`,
            [job.errorGroupId],
          )
        ).rows[0].state,
      ).toBe('closed');
    },
  );

  it('dead-lettered ticket investigation fails without changing the fix workflow', async () => {
    const t = await ticket();
    await matches(t, 3);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps(['confirmed', 'confirmed', 'confirmed']),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const row = (
      await pool.query(
        `UPDATE error_group_jobs SET status='claimed',worker_id='failure-test',lease_generation=1,lease_expires_at=now()+interval '5 minutes' WHERE ticket_id=$1 AND job_type='investigate' RETURNING id,error_group_id`,
        [t.id],
      )
    ).rows[0];
    const job = {
      id: row.id,
      projectId,
      ticketId: t.id,
      errorGroupId: row.error_group_id,
      publicationGeneration: 1,
      workerId: 'failure-test',
      leaseGeneration: '1',
      sessionId: null,
    } as TicketInvestigateJob;
    await transaction((tx) => beginInvestigation(tx, job));
    expect(
      await db.failJob(
        job.id,
        job.workerId,
        job.leaseGeneration,
        'Model unavailable',
        { exhaust: true },
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT investigation_status,fix_substate FROM error_groups WHERE id=$1`,
          [job.errorGroupId],
        )
      ).rows[0],
    ).toEqual({ investigation_status: 'failed', fix_substate: 'none' });
    expect(
      (await store.getTicket(pool, projectId, t.id))?.reinvestigate_needed,
    ).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT result->>'status' AS status FROM friction_investigation_results WHERE job_id=$1`,
          [job.id],
        )
      ).rows,
    ).toEqual([{ status: 'failed' }]);
  });

  it('publishes three of four checks with exactly verified evidence and a generation-stamped investigation', async () => {
    const t = await ticket();
    const recordings = await matches(t, 4);
    const job = await claim(t);
    await expect(
      processFrictionConfirm(
        job,
        deps(['confirmed', 'confirmed', 'confirmed', 'refuted']),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(
      (
        await pool.query(
          'SELECT status,live_generation,steps FROM friction_tickets WHERE id=$1',
          [t.id],
        )
      ).rows[0],
    ).toEqual({
      status: 'published',
      live_generation: 1,
      steps: 'Click Save; error appears.',
    });
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 ORDER BY signal_id',
          [t.id],
        )
      ).rows.map((r) => r.signal_id),
    ).toEqual(
      recordings
        .slice(0, 3)
        .map((r) => r.signalId)
        .sort(),
    );
    expect(
      (
        await pool.query(
          `SELECT publication_generation FROM error_group_jobs WHERE ticket_id=$1 AND job_type='investigate'`,
          [t.id],
        )
      ).rows,
    ).toEqual([{ publication_generation: 1 }]);
    expect(
      (
        await pool.query(`SELECT status FROM error_group_jobs WHERE id=$1`, [
          job.id,
        ])
      ).rows[0].status,
    ).toBe('completed');
  });
  it('keeps one of three tracking and creates no successor without selectable work', async () => {
    const t = await ticket();
    await matches(t, 3);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps(['confirmed', 'refuted', 'inconclusive']),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.getTicket(pool, projectId, t.id))!.status).toBe(
      'tracking',
    );
    expect(
      (
        await pool.query(
          `SELECT id FROM error_group_jobs WHERE ticket_id=$1 AND status='pending'`,
          [t.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it('reads and publishes when the replay rendered without external assets', async () => {
    // Real apps load cross-origin CSS/fonts/images; the replay aborts them and
    // reports assetsMissing. That is a degraded capture, not a failed one: a
    // production replay where it was fatal produced zero confirmations.
    const t = await ticket();
    await matches(t, 3);
    const dependencies = deps([]);
    dependencies.capture = async () => ({
      frames: [{ offsetMs: 0, pair: 'a', png: Buffer.from('png'), modelPng: Buffer.from('png') }],
      assetsMissing: true,
    });
    await expect(
      processFrictionConfirm(await claim(t), dependencies, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.cohortStats(pool, t)).toMatchObject({ counted: 3, confirmed: 3 });
    expect((await store.getTicket(pool, projectId, t.id))!.status).toBe('published');
    expect(
      (await pool.query(`SELECT frames_ok, frame_manifest->0->>'assetsMissing' AS degraded FROM friction_check_attempts WHERE ticket_id=$1`, [t.id])).rows,
    ).toEqual(Array.from({ length: 3 }, () => ({ frames_ok: true, degraded: 'true' })));
  });
  it('reserves budget only for reads whose capture produced frames', async () => {
    const t = await ticket();
    await matches(t, 3);
    const dependencies = deps([]);
    dependencies.dailyCap = 1;
    let captures = 0;
    dependencies.capture = async () => {
      captures += 1;
      if (captures === 1) throw new Error('Replay unavailable');
      return { frames: [{ offsetMs: 0, pair: 'a', png: Buffer.from('png'), modelPng: Buffer.from('png') }], assetsMissing: false };
    };
    // First member: capture fails, staged unavailable, no budget. Second: read
    // with the single unit. Third: budget exhausted, job rescheduled.
    await expect(
      processFrictionConfirm(await claim(t), dependencies, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobRescheduledError' });
    expect(
      (await pool.query('SELECT used FROM friction_confirmation_budget WHERE project_id=$1', [projectId])).rows,
    ).toEqual([{ used: 1 }]);
    expect(
      (await pool.query(`SELECT outcome FROM friction_check_attempts WHERE ticket_id=$1 ORDER BY outcome`, [t.id])).rows,
    ).toEqual([{ outcome: 'confirmed' }, { outcome: 'unavailable' }]);
  });
  it('stages unavailable capture failures and schedules only the due retry', async () => {
    const t = await ticket();
    await matches(t, 3);
    const dependencies = deps([]);
    dependencies.capture = async () => {
      throw new Error('Replay unavailable');
    };
    await expect(
      processFrictionConfirm(
        await claim(t),
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(await store.cohortStats(pool, t)).toMatchObject({
      counted: 0,
      confirmed: 0,
    });
    expect(
      (
        await pool.query(
          `SELECT attempts,permanent FROM friction_unavailable_retries WHERE ticket_id=$1`,
          [t.id],
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 3 }, () => ({ attempts: 1, permanent: false })),
    );
    expect(
      (
        await pool.query(
          `SELECT available_at>now()+interval '59 minutes' AS delayed FROM error_group_jobs WHERE ticket_id=$1 AND status='pending'`,
          [t.id],
        )
      ).rows,
    ).toEqual([{ delayed: true }]);
  });
  it('resumes the same batch after budget exhaustion without rechecking staged recordings', async () => {
    const t = await ticket();
    await matches(t, 3);
    const job = await claim(t);
    const first = deps([]);
    first.dailyCap = 1;
    await expect(
      processFrictionConfirm(job, first, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobRescheduledError' });
    const saved = (
      await pool.query(
        `SELECT batch_id,status,available_at>now() AS delayed FROM error_group_jobs WHERE id=$1`,
        [job.id],
      )
    ).rows[0];
    expect(saved).toMatchObject({ status: 'pending', delayed: true });
    expect(
      (
        await pool.query(
          'SELECT session_id FROM friction_check_attempts WHERE batch_id=$1',
          [saved.batch_id],
        )
      ).rows,
    ).toHaveLength(1);
    await pool.query(
      `UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=2,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`,
      [job.id, job.workerId],
    );
    job.leaseGeneration = '2';
    const resumed = deps([]);
    resumed.dailyCap = 3;
    await expect(
      processFrictionConfirm(job, resumed, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(
      (
        await pool.query('SELECT batch_id FROM error_group_jobs WHERE id=$1', [
          job.id,
        ])
      ).rows[0].batch_id,
    ).toBe(saved.batch_id);
    expect(
      (
        await pool.query(
          'SELECT used FROM friction_confirmation_budget WHERE project_id=$1',
          [projectId],
        )
      ).rows,
    ).toEqual([{ used: 3 }]);
    expect(
      (
        await pool.query(
          'SELECT execution FROM job_usage WHERE job_id=$1 ORDER BY execution',
          [job.id],
        )
      ).rows,
    ).toEqual([{ execution: 1 }, { execution: 2 }]);
    expect(
      (await store.getTicket(pool, projectId, t.id))!.live_generation,
    ).toBe(1);
  });
  it('discards a changed-state batch, retains attempts and requests reconciliation', async () => {
    const t = await ticket();
    await matches(t, 3);
    const dependencies = deps([]);
    const complete = dependencies.client.complete;
    let changed = false;
    dependencies.client.complete = async (args) => {
      const r = await complete(args);
      if (!changed) {
        changed = true;
        await pool.query(
          `UPDATE friction_tickets SET status='unpublished' WHERE id=$1`,
          [t.id],
        );
      }
      return r;
    };
    await expect(
      processFrictionConfirm(
        await claim(t),
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.getTicket(pool, projectId, t.id))!).toMatchObject({
      status: 'unpublished',
      reconcile_needed: true,
    });
    expect(
      (
        await pool.query(
          'SELECT status FROM friction_confirm_batches WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual([{ status: 'discarded' }]);
    expect(
      (
        await pool.query(
          'SELECT id FROM friction_check_attempts WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toHaveLength(3);
    expect((await store.cohortStats(pool, t)).counted).toBe(0);
  });
  it('discards a purged manifest member instead of getting stuck incomplete', async () => {
    const t = await ticket();
    const recordings = await matches(t, 3);
    const dependencies = deps([]);
    const complete = dependencies.client.complete;
    let purged = false;
    dependencies.client.complete = async (args) => {
      const r = await complete(args);
      if (!purged) {
        purged = true;
        await pool.query('DELETE FROM sessions WHERE id=$1', [
          recordings[2]!.sessionId,
        ]);
      }
      return r;
    };
    await expect(
      processFrictionConfirm(
        await claim(t),
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(
      (await store.getTicket(pool, projectId, t.id))!.reconcile_needed,
    ).toBe(true);
    expect(
      (
        await pool.query(
          'SELECT status FROM friction_confirm_batches WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual([{ status: 'discarded' }]);
  });
  it('enqueues an immediate successor only for the unread remainder', async () => {
    const t = await ticket();
    await matches(t, 11);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.cohortStats(pool, t)).confirmed).toBe(10);
    expect(
      (
        await pool.query(
          `SELECT available_at<=now() AS due FROM error_group_jobs WHERE ticket_id=$1 AND job_type='friction_confirm' AND status='pending'`,
          [t.id],
        )
      ).rows,
    ).toEqual([{ due: true }]);
  });

  async function publish(t: store.TicketRow) {
    await matches(t, 3);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    return (await store.getTicket(pool, projectId, t.id))!;
  }
  async function embed(t: store.TicketRow, similarity = 1) {
    const vector = Array.from({ length: 1536 }, (_, i) =>
      i === 0 ? similarity : i === 1 ? Math.sqrt(1 - similarity ** 2) : 0,
    );
    await pool.query(
      `UPDATE friction_tickets SET embedding=$2::vector,embedding_model='text-embedding-3-small' WHERE id=$1`,
      [t.id, JSON.stringify(vector)],
    );
  }
  it('folds cosine .9 matches and references while target evidence changes only after its own verification', async () => {
    const target = await publish(await ticket());
    await embed(target);
    const source = await ticket();
    await embed(source, 0.9);
    const recordings = await matches(source, 3);
    const dependencies = deps([]);
    const complete = dependencies.client.complete;
    dependencies.client.complete = async (args) =>
      args.user.includes('PROBLEM_A_START')
        ? {
            text: JSON.stringify({ oneFix: true, reason: 'Same handler' }),
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            stopReason: 'end_turn',
          }
        : complete(args);
    await expect(
      processFrictionConfirm(
        await claim(source),
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.getTicket(pool, projectId, source.id))!).toMatchObject({
      status: 'merged',
      merged_into: target.id,
    });
    expect(
      (await pool.query(`SELECT candidate_id, one_fix, reason FROM friction_gate_decisions WHERE ticket_id=$1`, [source.id])).rows,
    ).toEqual([{ candidate_id: target.id, one_fix: true, reason: 'Same handler' }]);
    expect(
      (await store.getTicket(pool, projectId, target.id))!.matched_count,
    ).toBe(6);
    expect((await store.cohortStats(pool, target)).confirmed).toBe(3);
    expect((await store.verifiedEvidence(pool, target)).signalIds).not.toEqual(
      expect.arrayContaining(recordings.map((r) => r.signalId)),
    );
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_ticket_match_observations WHERE ticket_id=$1 AND session_id=ANY($2::text[])',
          [target.id, recordings.map((r) => r.sessionId)],
        )
      ).rows,
    ).toHaveLength(3);
    await expect(
      processFrictionConfirm(
        await claim(target),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.cohortStats(pool, target)).confirmed).toBe(6);
  });
  it('republishes generation two while preserving generation one evidence', async () => {
    const t = await publish(await ticket());
    const first = (
      await pool.query(
        'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 AND generation=1 ORDER BY signal_id',
        [t.id],
      )
    ).rows;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await store.unpublish(tx, t);
      await tx.query('COMMIT');
    } finally {
      tx.release();
    }
    await matches(t, 1);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(
      (await store.getTicket(pool, projectId, t.id))!.live_generation,
    ).toBe(2);
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 AND generation=1 ORDER BY signal_id',
          [t.id],
        )
      ).rows,
    ).toEqual(first);
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 AND generation=2',
          [t.id],
        )
      ).rows,
    ).toHaveLength(4);
  });
  it('regresses only with three post-fix confirmations and preserves the old PR reference', async () => {
    const t = await publish(await ticket());
    const group = (await store.liveIncident(pool, t))!;
    await pool.query(
      `UPDATE error_groups SET fix_substate='resolved' WHERE id=$1`,
      [group.id],
    );
    await pool.query(
      `UPDATE friction_tickets SET fixed_at=clock_timestamp(),cohort_cutoff=clock_timestamp() WHERE id=$1`,
      [t.id],
    );
    await pool.query(
      `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,pr_url) VALUES($1,$2,1,'merged','https://github.com/test/repo/pull/1')`,
      [t.id, group.id],
    );
    await matches(t, 2);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(
      (await store.getTicket(pool, projectId, t.id))!.live_generation,
    ).toBe(1);
    const [third] = await matches(t, 1);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const regressed = (await store.getTicket(pool, projectId, t.id))!;
    expect(regressed.live_generation).toBe(2);
    expect(regressed.steps).toContain('Fix merged on');
    expect(regressed.steps).toContain('https://github.com/test/repo/pull/1');
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1 AND generation=2',
          [t.id],
        )
      ).rows,
    ).toHaveLength(3);
    expect((await store.verifiedEvidence(pool, regressed)).signalIds).toContain(
      third!.signalId,
    );
  });

  it('invalidates an empty publication snapshot when a neighbor publishes, then stops reclassifying after three changes', async () => {
    const source = await publish(await ticket());
    await embed(source);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await store.unpublish(tx, source);
      await tx.query('COMMIT');
      const unpublished = (await store.getTicket(pool, projectId, source.id))!;
      const plan = await prepareConfirmationTransition(
        pool,
        unpublished,
        null,
        deps([]).client,
        { add() {} },
      );
      expect(plan.neighbors).toEqual([]);
      const neighbor = await publish(await ticket());
      await embed(neighbor);
      for (let i = 0; i < 3; i++) {
        await tx.query('BEGIN');
        await tx.query(
          `SELECT pg_advisory_xact_lock(hashtext('friction_publish|'||$1))`,
          [environmentId],
        );
        await applyConfirmationTransition(
          tx,
          (await store.getTicket(tx, projectId, source.id, true))!,
          plan,
        );
        await tx.query('COMMIT');
      }
      expect(
        (await store.getTicket(pool, projectId, source.id))!,
      ).toMatchObject({
        status: 'unpublished',
        fold_retries: 3,
        reconcile_needed: true,
      });
      await tx.query('BEGIN');
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext('friction_publish|'||$1))`,
        [environmentId],
      );
      await applyConfirmationTransition(
        tx,
        (await store.getTicket(tx, projectId, source.id, true))!,
        plan,
      );
      await tx.query('COMMIT');
      expect(
        (await store.getTicket(pool, projectId, source.id))!,
      ).toMatchObject({
        status: 'published',
        live_generation: 2,
        reconcile_needed: false,
      });
    } finally {
      tx.release();
    }
  });
  it('discards after a deletion changes evidence without changing published status or generation', async () => {
    const t = await publish(await ticket());
    await matches(t, 2);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    const verified = await store.verifiedEvidence(pool, t);
    expect(verified.sessions).toBe(5);
    await matches(t, 1);
    const dependencies = deps([]);
    const complete = dependencies.client.complete;
    dependencies.client.complete = async (args) => {
      const result = await complete(args);
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('DELETE FROM sessions WHERE id=$1', [
          verified.sessionIds[0],
        ]);
        await tx.query('SELECT friction_reconcile_after_delete($1)', [t.id]);
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      return result;
    };
    await expect(
      processFrictionConfirm(
        await claim(t),
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.getTicket(pool, projectId, t.id))!).toMatchObject({
      status: 'published',
      live_generation: 1,
      reconcile_needed: true,
    });
    expect((await store.cohortStats(pool, t)).confirmed).toBe(4);
    expect(
      (
        await pool.query(
          `SELECT status FROM friction_confirm_batches WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [t.id],
        )
      ).rows,
    ).toEqual([{ status: 'discarded' }]);
  });
  it('retries malformed enum arrays and stages only the validated replacement', async () => {
    const t = await ticket();
    await matches(t, 3);
    const job = await claim(t);
    const dependencies = deps([]);
    const complete = dependencies.client.complete;
    let calls = 0;
    dependencies.client.complete = async (args) => {
      calls++;
      if (calls === 1)
        return {
          text: JSON.stringify({
            outcome: ['confirmed'],
            costToUser: ['lost_time'],
            evidenceLines: [],
            signalIds: [],
            note: 'Unsupported confirmation',
          }),
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stopReason: 'end_turn',
        };
      return complete(args);
    };
    await expect(
      processFrictionConfirm(job, dependencies, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect(calls).toBe(4);
    expect((await store.cohortStats(pool, t)).confirmed).toBe(3);
    expect(
      (
        await pool.query(
          'SELECT note FROM friction_check_attempts WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 3 }, () => ({ note: 'Click Save; error appears.' })),
    );
    expect(
      (
        await pool.query(
          'SELECT input_tokens::int FROM job_usage WHERE job_id=$1',
          [job.id],
        )
      ).rows,
    ).toEqual([{ input_tokens: 40 }]);
  });
  it('meters invalid attempts but never stages them and propagates cancellation', async () => {
    const t = await ticket();
    await matches(t, 3);
    const job = await claim(t);
    const dependencies = deps([]);
    dependencies.client.complete = async () => ({
      text: '{}',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      stopReason: 'end_turn',
    });
    await expect(
      processFrictionConfirm(job, dependencies, new AbortController().signal),
    ).rejects.toThrow('Confirmation invalid');
    expect(
      (
        await pool.query(
          'SELECT id FROM friction_check_attempts WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          'SELECT input_tokens::int FROM job_usage WHERE job_id=$1',
          [job.id],
        )
      ).rows,
    ).toEqual([{ input_tokens: 14 }]);
    const controller = new AbortController();
    controller.abort(new Error('Canceled by user'));
    await expect(
      processFrictionConfirm(job, dependencies, controller.signal),
    ).rejects.toThrow('Canceled by user');
  });
  it('refreshes verified evidence and reinvestigates without touching an open fix PR', async () => {
    const t = await publish(await ticket());
    const incident = (await store.liveIncident(pool, t))!;
    await pool.query(
      `UPDATE error_group_jobs SET status='completed' WHERE ticket_id=$1 AND job_type='investigate'`,
      [t.id],
    );
    await pool.query(
      `UPDATE friction_tickets SET reinvestigate_needed=true WHERE id=$1`,
      [t.id],
    );
    await pool.query(
      `UPDATE error_groups SET fix_substate='pr_open',investigation_status='failed',evidence_version_used=1 WHERE id=$1`,
      [incident.id],
    );
    await matches(t, 1);
    await expect(
      processFrictionConfirm(
        await claim(t),
        deps([]),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'JobCompletedInTransaction' });
    expect((await store.liveIncident(pool, t))!.fix_substate).toBe('pr_open');
    expect((await store.getTicket(pool, projectId, t.id))!).toMatchObject({
      live_generation: 1,
      evidence_version: 2,
      reinvestigate_needed: false,
    });
    expect(
      (
        await pool.query(
          `SELECT publication_generation FROM error_group_jobs WHERE ticket_id=$1 AND job_type='investigate' AND status='pending'`,
          [t.id],
        )
      ).rows,
    ).toEqual([{ publication_generation: 1 }]);
    expect(
      (
        await pool.query(
          'SELECT signal_id FROM friction_incident_evidence WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toHaveLength(4);
  });
  it('records no checks when the daily cap is zero or the lease expires during a model read', async () => {
    const t = await ticket();
    await matches(t, 3);
    const job = await claim(t);
    const dependencies = deps([]);
    dependencies.dailyCap = 0;
    await expect(
      processFrictionConfirm(job, dependencies, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'JobRescheduledError' });
    expect(
      (
        await pool.query(
          'SELECT id FROM friction_check_attempts WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual([]);
    await pool.query(
      `UPDATE error_group_jobs SET status='claimed',worker_id=$2,lease_generation=2,lease_expires_at=now()+interval '5 minutes' WHERE id=$1`,
      [job.id, job.workerId],
    );
    job.leaseGeneration = '2';
    dependencies.dailyCap = 10;
    const complete = dependencies.client.complete;
    dependencies.client.complete = async (args) => {
      const result = await complete(args);
      await pool.query(
        `UPDATE error_group_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [job.id],
      );
      return result;
    };
    await expect(
      processFrictionConfirm(job, dependencies, new AbortController().signal),
    ).rejects.toBeInstanceOf(db.LeaseLostError);
    expect(
      (
        await pool.query(
          'SELECT id FROM friction_check_attempts WHERE ticket_id=$1',
          [t.id],
        )
      ).rows,
    ).toEqual([]);
    expect((await store.getTicket(pool, projectId, t.id))!.status).toBe(
      'tracking',
    );
  });
});
