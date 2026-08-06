/**
 * Real-poller reliability tests. Unlike poller.test.ts (which mocks the db
 * layer), these drive the production `createPoller` against a real Postgres so
 * the lease-fencing SQL, the reaper, and the completion path are exercised
 * through the same wiring the worker runs. Gated on DATABASE_URL; runs in the
 * reliability CI job against a disposable migrated database.
 *
 * The `beforeComplete` hook simulates a crash at the exact boundary between a
 * job's business side effects committing and the queue recording completion —
 * the window Codex flagged (business-completion and queue-completion are
 * separate commits).
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { createPoller } from '../poller.js';
import type { ClaimedJob } from '../db.js';
import {
  completeJob,
  updateGroupStatus,
  updateGroupAndCreateFixJob,
  requeueStaleJobs,
  closePool,
} from '../db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const RELIABILITY_DB_TESTS = process.env['OPSLANE_RELIABILITY_DB_TESTS'] === '1';
const describeDb = DATABASE_URL && RELIABILITY_DB_TESTS ? describe : describe.skip;

let pool: pg.Pool;
let orgId = '';
let projectId = '';

async function seedInvestigateJob(): Promise<{ groupId: string; jobId: string }> {
  const org = await pool.query<{ id: string }>(`INSERT INTO orgs (name) VALUES ('poller-it-org') RETURNING id`);
  orgId = org.rows[0]!.id;
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (org_id, name, github_repo, default_branch)
     VALUES ($1, 'poller-it', 'octocat/hello', 'main') RETURNING id`, [orgId]);
  projectId = project.rows[0]!.id;
  const group = await pool.query<{ id: string }>(
    `INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, status)
     VALUES ($1, $2, 'Poller IT', now(), now(), 'queued') RETURNING id`,
    [projectId, `fp-${crypto.randomUUID()}`]);
  const groupId = group.rows[0]!.id;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO error_group_jobs (error_group_id, project_id, status, job_type, attempts, max_attempts)
     VALUES ($1, $2, 'pending', 'investigate', 0, 3) RETURNING id`, [groupId, projectId]);
  return { groupId, jobId: job.rows[0]!.id };
}

async function seedJobsInOneProject(count: number): Promise<string[]> {
  const { groupId, jobId } = await seedInvestigateJob();
  const ids = [jobId];
  for (let i = 0; i < count - 1; i += 1) {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id, project_id, status, job_type, attempts, max_attempts)
       VALUES ($1, $2, 'pending', 'investigate', 0, 3)
       RETURNING id`,
      [groupId, projectId],
    );
    ids.push(job.rows[0]!.id);
  }
  return ids;
}

async function fixJobCount(groupId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM error_group_jobs WHERE error_group_id=$1 AND job_type='fix'`, [groupId]);
  return Number(r.rows[0]!.n);
}
async function jobStatus(jobId: string): Promise<string> {
  const r = await pool.query<{ status: string }>(`SELECT status FROM error_group_jobs WHERE id=$1`, [jobId]);
  return r.rows[0]!.status;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(80);
  }
  throw new Error('waitFor timed out');
}

/**
 * Investigate side effects, faithful to the high-confidence path: set the group
 * analyzing, then atomically flip it to fixing and create a fix job. Routes by
 * type like the production processJob router (the exported `processJob` in
 * index.ts is what a full-fidelity system test would drive instead of this stub).
 */
function makeProcessJob() {
  return async (job: ClaimedJob, _signal: AbortSignal): Promise<void> => {
    if (job.jobType !== 'investigate') return;
    const group = await pool.query<{ status: string }>(
      `SELECT status FROM error_groups WHERE id = $1 AND project_id = $2`,
      [job.errorGroupId, job.projectId],
    );
    // Match processInvestigateJob's reclaimed-outcome adoption guard. Once a
    // prior attempt committed the fixing state, its retry must not enqueue a
    // second fix even if the first fix has already drained to completion.
    if (!['new', 'queued', 'analyzing', 'candidate'].includes(group.rows[0]!.status)) return;
    await updateGroupStatus(job.errorGroupId!, job.projectId, 'analyzing', undefined, job);
    await updateGroupAndCreateFixJob(job.errorGroupId!, job.projectId,
      { rootCause: 'nullable value', confidence: 'high' }, job);
  };
}

describeDb('real poller under lease loss', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DATABASE_URL }); });
  afterEach(async () => {
    if (projectId) {
      await pool.query(`DELETE FROM diagnosis_decisions WHERE project_id=$1`, [projectId]);
      await pool.query(`DELETE FROM error_group_jobs WHERE project_id=$1`, [projectId]);
      await pool.query(`DELETE FROM error_groups WHERE project_id=$1`, [projectId]);
      await pool.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
      await pool.query(`DELETE FROM orgs WHERE id=$1`, [orgId]);
    }
    orgId = ''; projectId = '';
  });
  afterAll(async () => { await closePool(); await pool.end(); });

  it('does not record completion when the lease is lost before the completion write', async () => {
    const { groupId, jobId } = await seedInvestigateJob();
    const poller = createPoller({
      intervalMs: 120,
      leaseDurationMs: 300_000,
      workerId: 'poller-it-worker',
      processJob: makeProcessJob(),
      // crash: expire the investigate job's lease at the completion boundary
      beforeComplete: async (job) => {
        if (job.jobType === 'investigate') {
          await pool.query(
            `UPDATE error_group_jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [job.id]);
        }
      },
    });

    poller.start();
    try {
      // side effects committed, but the fenced completion must be rejected
      await waitFor(async () => (await fixJobCount(groupId)) >= 1);
      await sleep(300);
      expect(await jobStatus(jobId)).toBe('claimed'); // NOT 'completed' — fence honored
      // the stale generation cannot complete the job either
      expect(await completeJob(jobId, 'poller-it-worker', '1')).toBe(false);
    } finally {
      await poller.stop();
    }
  }, 20_000);

  it('crash + reaper requeue does not create a duplicate fix job', async () => {
    const { groupId, jobId } = await seedInvestigateJob();
    let crashed = false;
    const poller = createPoller({
      intervalMs: 120,
      leaseDurationMs: 300_000,
      workerId: 'poller-it-worker',
      processJob: makeProcessJob(),
      beforeComplete: async (job) => {
        if (job.jobType === 'investigate' && !crashed) {
          crashed = true;
          await pool.query(
            `UPDATE error_group_jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [job.id]);
        }
      },
    });

    poller.start();
    try {
      // crash leaves the investigate job claimed with its fix job already created
      await waitFor(async () => (await fixJobCount(groupId)) >= 1 && (await jobStatus(jobId)) === 'claimed');
      expect(await requeueStaleJobs()).toBe(1);            // reaper reclaims the zombie
      // Retry spacing is production behavior. This test is about fencing and
      // idempotency after a later reclaim, so advance this fixture's window.
      await pool.query(
        `UPDATE error_group_jobs SET available_at = now() WHERE id = $1`,
        [jobId],
      );
      await waitFor(async () => (await jobStatus(jobId)) === 'completed'); // reprocessed to done
      expect(await fixJobCount(groupId)).toBe(1);
    } finally {
      await poller.stop();
    }
  }, 20_000);

  it('drains a seeded backlog without waiting a poll interval per job', async () => {
    const jobIds = await seedJobsInOneProject(10);
    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'drain-it',
      processJob: makeProcessJob(),
    });
    const started = Date.now();

    poller.start();
    await waitFor(async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM error_group_jobs
          WHERE id = ANY($1) AND status = 'completed'`,
        [jobIds],
      );
      return Number(rows[0]!.n) === 10;
    }, 10_000);
    const elapsed = Date.now() - started;
    await poller.stop();

    expect(elapsed).toBeLessThan(5000);
  });

  it('leaves no claimed job behind after stop() resolves', async () => {
    await seedInvestigateJob();
    const poller = createPoller({
      intervalMs: 50,
      leaseDurationMs: 30_000,
      workerId: 'shutdown-it',
      processJob: makeProcessJob(),
    });

    poller.start();
    await poller.stop();

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM error_group_jobs
        WHERE worker_id = 'shutdown-it' AND status = 'claimed'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('does not re-claim a failed job before its backoff window elapses', async () => {
    const { jobId } = await seedInvestigateJob();
    const poller = createPoller({
      intervalMs: 50,
      leaseDurationMs: 30_000,
      workerId: 'backoff-it',
      processJob: async () => { throw new Error('boom'); },
    });

    poller.start();
    await waitFor(async () => {
      const { rows } = await pool.query<{ attempts: number }>(
        `SELECT attempts FROM error_group_jobs WHERE id = $1`,
        [jobId],
      );
      return rows[0]!.attempts === 1;
    }, 5000);
    await sleep(1000);
    await poller.stop();

    const { rows } = await pool.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM error_group_jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.status).toBe('pending');
  });
});
