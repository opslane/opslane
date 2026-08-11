import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { scanReliabilityInvariants } from '../invariant-scanner.js';
import {
  createFixtureRepository,
  startProviderRecorders,
  type ProviderRecorders,
} from '../../../worker/src/__tests__/reliability-fixture.js';
import type { TestTenant } from '../../../../test-e2e/helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required for the friction-ladder system test; run it against a disposable migrated database',
  );
}

const ingestionUrl = process.env['INGESTION_URL'] ?? 'http://localhost:8082';
const webhookSecret = process.env['GITHUB_WEBHOOK_SECRET'] ?? 'reliability-webhook-secret';
const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GITHUB_TOKEN',
  'OPSLANE_GITHUB_API_URL',
  'OPSLANE_GITHUB_URL',
  'OPSLANE_SANDBOX_BACKEND',
  'OPSLANE_RELIABILITY_HARNESS',
] as const;

/**
 * The keyed friction dogfood loop against provider twins (no real
 * credentials): friction incident → autonomy ladder auto-triggers a fix →
 * real agent pipeline against the Anthropic twin → real git push → Suggestion
 * PR on the GitHub twin → twin merges/closes → signed pull_request webhook →
 * attributable pr_outcomes receipt.
 */
describe('friction ladder system tracer (provider twins)', () => {
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

  it('walks friction from investigation to a merged, attributed Suggestion PR', async () => {
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
        `Friction-ladder system test requires a disposable database with no live jobs; found ${liveBefore.rows[0]?.count}`,
      );
    }

    root = await mkdtemp(join(tmpdir(), 'opslane-friction-ladder-'));
    const githubRepo = `e2e/friction-ladder-${Date.now()}`;
    const remoteRoot = join(root, 'remotes');
    await createFixtureRepository(root, join(remoteRoot, `${githubRepo}.git`));

    providers = await startProviderRecorders({ ingestionUrl, webhookSecret });
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic-key';
    process.env['ANTHROPIC_BASE_URL'] = providers.anthropicBaseUrl;
    process.env['GITHUB_TOKEN'] = 'test-github-token';
    process.env['OPSLANE_GITHUB_API_URL'] = providers.githubBaseUrl;
    process.env['OPSLANE_GITHUB_URL'] = pathToFileURL(remoteRoot).href;
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';

    tenant = await helpers.seedTenant(githubRepo);
    // The ladder's opt-in rung: high-confidence, code-caused friction may fix
    // without a human click.
    await db.query(
      `UPDATE projects SET friction_autonomy = 'auto_fix' WHERE id = $1`,
      [tenant.projectId],
    );

    const group = await db.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, kind, status,
          signal_type, element_selector, page_url_normalized)
       VALUES ($1, 'fp-friction-ladder', 'Rage click on save', now(), now(), 'friction', 'queued',
               'rage_click', '[data-testid="save"]', 'https://fixture.invalid/settings')
       RETURNING id`,
      [tenant.projectId],
    );
    const groupId = group.rows[0]!.id;
    await db.query(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type) VALUES ($1, $2, 'investigate')`,
      [groupId, tenant.projectId],
    );

    const workerDb = await import('../../../worker/src/db.js');
    const worker = await import('../../../worker/src/index.js');
    const workerId = `friction-ladder-worker-${Date.now()}`;
    const signal = new AbortController().signal;

    // Investigation: the Anthropic twin classifies the friction as code-caused
    // at high confidence, so the ladder must enqueue an auto fix job itself.
    const investigateJob = await workerDb.claimJob(workerId, 120_000);
    expect(investigateJob).toMatchObject({
      errorGroupId: groupId,
      projectId: tenant.projectId,
      jobType: 'investigate',
    });
    await worker.processInvestigateJob(
      investigateJob as NonNullable<typeof investigateJob> & { errorGroupId: string },
      signal,
    );
    expect(
      await workerDb.completeJob(investigateJob!.id, workerId, investigateJob!.leaseGeneration),
    ).toBe(true);

    const autoFixJob = await db.query<{ id: string; triggered_by: string; status: string }>(
      `SELECT id, triggered_by, status FROM error_group_jobs
       WHERE error_group_id = $1 AND job_type = 'fix'`,
      [groupId],
    );
    expect(autoFixJob.rows).toHaveLength(1);
    expect(autoFixJob.rows[0]).toMatchObject({ triggered_by: 'auto', status: 'pending' });

    // Fix: the claim-time gate re-reads friction_autonomy and lets the auto
    // job through; the real pipeline clones, edits (twin script), runs the
    // fixture's tests, pushes, and opens the PR on the GitHub twin.
    const fixJob = await workerDb.claimJob(workerId, 300_000);
    expect(fixJob).toMatchObject({
      id: autoFixJob.rows[0]!.id,
      errorGroupId: groupId,
      jobType: 'fix',
      triggeredBy: 'auto',
    });
    await worker.processFixJob(
      fixJob as NonNullable<typeof fixJob> & { errorGroupId: string },
      signal,
    );
    expect(await workerDb.completeJob(fixJob!.id, workerId, fixJob!.leaseGeneration)).toBe(true);

    // The Suggestion contract: honest title, honest unverified-friction body.
    expect(providers.pullRequests).toHaveLength(1);
    const pull = providers.pullRequests[0]!;
    expect(pull.title).toMatch(/^\[Opslane\] Suggestion:/);
    expect(pull.body).toContain('friction itself was not re-verified');
    expect(pull.base).toBe('main');

    const afterFix = await db.query<{
      status: string;
      pr_number: number | null;
      pr_fix_job_id: string | null;
    }>(
      `SELECT status, pr_number, pr_fix_job_id FROM error_groups WHERE id = $1`,
      [groupId],
    );
    expect(afterFix.rows[0]).toEqual({
      status: 'pr_created',
      pr_number: pull.number,
      pr_fix_job_id: fixJob!.id,
    });
    expect(await scanReliabilityInvariants(db)).toEqual([]);

    // Merge on the twin → signed webhook → receipt BEFORE transition, fully
    // attributed to the fix job recorded at PR creation.
    const mergedAt = new Date(Date.now() - 60_000);
    mergedAt.setMilliseconds(0);
    const merge = await providers.mergePullRequest(pull.number, mergedAt);
    expect(merge.status).toBe(200);
    expect(await merge.json()).toMatchObject({ status: 'processed', action: 'merged' });

    const afterMerge = await db.query<{
      status: string;
      merged_at: Date | null;
    }>(
      `SELECT status, merged_at FROM error_groups WHERE id = $1`,
      [groupId],
    );
    expect(afterMerge.rows[0]?.status).toBe('merged');
    expect(afterMerge.rows[0]?.merged_at?.toISOString()).toBe(mergedAt.toISOString());

    const receipts = await db.query<{
      outcome: string;
      fix_job_id: string | null;
      pr_number: number;
    }>(
      `SELECT outcome, fix_job_id, pr_number FROM pr_outcomes WHERE error_group_id = $1`,
      [groupId],
    );
    expect(receipts.rows).toEqual([
      { outcome: 'merged', fix_job_id: fixJob!.id, pr_number: pull.number },
    ]);

    // The receipts surface: this merge counts as ONE auto-attributed merge —
    // the same join GetFixStats uses for the Settings toggle numbers.
    const stats = await db.query<{ kind: string; outcome: string; triggered_by: string | null }>(
      `SELECT eg.kind, o.outcome, j.triggered_by
       FROM pr_outcomes o
       JOIN error_groups eg ON o.error_group_id = eg.id
       LEFT JOIN error_group_jobs j ON o.fix_job_id = j.id
       WHERE o.project_id = $1`,
      [tenant.projectId],
    );
    expect(stats.rows).toEqual([
      { kind: 'friction', outcome: 'merged', triggered_by: 'auto' },
    ]);
    expect(await scanReliabilityInvariants(db)).toEqual([]);
  }, 300_000);

  it('returns a close-unmerged Suggestion to awaiting_approval with its receipt', async () => {
    const helpers = await import('../../../../test-e2e/helpers.js');
    const db = helpers.getPool();
    expect(tenant && providers && root, 'first test must have run').toBeTruthy();

    // A second friction incident already holding an open Suggestion PR: seed
    // the state the first test produced organically, then exercise only the
    // close leg through the twin.
    const group = await db.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, kind, status,
          signal_type, page_url_normalized, confidence)
       VALUES ($1, 'fp-friction-ladder-close', 'Dead click on export', now(), now(), 'friction', 'pr_created',
               'dead_click', 'https://fixture.invalid/export', 'high')
       RETURNING id`,
      [tenant!.projectId],
    );
    const groupId = group.rows[0]!.id;
    const fixJob = await db.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status, triggered_by)
       VALUES ($1, $2, 'fix', 'completed', 'auto') RETURNING id`,
      [groupId, tenant!.projectId],
    );
    const fixJobId = fixJob.rows[0]!.id;

    // Register the PR with the twin the same way the worker would.
    const [owner, repo] = (await db.query<{ github_repo: string }>(
      `SELECT github_repo FROM projects WHERE id = $1`,
      [tenant!.projectId],
    )).rows[0]!.github_repo.split('/') as [string, string];
    const create = await fetch(`${process.env['OPSLANE_GITHUB_API_URL']}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'token test-github-token' },
      body: JSON.stringify({
        title: '[Opslane] Suggestion: reconnect the export handler',
        body: 'The friction itself was not re-verified — review before merging',
        head: 'opslane/fix-export',
        base: 'main',
      }),
    });
    const created = await create.json() as { number: number };
    await db.query(
      `UPDATE error_groups
       SET pr_number = $2, pr_url = $3, pr_fix_job_id = $4
       WHERE id = $1`,
      [groupId, created.number, `https://github.test/${owner}/${repo}/pull/${created.number}`, fixJobId],
    );

    const closeResponse = await providers!.closePullRequest(created.number);
    expect(closeResponse.status).toBe(200);
    expect(await closeResponse.json()).toMatchObject({ status: 'processed', action: 'closed' });

    const afterClose = await db.query<{
      status: string;
      confidence: string | null;
      pr_number: number | null;
      pr_fix_job_id: string | null;
    }>(
      `SELECT status, confidence, pr_number, pr_fix_job_id FROM error_groups WHERE id = $1`,
      [groupId],
    );
    // Friction returns to the approval queue — not 'investigated' — with the
    // PR fields cleared and the investigation's confidence intact.
    expect(afterClose.rows[0]).toEqual({
      status: 'awaiting_approval',
      confidence: 'high',
      pr_number: null,
      pr_fix_job_id: null,
    });

    const receipt = await db.query<{ outcome: string; fix_job_id: string | null }>(
      `SELECT outcome, fix_job_id FROM pr_outcomes WHERE error_group_id = $1`,
      [groupId],
    );
    expect(receipt.rows).toEqual([{ outcome: 'closed', fix_job_id: fixJobId }]);
    expect(await scanReliabilityInvariants(db)).toEqual([]);
  }, 60_000);
});
