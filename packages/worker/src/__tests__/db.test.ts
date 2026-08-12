import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { purgeDiagnosisDecisions } from './purge-diagnosis-decisions.js';
import { purgeFixRunLedger } from './purge-fix-run-ledger.js';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  claimJob,
  heartbeat,
  completeJob,
  failJob,
  requeueStaleJobs,
  resolveInactiveGroups,
  resolveSilentMergedGroups,
  updateGroupStatus,
  updateGroupInvestigation,
  updateGroupAndCreateFixJob,
  updateJobTraceUrl,
  recordSetupPrResult,
  getPool,
  closePool,
  reserveDelivery,
  recordDeliveryPushed,
  finalizeDelivery,
  getQueueDepth,
  recordDiagnosisDecision,
  loadDiagnosisDecision,
  loadDiagnosisDecisionForSource,
  getGroupImpactBar,
  getFrictionGroupImpactBar,
  insertFixRunLedger,
} from '../db.js';
import { createLedgerRecorder } from '../verification-ledger.js';

const DATABASE_URL = process.env['DATABASE_URL'];

// Skip all integration tests if no DATABASE_URL is provided
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Seed helpers */
let testPool: pg.Pool;
let testOrgId: string;
let testProjectId: string;

async function seedTenant(): Promise<void> {
  const orgResult = await testPool.query<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ('test-org') RETURNING id`
  );
  testOrgId = orgResult.rows[0]!.id;

  const projectResult = await testPool.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo, default_branch)
     VALUES ($1, 'test-project', 'octocat/hello', 'main') RETURNING id`,
    [testOrgId]
  );
  testProjectId = projectResult.rows[0]!.id;
}

async function seedErrorGroupAndJob(overrides?: {
  status?: string;
  attempts?: number;
  max_attempts?: number;
  worker_id?: string | null;
  claimed_at?: Date | null;
  lease_expires_at?: Date | null;
}): Promise<{ errorGroupId: string; jobId: string }> {
  const groupResult = await testPool.query<{ id: string }>(
    `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status)
     VALUES ($1, $2, 'Test Error', now(), now(), 'queued') RETURNING id`,
    [testProjectId, `fp-${crypto.randomUUID()}`]
  );
  const errorGroupId = groupResult.rows[0]!.id;

  const status = overrides?.status ?? 'pending';
  const attempts = overrides?.attempts ?? 0;
  const maxAttempts = overrides?.max_attempts ?? 3;
  const workerId = overrides?.worker_id ?? null;
  const claimedAt = overrides?.claimed_at ?? null;
  const leaseExpiresAt = overrides?.lease_expires_at ?? null;

  const jobResult = await testPool.query<{ id: string }>(
    `INSERT INTO error_group_jobs
       (error_group_id, project_id, status, attempts, max_attempts, worker_id, claimed_at, lease_expires_at)
     VALUES ($1, $2, $3::job_status, $4, $5, $6, $7, $8)
     RETURNING id`,
    [errorGroupId, testProjectId, status, attempts, maxAttempts, workerId, claimedAt, leaseExpiresAt]
  );
  const jobId = jobResult.rows[0]!.id;

  return { errorGroupId, jobId };
}

async function seedPendingJob(options: {
  jobType: 'session_analysis' | 'investigate';
  availableAt: Date;
  createdAt?: Date;
}): Promise<string> {
  const { jobId } = await seedErrorGroupAndJob();
  await testPool.query(
    `UPDATE error_group_jobs
        SET job_type = $2, available_at = $3, created_at = $4
      WHERE id = $1`,
    [jobId, options.jobType, options.availableAt, options.createdAt ?? new Date()],
  );
  return jobId;
}

async function cleanupTestData(): Promise<void> {
  // Delete in reverse FK order
  await testPool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [testProjectId]);
  await purgeDiagnosisDecisions(testPool, testProjectId);
  await purgeFixRunLedger(testPool, testProjectId);
  await testPool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM error_events WHERE project_id = $1`, [testProjectId]);
  await testPool.query(
    `DELETE FROM error_group_affected_users
     WHERE end_user_id IN (SELECT id FROM end_users WHERE project_id = $1)`,
    [testProjectId],
  );
  await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM sessions WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM end_users WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM environments WHERE project_id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
  await testPool.query(`DELETE FROM orgs WHERE id = $1`, [testOrgId]);
}

async function expireAndReclaimWithSameWorker(): Promise<{
  jobId: string;
  errorGroupId: string;
  staleGeneration: string;
  currentGeneration: string;
}> {
  const { jobId, errorGroupId } = await seedErrorGroupAndJob();
  const staleClaim = await claimJob('worker-reused', 60_000);
  expect(staleClaim?.id).toBe(jobId);

  await testPool.query(
    `UPDATE error_group_jobs
     SET lease_expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [jobId],
  );
  expect(await requeueStaleJobs()).toBe(1);

  // The reaper now backs retries off. This helper is specifically exercising
  // generation fencing after a later reclaim, so make that retry eligible
  // without weakening any of the stale-generation assertions below.
  await testPool.query(
    `UPDATE error_group_jobs SET available_at = now() WHERE id = $1`,
    [jobId],
  );

  const currentClaim = await claimJob('worker-reused', 60_000);
  expect(currentClaim?.id).toBe(jobId);
  expect(BigInt(currentClaim!.leaseGeneration)).toBe(
    BigInt(staleClaim!.leaseGeneration) + 1n,
  );

  return {
    jobId,
    errorGroupId,
    staleGeneration: staleClaim!.leaseGeneration,
    currentGeneration: currentClaim!.leaseGeneration,
  };
}

describeDb('db.ts integration tests', () => {
  beforeAll(async () => {
    testPool = new pg.Pool({ connectionString: DATABASE_URL });
    // Ensure the worker's getPool uses the same DATABASE_URL (it reads from env)
    await seedTenant();
  });

  afterAll(async () => {
    await cleanupTestData();
    await testPool.end();
    await closePool();
  });

  beforeEach(async () => {
    // Clean only jobs and error groups between tests, keep tenant
    await testPool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [testProjectId]);
    await testPool.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [testProjectId]);
    await purgeDiagnosisDecisions(testPool, testProjectId);
    await purgeFixRunLedger(testPool, testProjectId);
    await testPool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [testProjectId]);
    await testPool.query(`DELETE FROM error_events WHERE project_id = $1`, [testProjectId]);
    await testPool.query(
      `DELETE FROM error_group_affected_users
       WHERE end_user_id IN (SELECT id FROM end_users WHERE project_id = $1)`,
      [testProjectId],
    );
    await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [testProjectId]);
  });

  describe('diagnosis decisions', () => {
    const baseDecision = {
      diagnosis: null,
      model: 'claude-sonnet-4-6',
      promptVersion: 'diagnosis-v1',
      basis: 'local_defect' as const,
      confidence: 'high' as const,
    };

    describe('loadDiagnosisDecision', () => {
      it('returns the most recent decision for the group', async () => {
        const { errorGroupId } = await seedErrorGroupAndJob();
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision,
          outcome: 'not_actionable',
          decisionReason: 'external',
          basis: 'cause_outside_codebase',
          confidence: 'high',
        });

        expect(await loadDiagnosisDecision(errorGroupId, testProjectId)).toMatchObject({
          outcome: 'not_actionable', basis: 'cause_outside_codebase', confidence: 'high',
        });
      });

      // requeueStaleJobs updates error_group_jobs in place, so a retried job keeps
      // its id. A partial unique index on job_id plus ON CONFLICT DO NOTHING
      // therefore dropped every retry's conclusion: attempt 1 concluded
      // not_actionable, attempt 2 concluded code_fix, and the fix gate went on
      // reading attempt 1 forever — with migration 034 leaving no way to correct
      // it. See migration 037.
      it('records each attempt of a retried job, not just the first', async () => {
        const { errorGroupId, jobId } = await seedErrorGroupAndJob();
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision, jobId, outcome: 'not_actionable', decisionReason: 'attempt 1',
          basis: 'cause_outside_codebase', confidence: 'high',
        });
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision, jobId, outcome: 'code_fix', decisionReason: 'attempt 2 after requeue',
          basis: 'local_defect', confidence: 'high',
        });

        const { rows } = await testPool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM diagnosis_decisions WHERE job_id = $1', [jobId],
        );
        expect(rows[0]?.n).toBe('2');
        expect(await loadDiagnosisDecision(errorGroupId, testProjectId)).toMatchObject({
          outcome: 'code_fix', basis: 'local_defect', confidence: 'high',
        });
      });

      it('returns the newest of several decisions for the same group', async () => {
        const { errorGroupId } = await seedErrorGroupAndJob();
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision, outcome: 'needs_more_context', decisionReason: 'first',
          basis: 'insufficient_evidence', confidence: 'low',
        });
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision, outcome: 'code_fix', decisionReason: 'second',
          basis: 'local_defect', confidence: 'high',
        });

        expect(await loadDiagnosisDecision(errorGroupId, testProjectId)).toMatchObject({
          outcome: 'code_fix', basis: 'local_defect', confidence: 'high',
        });
      });

      it('loads the decision linked to the source investigation instead of a newer group decision', async () => {
        const { errorGroupId, jobId: sourceJobId } = await seedErrorGroupAndJob();
        const newerJob = await testPool.query<{ id: string }>(
          `INSERT INTO error_group_jobs (error_group_id, project_id, job_type)
           VALUES ($1, $2, 'investigate') RETURNING id`,
          [errorGroupId, testProjectId],
        );
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision,
          jobId: sourceJobId,
          outcome: 'code_fix',
          decisionReason: 'source decision',
          policyEligible: true,
          policyBasis: { v: 1, identified_users: 1, recent_anon_sessions: 0 },
        });
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision,
          jobId: newerJob.rows[0]!.id,
          outcome: 'not_actionable',
          decisionReason: 'newer unrelated decision',
          basis: 'cause_outside_codebase',
          policyEligible: false,
          policyBasis: { v: 1, identified_users: 0, recent_anon_sessions: 0 },
        });

        expect(await loadDiagnosisDecisionForSource(
          errorGroupId,
          testProjectId,
          sourceJobId,
        )).toMatchObject({
          outcome: 'code_fix',
          policyEligible: true,
          policyBasis: { v: 1, identified_users: 1, recent_anon_sessions: 0 },
        });
      });

      it('returns null when the group has no decision', async () => {
        const { errorGroupId } = await seedErrorGroupAndJob();
        expect(await loadDiagnosisDecision(errorGroupId, testProjectId)).toBeNull();
      });

      it('scopes by project', async () => {
        const { errorGroupId } = await seedErrorGroupAndJob();
        await recordDiagnosisDecision(errorGroupId, testProjectId, {
          ...baseDecision, outcome: 'code_fix', decisionReason: 'r',
          basis: 'local_defect', confidence: 'high',
        });

        const other = await testPool.query<{ id: string }>(
          `INSERT INTO orgs (name) VALUES ('other-org') RETURNING id`,
        );
        const otherProject = await testPool.query<{ id: string }>(
          `INSERT INTO projects (org_id, name, github_repo, default_branch)
           VALUES ($1, 'other-project', 'octocat/other', 'main') RETURNING id`,
          [other.rows[0]!.id],
        );

        expect(await loadDiagnosisDecision(errorGroupId, otherProject.rows[0]!.id)).toBeNull();

        await testPool.query(`DELETE FROM projects WHERE id = $1`, [otherProject.rows[0]!.id]);
        await testPool.query(`DELETE FROM orgs WHERE id = $1`, [other.rows[0]!.id]);
      });
    });

    it('records every decision for separate jobs without overwriting earlier conclusions', async () => {
      const { errorGroupId, jobId: firstJobId } = await seedErrorGroupAndJob();
      const secondJob = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs (error_group_id, project_id, job_type)
         VALUES ($1, $2, 'investigate') RETURNING id`,
        [errorGroupId, testProjectId],
      );

      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...baseDecision,
        jobId: firstJobId,
        outcome: 'not_actionable',
        decisionReason: 'The cause is outside this codebase',
        causeLocation: 'GET /api/assets/search (remote service)',
      });
      await recordDiagnosisDecision(errorGroupId, testProjectId, {
        ...baseDecision,
        jobId: secondJob.rows[0]!.id,
        outcome: 'code_fix',
        decisionReason: 'The cause is at src/App.vue:42',
        causeLocation: 'src/App.vue:42',
      });

      const { rows } = await testPool.query<{ outcome: string }>(
        `SELECT outcome FROM diagnosis_decisions
         WHERE error_group_id = $1 ORDER BY decided_at, id`,
        [errorGroupId],
      );
      expect(rows.map((row) => row.outcome)).toEqual(['not_actionable', 'code_fix']);
    });

    // Replaces a test that recorded the SAME decision twice and asserted one row.
    // Deduplicating on job_id is what broke retries: it only ever exercised the
    // identical-decision case, so the case that mattered — a retry reaching a
    // DIFFERENT conclusion, silently discarded — went unnoticed. See migration 037
    // and 'records each attempt of a retried job, not just the first'.
    it('appends a row per attempt, and the newest is the one that counts', async () => {
      const { errorGroupId, jobId } = await seedErrorGroupAndJob();
      const decision = {
        ...baseDecision,
        jobId,
        outcome: 'code_fix' as const,
        decisionReason: 'The cause is at src/App.vue:42',
        causeLocation: 'src/App.vue:42',
      };

      await recordDiagnosisDecision(errorGroupId, testProjectId, decision);
      await recordDiagnosisDecision(errorGroupId, testProjectId, decision);

      const { rows } = await testPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM diagnosis_decisions WHERE job_id = $1',
        [jobId],
      );
      expect(rows[0]!.n).toBe(2);
      expect(await loadDiagnosisDecision(errorGroupId, testProjectId)).toMatchObject({
        outcome: 'code_fix', basis: 'local_defect', confidence: 'high',
      });
    });

    it('stores the status transition and its decision together', async () => {
      const { errorGroupId, jobId } = await seedErrorGroupAndJob();
      await updateGroupInvestigation(errorGroupId, testProjectId, 'insight', {
        rootCause: 'The remote search endpoint timed out',
        confidence: 'medium',
        decision: {
          ...baseDecision,
          jobId,
          outcome: 'not_actionable',
          decisionReason: 'The cause is outside this codebase',
          causeLocation: 'GET /api/assets/search (remote service)',
        },
      });

      const { rows } = await testPool.query<{ status: string; outcome: string }>(
        `SELECT eg.status, dd.outcome
         FROM error_groups eg
         JOIN diagnosis_decisions dd ON dd.error_group_id = eg.id
         WHERE eg.id = $1 AND dd.job_id = $2`,
        [errorGroupId, jobId],
      );
      expect(rows[0]).toEqual({ status: 'insight', outcome: 'not_actionable' });
    });
  });

  describe('impact policy', () => {
    it('qualifies at one identified user or three recent anonymous sessions', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();
      const environment = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `impact-${crypto.randomUUID()}`],
      );
      for (const sessionId of ['anon-1', 'anon-2']) {
        await testPool.query(
          `INSERT INTO error_events
             (project_id, environment_id, error_group_id, session_id, timestamp,
              error_type, error_message, stack_trace_raw)
           VALUES ($1, $2, $3, $4, now(), 'Error', 'impact', 'stack')`,
          [testProjectId, environment.rows[0]!.id, errorGroupId, sessionId],
        );
      }
      await expect(getGroupImpactBar(errorGroupId, testProjectId)).resolves.toEqual({
        identifiedUsers: 0,
        recentAnonSessions: 2,
        eligible: false,
      });

      await testPool.query(
        `INSERT INTO error_events
           (project_id, environment_id, error_group_id, session_id, timestamp,
            error_type, error_message, stack_trace_raw)
         VALUES ($1, $2, $3, 'anon-3', now(), 'Error', 'impact', 'stack')`,
        [testProjectId, environment.rows[0]!.id, errorGroupId],
      );
      expect(await getGroupImpactBar(errorGroupId, testProjectId)).toMatchObject({
        recentAnonSessions: 3,
        eligible: true,
      });

      const user = await testPool.query<{ id: string }>(
        `INSERT INTO end_users (project_id, external_user_id)
         VALUES ($1, $2) RETURNING id`,
        [testProjectId, `impact-user-${crypto.randomUUID()}`],
      );
      await testPool.query(
        `INSERT INTO error_group_affected_users (error_group_id, end_user_id)
         VALUES ($1, $2)`,
        [errorGroupId, user.rows[0]!.id],
      );
      expect(await getGroupImpactBar(errorGroupId, testProjectId)).toMatchObject({
        identifiedUsers: 1,
        eligible: true,
      });
    });

    it('uses accepted active friction sessions and the server-observed seven-day window', async () => {
      const environment = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `friction-impact-${crypto.randomUUID()}`],
      );
      const user = await testPool.query<{ id: string }>(
        `INSERT INTO end_users (project_id, external_user_id) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `friction-impact-user-${crypto.randomUUID()}`],
      );
      const seedGroup = async (label: string): Promise<string> => {
        const result = await testPool.query<{ id: string }>(
          `INSERT INTO error_groups
             (project_id, environment_id, fingerprint, title, first_seen, last_seen, status, kind)
           VALUES ($1, $2, $3, $3, now(), now(), 'insight', 'friction') RETURNING id`,
          [testProjectId, environment.rows[0]!.id, `${label}-${crypto.randomUUID()}`],
        );
        return result.rows[0]!.id;
      };
      const seedSignal = async (options: {
        groupId: string; sessionId: string; fingerprint: string;
        endUserId?: string; status?: string; retracted?: boolean; old?: boolean;
      }): Promise<void> => {
        await testPool.query(
          `INSERT INTO sessions (id, project_id, environment_id, started_at)
           VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
          [options.sessionId, testProjectId, environment.rows[0]!.id],
        );
        await testPool.query(
          `INSERT INTO friction_signals
             (session_id, project_id, environment_id, end_user_id, rule_version, signal_type,
              fingerprint, page_url_normalized, occurred_at, adjudication_status, incident_id,
              retracted_at, created_at)
           VALUES ($1,$2,$3,$4,1,'dead_click',$5,'/impact',now(),$6,$7,
                   CASE WHEN $8 THEN now() ELSE NULL END,
                   CASE WHEN $9 THEN now()-interval '8 days' ELSE now() END)`,
          [options.sessionId, testProjectId, environment.rows[0]!.id, options.endUserId ?? null,
            options.fingerprint, options.status ?? 'accepted', options.groupId,
            options.retracted ?? false, options.old ?? false],
        );
      };

      const identified = await seedGroup('identified');
      const mixedSession = `mixed-${crypto.randomUUID()}`;
      await seedSignal({ groupId: identified, sessionId: mixedSession, fingerprint: 'identified', endUserId: user.rows[0]!.id });
      await seedSignal({ groupId: identified, sessionId: mixedSession, fingerprint: 'anonymous-in-mixed' });
      await expect(getFrictionGroupImpactBar(identified, testProjectId)).resolves.toEqual({
        identifiedUsers: 1, recentAnonSessions: 0, eligible: true,
      });

      const anonymous = await seedGroup('anonymous');
      for (let i = 0; i < 3; i++) {
        await seedSignal({ groupId: anonymous, sessionId: `anon-${i}-${crypto.randomUUID()}`, fingerprint: `anon-${i}` });
      }
      await expect(getFrictionGroupImpactBar(anonymous, testProjectId)).resolves.toEqual({
        identifiedUsers: 0, recentAnonSessions: 3, eligible: true,
      });

      const below = await seedGroup('below');
      for (let i = 0; i < 2; i++) {
        await seedSignal({ groupId: below, sessionId: `below-${i}-${crypto.randomUUID()}`, fingerprint: `below-${i}` });
      }
      await seedSignal({ groupId: below, sessionId: `retracted-${crypto.randomUUID()}`, fingerprint: 'retracted', retracted: true });
      await seedSignal({ groupId: below, sessionId: `pending-${crypto.randomUUID()}`, fingerprint: 'pending', status: 'pending' });
      await seedSignal({ groupId: below, sessionId: `old-${crypto.randomUUID()}`, fingerprint: 'old', old: true });
      await expect(getFrictionGroupImpactBar(below, testProjectId)).resolves.toEqual({
        identifiedUsers: 0, recentAnonSessions: 2, eligible: false,
      });
    });
  });

  describe('fix verification ledger', () => {
    it('persists ordered harness entries and their explicit not-run set', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const recorder = createLedgerRecorder(jobId, testProjectId);
      recorder.record({
        command: 'pnpm test', commitSha: 'base-sha', workdirDirty: false,
        discovered: 2, passed: 1, failed: 1, skipped: 0,
        truncated: false, timedOut: false,
      }, 'suite_baseline');
      recorder.record({
        command: 'pnpm build', commitSha: 'fix-sha', workdirDirty: false,
        discovered: null, passed: null, failed: 0, skipped: null,
        truncated: false, timedOut: false,
      }, 'build');
      recorder.finalizeNotRun(['repro_red', 'repro_green']);

      await insertFixRunLedger(recorder.entries());

      const { rows } = await testPool.query<{
        entry_seq: number;
        command: string;
        not_run: string[];
      }>(
        `SELECT entry_seq, command, not_run
         FROM fix_run_ledger WHERE run_id = $1 ORDER BY entry_seq`,
        [recorder.runId],
      );
      expect(rows).toEqual([
        { entry_seq: 1, command: 'pnpm test', not_run: [] },
        { entry_seq: 2, command: 'pnpm build', not_run: ['repro_red', 'repro_green'] },
      ]);
    });
  });

  describe('digest readiness projection', () => {
    it('moves the readiness clock only when status or reason changes', async () => {
      const seeded = await seedErrorGroupAndJob();
      await updateGroupInvestigation(seeded.errorGroupId, testProjectId, 'insight', {
        rootCause: 'validated cause',
        readiness: { status: 'eligible', reason: 'validated_cause' },
      });
      const oldClock = (await testPool.query<{ updated_at: Date }>(
        `UPDATE digest_readiness SET updated_at = now() - interval '1 hour'
         WHERE incident_id = $1 RETURNING updated_at`,
        [seeded.errorGroupId],
      )).rows[0]!.updated_at;

      await updateGroupInvestigation(seeded.errorGroupId, testProjectId, 'insight', {
        rootCause: 'validated cause',
        readiness: { status: 'eligible', reason: 'validated_cause' },
      });
      const unchanged = (await testPool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM digest_readiness WHERE incident_id = $1`,
        [seeded.errorGroupId],
      )).rows[0]!.updated_at;
      expect(unchanged.getTime()).toBe(oldClock.getTime());

      await updateGroupInvestigation(seeded.errorGroupId, testProjectId, 'insight', {
        rootCause: 'validated cause',
        readiness: { status: 'eligible', reason: 'fix_pr_opened' },
      });
      const changed = (await testPool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM digest_readiness WHERE incident_id = $1`,
        [seeded.errorGroupId],
      )).rows[0]!.updated_at;
      expect(changed.getTime()).toBeGreaterThan(oldClock.getTime());
      expect(Date.now() - changed.getTime()).toBeLessThan(10_000);
    });

    it('upserts readiness in the same investigation write and leaves legacy rows absent', async () => {
      const first = await seedErrorGroupAndJob();
      await updateGroupInvestigation(first.errorGroupId, testProjectId, 'insight', {
        rootCause: 'validated cause',
        readiness: { status: 'ineligible', reason: 'filler_verdict: rejected' },
      });
      expect((await testPool.query(
        `SELECT status, reason FROM digest_readiness WHERE incident_id = $1`,
        [first.errorGroupId],
      )).rows[0]).toEqual({ status: 'ineligible', reason: 'filler_verdict: rejected' });

      await updateGroupInvestigation(first.errorGroupId, testProjectId, 'insight', {
        rootCause: 'validated cause',
        readiness: { status: 'eligible', reason: 'validated_cause' },
      });
      expect((await testPool.query(
        `SELECT status, reason FROM digest_readiness WHERE incident_id = $1`,
        [first.errorGroupId],
      )).rows[0]).toEqual({ status: 'eligible', reason: 'validated_cause' });

      const legacy = await seedErrorGroupAndJob();
      await updateGroupInvestigation(legacy.errorGroupId, testProjectId, 'insight', {
        rootCause: 'legacy cause',
      });
      expect((await testPool.query(
        `SELECT count(*)::int AS n FROM digest_readiness WHERE incident_id = $1`,
        [legacy.errorGroupId],
      )).rows[0]!.n).toBe(0);
    });

    it('refuses report-only fix creation before mutating the group', async () => {
      const seeded = await seedErrorGroupAndJob();
      const claim = await claimJob('report-only-worker', 60_000);
      expect(claim?.id).toBe(seeded.jobId);
      const result = await updateGroupAndCreateFixJob(
        seeded.errorGroupId,
        testProjectId,
        { rootCause: 'verified cause', confidence: 'high' },
        { ...claim!, triggeredBy: 'reinvestigate_report_only' },
      );
      expect(result).toEqual({ created: false, reason: 'report_only' });
      expect((await testPool.query(
        `SELECT status FROM error_groups WHERE id = $1`, [seeded.errorGroupId],
      )).rows[0]!.status).toBe('queued');
      expect((await testPool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs WHERE error_group_id = $1 AND job_type IN ('fix','error_fix')`,
        [seeded.errorGroupId],
      )).rows[0]!.n).toBe(0);
    });

    it('never steals a pending human fix while still recording the new policy decision', async () => {
      const seeded = await seedErrorGroupAndJob();
      const claim = await claimJob('human-precedence-worker', 60_000);
      expect(claim?.id).toBe(seeded.jobId);
      const humanFix = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs
           (error_group_id, project_id, job_type, triggered_by)
         VALUES ($1, $2, 'fix', 'human') RETURNING id`,
        [seeded.errorGroupId, testProjectId],
      );

      const result = await updateGroupAndCreateFixJob(
        seeded.errorGroupId,
        testProjectId,
        {
          rootCause: 'new automated diagnosis',
          sourceJobId: seeded.jobId,
          decision: {
            diagnosis: null,
            model: 'claude-sonnet-5',
            promptVersion: 'diagnosis-v1',
            basis: 'local_defect',
            confidence: 'medium',
            jobId: seeded.jobId,
            outcome: 'code_fix',
            decisionReason: 'local cause above impact bar',
            policyEligible: true,
            policyBasis: { v: 1, identified_users: 1, recent_anon_sessions: 0 },
          },
          readiness: { status: 'eligible', reason: 'validated_cause' },
        },
        claim!,
      );

      expect(result).toEqual({ created: false, reason: 'pending_human_job' });
      expect((await testPool.query(
        `SELECT status, triggered_by FROM error_group_jobs WHERE id = $1`,
        [humanFix.rows[0]!.id],
      )).rows[0]).toEqual({ status: 'pending', triggered_by: 'human' });
      expect(await loadDiagnosisDecisionForSource(
        seeded.errorGroupId,
        testProjectId,
        seeded.jobId,
      )).toMatchObject({ policyEligible: true });
    });

    it('reinvestigation script is idempotent over success and retries failures', async () => {
      const seeded = await seedErrorGroupAndJob();
      await testPool.query(
        `INSERT INTO digest_readiness (incident_id, project_id, status, reason)
         VALUES ($1, $2, 'ineligible', 'quarantined_degenerate')`,
        [seeded.errorGroupId, testProjectId],
      );
      const script = readFileSync(
        new URL('../../../../scripts/reinvestigate-quarantined.sql', import.meta.url),
        'utf8',
      );
      const countJobs = async (): Promise<number> => Number((await testPool.query(
        `SELECT count(*) AS n FROM error_group_jobs
         WHERE error_group_id = $1 AND triggered_by = 'reinvestigate_report_only'`,
        [seeded.errorGroupId],
      )).rows[0]!.n);

      await testPool.query(script);
      expect(await countJobs()).toBe(1);

      await testPool.query(
        `UPDATE error_group_jobs SET status = 'completed'
         WHERE error_group_id = $1 AND triggered_by = 'reinvestigate_report_only'`,
        [seeded.errorGroupId],
      );
      await testPool.query(script);
      expect(await countJobs()).toBe(1);

      await testPool.query(
        `UPDATE error_group_jobs SET status = 'failed'
         WHERE error_group_id = $1 AND triggered_by = 'reinvestigate_report_only'`,
        [seeded.errorGroupId],
      );
      await testPool.query(script);
      expect(await countJobs()).toBe(2);
    });

    it('reinvestigation script resets quarantined incidents to queued so the adoption guard cannot no-op them', async () => {
      const seeded = await seedErrorGroupAndJob();
      // The quarantined book sits in terminal-looking statuses; without the
      // reset every report-only job completes as a silent no-op (observed 8/8
      // on the 2026-08-11 prod-copy rehearsal).
      await testPool.query(
        `UPDATE error_groups SET status = 'insight' WHERE id = $1`,
        [seeded.errorGroupId],
      );
      await testPool.query(
        `INSERT INTO digest_readiness (incident_id, project_id, status, reason)
         VALUES ($1, $2, 'ineligible', 'quarantined_degenerate')`,
        [seeded.errorGroupId, testProjectId],
      );
      const script = readFileSync(
        new URL('../../../../scripts/reinvestigate-quarantined.sql', import.meta.url),
        'utf8',
      );
      await testPool.query(script);
      const { rows } = await testPool.query(
        `SELECT status FROM error_groups WHERE id = $1`, [seeded.errorGroupId],
      );
      expect(rows[0]!.status).toBe('queued');
    });

    it('reinvestigation script leaves human-terminal incidents untouched', async () => {
      const seeded = await seedErrorGroupAndJob();
      await testPool.query(
        `UPDATE error_groups SET status = 'resolved', resolved_at = now() WHERE id = $1`,
        [seeded.errorGroupId],
      );
      await testPool.query(
        `INSERT INTO digest_readiness (incident_id, project_id, status, reason)
         VALUES ($1, $2, 'ineligible', 'quarantined_degenerate')`,
        [seeded.errorGroupId, testProjectId],
      );
      const script = readFileSync(
        new URL('../../../../scripts/reinvestigate-quarantined.sql', import.meta.url),
        'utf8',
      );
      await testPool.query(script);
      const { rows } = await testPool.query(
        `SELECT g.status,
           (SELECT count(*)::int FROM error_group_jobs j
            WHERE j.error_group_id = g.id AND j.triggered_by = 'reinvestigate_report_only') AS jobs
         FROM error_groups g WHERE g.id = $1`,
        [seeded.errorGroupId],
      );
      expect(rows[0]!.status).toBe('resolved');
      expect(rows[0]!.jobs).toBe(0);
    });

    it('a failure-path needs_human park demotes a pending readiness row and never creates one', async () => {
      const seeded = await seedErrorGroupAndJob();
      await testPool.query(
        `INSERT INTO digest_readiness (incident_id, project_id, status, reason)
         VALUES ($1, $2, 'pending', 'reinvestigating')`,
        [seeded.errorGroupId, testProjectId],
      );
      await updateGroupStatus(seeded.errorGroupId, testProjectId, 'needs_human', {
        reason: {
          reason_code: 'repo_access_denied',
          reason_message: 'clone failed',
          remediation: 'check repository credentials',
        },
      });
      const demoted = await testPool.query(
        `SELECT status, reason FROM digest_readiness WHERE incident_id = $1`,
        [seeded.errorGroupId],
      );
      expect(demoted.rows[0]).toMatchObject({ status: 'ineligible', reason: 'repo_access_denied' });

      // Absent-row legacy groups stay absent-row on the same transition.
      const legacy = await seedErrorGroupAndJob();
      await updateGroupStatus(legacy.errorGroupId, testProjectId, 'needs_human', {
        reason: {
          reason_code: 'repo_access_denied',
          reason_message: 'clone failed',
          remediation: 'check repository credentials',
        },
      });
      const rows = await testPool.query(
        `SELECT count(*)::int AS n FROM digest_readiness WHERE incident_id = $1`,
        [legacy.errorGroupId],
      );
      expect(rows.rows[0]!.n).toBe(0);
    });
  });

  describe('draft delivery lifecycle', () => {
    it('reserves before delivery and atomically opens a draft with one CI watcher', async () => {
      const { errorGroupId, jobId } = await seedErrorGroupAndJob();
      const claim = await claimJob('draft-worker', 60_000);
      expect(claim?.id).toBe(jobId);
      await testPool.query(
        `UPDATE error_groups SET status = 'fixing' WHERE id = $1`,
        [errorGroupId],
      );

      const reservation = await reserveDelivery(errorGroupId, testProjectId, {
        operationKey: `fix:${errorGroupId}`,
        branchName: `opslane/fix-${errorGroupId.slice(0, 8)}`,
        posture: 'draft',
        diffHash: 'abc123',
        candidateDiff: '--- a/a\n+++ b/a\n',
      }, claim!);
      expect(reservation.status).toBe('reserved');

      await recordDeliveryPushed(errorGroupId, testProjectId, 'head-sha-1', claim!);
      await finalizeDelivery(errorGroupId, testProjectId, {
        status: 'pr_draft',
        prUrl: 'https://github.com/octocat/hello/pull/7',
        prNumber: 7,
        headSha: 'head-sha-1',
        confidence: 'medium',
        fixJobId: jobId,
        reason: {
          reason_code: 'low_confidence_fix',
          reason_message: 'No repository test runner was available.',
          remediation: 'Review repository CI before marking the draft ready.',
        },
        candidateDiff: '--- a/a\n+++ b/a\n',
        evidence: { version: 1, tier: 'E0', checks: [] },
        readiness: { status: 'eligible', reason: 'fix_pr_opened' },
      }, claim!);

      const group = await testPool.query<{
        status: string;
        pr_number: number;
        reason_code: string;
        terminal_fix_job_id: string | null;
      }>(`SELECT status, pr_number, reason_code, terminal_fix_job_id FROM error_groups WHERE id = $1`, [errorGroupId]);
      expect(group.rows[0]).toMatchObject({
        status: 'pr_draft',
        pr_number: 7,
        reason_code: 'low_confidence_fix',
        terminal_fix_job_id: jobId,
      });
      expect((await testPool.query(
        `SELECT status, reason FROM digest_readiness WHERE incident_id = $1`,
        [errorGroupId],
      )).rows[0]).toEqual({ status: 'eligible', reason: 'fix_pr_opened' });
      const delivery = await testPool.query<{ state: string; head_sha: string }>(
        `SELECT state, head_sha FROM delivery_reservations WHERE error_group_id = $1`,
        [errorGroupId],
      );
      expect(delivery.rows[0]).toEqual({ state: 'open', head_sha: 'head-sha-1' });
      const watchers = await testPool.query<{ payload: { prNumber: number; headSha: string } }>(
        `SELECT payload FROM error_group_jobs
         WHERE error_group_id = $1 AND job_type = 'ci_watch' AND status = 'pending'`,
        [errorGroupId],
      );
      expect(watchers.rows).toHaveLength(1);
      expect(watchers.rows[0]?.payload).toMatchObject({ prNumber: 7, headSha: 'head-sha-1' });
    });
  });

  describe('group lifecycle timestamps', () => {
    const reason = {
      reason_code: 'worker_runtime_error' as const,
      reason_message: 'The worker could not complete the incident',
      remediation: 'Review the incident manually',
    };

    it('stamps PR creation and retains it across later status changes', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();

      await updateGroupStatus(errorGroupId, testProjectId, 'pr_created', {
        pr_url: 'https://github.com/octocat/hello/pull/42',
        pr_number: 42,
      });
      const stamped = await testPool.query<{ pr_created_at: Date | null }>(
        `SELECT pr_created_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(stamped.rows[0]?.pr_created_at).toBeInstanceOf(Date);

      await updateGroupStatus(errorGroupId, testProjectId, 'analyzing');
      const retained = await testPool.query<{ pr_created_at: Date | null }>(
        `SELECT pr_created_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(retained.rows[0]?.pr_created_at).toEqual(stamped.rows[0]?.pr_created_at);
    });

    it('stamps needs-human status updates and retains the timestamp later', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();

      await updateGroupStatus(errorGroupId, testProjectId, 'needs_human', { reason });
      const stamped = await testPool.query<{ needs_human_at: Date | null }>(
        `SELECT needs_human_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(stamped.rows[0]?.needs_human_at).toBeInstanceOf(Date);

      await updateGroupStatus(errorGroupId, testProjectId, 'queued');
      const retained = await testPool.query<{ needs_human_at: Date | null }>(
        `SELECT needs_human_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(retained.rows[0]?.needs_human_at).toEqual(stamped.rows[0]?.needs_human_at);
    });

    it('stamps needs-human investigation results', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();

      await updateGroupInvestigation(errorGroupId, testProjectId, 'needs_human', {
        rootCause: 'External dependency failed',
        reason,
      });

      const result = await testPool.query<{
        status: string;
        needs_human_at: Date | null;
      }>(
        `SELECT status, needs_human_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(result.rows[0]?.status).toBe('needs_human');
      expect(result.rows[0]?.needs_human_at).toBeInstanceOf(Date);
    });

    it('does not move pr_created_at when the same status is written again', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();

      await updateGroupStatus(errorGroupId, testProjectId, 'pr_created', {
        pr_url: 'https://github.com/octocat/hello/pull/43',
        pr_number: 43,
      });
      const first = await testPool.query<{ pr_created_at: Date | null }>(
        `SELECT pr_created_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );

      // Retried terminal writes happen under the at-least-once job model; they
      // must not drag the stamp forward and inflate windowed admin metrics.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await updateGroupStatus(errorGroupId, testProjectId, 'pr_created', {
        pr_url: 'https://github.com/octocat/hello/pull/43',
        pr_number: 43,
      });
      const second = await testPool.query<{ pr_created_at: Date | null }>(
        `SELECT pr_created_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(second.rows[0]?.pr_created_at).toEqual(first.rows[0]?.pr_created_at);
    });

    it('stamps pr_created_at through investigation updates', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();

      await updateGroupInvestigation(errorGroupId, testProjectId, 'pr_created', {
        rootCause: 'Fix PR opened after investigation',
      });

      const result = await testPool.query<{ status: string; pr_created_at: Date | null }>(
        `SELECT status, pr_created_at FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(result.rows[0]?.status).toBe('pr_created');
      expect(result.rows[0]?.pr_created_at).toBeInstanceOf(Date);
    });
  });

  describe('claimJob', () => {
    it('should claim a pending job and set claimed status', async () => {
      const { jobId } = await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(jobId);
      expect(job!.workerId).toBe('worker-1');
      expect(job!.leaseGeneration).toBe('1');

      // Verify the job is now claimed in the database
      const dbResult = await testPool.query<{
        status: string;
        worker_id: string;
        claimed_at: Date;
        lease_expires_at: Date;
      }>(
        `SELECT status, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = dbResult.rows[0]!;
      expect(row.status).toBe('claimed');
      expect(row.worker_id).toBe('worker-1');
      expect(row.claimed_at).toBeTruthy();
      expect(row.lease_expires_at).toBeTruthy();
    });

    it('should return null when no pending jobs exist', async () => {
      const job = await claimJob('worker-1', 60_000);
      expect(job).toBeNull();
    });

    it('should claim the oldest pending job first (FIFO)', async () => {
      // Seed two jobs — the first one inserted should be claimed
      const { jobId: firstJobId } = await seedErrorGroupAndJob();
      // Small delay to ensure different created_at
      await new Promise((r) => setTimeout(r, 10));
      await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(firstJobId);
    });

    it('should skip already-claimed jobs', async () => {
      // Seed one already-claimed job and one pending
      await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'other-worker',
        claimed_at: new Date(),
        lease_expires_at: new Date(Date.now() + 60_000),
      });
      const { jobId: pendingJobId } = await seedErrorGroupAndJob();

      const job = await claimJob('worker-1', 60_000);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(pendingJobId);
    });
  });

  describe('getQueueDepth', () => {
    it('reports eligible and backed-off depth separately per job type', async () => {
      const oneMinuteAgo = new Date(Date.now() - 60_000);
      await seedPendingJob({
        jobType: 'session_analysis',
        availableAt: oneMinuteAgo,
        createdAt: oneMinuteAgo,
      });
      await seedPendingJob({
        jobType: 'session_analysis',
        availableAt: new Date(Date.now() + 600_000),
      });

      const depth = await getQueueDepth();
      const row = depth.find((entry) => entry.jobType === 'session_analysis');
      expect(row?.eligible).toBe(1);
      expect(row?.backedOff).toBe(1);
      expect(row?.oldestEligibleSeconds).toBeGreaterThanOrEqual(59);
    });
  });

  describe('fair scheduling and per-type caps (issue #28)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function seedSession(): Promise<string> {
      const envResult = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `env-${crypto.randomUUID()}`]
      );
      const sessionId = `sess-${crypto.randomUUID()}`;
      await testPool.query(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [sessionId, testProjectId, envResult.rows[0]!.id]
      );
      return sessionId;
    }

    async function seedAnalysisJob(): Promise<string> {
      const sessionId = await seedSession();
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs (project_id, status, job_type, session_id)
         VALUES ($1, 'pending', 'session_analysis', $2) RETURNING id`,
        [testProjectId, sessionId]
      );
      return res.rows[0]!.id;
    }

    async function seedTypedJob(jobType: 'fix' | 'error_fix' | 'investigate'): Promise<string> {
      const { jobId } = await seedErrorGroupAndJob();
      await testPool.query(
        `UPDATE error_group_jobs SET job_type = $2 WHERE id = $1`,
        [jobId, jobType]
      );
      return jobId;
    }

    it('claims route-map enrichment after every production job kind even when it is oldest', async () => {
      const group = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status)
         VALUES ($1, $2, 'Route lane ordering', now(), now(), 'queued')
         RETURNING id`,
        [testProjectId, `fp-${crypto.randomUUID()}`],
      );
      const groupId = group.rows[0]!.id;
      const kinds = [
        'error_fix',
        'investigate',
        'fix',
        'setup_pr',
        'session_analysis',
        'ci_watch',
        'route_map',
      ] as const;
      for (const [index, kind] of kinds.entries()) {
        await testPool.query(
          `INSERT INTO error_group_jobs
             (error_group_id, project_id, status, job_type, created_at)
           VALUES ($1, $2, 'pending', $3, now() - ($4 * interval '1 minute'))`,
          [kind === 'route_map' ? null : groupId, testProjectId, kind, kind === 'route_map' ? 60 : index],
        );
      }

      const claimed: string[] = [];
      for (let index = 0; index < kinds.length; index++) {
        const job = await claimJob(`route-order-${index}`, 600_000, 2);
        expect(job).not.toBeNull();
        claimed.push(job!.jobType);
      }
      expect(claimed).toHaveLength(kinds.length);
      expect(claimed.at(-1)).toBe('route_map');
      expect(new Set(claimed)).toEqual(new Set(kinds));
    });

    it('caps concurrently claimed session_analysis jobs', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();

      const first = await claimJob('w1', 60_000, 2);
      const second = await claimJob('w2', 60_000, 2);
      expect(first?.jobType).toBe('session_analysis');
      expect(second?.jobType).toBe('session_analysis');

      // Third pending analysis job exists, but the cap is reached.
      const third = await claimJob('w3', 60_000, 2);
      expect(third).toBeNull();
    });

    it('a cap of zero blocks session_analysis claims entirely', async () => {
      await seedAnalysisJob();
      const claim = await claimJob('w1', 60_000, 0);
      expect(claim).toBeNull();
    });

    it('a fresh error_fix is claimed immediately during an analysis flood', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();

      // Analysis flood in progress: two claimed (at cap), one still pending.
      await claimJob('w1', 60_000, 2);
      await claimJob('w2', 60_000, 2);

      const fixJobId = await seedTypedJob('error_fix');
      const next = await claimJob('w3', 60_000, 2);
      expect(next?.id).toBe(fixJobId);
    });

    it('error_fix outranks a pending analysis backlog from a cold start too', async () => {
      await seedAnalysisJob();
      await sleep(5);
      const fixJobId = await seedTypedJob('error_fix');
      const first = await claimJob('w1', 60_000, 2);
      expect(first?.id).toBe(fixJobId);
    });

    it('session_analysis makes progress under a fix backlog, up to its cap', async () => {
      for (let i = 0; i < 5; i++) {
        await seedTypedJob('fix');
        await sleep(5);
      }
      for (let i = 0; i < 3; i++) {
        await seedAnalysisJob();
        await sleep(5);
      }

      // Long leases: claimed jobs stay running for the whole test, so the
      // sequence shows lane alternation and then the cap binding.
      const types: string[] = [];
      for (let i = 0; i < 6; i++) {
        const job = await claimJob(`w${i}`, 600_000, 2);
        expect(job).not.toBeNull();
        types.push(job!.jobType);
      }
      expect(types).toEqual([
        'fix', 'session_analysis', 'fix', 'session_analysis', 'fix', 'fix',
      ]);
    });

    it('enforces the cap under truly concurrent claimers (no overshoot)', async () => {
      for (let i = 0; i < 3; i++) {
        await seedAnalysisJob();
        await sleep(5);
      }
      for (let i = 0; i < 3; i++) {
        await seedTypedJob('fix');
        await sleep(5);
      }

      // Six workers poll at the same instant with cap 1. Without serialized
      // admission they would all see zero running analysis jobs and overshoot.
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, i) => claimJob(`cw${i}`, 600_000, 1))
      );

      const byType = claims
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => c.jobType);
      expect(byType.filter((t) => t === 'session_analysis')).toHaveLength(1);
      expect(byType.filter((t) => t === 'fix')).toHaveLength(3);
      expect(claims.filter((c) => c === null)).toHaveLength(2);
    });

    it('completing an analysis job releases its cap slot', async () => {
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedAnalysisJob();
      await sleep(5);
      await seedTypedJob('fix');

      // Cold start: both lanes tie, so the interactive lane goes first.
      const f1 = await claimJob('w1', 600_000, 2);
      expect(f1?.jobType).toBe('fix');

      const a1 = await claimJob('w2', 600_000, 2);
      const a2 = await claimJob('w3', 600_000, 2);
      expect(a1?.jobType).toBe('session_analysis');
      expect(a2?.jobType).toBe('session_analysis');

      // At cap with only analysis pending: nothing is claimable.
      const blocked = await claimJob('w4', 600_000, 2);
      expect(blocked).toBeNull();

      // Completion releases a slot; the pending analysis job is claimable again.
      const completed = await completeJob(a1!.id, 'w2', a1!.leaseGeneration);
      expect(completed).toBe(true);
      const a3 = await claimJob('w5', 600_000, 2);
      expect(a3?.jobType).toBe('session_analysis');
    });
  });

  describe('automatic fix creation kind gate (issue #56)', () => {
    it('refuses automatic fix creation for friction incidents (typed no-transition result)', async () => {
      const groupRes = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status, kind)
         VALUES ($1, $2, 'Friction incident', now(), now(), 'analyzing', 'friction')
         RETURNING id`,
        [testProjectId, `fp-${crypto.randomUUID()}`]
      );
      const groupId = groupRes.rows[0]!.id;
      await testPool.query(
        `INSERT INTO error_group_jobs (error_group_id, project_id, job_type)
         VALUES ($1, $2, 'investigate')`,
        [groupId, testProjectId]
      );
      const claim = await claimJob('gate-worker', 60_000);
      const lease = {
        id: claim!.id,
        workerId: 'gate-worker',
        leaseGeneration: claim!.leaseGeneration,
        projectId: testProjectId,
        errorGroupId: groupId,
        sessionId: null,
      };

      const result = await updateGroupAndCreateFixJob(
        groupId,
        testProjectId,
        { rootCause: 'code cause', confidence: 'high' },
        lease
      );
      expect(result).toEqual({ created: false, reason: 'kind_not_error' });

      const group = (await testPool.query(
        `SELECT status FROM error_groups WHERE id = $1`, [groupId]
      )).rows[0]!;
      expect(group.status).toBe('analyzing');
      const fixJobs = await testPool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs
         WHERE error_group_id = $1 AND job_type IN ('fix', 'error_fix')`,
        [groupId]
      );
      expect(fixJobs.rows[0]!.n).toBe(0);
    });
  });

  describe('dead-letter reconciliation for session_analysis (issue #56)', () => {
    async function seedEnvAndSession(): Promise<{ envId: string; sessionId: string }> {
      const envRes = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `env-${crypto.randomUUID()}`]
      );
      const sessionId = `sess-${crypto.randomUUID()}`;
      await testPool.query(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [sessionId, testProjectId, envRes.rows[0]!.id]
      );
      return { envId: envRes.rows[0]!.id, sessionId };
    }

    async function seedAnalysisJobRow(sessionId: string, maxAttempts: number): Promise<string> {
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO error_group_jobs (project_id, status, job_type, session_id, max_attempts)
         VALUES ($1, 'pending', 'session_analysis', $2, $3) RETURNING id`,
        [testProjectId, sessionId, maxAttempts]
      );
      return res.rows[0]!.id;
    }

    async function seedClaimedSignal(opts: {
      envId: string;
      sessionId?: string;
      jobId: string | null;
      status?: string;
      fingerprint?: string;
    }): Promise<string> {
      // Bucket signals share a fingerprint across DIFFERENT sessions
      // (UNIQUE(session_id, fingerprint, rule_version)); give each its own.
      const sessionId = `sess-${crypto.randomUUID()}`;
      await testPool.query(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [sessionId, testProjectId, opts.envId]
      );
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO friction_signals
           (session_id, project_id, environment_id, rule_version, signal_type,
            fingerprint, page_url_normalized, occurred_at, adjudication_status,
            adjudication_job_id, adjudication_attempts)
         VALUES ($1, $2, $3, 1, 'rage_click', $4, '/checkout', now(), $5, $6, 1)
         RETURNING id`,
        [
          sessionId,
          testProjectId,
          opts.envId,
          opts.fingerprint ?? 'fp-deadletter',
          opts.status ?? 'pending',
          opts.jobId,
        ]
      );
      return res.rows[0]!.id;
    }

    async function seedInFlightGeneration(envId: string, jobId: string): Promise<string> {
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO friction_adjudication_generations
           (project_id, environment_id, fingerprint, rule_version, prompt_version,
            status, window_start, window_end, claim_job_id, attempts)
         VALUES ($1, $2, 'fp-deadletter', 1, 1, 'adjudicating',
                 now() - interval '7 days', now(), $3, 1)
         RETURNING id`,
        [testProjectId, envId, jobId]
      );
      return res.rows[0]!.id;
    }

    it('explicit failJob at max attempts reconciles signals, generation, and diagnostic atomically', async () => {
      const { envId, sessionId } = await seedEnvAndSession();
      const jobRowId = await seedAnalysisJobRow(sessionId, 1);
      const claim = await claimJob('dl-worker', 60_000);
      expect(claim?.id).toBe(jobRowId);

      const pendingA = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId });
      const pendingB = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId });
      const accepted = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId, status: 'accepted' });
      const unclaimed = await seedClaimedSignal({ envId, sessionId, jobId: null });
      const generationId = await seedInFlightGeneration(envId, jobRowId);

      const failed = await failJob(jobRowId, 'dl-worker', claim!.leaseGeneration, 'adjudicator down');
      expect(failed).toBe(true);

      const job = (await testPool.query(
        `SELECT status FROM error_group_jobs WHERE id = $1`, [jobRowId]
      )).rows[0]!;
      expect(job.status).toBe('dead_letter');

      const statuses = new Map(
        (await testPool.query(
          `SELECT id, adjudication_status FROM friction_signals WHERE project_id = $1`,
          [testProjectId]
        )).rows.map((r) => [r.id, r.adjudication_status])
      );
      expect(statuses.get(pendingA)).toBe('unchecked');
      expect(statuses.get(pendingB)).toBe('unchecked');
      expect(statuses.get(accepted)).toBe('accepted');
      expect(statuses.get(unclaimed)).toBe('pending');

      const gen = (await testPool.query(
        `SELECT status, finished_at, diagnostic_incident_id
         FROM friction_adjudication_generations WHERE id = $1`,
        [generationId]
      )).rows[0]!;
      expect(gen.status).toBe('unchecked');
      expect(gen.finished_at).toBeTruthy();
      expect(gen.diagnostic_incident_id).toBeTruthy();

      const diagnostic = (await testPool.query(
        `SELECT fingerprint, status, kind, adjudication_status, occurrence_count, affected_users_count
         FROM error_groups WHERE id = $1`,
        [gen.diagnostic_incident_id]
      )).rows[0]!;
      expect(diagnostic.fingerprint).toBe(`friction-unchecked:${generationId}`);
      expect(diagnostic.status).toBe('candidate');
      expect(diagnostic.kind).toBe('friction');
      expect(diagnostic.adjudication_status).toBe('unchecked');
      expect(diagnostic.occurrence_count).toBe(0);
      expect(diagnostic.affected_users_count).toBe(0);
      const junctions = await testPool.query(
        `SELECT count(*)::int AS n FROM error_group_affected_users WHERE error_group_id = $1`,
        [gen.diagnostic_incident_id]
      );
      expect(junctions.rows[0]!.n).toBe(0);
      const diagJobs = await testPool.query(
        `SELECT count(*)::int AS n FROM error_group_jobs WHERE error_group_id = $1`,
        [gen.diagnostic_incident_id]
      );
      expect(diagJobs.rows[0]!.n).toBe(0);

      // The in-flight slot is released: a later generation can be claimed.
      const again = await testPool.query(
        `INSERT INTO friction_adjudication_generations
           (project_id, environment_id, fingerprint, rule_version, prompt_version,
            status, window_start, window_end)
         VALUES ($1, $2, 'fp-deadletter', 1, 1, 'adjudicating', now() - interval '7 days', now())
         RETURNING id`,
        [testProjectId, envId]
      );
      expect(again.rows[0]!.id).toBeTruthy();
    });

    it('a retryable failure reconciles nothing, but releases the in-flight slot', async () => {
      const { envId, sessionId } = await seedEnvAndSession();
      const jobRowId = await seedAnalysisJobRow(sessionId, 3);
      const claim = await claimJob('dl-worker-2', 60_000);
      const pending = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId });
      const generationId = await seedInFlightGeneration(envId, jobRowId);

      await failJob(jobRowId, 'dl-worker-2', claim!.leaseGeneration, 'transient');

      // Reconciliation still does NOT happen on a retry: the signal keeps its
      // pending status rather than being flipped to 'unchecked', and no
      // diagnostic is written. That was this test's original point and it holds.
      const sig = (await testPool.query(
        `SELECT adjudication_status FROM friction_signals WHERE id = $1`, [pending]
      )).rows[0]!;
      expect(sig.adjudication_status).toBe('pending');

      // What DID change: the generation is released rather than left
      // 'adjudicating'. Leaving it stranded wedged the bucket permanently —
      // the retry met its own in-flight row, logged "already in flight,
      // skipping", and then COMPLETED, so the job never dead-lettered and the
      // reconciliation above never ran. Verified live: 12 affected users, zero
      // incidents, until this release was added.
      const gen = await testPool.query(
        `SELECT status FROM friction_adjudication_generations WHERE id = $1`, [generationId]
      );
      expect(gen.rows).toHaveLength(0);

      // And the slot is genuinely free: the same bucket can be claimed again.
      const again = await testPool.query(
        `INSERT INTO friction_adjudication_generations
           (project_id, environment_id, fingerprint, rule_version, prompt_version,
            status, window_start, window_end)
         VALUES ($1, $2, 'fp-deadletter', 1, 1, 'adjudicating', now() - interval '7 days', now())
         RETURNING id`,
        [testProjectId, envId]
      );
      expect(again.rows[0]!.id).toBeTruthy();
    });

    it('lease-reaper dead-lettering performs the same reconciliation', async () => {
      const { envId, sessionId } = await seedEnvAndSession();
      const jobRowId = await seedAnalysisJobRow(sessionId, 1);
      await claimJob('dl-worker-3', 60_000);
      const pending = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId });
      const generationId = await seedInFlightGeneration(envId, jobRowId);

      await testPool.query(
        `UPDATE error_group_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobRowId]
      );
      expect(await requeueStaleJobs()).toBe(1);

      const sig = (await testPool.query(
        `SELECT adjudication_status FROM friction_signals WHERE id = $1`, [pending]
      )).rows[0]!;
      expect(sig.adjudication_status).toBe('unchecked');
      const gen = (await testPool.query(
        `SELECT status, diagnostic_incident_id FROM friction_adjudication_generations WHERE id = $1`,
        [generationId]
      )).rows[0]!;
      expect(gen.status).toBe('unchecked');
      expect(gen.diagnostic_incident_id).toBeTruthy();
      const session = (await testPool.query(
        `SELECT status FROM sessions WHERE id = $1`, [sessionId]
      )).rows[0]!;
      expect(session.status).toBe('analysis_failed');
    });

    it('fold-claimed signals with no generation get signal-scoped diagnostics', async () => {
      const { envId, sessionId } = await seedEnvAndSession();
      const jobRowId = await seedAnalysisJobRow(sessionId, 1);
      const claim = await claimJob('dl-worker-4', 60_000);
      const signalId = await seedClaimedSignal({ envId, sessionId, jobId: jobRowId, fingerprint: 'fp-fold-dl' });

      await failJob(jobRowId, 'dl-worker-4', claim!.leaseGeneration, 'boom');

      const diagnostic = (await testPool.query(
        `SELECT status, kind, adjudication_status FROM error_groups
         WHERE project_id = $1 AND fingerprint = $2`,
        [testProjectId, `friction-unchecked:${signalId}`]
      )).rows[0]!;
      expect(diagnostic.kind).toBe('friction');
      expect(diagnostic.adjudication_status).toBe('unchecked');
    });
  });

  describe('resolveSilentMergedGroups (friction-aware, issue #56)', () => {
    async function seedMergedGroup(): Promise<string> {
      const res = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status, merged_at)
         VALUES ($1, $2, 'Merged Error', now() - interval '3 days', now() - interval '2 days',
                 'merged', now() - interval '2 days')
         RETURNING id`,
        [testProjectId, `fp-${crypto.randomUUID()}`]
      );
      return res.rows[0]!.id;
    }

    async function seedLinkedSignal(groupId: string, opts: {
      status: string;
      occurredAt: string;
      retracted?: boolean;
    }): Promise<void> {
      const envRes = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name) VALUES ($1, $2) RETURNING id`,
        [testProjectId, `env-${crypto.randomUUID()}`]
      );
      const sessionId = `sess-${crypto.randomUUID()}`;
      await testPool.query(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now() - interval '1 day')`,
        [sessionId, testProjectId, envRes.rows[0]!.id]
      );
      await testPool.query(
        `INSERT INTO friction_signals
           (session_id, project_id, environment_id, rule_version, signal_type,
            fingerprint, page_url_normalized, occurred_at, adjudication_status,
            incident_id, retracted_at)
         VALUES ($1, $2, $3, 1, 'rage_click', $4, '/x', $5, $6, $7, $8)`,
        [
          sessionId,
          testProjectId,
          envRes.rows[0]!.id,
          `fp-${crypto.randomUUID()}`,
          opts.occurredAt,
          opts.status,
          groupId,
          opts.retracted ? new Date() : null,
        ]
      );
    }

    const afterMerge = () => new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    const beforeMerge = () => new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

    it('resolves a truly silent merged group', async () => {
      const groupId = await seedMergedGroup();
      const resolved = await resolveSilentMergedGroups();
      expect(resolved).toContain(groupId);

      const group = await testPool.query<{
        status: string;
        resolved_reason: string | null;
        resolved_in_release: string | null;
      }>(
        `SELECT status, resolved_reason, resolved_in_release
         FROM error_groups WHERE id = $1`,
        [groupId],
      );
      expect(group.rows[0]).toEqual({
        status: 'resolved',
        resolved_reason: 'merged',
        resolved_in_release: null,
      });
    });

    it('does not resolve when active accepted linked friction occurred after merged_at', async () => {
      const groupId = await seedMergedGroup();
      await seedLinkedSignal(groupId, { status: 'accepted', occurredAt: afterMerge() });
      const resolved = await resolveSilentMergedGroups();
      expect(resolved).not.toContain(groupId);
    });

    it('resolves when linked friction predates the merge', async () => {
      const groupId = await seedMergedGroup();
      await seedLinkedSignal(groupId, { status: 'accepted', occurredAt: beforeMerge() });
      const resolved = await resolveSilentMergedGroups();
      expect(resolved).toContain(groupId);
    });

    it('resolves when post-merge linked friction is rejected or retracted', async () => {
      const groupId = await seedMergedGroup();
      await seedLinkedSignal(groupId, { status: 'rejected', occurredAt: afterMerge() });
      await seedLinkedSignal(groupId, { status: 'accepted', occurredAt: afterMerge(), retracted: true });
      const resolved = await resolveSilentMergedGroups();
      expect(resolved).toContain(groupId);
    });
  });

  describe('resolveInactiveGroups', () => {
    it('resolves only stale eligible groups and stamps the newest release', async () => {
      const env = await testPool.query<{ id: string }>(
        `INSERT INTO environments (project_id, name)
         VALUES ($1, $2) RETURNING id`,
        [testProjectId, `env-${crypto.randomUUID()}`],
      );
      const environmentId = env.rows[0]!.id;

      await testPool.query(
        // created_at (server arrival), not the client timestamp, drives release
        // ranking — set it explicitly so the two rows don't tie on now().
        `INSERT INTO error_events
           (project_id, environment_id, timestamp, error_type, error_message,
            stack_trace_raw, release, created_at)
         VALUES
           ($1, $2, now() - interval '10 days', 'Error', 'old', 'stack', 'release-old', now() - interval '10 days'),
           ($1, $2, now() - interval '2 days', 'Error', 'new', 'stack', 'release-new', now() - interval '2 days')`,
        [testProjectId, environmentId],
      );

      const statuses = [
        'needs_human',
        'investigated',
        'new',
        'pr_created',
        'pr_draft',
        'analyzing',
        'queued',
        'fixing',
        'merged',
        'archived',
        'resolved',
      ] as const;
      const groupIds = new Map<string, string>();
      for (const status of statuses) {
        const group = await testPool.query<{ id: string }>(
          `INSERT INTO error_groups
             (project_id, fingerprint, title, first_seen, last_seen, status)
           VALUES ($1, $2, 'Inactive Error', now() - interval '30 days',
                   now() - interval '20 days', $3::error_group_status)
           RETURNING id`,
          [testProjectId, `fp-${status}-${crypto.randomUUID()}`, status],
        );
        groupIds.set(status, group.rows[0]!.id);
      }
      const recent = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status)
         VALUES ($1, $2, 'Recent Error', now() - interval '5 days',
                 now() - interval '3 days', 'needs_human')
         RETURNING id`,
        [testProjectId, `fp-recent-${crypto.randomUUID()}`],
      );

      const resolved = await resolveInactiveGroups(14);
      expect(new Set(resolved)).toEqual(new Set([
        groupIds.get('needs_human')!,
        groupIds.get('investigated')!,
      ]));

      const groups = await testPool.query<{
        id: string;
        status: string;
        resolved_at: Date | null;
        resolved_reason: string | null;
        resolved_in_release: string | null;
      }>(
        `SELECT id, status, resolved_at, resolved_reason, resolved_in_release
         FROM error_groups
         WHERE id = ANY($1::uuid[])`,
        [[...groupIds.values(), recent.rows[0]!.id]],
      );
      const byId = new Map(groups.rows.map((row) => [row.id, row]));

      for (const status of ['needs_human', 'investigated'] as const) {
        expect(byId.get(groupIds.get(status)!)).toMatchObject({
          status: 'resolved',
          resolved_at: expect.any(Date),
          resolved_reason: 'auto_resolved',
          resolved_in_release: 'release-new',
        });
      }
      for (const status of statuses.slice(2)) {
        expect(byId.get(groupIds.get(status)!)?.status).toBe(status);
      }
      expect(byId.get(recent.rows[0]!.id)?.status).toBe('needs_human');
    });
  });

  describe('heartbeat', () => {
    it('should extend the lease on a claimed job', async () => {
      const { jobId } = await seedErrorGroupAndJob();

      // First claim the job
      const claimed = await claimJob('worker-1', 30_000);

      // Get the initial lease_expires_at
      const before = await testPool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const initialLease = before.rows[0]!.lease_expires_at;

      // Small delay to ensure the new lease is different
      await new Promise((r) => setTimeout(r, 20));

      // Heartbeat with a longer lease
      const extended = await heartbeat(
        jobId,
        'worker-1',
        claimed!.leaseGeneration,
        120_000,
      );
      expect(extended).toBe(true);

      // Verify lease was extended
      const after = await testPool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const newLease = after.rows[0]!.lease_expires_at;
      expect(newLease.getTime()).toBeGreaterThan(initialLease.getTime());
    });

    it('should return false for wrong worker_id', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);

      const extended = await heartbeat(
        jobId,
        'wrong-worker',
        claimed!.leaseGeneration,
        60_000,
      );
      expect(extended).toBe(false);
    });

    it('should return false for a completed job', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);
      await completeJob(jobId, 'worker-1', claimed!.leaseGeneration);

      const extended = await heartbeat(
        jobId,
        'worker-1',
        claimed!.leaseGeneration,
        60_000,
      );
      expect(extended).toBe(false);
    });
  });

  describe('completeJob', () => {
    it('should mark a claimed job as completed', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await completeJob(jobId, 'worker-1', claimed!.leaseGeneration),
      ).toBe(true);

      const result = await testPool.query<{ status: string }>(
        `SELECT status FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      expect(result.rows[0]!.status).toBe('completed');
    });
  });

  describe('lease generation fencing', () => {
    it('does not let an expired owner revive or terminate a claim before reaping', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claim = await claimJob('worker-expired', 60_000);
      await testPool.query(
        `UPDATE error_group_jobs
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [jobId],
      );

      expect(
        await heartbeat(jobId, 'worker-expired', claim!.leaseGeneration, 60_000),
      ).toBe(false);
      expect(
        await completeJob(jobId, 'worker-expired', claim!.leaseGeneration),
      ).toBe(false);
      expect(
        await failJob(
          jobId,
          'worker-expired',
          claim!.leaseGeneration,
          'late failure',
        ),
      ).toBe(false);
      const row = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        `SELECT status, attempts, last_error
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(row.rows[0]).toEqual({
        status: 'claimed',
        attempts: 0,
        last_error: null,
      });
    });

    it('rejects a stale heartbeat after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();
      const before = await testPool.query<{
        status: string;
        lease_generation: string;
        lease_expires_at: Date;
      }>(
        `SELECT status, lease_generation::text, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );

      expect(
        await heartbeat(jobId, 'worker-reused', staleGeneration, 120_000),
      ).toBe(false);

      const after = await testPool.query<{
        status: string;
        lease_generation: string;
        lease_expires_at: Date;
      }>(
        `SELECT status, lease_generation::text, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(
        await heartbeat(jobId, 'worker-reused', currentGeneration, 120_000),
      ).toBe(true);
    });

    it('rejects stale completion after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();

      expect(
        await completeJob(jobId, 'worker-reused', staleGeneration),
      ).toBe(false);
      expect(
        await testPool.query<{ status: string }>(
          `SELECT status FROM error_group_jobs WHERE id = $1`,
          [jobId],
        ),
      ).toMatchObject({ rows: [{ status: 'claimed' }] });
      expect(
        await completeJob(jobId, 'worker-reused', currentGeneration),
      ).toBe(true);
    });

    it('rejects stale failure after the same worker ID reclaims the job', async () => {
      const { jobId, staleGeneration, currentGeneration } =
        await expireAndReclaimWithSameWorker();

      expect(
        await failJob(
          jobId,
          'worker-reused',
          staleGeneration,
          'stale execution failed',
        ),
      ).toBe(false);
      const afterStale = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
        lease_generation: string;
      }>(
        `SELECT status, attempts, last_error, lease_generation::text
         FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(afterStale.rows[0]).toMatchObject({
        status: 'claimed',
        attempts: 1,
        last_error: 'reaper: lease expired (attempt 1)',
        lease_generation: currentGeneration,
      });
      expect(
        await failJob(
          jobId,
          'worker-reused',
          currentGeneration,
          'current execution failed',
        ),
      ).toBe(true);
    });

    it('fences trace, group, and fix-job writes with the current generation', async () => {
      const {
        jobId,
        errorGroupId,
        staleGeneration,
        currentGeneration,
      } = await expireAndReclaimWithSameWorker();
      const staleLease = {
        id: jobId,
        workerId: 'worker-reused',
        leaseGeneration: staleGeneration,
        projectId: testProjectId,
        errorGroupId,
        sessionId: null,
      };
      const currentLease = {
        ...staleLease,
        leaseGeneration: currentGeneration,
      };

      expect(
        await updateJobTraceUrl(
          jobId,
          'worker-reused',
          staleGeneration,
          'https://trace.invalid/stale',
        ),
      ).toBe(false);
      await expect(
        updateGroupStatus(
          errorGroupId,
          testProjectId,
          'analyzing',
          undefined,
          staleLease,
        ),
      ).rejects.toThrow('lease lost');
      await expect(
        updateGroupInvestigation(
          errorGroupId,
          testProjectId,
          'investigated',
          { rootCause: 'stale result' },
          staleLease,
        ),
      ).rejects.toThrow('lease lost');

      const beforeCurrent = await testPool.query<{
        status: string;
        root_cause: string | null;
        trace_url: string | null;
      }>(
        `SELECT eg.status, eg.root_cause, j.trace_url
         FROM error_groups eg
         JOIN error_group_jobs j ON j.error_group_id = eg.id
         WHERE eg.id = $1 AND j.id = $2`,
        [errorGroupId, jobId],
      );
      expect(beforeCurrent.rows[0]).toEqual({
        status: 'queued',
        root_cause: null,
        trace_url: null,
      });

      await updateGroupStatus(
        errorGroupId,
        testProjectId,
        'analyzing',
        undefined,
        currentLease,
      );
      await expect(
        updateGroupAndCreateFixJob(
          errorGroupId,
          testProjectId,
          { rootCause: 'stale result' },
          staleLease,
        ),
      ).rejects.toThrow('lease lost');
      const staleFixCount = await testPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM error_group_jobs
         WHERE error_group_id = $1 AND job_type = 'fix'`,
        [errorGroupId],
      );
      expect(staleFixCount.rows[0]?.count).toBe('0');

      const fixResult = await updateGroupAndCreateFixJob(
        errorGroupId,
        testProjectId,
        { rootCause: 'current result', confidence: 'high', platform: 'python' },
        currentLease,
      );
      expect(fixResult).toEqual({ created: true, fixJobId: expect.any(String) });
      const final = await testPool.query<{
        status: string;
        root_cause: string | null;
      }>(
        `SELECT status, root_cause FROM error_groups WHERE id = $1`,
        [errorGroupId],
      );
      expect(final.rows[0]).toEqual({
        status: 'fixing',
        root_cause: 'current result',
      });
      const fixJob = await testPool.query<{ platform: string | null }>(
        `SELECT platform FROM error_group_jobs WHERE id = $1`,
        [fixResult.created ? fixResult.fixJobId : ''],
      );
      expect(fixJob.rows[0]?.platform).toBe('python');
    });

    it('does not authorize another tenant with a valid current lease', async () => {
      const { errorGroupId } = await seedErrorGroupAndJob();
      const claim = await claimJob('tenant-bound-worker', 60_000);
      expect(claim?.errorGroupId).toBe(errorGroupId);

      const otherOrg = await testPool.query<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('lease-other-org') RETURNING id`,
      );
      const otherProject = await testPool.query<{ id: string }>(
        `INSERT INTO projects (org_id, name, github_repo, default_branch)
         VALUES ($1, 'lease-other-project', 'other/repo', 'main') RETURNING id`,
        [otherOrg.rows[0]!.id],
      );
      const otherGroup = await testPool.query<{ id: string }>(
        `INSERT INTO error_groups
           (project_id, fingerprint, title, first_seen, last_seen, status)
         VALUES ($1, $2, 'Other tenant error', now(), now(), 'queued')
         RETURNING id`,
        [otherProject.rows[0]!.id, `fp-${crypto.randomUUID()}`],
      );

      try {
        await expect(
          updateGroupStatus(
            otherGroup.rows[0]!.id,
            otherProject.rows[0]!.id,
            'analyzing',
            undefined,
            claim!,
          ),
        ).rejects.toThrow('lease lost');
        await expect(
          updateGroupAndCreateFixJob(
            otherGroup.rows[0]!.id,
            otherProject.rows[0]!.id,
            { rootCause: 'cross-tenant mutation' },
            claim!,
          ),
        ).rejects.toThrow('lease lost');
        await expect(
          recordSetupPrResult(
            otherProject.rows[0]!.id,
            'opening',
            {},
            claim!,
          ),
        ).rejects.toThrow('lease lost');

        const untouched = await testPool.query<{ status: string }>(
          `SELECT status FROM error_groups WHERE id = $1`,
          [otherGroup.rows[0]!.id],
        );
        expect(untouched.rows[0]?.status).toBe('queued');
      } finally {
        await testPool.query(`DELETE FROM error_groups WHERE project_id = $1`, [otherProject.rows[0]!.id]);
        await testPool.query(`DELETE FROM projects WHERE id = $1`, [otherProject.rows[0]!.id]);
        await testPool.query(`DELETE FROM orgs WHERE id = $1`, [otherOrg.rows[0]!.id]);
      }
    });
  });

  describe('failJob', () => {
    it('should retry (reset to pending) when under max_attempts', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        attempts: 0,
        max_attempts: 3,
      });
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await failJob(
          jobId,
          'worker-1',
          claimed!.leaseGeneration,
          'Something broke',
        ),
      ).toBe(true);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('Something broke');
      // Should be cleared for reclaim
      expect(row.worker_id).toBeNull();
      expect(row.claimed_at).toBeNull();
      expect(row.lease_expires_at).toBeNull();
    });

    it('schedules a retry in the future instead of immediately', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);
      const before = Date.now();

      await failJob(jobId, 'worker-1', claimed!.leaseGeneration, 'transient boom');

      const { rows } = await testPool.query<{
        status: string;
        available_at: Date;
        attempts: number;
      }>(
        `SELECT status, available_at, attempts FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.attempts).toBe(1);
      const delayMs = rows[0]!.available_at.getTime() - before;
      expect(delayMs).toBeGreaterThan(14_000);
      expect(delayMs).toBeLessThan(46_000);
    });

    it('does not let a backed-off job be claimed before its window elapses', async () => {
      const { jobId } = await seedErrorGroupAndJob();
      const claimed = await claimJob('worker-1', 60_000);
      await failJob(jobId, 'worker-1', claimed!.leaseGeneration, 'transient boom');

      // toBeNull, not `?.id !== jobId`: optional chaining makes a null return
      // satisfy the assertion for any reason at all, so a globally broken
      // claimJob would pass. The positive control below rules that out.
      const retry = await claimJob('other-worker', 30_000);
      expect(retry).toBeNull();

      await testPool.query(
        `UPDATE error_group_jobs SET available_at = now() WHERE id = $1`,
        [jobId],
      );
      const afterWindow = await claimJob('other-worker', 30_000);
      expect(afterWindow?.id).toBe(jobId);
    });

    it('leaves available_at alone when the job dead-letters', async () => {
      const { jobId } = await seedErrorGroupAndJob({ attempts: 2, max_attempts: 3 });
      const claimed = await claimJob('worker-1', 60_000);
      const { rows: pre } = await testPool.query<{ available_at: Date }>(
        `SELECT available_at FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );

      await failJob(jobId, 'worker-1', claimed!.leaseGeneration, 'final boom');

      const { rows: post } = await testPool.query<{ status: string; available_at: Date }>(
        `SELECT status, available_at FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(post[0]!.status).toBe('dead_letter');
      expect(post[0]!.available_at.getTime()).toBe(pre[0]!.available_at.getTime());
    });

    it('should dead-letter when at max_attempts', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        attempts: 2,
        max_attempts: 3,
      });
      const claimed = await claimJob('worker-1', 60_000);

      expect(
        await failJob(
          jobId,
          'worker-1',
          claimed!.leaseGeneration,
          'Final failure',
        ),
      ).toBe(true);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string;
      }>(
        `SELECT status, attempts, last_error FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('dead_letter');
      expect(row.attempts).toBe(3);
      expect(row.last_error).toBe('Final failure');
    });
  });

  describe('requeueStaleJobs', () => {
    it('should reset expired claimed jobs to pending and increment attempts', async () => {
      // Seed a job that is claimed but has an expired lease
      const { jobId } = await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'dead-worker',
        claimed_at: new Date(Date.now() - 120_000),
        lease_expires_at: new Date(Date.now() - 60_000), // expired 60s ago
        attempts: 0,
        max_attempts: 3,
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(1);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('reaper');
      expect(row.worker_id).toBeNull();
      expect(row.claimed_at).toBeNull();
      expect(row.lease_expires_at).toBeNull();
    });

    it('spaces reaper requeues the same way failJob does', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'dead-worker',
        claimed_at: new Date(Date.now() - 120_000),
        lease_expires_at: new Date(Date.now() - 60_000),
      });
      const before = Date.now();

      await requeueStaleJobs();

      const { rows } = await testPool.query<{ status: string; available_at: Date }>(
        `SELECT status, available_at FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.available_at.getTime()).toBeGreaterThan(before + 14_000);
    });

    it('should dead-letter expired jobs at max_attempts and preserve ownership for forensics', async () => {
      const { jobId } = await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'dead-worker',
        claimed_at: new Date(Date.now() - 120_000),
        lease_expires_at: new Date(Date.now() - 60_000),
        attempts: 2,
        max_attempts: 3,
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(1);

      const result = await testPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        worker_id: string | null;
        claimed_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT status, attempts, last_error, worker_id, claimed_at, lease_expires_at
         FROM error_group_jobs WHERE id = $1`,
        [jobId]
      );
      const row = result.rows[0]!;
      expect(row.status).toBe('dead_letter');
      expect(row.attempts).toBe(3);
      expect(row.last_error).toContain('dead-lettered by reaper');
      // Ownership preserved for forensic investigation
      expect(row.worker_id).toBe('dead-worker');
      expect(row.claimed_at).not.toBeNull();
      expect(row.lease_expires_at).not.toBeNull();
    });

    it('should not requeue jobs with valid leases', async () => {
      await seedErrorGroupAndJob({
        status: 'claimed',
        worker_id: 'active-worker',
        claimed_at: new Date(),
        lease_expires_at: new Date(Date.now() + 300_000), // expires in 5 min
      });

      const count = await requeueStaleJobs();
      expect(count).toBe(0);
    });

    it('should return 0 when no stale jobs exist', async () => {
      const count = await requeueStaleJobs();
      expect(count).toBe(0);
    });
  });
});
