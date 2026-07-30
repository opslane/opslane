import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { scanReliabilityInvariants } from '../invariant-scanner.js';
import {
  createFixtureRepository,
  execFile,
  GIT_ENV,
  startProviderRecorders,
  toolNames,
  type ProviderRecorders,
} from '../../../worker/src/__tests__/reliability-fixture.js';
import type { TestTenant } from '../../../../test-e2e/helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required for the reliability system test; run it against a disposable migrated database',
  );
}

const ingestionUrl = process.env['INGESTION_URL'] ?? 'http://localhost:8082';
const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GITHUB_TOKEN',
  'OPSLANE_GITHUB_API_URL',
  'OPSLANE_GITHUB_URL',
  'OPSLANE_SANDBOX_BACKEND',
  'OPSLANE_RELIABILITY_HARNESS',
] as const;

describe('event-to-pr reliability system tracer', () => {
  const savedEnv = new Map<string, string | undefined>();
  let root: string | undefined;
  let providers: ProviderRecorders | undefined;
  let tenant: TestTenant | undefined;

  afterAll(async () => {
    const helpers = await import('../../../../test-e2e/helpers.js');
    const workerDb = await import('../../../worker/src/db.js');
    if (tenant) await helpers.cleanupTenant(tenant.orgId).catch(() => undefined);
    await Promise.all([
      workerDb.closePool(),
      helpers.closePool(),
      providers?.close(),
    ]);
    if (root) await rm(root, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('persists one real event through investigate and fix jobs to pr_created', async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);

    const health = await fetch(`${ingestionUrl}/health`);
    expect(health.ok, `Ingestion is not healthy at ${ingestionUrl}`).toBe(true);

    const helpers = await import('../../../../test-e2e/helpers.js');
    const db = helpers.getPool();
    const liveBefore = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM error_group_jobs WHERE status IN ('pending', 'claimed')`,
    );
    if (liveBefore.rows[0]?.count !== '0') {
      throw new Error(
        `Reliability system test requires a disposable database with no live jobs; found ${liveBefore.rows[0]?.count}`,
      );
    }

    root = await mkdtemp(join(tmpdir(), 'opslane-reliability-system-'));
    const githubRepo = `e2e/reliability-${Date.now()}`;
    const remoteRoot = join(root, 'remotes');
    const remote = join(remoteRoot, `${githubRepo}.git`);
    const fixture = await createFixtureRepository(root, remote);
    await expect(execFile('npm', ['test'], { cwd: fixture.deliveryClone })).rejects.toBeDefined();

    providers = await startProviderRecorders();
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic-key';
    process.env['ANTHROPIC_BASE_URL'] = providers.anthropicBaseUrl;
    process.env['GITHUB_TOKEN'] = 'test-github-token';
    process.env['OPSLANE_GITHUB_API_URL'] = providers.githubBaseUrl;
    process.env['OPSLANE_GITHUB_URL'] = pathToFileURL(remoteRoot).href;
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';

    tenant = await helpers.seedTenant(githubRepo);
    const postResponse = await helpers.postEvent(tenant.ingestKey, {
      timestamp: new Date().toISOString(),
      error: {
        type: 'TypeError',
        message: "Cannot read properties of null (reading 'value')",
        stack: 'TypeError: missing value\n    at value (src/value.js:1:39)',
      },
      breadcrumbs: [],
      context: { url: 'https://fixture.invalid/missing-value' },
      sdk_version: '0.0.1-reliability',
    });
    expect(postResponse.status).toBe(202);
    const accepted = await postResponse.json() as {
      event_id: string;
      group_id: string;
      error_group_id: string;
    };
    expect(accepted.group_id).toBe(accepted.error_group_id);

    const workerDb = await import('../../../worker/src/db.js');
    const worker = await import('../../../worker/src/index.js');
    const workerId = `reliability-worker-${Date.now()}`;
    const signal = new AbortController().signal;

    const staleInvestigateJob = await workerDb.claimJob(workerId, 120_000);
    expect(staleInvestigateJob).toMatchObject({
      errorGroupId: accepted.group_id,
      projectId: tenant.projectId,
      jobType: 'investigate',
    });
    await db.query(
      `UPDATE error_group_jobs
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [staleInvestigateJob!.id],
    );
    expect(await workerDb.requeueStaleJobs()).toBe(1);

    const investigateJob = await workerDb.claimJob(workerId, 120_000);
    expect(investigateJob).toMatchObject({
      id: staleInvestigateJob!.id,
      workerId,
      attempts: 1,
    });
    expect(BigInt(investigateJob!.leaseGeneration)).toBe(
      BigInt(staleInvestigateJob!.leaseGeneration) + 1n,
    );
    expect(
      await workerDb.heartbeat(
        staleInvestigateJob!.id,
        workerId,
        staleInvestigateJob!.leaseGeneration,
        120_000,
      ),
    ).toBe(false);
    expect(
      await workerDb.completeJob(
        staleInvestigateJob!.id,
        workerId,
        staleInvestigateJob!.leaseGeneration,
      ),
    ).toBe(false);
    expect(
      await workerDb.failJob(
        staleInvestigateJob!.id,
        workerId,
        staleInvestigateJob!.leaseGeneration,
        'stale execution must not mutate the recovered claim',
      ),
    ).toBe(false);
    const recoveredClaim = await db.query<{
      status: string;
      attempts: number;
      worker_id: string;
      lease_generation: string;
      last_error: string;
    }>(
      `SELECT status, attempts, worker_id, lease_generation::text, last_error
       FROM error_group_jobs WHERE id = $1`,
      [investigateJob!.id],
    );
    expect(recoveredClaim.rows[0]).toEqual({
      status: 'claimed',
      attempts: 1,
      worker_id: workerId,
      lease_generation: investigateJob!.leaseGeneration,
      last_error: 'reaper: lease expired (attempt 1)',
    });
    expect(await scanReliabilityInvariants(db)).toEqual([]);

    await worker.processInvestigateJob(
      investigateJob as NonNullable<typeof investigateJob> & { errorGroupId: string },
      signal,
    );

    const afterInvestigation = await db.query<{
      status: string;
      root_cause: string | null;
      confidence: string | null;
    }>(
      `SELECT status, root_cause, confidence FROM error_groups WHERE id = $1 AND project_id = $2`,
      [accepted.group_id, tenant.projectId],
    );
    expect(afterInvestigation.rows[0]).toMatchObject({
      status: 'fixing',
      confidence: 'high',
    });
    expect(afterInvestigation.rows[0]?.root_cause).toContain('nullable production value');
    expect(
      await workerDb.completeJob(
        investigateJob!.id,
        workerId,
        investigateJob!.leaseGeneration,
      ),
    ).toBe(true);

    const fixJob = await workerDb.claimJob(workerId, 120_000);
    expect(fixJob).toMatchObject({
      errorGroupId: accepted.group_id,
      projectId: tenant.projectId,
      jobType: 'fix',
    });
    await worker.processFixJob(
      fixJob as NonNullable<typeof fixJob> & { errorGroupId: string },
      signal,
    );
    expect(
      await workerDb.completeJob(fixJob!.id, workerId, fixJob!.leaseGeneration),
    ).toBe(true);

    const jobs = await db.query<{ job_type: string; status: string }>(
      `SELECT job_type, status FROM error_group_jobs WHERE error_group_id = $1 ORDER BY created_at, id`,
      [accepted.group_id],
    );
    expect(jobs.rows).toEqual([
      { job_type: 'investigate', status: 'completed' },
      { job_type: 'fix', status: 'completed' },
    ]);

    // Reading an incident needs a signed-in user, not the ingest key. The
    // ingest key is write-only now, so passing it here sends it as a bearer
    // token and the server rejects it as an expired session.
    const incident = await helpers.getIncident(
      tenant.userSession,
      tenant.projectId,
      accepted.group_id,
    );
    expect(incident).toMatchObject({
      id: accepted.group_id,
      project_id: tenant.projectId,
      status: 'pr_created',
      confidence: 'high',
      pr_url: `https://github.test/${githubRepo}/pull/42`,
    });
    expect(await scanReliabilityInvariants(db)).toEqual([]);

    expect(providers.anthropicJournal).toHaveLength(6);
    expect(toolNames(providers.anthropicJournal[0]!.body)).toContain('classify_error');
    expect(toolNames(providers.anthropicJournal[4]!.body)).toEqual(['score_diff']);
    // Durable delivery reconciles before it creates: the pipeline looks for an
    // existing open PR on the stable branch, probes the branch head (absent →
    // push), and createPR runs its own idempotency lookup before the one POST.
    expect(providers.githubJournal).toHaveLength(4);
    const journalPaths = providers.githubJournal.map((entry) => entry.path);
    expect(journalPaths[0]).toMatch(new RegExp(`^/repos/${githubRepo}/pulls\\?`));
    expect(journalPaths[0]).toContain('state=open');
    expect(journalPaths[1]).toMatch(new RegExp(`^/repos/${githubRepo}/git/ref/heads`));
    expect(journalPaths[2]).toMatch(new RegExp(`^/repos/${githubRepo}/pulls\\?`));
    expect(providers.githubJournal[3]).toMatchObject({
      path: `/repos/${githubRepo}/pulls`,
      authorization: 'token test-github-token',
      body: {
        base: 'main',
        head: expect.stringMatching(/^opslane\/fix-/),
      },
    });

    const refs = await execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/opslane/'], {
      cwd: remote,
      env: GIT_ENV,
    });
    const pushedBranches = refs.stdout.trim().split('\n').filter(Boolean);
    expect(pushedBranches).toHaveLength(1);
    const verified = join(root, 'verified-system');
    await execFile('git', ['clone', '--branch', pushedBranches[0]!, remote, verified], { env: GIT_ENV });
    await expect(execFile('npm', ['test'], { cwd: verified })).resolves.toMatchObject({ stdout: expect.any(String) });
    expect(await readFile(join(verified, 'src', 'value.js'), 'utf8')).toContain("?? 'UNKNOWN'");
  });
});
