import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { purgeDiagnosisDecisions } from '../../__tests__/purge-diagnosis-decisions.js';
import pg from 'pg';
import { getPool, closePool } from '../../db.js';
import {
  claimSignalsForAdjudication,
  findFoldTarget,
  applyFoldOutcome,
  recomputeIncidentImpact,
  tryReserveAdjudicationCall,
  type FoldSignal,
} from '../promotion-db.js';
import { writeFrictionSignals } from '../persist.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

let pool: pg.Pool;
let projectId: string;
let environmentId: string;
let orgId: string;

async function seedTenant(): Promise<void> {
  const org = await pool.query<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ('b4-promotion-test') RETURNING id`
  );
  orgId = org.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo, default_branch)
     VALUES ($1, 'b4-project', 'octocat/hello', 'main') RETURNING id`,
    [orgId]
  );
  projectId = proj.rows[0]!.id;
  const env = await pool.query<{ id: string }>(
    `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
    [projectId]
  );
  environmentId = env.rows[0]!.id;
}

export interface SeededSignal {
  id: string;
  sessionId: string;
}

async function seedSession(id?: string, envId = environmentId): Promise<string> {
  const sessionId = id ?? `sess-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO sessions (id, project_id, environment_id, started_at)
     VALUES ($1, $2, $3, now() - interval '10 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, projectId, envId]
  );
  return sessionId;
}

async function seedEndUser(externalId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO end_users (project_id, external_user_id, first_seen, last_seen)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (project_id, external_user_id) DO UPDATE SET last_seen = now()
     RETURNING id`,
    [projectId, externalId]
  );
  return res.rows[0]!.id;
}

async function seedSignal(opts: {
  sessionId?: string;
  fingerprint?: string;
  occurredAt?: string;
  occurrenceCount?: number;
  endUserId?: string | null;
  status?: string;
}): Promise<SeededSignal> {
  const sessionId = opts.sessionId ?? (await seedSession());
  const res = await pool.query<{ id: string }>(
    `INSERT INTO friction_signals
       (session_id, project_id, environment_id, end_user_id, rule_version,
        signal_type, fingerprint, page_url_normalized, occurred_at,
        occurrence_count, adjudication_status)
     VALUES ($1, $2, $3, $4, 1, 'rage_click', $5, '/checkout', $6, $7, $8)
     RETURNING id`,
    [
      sessionId,
      projectId,
      environmentId,
      opts.endUserId ?? null,
      opts.fingerprint ?? 'fp-rage-checkout',
      opts.occurredAt ?? new Date().toISOString(),
      opts.occurrenceCount ?? 1,
      opts.status ?? 'pending',
    ]
  );
  return { id: res.rows[0]!.id, sessionId };
}

async function seedErrorGroupWithEvent(opts: {
  sessionId: string;
  eventAt: string;
  status?: string;
  kind?: string;
  fingerprint?: string;
}): Promise<{ groupId: string; eventId: string }> {
  const group = await pool.query<{ id: string }>(
    `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status, kind)
     VALUES ($1, $2, 'Test Error', $3, $3, $4::error_group_status, $5)
     RETURNING id`,
    [
      projectId,
      opts.fingerprint ?? `fp-err-${crypto.randomUUID()}`,
      opts.eventAt,
      opts.status ?? 'queued',
      opts.kind ?? 'error',
    ]
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO error_events
       (project_id, environment_id, timestamp, error_type, error_message,
        stack_trace_raw, breadcrumbs, context, session_id, error_group_id)
     VALUES ($1, $2, $3, 'TypeError', 'boom', '', '[]'::jsonb, '{}'::jsonb, $4, $5)
     RETURNING id`,
    [projectId, environmentId, opts.eventAt, opts.sessionId, group.rows[0]!.id]
  );
  return { groupId: group.rows[0]!.id, eventId: event.rows[0]!.id };
}

async function seedAnalysisJob(sessionId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO error_group_jobs (project_id, status, job_type, session_id)
     VALUES ($1, 'claimed', 'session_analysis', $2) RETURNING id`,
    [projectId, sessionId]
  );
  return res.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM adjudication_call_budget WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [projectId]);
  await pool.query(`UPDATE error_groups SET representative_signal_id = NULL WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [projectId]);
  await purgeDiagnosisDecisions(pool, projectId);
  await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM error_events WHERE project_id = $1`, [projectId]);
  await pool.query(
    `DELETE FROM error_group_affected_users WHERE error_group_id IN
       (SELECT id FROM error_groups WHERE project_id = $1)`,
    [projectId]
  );
  await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM end_users WHERE project_id = $1`, [projectId]);
}

import { purgeStaleTenants } from './tenant-purge.js';

describeDb('promotion-db integration', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await purgeStaleTenants(pool, 'b4-promotion-test');
    await seedTenant();
  });

  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM environments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it('reserves the per-project adjudication budget atomically', async () => {
    const client = await getPool().connect();
    try {
      expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
      expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
      expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(true);
      expect(await tryReserveAdjudicationCall(client, projectId, 3)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('supersedes prior-version signals and persists occurrence timestamps', async () => {
    const sessionId = await seedSession();
    const session = {
      id: sessionId, project_id: projectId, environment_id: environmentId,
      end_user_id: null, status: 'analyzing', started_at: new Date().toISOString(), chunk_count: 1,
    };
    const detected = (fingerprint: string, version: number) => ({
      signalType: 'dead_click' as const,
      fingerprint,
      elementSelector: '#save',
      pageUrlNormalized: '/settings',
      occurredAt: 1_754_000_000_000,
      occurredAts: [1_754_000_000_000],
      occurrenceCount: 1,
      ruleVersion: version,
    });
    await writeFrictionSignals(session, [detected('kept', 1), detected('removed', 1)], 1);
    await writeFrictionSignals(session, [detected('kept', 2)], 2);

    const { rows } = await pool.query<{
      fingerprint: string; rule_version: number; superseded_by: string | null;
      retracted_at: Date | null; occurred_ats: number[] | null;
    }>(`SELECT fingerprint, rule_version, superseded_by, retracted_at, occurred_ats
        FROM friction_signals WHERE session_id = $1 ORDER BY rule_version, fingerprint`, [sessionId]);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.rule_version === 1 && row.fingerprint === 'kept')?.superseded_by).not.toBeNull();
    expect(rows.find((row) => row.fingerprint === 'removed')?.retracted_at).not.toBeNull();
    expect(rows.find((row) => row.rule_version === 2)?.occurred_ats).toEqual([1_754_000_000_000]);
  });

  describe('claimSignalsForAdjudication', () => {
    it('claims pending signals and increments attempts', async () => {
      const s1 = await seedSignal({});
      const s2 = await seedSignal({ fingerprint: 'fp-other' });
      const jobId = await seedAnalysisJob(s1.sessionId);

      const client = await getPool().connect();
      try {
        const claimed = await claimSignalsForAdjudication(client, [s1.id, s2.id], jobId);
        expect(claimed).toBe(2);
      } finally {
        client.release();
      }

      const rows = await pool.query(
        `SELECT adjudication_job_id, adjudication_attempts FROM friction_signals
         WHERE id = ANY($1::uuid[])`,
        [[s1.id, s2.id]]
      );
      for (const row of rows.rows) {
        expect(row.adjudication_job_id).toBe(jobId);
        expect(row.adjudication_attempts).toBe(1);
      }
    });

    it('only touches pending rows', async () => {
      const accepted = await seedSignal({ status: 'accepted' });
      const rejected = await seedSignal({ status: 'rejected', fingerprint: 'fp-b' });
      const pending = await seedSignal({ fingerprint: 'fp-c' });
      const jobId = await seedAnalysisJob(pending.sessionId);

      const client = await getPool().connect();
      try {
        const claimed = await claimSignalsForAdjudication(
          client,
          [accepted.id, rejected.id, pending.id],
          jobId
        );
        expect(claimed).toBe(1);
      } finally {
        client.release();
      }

      const untouched = await pool.query(
        `SELECT adjudication_attempts FROM friction_signals WHERE id = ANY($1::uuid[])`,
        [[accepted.id, rejected.id]]
      );
      for (const row of untouched.rows) expect(row.adjudication_attempts).toBe(0);
    });
  });

  describe('findFoldTarget', () => {
    const T0 = new Date('2026-07-15T12:00:00.000Z');
    const at = (deltaSeconds: number) =>
      new Date(T0.getTime() + deltaSeconds * 1000).toISOString();

    async function target(sessionId: string, occurredAt: string) {
      const client = await getPool().connect();
      try {
        return await findFoldTarget(client, projectId, sessionId, occurredAt);
      } finally {
        client.release();
      }
    }

    it.each([-30, 0, 30])('window is inclusive at %ds', async (delta) => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(delta) });
      const found = await target(sessionId, at(0));
      expect(found?.errorGroupId).toBe(groupId);
    });

    it.each([-31, 31])('outside the window at %ds finds nothing', async (delta) => {
      const sessionId = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(delta) });
      expect(await target(sessionId, at(0))).toBeNull();
    });

    it('chooses the nearest error and breaks ties deterministically', async () => {
      const sessionId = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(-20) });
      const { groupId: nearest } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const found = await target(sessionId, at(0));
      expect(found?.errorGroupId).toBe(nearest);
    });

    it('skips archived groups and other sessions', async () => {
      const sessionId = await seedSession();
      const otherSession = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(1), status: 'archived' });
      await seedErrorGroupWithEvent({ sessionId: otherSession, eventAt: at(0) });
      expect(await target(sessionId, at(0))).toBeNull();
    });

    it('returns terminal non-archived targets (resolved/merged)', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId,
        eventAt: at(2),
        status: 'resolved',
      });
      const found = await target(sessionId, at(0));
      expect(found?.errorGroupId).toBe(groupId);
      expect(found?.status).toBe('resolved');
    });

    it('never folds into friction incidents', async () => {
      const sessionId = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(0), kind: 'friction' });
      expect(await target(sessionId, at(0))).toBeNull();
    });
  });

  describe('applyFoldOutcome', () => {
    const T0 = new Date('2026-07-15T12:00:00.000Z');
    const at = (deltaSeconds: number) =>
      new Date(T0.getTime() + deltaSeconds * 1000).toISOString();
    const META = { modelId: 'stub-model', promptVersion: 1, jobId: '' };

    async function loadSignalRow(signalId: string): Promise<FoldSignal> {
      const { rows } = await pool.query(
        `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
                occurred_at::text AS occurred_at
         FROM friction_signals WHERE id = $1`,
        [signalId]
      );
      return rows[0] as FoldSignal;
    }

    async function groupState(groupId: string) {
      const { rows } = await pool.query(
        `SELECT status, occurrence_count, affected_users_count, last_seen::text AS last_seen
         FROM error_groups WHERE id = $1`,
        [groupId]
      );
      return rows[0]!;
    }

    it('accepted verdict attaches once with impact, audit, and a 90-day session pin', async () => {
      const sessionId = await seedSession();
      const endUserId = await seedEndUser('fold-user-1');
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0), endUserId });
      const before = await groupState(groupId);

      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'real friction' },
        meta: META,
      });
      expect(outcome).toBe('attached');

      const sig = (await pool.query(
        `SELECT adjudication_status, adjudication_scope, adjudication_model,
                adjudication_prompt_version, adjudication_reason, incident_id, adjudicated_at
         FROM friction_signals WHERE id = $1`,
        [seeded.id]
      )).rows[0]!;
      expect(sig.adjudication_status).toBe('accepted');
      expect(sig.adjudication_scope).toBe('fold');
      expect(sig.adjudication_model).toBe('stub-model');
      expect(sig.adjudication_prompt_version).toBe(1);
      expect(sig.incident_id).toBe(groupId);
      expect(sig.adjudicated_at).toBeTruthy();

      const after = await groupState(groupId);
      expect(after.occurrence_count).toBe(before.occurrence_count + 1);
      expect(after.affected_users_count).toBe(1);
      expect(after.status).toBe(before.status);

      const junction = (await pool.query(
        `SELECT occurrence_count FROM error_group_affected_users
         WHERE error_group_id = $1 AND end_user_id = $2`,
        [groupId, endUserId]
      )).rows[0]!;
      expect(junction.occurrence_count).toBe(1);

      const session = (await pool.query(
        `SELECT retain_until, started_at FROM sessions WHERE id = $1`,
        [sessionId]
      )).rows[0]!;
      const expectedPin = new Date(session.started_at).getTime() + 90 * 24 * 3600 * 1000;
      expect(new Date(session.retain_until).getTime()).toBe(expectedPin);
    });

    it('records an accepted fold in the error group environment rollup', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      await pool.query(
        `INSERT INTO error_group_environments
           (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, $3, $3, 1)`,
        [groupId, environmentId, at(5)]
      );
      const seeded = await seedSignal({ sessionId, occurredAt: at(0), occurrenceCount: 3 });

      expect(
        await applyFoldOutcome({
          signal: await loadSignalRow(seeded.id),
          verdict: { accepted: true, reason: 'real friction' },
          meta: META,
        })
      ).toBe('attached');

      const { rows } = await pool.query(
        `SELECT environment_id, first_seen, last_seen, occurrence_count
         FROM error_group_environments
         WHERE error_group_id = $1`,
        [groupId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        environment_id: environmentId,
        occurrence_count: '4',
      });
      expect(new Date(rows[0]!.first_seen).getTime()).toBe(new Date(at(0)).getTime());
      expect(new Date(rows[0]!.last_seen).getTime()).toBe(new Date(at(5)).getTime());
      expect((await groupState(groupId)).occurrence_count).toBe(4);
    });

    it('is idempotent: a second call is a no-op', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0) });
      const signal = await loadSignalRow(seeded.id);

      expect(
        await applyFoldOutcome({ signal, verdict: { accepted: true, reason: 'r' }, meta: META })
      ).toBe('attached');
      const afterFirst = await groupState(groupId);
      expect(
        await applyFoldOutcome({ signal, verdict: { accepted: true, reason: 'r' }, meta: META })
      ).toBe('noop');
      const afterSecond = await groupState(groupId);
      expect(afterSecond.occurrence_count).toBe(afterFirst.occurrence_count);
    });

    it('rejected verdict persists audit only', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0) });
      const before = await groupState(groupId);

      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: false, reason: 'detector noise' },
        meta: META,
      });
      expect(outcome).toBe('rejected');

      const sig = (await pool.query(
        `SELECT adjudication_status, incident_id FROM friction_signals WHERE id = $1`,
        [seeded.id]
      )).rows[0]!;
      expect(sig.adjudication_status).toBe('rejected');
      expect(sig.incident_id).toBeNull();
      expect((await groupState(groupId)).occurrence_count).toBe(before.occurrence_count);
    });

    it('terminal targets keep their status and gain no job', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId,
        eventAt: at(5),
        status: 'resolved',
      });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0) });

      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'r' },
        meta: META,
      });
      expect(outcome).toBe('attached');

      const after = await groupState(groupId);
      expect(after.status).toBe('resolved');
      const jobs = await pool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs WHERE error_group_id = $1`,
        [groupId]
      );
      expect(jobs.rows[0]!.n).toBe(0);
    });

    it('accepted signal with no fold target is a noop (falls to the bucket path)', async () => {
      const sessionId = await seedSession();
      const seeded = await seedSignal({ sessionId, occurredAt: at(0) });
      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'r' },
        meta: META,
      });
      expect(outcome).toBe('no_target');
      const sig = (await pool.query(
        `SELECT adjudication_status, incident_id FROM friction_signals WHERE id = $1`,
        [seeded.id]
      )).rows[0]!;
      // Verdict persists so the bucket path can inherit it without a new call.
      expect(sig.adjudication_status).toBe('accepted');
      expect(sig.incident_id).toBeNull();
    });

    it('resumes an accepted-but-unattached signal after a crash', async () => {
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0), status: 'accepted' });

      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'resume' },
        meta: META,
      });
      expect(outcome).toBe('attached');
      const sig = (await pool.query(
        `SELECT incident_id FROM friction_signals WHERE id = $1`,
        [seeded.id]
      )).rows[0]!;
      expect(sig.incident_id).toBe(groupId);
    });

    it.each(['rejected', 'unchecked'])('%s signals are terminal no-ops', async (status) => {
      const sessionId = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0), status });
      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'r' },
        meta: META,
      });
      expect(outcome).toBe('noop');
    });

    it('retracted and superseded signals never attach', async () => {
      const sessionId = await seedSession();
      await seedErrorGroupWithEvent({ sessionId, eventAt: at(5) });
      const seeded = await seedSignal({ sessionId, occurredAt: at(0) });
      await pool.query(`UPDATE friction_signals SET retracted_at = now() WHERE id = $1`, [
        seeded.id,
      ]);
      const outcome = await applyFoldOutcome({
        signal: await loadSignalRow(seeded.id),
        verdict: { accepted: true, reason: 'r' },
        meta: META,
      });
      expect(outcome).toBe('noop');
    });
  });

  describe('recomputeIncidentImpact', () => {
    it('rebuilds environment rollups with the same weighted source semantics as backfill', async () => {
      const t0 = new Date('2026-07-16T12:00:00.000Z');
      const at = (deltaSeconds: number) =>
        new Date(t0.getTime() + deltaSeconds * 1000).toISOString();
      const envB = (await pool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [projectId, `staging-${crypto.randomUUID()}`]
      )).rows[0]!.id;
      const obsoleteEnv = (await pool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [projectId, `obsolete-${crypto.randomUUID()}`]
      )).rows[0]!.id;
      const sessionA = await seedSession();
      const sessionB = await seedSession(undefined, envB);
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId: sessionA,
        eventAt: at(10),
      });
      await pool.query(
        `UPDATE error_events SET created_at = $2 WHERE error_group_id = $1`,
        [groupId, at(100)]
      );
      await pool.query(
        `INSERT INTO error_events
           (project_id, environment_id, timestamp, error_type, error_message,
            stack_trace_raw, breadcrumbs, context, session_id, error_group_id, created_at)
         VALUES ($1, $2, $3, 'TypeError', 'boom', '', '[]'::jsonb, '{}'::jsonb, $4, $5, $6)`,
        [projectId, envB, at(20), sessionB, groupId, at(200)]
      );
      const active = await seedSignal({
        sessionId: sessionA,
        occurredAt: at(5),
        occurrenceCount: 4,
        status: 'accepted',
      });
      const retracted = await seedSignal({
        sessionId: sessionA,
        fingerprint: 'fp-retracted-rollup',
        occurredAt: at(30),
        occurrenceCount: 7,
        status: 'accepted',
      });
      const superseded = await seedSignal({
        sessionId: sessionA,
        fingerprint: 'fp-superseded-rollup',
        occurredAt: at(35),
        occurrenceCount: 9,
        status: 'accepted',
      });
      await pool.query(
        `UPDATE friction_signals
         SET incident_id = $2,
             retracted_at = CASE WHEN id = $3 THEN now() ELSE NULL END,
             superseded_by = CASE WHEN id = $4 THEN $5::uuid ELSE NULL END
         WHERE id = ANY($1::uuid[])`,
        [[active.id, retracted.id, superseded.id], groupId, retracted.id, superseded.id, active.id]
      );

      // Stale and obsolete rows prove the rebuild is absolute, not additive.
      await pool.query(
        `INSERT INTO error_group_environments
           (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, $4, $4, 99), ($1, $3, $4, $4, 99)`,
        [groupId, environmentId, obsoleteEnv, at(40)]
      );

      const client = await getPool().connect();
      try {
        await recomputeIncidentImpact(client, groupId, projectId);
      } finally {
        client.release();
      }

      const { rows } = await pool.query<{
        environment_id: string;
        first_seen: Date;
        last_seen: Date;
        occurrence_count: string;
      }>(
        `SELECT environment_id, first_seen, last_seen, occurrence_count
         FROM error_group_environments
         WHERE error_group_id = $1
         ORDER BY environment_id`,
        [groupId]
      );
      expect(rows.map((row) => ({
        environmentId: row.environment_id,
        firstSeen: row.first_seen.toISOString(),
        lastSeen: row.last_seen.toISOString(),
        occurrenceCount: row.occurrence_count,
      }))).toEqual([
        {
          environmentId: environmentId,
          firstSeen: at(5),
          lastSeen: at(10),
          occurrenceCount: '5',
        },
        {
          environmentId: envB,
          firstSeen: at(20),
          lastSeen: at(20),
          occurrenceCount: '1',
        },
      ].sort((a, b) => a.environmentId.localeCompare(b.environmentId)));
    });

    it('rebuilds impact from active source rows after retraction', async () => {
      const sessionId = await seedSession();
      const userA = await seedEndUser('recompute-a');
      const userB = await seedEndUser('recompute-b');
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId,
        eventAt: new Date().toISOString(),
      });
      const META = { modelId: 'stub-model', promptVersion: 1, jobId: '' };

      const sigA = await seedSignal({ sessionId, occurredAt: new Date().toISOString(), endUserId: userA });
      const sigB = await seedSignal({
        sessionId,
        fingerprint: 'fp-second',
        occurredAt: new Date().toISOString(),
        endUserId: userB,
      });
      for (const seeded of [sigA, sigB]) {
        const { rows } = await pool.query(
          `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
                  occurred_at::text AS occurred_at FROM friction_signals WHERE id = $1`,
          [seeded.id]
        );
        await applyFoldOutcome({
          signal: rows[0] as FoldSignal,
          verdict: { accepted: true, reason: 'r' },
          meta: META,
        });
      }

      // Retract one attached signal, then recompute from source rows.
      await pool.query(`UPDATE friction_signals SET retracted_at = now() WHERE id = $1`, [
        sigB.id,
      ]);
      const client = await getPool().connect();
      try {
        await recomputeIncidentImpact(client, groupId, projectId);
      } finally {
        client.release();
      }

      const group = (await pool.query(
        `SELECT occurrence_count, affected_users_count FROM error_groups WHERE id = $1`,
        [groupId]
      )).rows[0]!;
      // 1 error event + 1 remaining active signal.
      expect(group.occurrence_count).toBe(2);
      expect(group.affected_users_count).toBe(1);

      const junctions = await pool.query(
        `SELECT end_user_id FROM error_group_affected_users WHERE error_group_id = $1`,
        [groupId]
      );
      expect(junctions.rows).toHaveLength(1);
      expect(junctions.rows[0]!.end_user_id).toBe(userA);
    });

    it('keeps attached-signal weight, retraction, and resurrection exact through persistence', async () => {
      const t0 = new Date('2026-07-16T14:00:00.000Z');
      const at = (deltaSeconds: number) => new Date(t0.getTime() + deltaSeconds * 1000);
      const sessionId = await seedSession();
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId,
        eventAt: at(10).toISOString(),
      });
      await pool.query(
        `INSERT INTO error_group_environments
           (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, $3, $3, 1)`,
        [groupId, environmentId, at(10).toISOString()],
      );
      const seeded = await seedSignal({
        sessionId,
        fingerprint: 'fp-persist-exact',
        occurredAt: at(5).toISOString(),
        occurrenceCount: 3,
      });
      const signalRow = (await pool.query(
        `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
                occurred_at::text AS occurred_at
         FROM friction_signals WHERE id = $1`,
        [seeded.id],
      )).rows[0] as FoldSignal;
      await applyFoldOutcome({
        signal: signalRow,
        verdict: { accepted: true, reason: 'real friction' },
        meta: { modelId: 'stub-model', promptVersion: 1, jobId: '' },
      });

      const session = {
        id: sessionId,
        project_id: projectId,
        environment_id: environmentId,
        end_user_id: null,
        status: 'pending',
        started_at: '2026-08-01T00:00:00Z',
        chunk_count: 1,
      };
      const detected = (occurredAt: Date, occurrenceCount: number) => ({
        signalType: 'rage_click' as const,
        fingerprint: 'fp-persist-exact',
        elementSelector: '#checkout',
        pageUrlNormalized: '/checkout',
        occurredAt: occurredAt.getTime(),
        occurredAts: [occurredAt.getTime()],
        occurrenceCount,
        ruleVersion: 1,
      });
      const impact = async () => {
        const group = (await pool.query<{ occurrence_count: number }>(
          `SELECT occurrence_count FROM error_groups WHERE id = $1`,
          [groupId],
        )).rows[0]!;
        const rollup = (await pool.query<{
          occurrence_count: string;
          first_seen: Date;
          last_seen: Date;
        }>(
          `SELECT occurrence_count, first_seen, last_seen
           FROM error_group_environments
           WHERE error_group_id = $1 AND environment_id = $2`,
          [groupId, environmentId],
        )).rows[0]!;
        return { group: group.occurrence_count, rollup };
      };

      await writeFrictionSignals(session, [detected(at(20), 5)], 1);
      let current = await impact();
      expect(current.group).toBe(6);
      expect(current.rollup.occurrence_count).toBe('6');
      expect(current.rollup.first_seen.toISOString()).toBe(at(10).toISOString());
      expect(current.rollup.last_seen.toISOString()).toBe(at(20).toISOString());

      await writeFrictionSignals(session, [], 1);
      current = await impact();
      expect(current.group).toBe(1);
      expect(current.rollup.occurrence_count).toBe('1');

      await writeFrictionSignals(session, [detected(at(0), 4)], 1);
      current = await impact();
      expect(current.group).toBe(5);
      expect(current.rollup.occurrence_count).toBe('5');
      expect(current.rollup.first_seen.toISOString()).toBe(at(0).toISOString());
      expect(current.rollup.last_seen.toISOString()).toBe(at(10).toISOString());
    });

    it('rejects a mismatched project without deleting another tenant impact', async () => {
      const sessionId = await seedSession();
      const userId = await seedEndUser('recompute-tenant-scope');
      const { groupId } = await seedErrorGroupWithEvent({
        sessionId,
        eventAt: new Date().toISOString(),
      });
      await pool.query(
        `INSERT INTO error_group_environments
           (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, now(), now(), 1)`,
        [groupId, environmentId],
      );
      await pool.query(
        `INSERT INTO error_group_affected_users
           (error_group_id, end_user_id, first_seen, last_seen, occurrence_count)
         VALUES ($1, $2, now(), now(), 1)`,
        [groupId, userId],
      );
      const otherOrg = (await pool.query<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
        [`recompute-other-${crypto.randomUUID()}`],
      )).rows[0]!.id;
      const otherProject = (await pool.query<{ id: string }>(
        `INSERT INTO projects (org_id, name) VALUES ($1, 'other') RETURNING id`,
        [otherOrg],
      )).rows[0]!.id;

      const client = await getPool().connect();
      try {
        await expect(recomputeIncidentImpact(client, groupId, otherProject)).rejects.toThrow();
      } finally {
        client.release();
      }
      const remaining = await pool.query<{ rollups: string; users: string }>(
        `SELECT
           (SELECT count(*) FROM error_group_environments WHERE error_group_id = $1)::text AS rollups,
           (SELECT count(*) FROM error_group_affected_users WHERE error_group_id = $1)::text AS users`,
        [groupId],
      );
      expect(remaining.rows[0]).toEqual({ rollups: '1', users: '1' });

      await pool.query(`DELETE FROM projects WHERE id = $1`, [otherProject]);
      await pool.query(`DELETE FROM orgs WHERE id = $1`, [otherOrg]);
    });
  });
});
