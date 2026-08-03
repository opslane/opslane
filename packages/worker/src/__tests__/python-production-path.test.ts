import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

import type { ClaimedJob } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  setWorkerId: vi.fn(),
}));

vi.mock('../repo-clone.js', () => ({
  cloneRepo: vi.fn(),
  buildRepoUrl: vi.fn((githubRepo: string) => `https://github.com/${githubRepo}.git`),
  gitCommitAndPush: vi.fn(),
  validateDiffPaths: vi.fn(),
}));

vi.mock('../investigate.js', () => ({ investigateError: vi.fn() }));
vi.mock('../agent-fix.js', () => ({ runAgentFix: vi.fn() }));
vi.mock('../pr.js', () => ({ createPR: vi.fn(), createGitHubClient: vi.fn() }));
vi.mock('../minio-client.js', () => ({ fetchObject: vi.fn(), getMinIOConfig: vi.fn(() => null) }));
vi.mock('../poller.js', () => ({ createPoller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }));
vi.mock('../github-app.js', () => ({ getInstallationToken: vi.fn() }));
vi.mock('../setup-pr.js', () => ({ processSetupPrJob: vi.fn() }));
vi.mock('../source-map.js', () => ({ parseStackFrames: vi.fn(() => []), resolveFrame: vi.fn() }));
vi.mock('../resolve-stack.js', () => ({
  resolveEventStack: vi.fn(async () => ({
    status: 'no_debug_ids', frames: null, envelope: null,
  })),
}));
vi.mock('../visual-analysis.js', () => ({ runVisualAnalysis: vi.fn() }));
vi.mock('../ci-watch.js', () => ({ processCIWatchJob: vi.fn() }));
vi.mock('../tracing.js', () => ({
  initTracing: vi.fn(),
  shutdownTracing: vi.fn(),
  withJobTrace: vi.fn((_jobId: string, _groupId: string, _projectId: string, fn: () => unknown) => fn()),
  traceSpan: vi.fn((_name: string, _attributes: unknown, fn: () => unknown) => fn()),
  getActiveTraceId: vi.fn(() => null),
  buildLangfuseTraceUrl: vi.fn(() => null),
}));
vi.mock('../friction/friction-evidence.js', () => ({ gatherFrictionEvidence: vi.fn() }));
vi.mock('../friction/investigate-friction.js', () => ({ investigateFriction: vi.fn() }));
vi.mock('../friction/chunk-reader.js', () => ({ readChunksBounded: vi.fn() }));
vi.mock('../friction/analyzer.js', () => ({ analyzeSession: vi.fn(), RULE_VERSION: 1 }));
vi.mock('../friction/persist.js', () => ({ writeFrictionSignals: vi.fn() }));
vi.mock('../friction/promotion.js', () => ({ processFrictionOutcomes: vi.fn() }));
vi.mock('../friction/adjudicator.js', () => ({
  createAnthropicAdjudicator: vi.fn(() => ({ modelId: 'test', promptVersion: 1, adjudicate: vi.fn() })),
}));

const db = await import('../db.js');
const { processJobInner } = await import('../index.js');
const { investigateError } = await import('../investigate.js');
const { runAgentFix } = await import('../agent-fix.js');
const { cloneRepo } = await import('../repo-clone.js');

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PYTHON_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/app/cart.py", line 11, in total',
  '    return price + tax',
  "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'",
].join('\n');

interface SeededIncident {
  groupId: string;
  investigateJob: ClaimedJob;
}

describeDb('Python two-stage production path', () => {
  let pool: pg.Pool;
  let orgId = '';
  let projectId = '';
  let environmentId = '';

  async function seedPythonIncident(): Promise<SeededIncident> {
    const event = await pool.query<{ id: string }>(
      `INSERT INTO error_events
         (project_id, environment_id, timestamp, error_type, error_message,
          stack_trace_raw, breadcrumbs, context, platform)
       VALUES ($1, $2, now(), 'TypeError', 'price cannot be null', $3, '[]', $4::jsonb, 'python')
       RETURNING id`,
      [projectId, environmentId, PYTHON_TRACEBACK, JSON.stringify({ runtime: { name: 'CPython', version: '3.11.8' } })],
    );
    const eventId = event.rows[0]!.id;

    const group = await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, status, kind,
          sample_event_id, platform)
       VALUES ($1, $2, 'Python cart total failed', now(), now(), 'queued', 'error', $3, 'python')
       RETURNING id`,
      [projectId, `python-production-${crypto.randomUUID()}`, eventId],
    );
    const groupId = group.rows[0]!.id;
    await pool.query(`UPDATE error_events SET error_group_id = $1 WHERE id = $2`, [groupId, eventId]);

    const workerId = `python-investigate-${crypto.randomUUID()}`;
    const job = await pool.query<{ id: string; lease_generation: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id, project_id, status, job_type, attempts, max_attempts,
          worker_id, claimed_at, lease_expires_at, lease_generation)
       VALUES ($1, $2, 'claimed', 'investigate', 0, 3, $3, now(),
               now() + interval '10 minutes', 1)
       RETURNING id, lease_generation::text`,
      [groupId, projectId, workerId],
    );

    return {
      groupId,
      investigateJob: {
        id: job.rows[0]!.id,
        workerId,
        errorGroupId: groupId,
        sourceId: null,
        projectId,
        jobType: 'investigate',
        attempts: 0,
        maxAttempts: 3,
        guidance: null,
        leaseGeneration: job.rows[0]!.lease_generation,
        triggeredBy: null,
        sessionId: null,
        platform: null,
      },
    };
  }

  async function claimSpecificFixJob(groupId: string): Promise<ClaimedJob> {
    const workerId = `python-fix-${crypto.randomUUID()}`;
    const result = await pool.query<{
      id: string;
      attempts: number;
      max_attempts: number;
      lease_generation: string;
      platform: 'python' | 'javascript' | null;
      triggered_by: 'auto' | 'human' | null;
    }>(
      `UPDATE error_group_jobs
       SET status = 'claimed', worker_id = $2, claimed_at = now(),
           lease_expires_at = now() + interval '10 minutes',
           lease_generation = lease_generation + 1
       WHERE id = (
         SELECT id FROM error_group_jobs
         WHERE error_group_id = $1 AND project_id = $3
           AND job_type = 'fix' AND status = 'pending'
         ORDER BY created_at, id
         LIMIT 1
       )
       RETURNING id, attempts, max_attempts, lease_generation::text,
                 platform, triggered_by`,
      [groupId, workerId, projectId],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    return {
      id: row.id,
      workerId,
      errorGroupId: groupId,
      sourceId: null,
      projectId,
      jobType: 'fix',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      guidance: null,
      leaseGeneration: row.lease_generation,
      triggeredBy: row.triggered_by,
      sessionId: null,
      platform: row.platform,
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`python-production-path-${crypto.randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'python-production-path', 'example/python-app', 'main')
       RETURNING id`,
      [orgId],
    );
    projectId = project.rows[0]!.id;
    const environment = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId],
    );
    environmentId = environment.rows[0]!.id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic-key';
    process.env['GITHUB_TOKEN'] = 'test-github-token';
    vi.mocked(cloneRepo).mockResolvedValue({
      repoDir: '/tmp/python-production-path',
      defaultBranch: 'main',
      cleanup: vi.fn(),
    });
    vi.mocked(investigateError).mockResolvedValue({
      fixable: true,
      confidence: 'high',
      reason: 'cart.py adds a nullable price without a guard',
      remediation: 'Treat a missing price as zero before calculating the total',
      filesRead: ['cart.py'],
      findings: 'The traceback resolves to application code in cart.py.',
    });
    vi.mocked(runAgentFix).mockResolvedValue({
      status: 'needs_human',
      confidence: 'medium',
      reason: {
        reason_code: 'tests_failed',
        reason_message: 'The candidate did not pass pytest.',
        remediation: 'Review the pytest failure and candidate patch.',
      },
    });
  });

  afterEach(async () => {
    delete process.env['OPSLANE_PYTHON_PIPELINE'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GITHUB_TOKEN'];
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_events WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
  });

  afterAll(async () => {
    if (projectId) {
      await pool.query(`DELETE FROM environments WHERE project_id = $1`, [projectId]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    }
    await pool.end();
    await db.closePool();
  });

  it('persists Python routing and uses it after the feature flag flips off between stages', async () => {
    process.env['OPSLANE_PYTHON_PIPELINE'] = '1';
    const { groupId, investigateJob } = await seedPythonIncident();

    await processJobInner(investigateJob, new AbortController().signal);

    const durableFix = await pool.query<{ id: string; platform: string; status: string }>(
      `SELECT id, platform, status FROM error_group_jobs
       WHERE error_group_id = $1 AND job_type = 'fix'`,
      [groupId],
    );
    expect(durableFix.rows).toHaveLength(1);
    expect(durableFix.rows[0]).toMatchObject({ platform: 'python', status: 'pending' });
    expect(await db.completeJob(
      investigateJob.id,
      investigateJob.workerId,
      investigateJob.leaseGeneration,
    )).toBe(true);

    process.env['OPSLANE_PYTHON_PIPELINE'] = '0';
    const fixJob = await claimSpecificFixJob(groupId);
    expect(fixJob.platform).toBe('python');

    await processJobInner(fixJob, new AbortController().signal);

    expect(runAgentFix).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'python',
      customerRuntime: { name: 'CPython', version: '3.11.8' },
      stackTrace: PYTHON_TRACEBACK,
    }));
    const group = await pool.query<{ status: string; reason_code: string }>(
      `SELECT status, reason_code FROM error_groups WHERE id = $1`,
      [groupId],
    );
    expect(group.rows[0]).toEqual({ status: 'needs_human', reason_code: 'tests_failed' });
  });

  it('keeps Python incidents on the existing terminal path while the flag is off', async () => {
    process.env['OPSLANE_PYTHON_PIPELINE'] = '0';
    const { groupId, investigateJob } = await seedPythonIncident();

    await processJobInner(investigateJob, new AbortController().signal);

    const group = await pool.query<{
      status: string;
      reason_code: string;
      reason_message: string;
      remediation: string;
    }>(
      `SELECT status, reason_code, reason_message, remediation
       FROM error_groups WHERE id = $1`,
      [groupId],
    );
    expect(group.rows[0]).toMatchObject({
      status: 'needs_human',
      reason_code: 'unfixable_no_app_frames',
    });
    expect(group.rows[0]!.reason_message).toBeTruthy();
    expect(group.rows[0]!.remediation).toBeTruthy();
    expect(investigateError).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
    const fixJobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM error_group_jobs
       WHERE error_group_id = $1 AND job_type = 'fix'`,
      [groupId],
    );
    expect(fixJobs.rows[0]!.count).toBe('0');
  });
});
