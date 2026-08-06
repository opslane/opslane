import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../db.js';
import {
  countEligibleUsers,
  ensureCandidate,
  claimGeneration,
  findValidAcceptedGeneration,
  applyBucketOutcome,
  attachInheritedSignal,
  frictionIncidentFingerprint,
  type FoldSignal,
} from '../promotion-db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const FP = 'fp-rage-checkout';
const RULE_VERSION = 1;
const PROMPT_VERSION = 1;
const META = { modelId: 'stub-model', promptVersion: PROMPT_VERSION, jobId: '' };

let pool: pg.Pool;
let orgId: string;
let projectId: string;
let environmentId: string;
let stagingEnvironmentId: string;

function tuple(envId = environmentId) {
  return {
    projectId,
    environmentId: envId,
    fingerprint: FP,
    ruleVersion: RULE_VERSION,
    promptVersion: PROMPT_VERSION,
  };
}

async function seedSession(): Promise<string> {
  const sessionId = `sess-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO sessions (id, project_id, environment_id, started_at)
     VALUES ($1, $2, $3, now() - interval '10 minutes')`,
    [sessionId, projectId, environmentId]
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
  user?: string | null;
  fingerprint?: string;
  environmentId?: string;
  occurredAt?: string;
  status?: string;
  occurrenceCount?: number;
  jobId?: string | null;
}): Promise<{ id: string; sessionId: string }> {
  const sessionId = await seedSession();
  const endUserId = opts.user === null || opts.user === undefined
    ? opts.user === null ? null : await seedEndUser(`u-${crypto.randomUUID()}`)
    : await seedEndUser(opts.user);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO friction_signals
       (session_id, project_id, environment_id, end_user_id, rule_version,
        signal_type, fingerprint, page_url_normalized, occurred_at,
        adjudication_status, occurrence_count, adjudication_job_id)
     VALUES ($1, $2, $3, $4, $5, 'rage_click', $6, '/checkout', $7, $8, $9, $10)
     RETURNING id`,
    [
      sessionId,
      projectId,
      opts.environmentId ?? environmentId,
      endUserId,
      RULE_VERSION,
      opts.fingerprint ?? FP,
      opts.occurredAt ?? new Date().toISOString(),
      opts.status ?? 'pending',
      opts.occurrenceCount ?? 1,
      opts.jobId ?? null,
    ]
  );
  return { id: res.rows[0]!.id, sessionId };
}

async function seedJob(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO error_group_jobs (project_id, status, job_type)
     VALUES ($1, 'claimed', 'session_analysis') RETURNING id`,
    [projectId]
  );
  return res.rows[0]!.id;
}

async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  // signals ↔ generations reference each other; null the signal-side FKs
  // before deleting signals, then generations, then groups.
  await pool.query(`UPDATE error_groups SET representative_signal_id = NULL WHERE project_id = $1`, [projectId]);
  await pool.query(
    `UPDATE friction_adjudication_generations SET representative_signal_id = NULL WHERE project_id = $1`,
    [projectId]
  );
  await pool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM diagnosis_decisions WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
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

describeDb('bucket promotion integration', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await purgeStaleTenants(pool, 'b4-bucket-test');
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('b4-bucket-test') RETURNING id`
    );
    orgId = org.rows[0]!.id;
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'b4-bucket', 'octocat/hello', 'main') RETURNING id`,
      [orgId]
    );
    projectId = proj.rows[0]!.id;
    const env = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId]
    );
    environmentId = env.rows[0]!.id;
    const staging = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'staging') RETURNING id`,
      [projectId]
    );
    stagingEnvironmentId = staging.rows[0]!.id;
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

  describe('countEligibleUsers', () => {
    it('counts distinct identified users of pending active signals in 7 days', async () => {
      for (let i = 0; i < 4; i++) await seedSignal({ user: `user-${i}` });
      // Same user twice: still one.
      await seedSignal({ user: 'user-0' });
      expect(await withClient((c) => countEligibleUsers(c, tuple()))).toBe(4);
      await seedSignal({ user: 'user-4' });
      expect(await withClient((c) => countEligibleUsers(c, tuple()))).toBe(5);
    });

    it('excludes anonymous, terminal, superseded, out-of-window, and other-environment signals', async () => {
      await seedSignal({ user: null }); // anonymous
      await seedSignal({ user: 'r', status: 'rejected' });
      await seedSignal({ user: 'u', status: 'unchecked' });
      await seedSignal({ user: 'old', occurredAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
      await seedSignal({ user: 'other-env', environmentId: stagingEnvironmentId });
      const retracted = await seedSignal({ user: 'retracted' });
      await pool.query(`UPDATE friction_signals SET retracted_at = now() WHERE id = $1`, [retracted.id]);
      expect(await withClient((c) => countEligibleUsers(c, tuple()))).toBe(0);
    });
  });

  describe('claimGeneration', () => {
    it('creates one in-flight generation with exact window bounds', async () => {
      const jobId = await seedJob();
      const gen = await claimGeneration(tuple(), jobId);
      expect(gen).not.toBeNull();
      const row = (await pool.query(
        `SELECT status, claim_job_id,
                (window_end - window_start) = interval '7 days' AS window_ok
         FROM friction_adjudication_generations WHERE id = $1`,
        [gen!.id]
      )).rows[0]!;
      expect(row.status).toBe('adjudicating');
      expect(row.claim_job_id).toBe(jobId);
      expect(row.window_ok).toBe(true);
    });

    it('concurrent claimers converge on one generation', async () => {
      const jobA = await seedJob();
      const jobB = await seedJob();
      const [a, b] = await Promise.all([
        claimGeneration(tuple(), jobA),
        claimGeneration(tuple(), jobB),
      ]);
      expect([a, b].filter((g) => g !== null)).toHaveLength(1);
    });

    it('a terminal generation releases the in-flight slot', async () => {
      const jobId = await seedJob();
      const gen = await claimGeneration(tuple(), jobId);
      await pool.query(
        `UPDATE friction_adjudication_generations
         SET status = 'unchecked', finished_at = now() WHERE id = $1`,
        [gen!.id]
      );
      const again = await claimGeneration(tuple(), await seedJob());
      expect(again).not.toBeNull();
    });
  });

  describe('applyBucketOutcome', () => {
    async function seedThresholdBucket(jobId: string): Promise<Array<{ id: string; sessionId: string }>> {
      const signals = [];
      for (let i = 0; i < 5; i++) {
        signals.push(
          await seedSignal({ user: `bucket-user-${i}`, jobId, occurrenceCount: i === 2 ? 9 : 1 })
        );
      }
      return signals;
    }

    it('accepted verdict promotes the candidate exactly once with full impact', async () => {
      const jobId = await seedJob();
      const signals = await seedThresholdBucket(jobId);
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: '#buy',
        })
      );
      const gen = await claimGeneration(tuple(), jobId);

      const outcome = await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen!.id,
        verdict: { accepted: true, reason: 'real friction' },
        meta: { ...META, jobId },
      });
      expect(outcome).toBe('promoted');

      const incidentFp = frictionIncidentFingerprint(environmentId, FP);
      const group = (await pool.query(
        `SELECT id, status, kind, environment_id, occurrence_count, affected_users_count,
                representative_signal_id
         FROM error_groups WHERE project_id = $1 AND fingerprint = $2`,
        [projectId, incidentFp]
      )).rows[0]!;
      expect(group.status).toBe('queued');
      expect(group.kind).toBe('friction');
      expect(group.environment_id).toBe(environmentId);
      expect(group.occurrence_count).toBe(13); // 4×1 + 9
      expect(group.affected_users_count).toBe(5);
      // Representative: highest occurrence_count wins.
      expect(group.representative_signal_id).toBe(signals[2]!.id);

      // Exactly one investigate job.
      const jobs = await pool.query(
        `SELECT job_type, triggered_by FROM error_group_jobs WHERE error_group_id = $1`,
        [group.id]
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]!.job_type).toBe('investigate');

      // All signals attached and accepted; sessions pinned.
      const sigRows = await pool.query(
        `SELECT adjudication_status, adjudication_scope, generation_id, incident_id
         FROM friction_signals WHERE project_id = $1`,
        [projectId]
      );
      for (const row of sigRows.rows) {
        expect(row.adjudication_status).toBe('accepted');
        expect(row.adjudication_scope).toBe('bucket');
        expect(row.generation_id).toBe(gen!.id);
        expect(row.incident_id).toBe(group.id);
      }
      const pins = await pool.query(
        `SELECT count(*)::int AS n FROM sessions
         WHERE project_id = $1 AND retain_until = started_at + interval '90 days'`,
        [projectId]
      );
      expect(pins.rows[0]!.n).toBe(5);

      // Generation is terminal-accepted with validity.
      const genRow = (await pool.query(
        `SELECT status, promoted_incident_id,
                (valid_until - adjudicated_at) = interval '7 days' AS validity_ok
         FROM friction_adjudication_generations WHERE id = $1`,
        [gen!.id]
      )).rows[0]!;
      expect(genRow.status).toBe('accepted');
      expect(genRow.promoted_incident_id).toBe(group.id);
      expect(genRow.validity_ok).toBe(true);

      // Idempotency: replaying the outcome is a no-op.
      expect(
        await applyBucketOutcome({
          tuple: tuple(),
          generationId: gen!.id,
          verdict: { accepted: true, reason: 'real friction' },
          meta: { ...META, jobId },
        })
      ).toBe('noop');
    });

    it('rejected verdict terminates the generation with no incident', async () => {
      const jobId = await seedJob();
      await seedThresholdBucket(jobId);
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const gen = await claimGeneration(tuple(), jobId);

      const outcome = await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen!.id,
        verdict: { accepted: false, reason: 'noise' },
        meta: { ...META, jobId },
      });
      expect(outcome).toBe('rejected');

      const group = (await pool.query(
        `SELECT status, occurrence_count FROM error_groups
         WHERE project_id = $1 AND fingerprint = $2`,
        [projectId, frictionIncidentFingerprint(environmentId, FP)]
      )).rows[0]!;
      expect(group.status).toBe('candidate');
      expect(group.occurrence_count).toBe(0);
      const jobs = await pool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs WHERE job_type = 'investigate' AND project_id = $1`,
        [projectId]
      );
      expect(jobs.rows[0]!.n).toBe(0);
    });

    it('a later accepted generation updates the existing incident without a new job', async () => {
      // First promotion.
      const jobId = await seedJob();
      await seedThresholdBucket(jobId);
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const gen1 = await claimGeneration(tuple(), jobId);
      await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen1!.id,
        verdict: { accepted: true, reason: 'r' },
        meta: { ...META, jobId },
      });
      // Expire the first generation's validity.
      await pool.query(
        `UPDATE friction_adjudication_generations SET valid_until = now() - interval '1 hour' WHERE id = $1`,
        [gen1!.id]
      );

      // Five fresh users cross the threshold again.
      const jobId2 = await seedJob();
      for (let i = 0; i < 5; i++) {
        await seedSignal({ user: `second-wave-${i}`, jobId: jobId2 });
      }
      const gen2 = await claimGeneration(tuple(), jobId2);
      expect(gen2).not.toBeNull();
      const outcome = await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen2!.id,
        verdict: { accepted: true, reason: 'still real' },
        meta: { ...META, jobId: jobId2 },
      });
      expect(outcome).toBe('updated');

      const group = (await pool.query(
        `SELECT id, affected_users_count FROM error_groups
         WHERE project_id = $1 AND fingerprint = $2`,
        [projectId, frictionIncidentFingerprint(environmentId, FP)]
      )).rows[0]!;
      expect(group.affected_users_count).toBe(10);
      const jobs = await pool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs
         WHERE error_group_id = $1 AND job_type = 'investigate'`,
        [group.id]
      );
      expect(jobs.rows[0]!.n).toBe(1); // still just the first promotion's job
    });

    it('environments never combine: same fingerprint promotes independently', async () => {
      const jobId = await seedJob();
      await seedThresholdBucket(jobId);
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const gen = await claimGeneration(tuple(), jobId);
      await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen!.id,
        verdict: { accepted: true, reason: 'r' },
        meta: { ...META, jobId },
      });

      // Staging candidate is a distinct row; production incident untouched by it.
      await withClient((c) =>
        ensureCandidate(c, tuple(stagingEnvironmentId), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const rows = await pool.query(
        `SELECT fingerprint, status FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' ORDER BY fingerprint`,
        [projectId]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.map((r) => r.status).sort()).toEqual(['candidate', 'queued']);
    });

    it('resumes an accepted generation whose signals were never attached (crash recovery)', async () => {
      const jobId = await seedJob();
      await seedThresholdBucket(jobId);
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const gen = await claimGeneration(tuple(), jobId);
      // Simulate a crash after the verdict was persisted but before the outcome.
      await pool.query(
        `UPDATE friction_adjudication_generations
         SET status = 'accepted', adjudicated_at = now(), valid_until = now() + interval '7 days'
         WHERE id = $1`,
        [gen!.id]
      );

      const outcome = await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen!.id,
        verdict: { accepted: true, reason: 'resume' },
        meta: { ...META, jobId },
      });
      expect(outcome).toBe('promoted');
      const group = (await pool.query(
        `SELECT status, affected_users_count FROM error_groups
         WHERE project_id = $1 AND fingerprint = $2`,
        [projectId, frictionIncidentFingerprint(environmentId, FP)]
      )).rows[0]!;
      expect(group.status).toBe('queued');
      expect(group.affected_users_count).toBe(5);
    });
  });

  describe('verdict inheritance', () => {
    it('a later matching signal attaches under a valid accepted generation without a new call', async () => {
      const jobId = await seedJob();
      for (let i = 0; i < 5; i++) await seedSignal({ user: `inherit-${i}`, jobId });
      await withClient((c) =>
        ensureCandidate(c, tuple(), {
          signalType: 'rage_click',
          pageUrlNormalized: '/checkout',
          elementSelector: null,
        })
      );
      const gen = await claimGeneration(tuple(), jobId);
      await applyBucketOutcome({
        tuple: tuple(),
        generationId: gen!.id,
        verdict: { accepted: true, reason: 'r' },
        meta: { ...META, jobId },
      });

      const valid = await withClient((c) => findValidAcceptedGeneration(c, tuple()));
      expect(valid?.id).toBe(gen!.id);

      const late = await seedSignal({ user: 'inherit-late' });
      const lateRow = (await pool.query(
        `SELECT id, project_id, environment_id, end_user_id, session_id, fingerprint,
                occurred_at::text AS occurred_at FROM friction_signals WHERE id = $1`,
        [late.id]
      )).rows[0] as FoldSignal;
      const outcome = await attachInheritedSignal(lateRow, valid!);
      expect(outcome).toBe('attached');

      const group = (await pool.query(
        `SELECT affected_users_count, occurrence_count FROM error_groups
         WHERE project_id = $1 AND fingerprint = $2`,
        [projectId, frictionIncidentFingerprint(environmentId, FP)]
      )).rows[0]!;
      expect(group.affected_users_count).toBe(6);
      expect(group.occurrence_count).toBe(6);
    });

    it('expired generations do not inherit', async () => {
      const jobId = await seedJob();
      const gen = await claimGeneration(tuple(), jobId);
      await pool.query(
        `UPDATE friction_adjudication_generations
         SET status = 'accepted', adjudicated_at = now() - interval '8 days',
             valid_until = now() - interval '1 day'
         WHERE id = $1`,
        [gen!.id]
      );
      expect(await withClient((c) => findValidAcceptedGeneration(c, tuple()))).toBeNull();
    });
  });
});
