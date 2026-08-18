import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePool, upsertProductContextClaims, recordJobUsage } from '../db.js';
import type { RouteClaim } from '../product-context/schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('product-context write path integration', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;
  const workerId = 'worker-int-test';

  function claim(overrides: Partial<RouteClaim> & { route: string }): RouteClaim {
    return {
      purpose: 'Edit a thing',
      actions: ['save'],
      clientRefs: ['src/a.ts'],
      serverRefs: [],
      audience: 'standard',
      confidence: 0.9,
      evidenceConflicts: [],
      ...overrides,
    };
  }

  async function claimedJob(): Promise<{ jobId: string; leaseGeneration: string }> {
    // Only one product_context job may be pending/claimed per project
    // (uq_product_context_job_active); retire earlier test jobs first.
    await pool.query(
      `UPDATE error_group_jobs SET status = 'completed'
        WHERE project_id = $1 AND job_type = 'product_context' AND status IN ('pending','claimed')`,
      [projectId],
    );
    // claimed_at sits far in the past on purpose: db.test.ts's fair-scheduling
    // assertions compare MAX(claimed_at) across ALL job history on the shared
    // test database, and a fresh timestamp from this suite would reorder its
    // lanes when the files run in parallel. The lease check only reads
    // lease_expires_at, so an ancient claimed_at is still a valid live lease.
    const job = await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (project_id, job_type, triggered_by, payload, status, worker_id,
          claimed_at, lease_expires_at, lease_generation)
       VALUES ($1, 'product_context', 'auto', '{}'::jsonb, 'claimed', $2,
               now() - interval '10 years', now() + interval '5 minutes', 1)
       RETURNING id, lease_generation::text AS lease_generation`,
      [projectId, workerId],
    );
    return { jobId: job.rows[0]!.id, leaseGeneration: job.rows[0]!.lease_generation };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`worker-product-context-${crypto.randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'pc-project', 'example/pc', 'main') RETURNING id`,
      [orgId],
    );
    projectId = project.rows[0]!.id;
  });

  afterAll(async () => {
    // job_usage is insert-only by trigger, so the job that recorded usage — and
    // with it the project and org — cannot be deleted. Clean up best-effort.
    const drop = async (sql: string): Promise<void> => {
      await pool.query(sql, [projectId]).catch(() => undefined);
    };
    // Retire whatever survives so no suite sharing this database can claim it,
    // and clear claimed_at: claimJob's lane ordering compares MAX(claimed_at)
    // over all job history, so a stranded timestamp would reorder other suites.
    await drop(`UPDATE error_group_jobs
                   SET status = CASE WHEN status IN ('pending','claimed')
                                     THEN 'completed' ELSE status END,
                       claimed_at = NULL
                 WHERE project_id = $1`);
    await drop(`DELETE FROM route_map WHERE project_id = $1`);
    await drop(`DELETE FROM product_context_runs WHERE project_id = $1`);
    await drop(`DELETE FROM error_group_jobs WHERE project_id = $1
                  AND id NOT IN (SELECT job_id FROM job_usage)`);
    await drop(`DELETE FROM projects WHERE id = $1`);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]).catch(() => undefined);
    await pool.end();
    await closePool();
  });

  it('persists conflicts, review status, declared requests, and the run record in one write', async () => {
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-1', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/a': ['PUT /api/a'] },
      run: { execution: 0, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001, latencyMs: 250, humanRouteCount: 0 },
      claims: [
        claim({ route: '/a', confidence: 0.5, evidenceConflicts: ['PUT /api/a observed, no handler in repo'] }),
        claim({ route: '/b', purpose: 'unknown', audience: 'unknown', confidence: 0, clientRefs: [], actions: [] }),
      ],
    });
    expect(wrote).toBe(true);

    const routeA = await pool.query(
      `SELECT evidence_conflicts, review_status, declared_requests, observed_requests
         FROM route_map WHERE project_id = $1 AND pattern = '/a'`, [projectId]);
    expect(routeA.rows[0].evidence_conflicts).toEqual(['PUT /api/a observed, no handler in repo']);
    expect(routeA.rows[0].review_status).toBe('needs_review');
    expect(routeA.rows[0].declared_requests).toEqual(['PUT /api/a']);
    expect(routeA.rows[0].observed_requests).toEqual([]);

    const run = await pool.query(
      `SELECT route_count, unknown_count, conflict_count, coverage::float8 AS coverage, latency_ms
         FROM product_context_runs WHERE job_id = $1 AND execution = 0`, [lease.jobId]);
    expect(run.rows[0]).toMatchObject({ route_count: 2, unknown_count: 1, conflict_count: 1, coverage: 0.5, latency_ms: 250 });
  });

  it('a clean refresh clears review_status and conflicts and replaces declared requests', async () => {
    // Seed the dirty state inside this test so it proves clearing on its own
    // (a default-'clear' implementation that never clears must fail here).
    await pool.query(
      `UPDATE route_map
          SET review_status = 'needs_review', evidence_conflicts = ARRAY['stale conflict']
        WHERE project_id = $1 AND pattern = '/a'`,
      [projectId],
    );
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-2', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/a': ['PUT /api/a', 'GET /api/a'] },
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 0 },
      claims: [claim({ route: '/a', confidence: 0.9 })],
    });
    expect(wrote).toBe(true);
    const routeA = await pool.query(
      `SELECT evidence_conflicts, review_status, declared_requests
         FROM route_map WHERE project_id = $1 AND pattern = '/a'`, [projectId]);
    expect(routeA.rows[0].evidence_conflicts).toEqual([]);
    expect(routeA.rows[0].review_status).toBe('clear');
    expect(routeA.rows[0].declared_requests).toEqual(['PUT /api/a', 'GET /api/a']);
  });

  it('never touches a human row, including the new columns', async () => {
    await pool.query(
      `INSERT INTO route_map (project_id, pattern, name, purpose, tier, source, audience, confidence)
       VALUES ($1, '/h', 'Human', 'Curated', 'standard', 'human', 'standard', 1)`, [projectId]);
    const before = await pool.query(`SELECT * FROM route_map WHERE project_id = $1 AND pattern = '/h'`, [projectId]);
    const lease = await claimedJob();
    await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-3', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: { '/h': ['GET /api/h'] },
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 1 },
      claims: [claim({ route: '/h', purpose: 'model rewrite attempt', evidenceConflicts: ['x'] })],
    });
    const after = await pool.query(`SELECT * FROM route_map WHERE project_id = $1 AND pattern = '/h'`, [projectId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('a lost lease writes neither claims nor a run record', async () => {
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: '999',
      commitSha: 'sha-4', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: {},
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 0 },
      claims: [claim({ route: '/fenced' })],
    });
    expect(wrote).toBe(false);
    const run = await pool.query(`SELECT count(*)::int AS n FROM product_context_runs WHERE job_id = $1`, [lease.jobId]);
    expect(run.rows[0].n).toBe(0);
  });

  it('claims and the run record share one transaction: a failing run insert rolls back the routes', async () => {
    const lease = await claimedJob();
    // latency_ms has CHECK (latency_ms >= 0); -1 forces the run insert to fail
    // after the route upserts, so the whole write must roll back.
    await expect(upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-tx', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: {},
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: -1, humanRouteCount: 0 },
      claims: [claim({ route: '/txprobe' })],
    })).rejects.toThrow();
    const route = await pool.query(
      `SELECT count(*)::int AS n FROM route_map WHERE project_id = $1 AND pattern = '/txprobe'`, [projectId]);
    expect(route.rows[0].n).toBe(0);
  });

  it('recordJobUsage accepts phase product_context against a real job', async () => {
    const lease = await claimedJob();
    await recordJobUsage({
      jobId: lease.jobId, execution: 0, phase: 'product_context',
      model: 'claude-sonnet-5',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.001,
    });
    const usage = await pool.query(`SELECT phase FROM job_usage WHERE job_id = $1`, [lease.jobId]);
    expect(usage.rows[0]?.phase).toBe('product_context');
  });

  it('a model refresh never clobbers observed_requests (Slice 5 owns that column)', async () => {
    await pool.query(
      `UPDATE route_map SET observed_requests = ARRAY['PUT /api/a']
        WHERE project_id = $1 AND pattern = '/a'`,
      [projectId],
    );
    const lease = await claimedJob();
    const wrote = await upsertProductContextClaims({
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      commitSha: 'sha-obs', promptVersion: 1, model: 'claude-sonnet-5',
      declaredRequests: {},
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 1, humanRouteCount: 0 },
      claims: [claim({ route: '/a' })],
    });
    expect(wrote).toBe(true);
    const route = await pool.query(
      `SELECT observed_requests, commit_sha FROM route_map WHERE project_id = $1 AND pattern = '/a'`,
      [projectId],
    );
    expect(route.rows[0].observed_requests).toEqual(['PUT /api/a']);
    expect(route.rows[0].commit_sha).toBe('sha-obs');
  });

  it('re-recording the same (job, execution) keeps the latest run values instead of dropping them', async () => {
    const lease = await claimedJob();
    const base = {
      projectId, jobId: lease.jobId, workerId, leaseGeneration: lease.leaseGeneration,
      promptVersion: 1, model: 'claude-sonnet-5', declaredRequests: {},
      claims: [claim({ route: '/a' })],
    };
    await upsertProductContextClaims({
      ...base, commitSha: 'sha-run-1',
      run: { execution: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 111, humanRouteCount: 0 },
    });
    await upsertProductContextClaims({
      ...base, commitSha: 'sha-run-2',
      run: { execution: 0, usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, latencyMs: 222, humanRouteCount: 0 },
    });
    const run = await pool.query(
      `SELECT commit_sha, latency_ms FROM product_context_runs WHERE job_id = $1 AND execution = 0`,
      [lease.jobId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ commit_sha: 'sha-run-2', latency_ms: 222 });
  });
});
