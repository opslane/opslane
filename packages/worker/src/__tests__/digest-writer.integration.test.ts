import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../db.js';
import {
  loadFrozenDigestRun,
  persistWrittenDigest,
  writeDigest,
  type DigestCandidate,
} from '../digest-writer/job.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('digest writer database handoff', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;
  let issueId: string;
  let episodeId: string;
  let runId: string;
  let frozen: DigestCandidate;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`digest-writer-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id,name,github_repo)
       VALUES ($1,'digest writer','acme/shop') RETURNING id`, [orgId],
    )).rows[0]!.id;
    issueId = (await pool.query<{ id: string }>(
      `INSERT INTO error_groups (project_id,fingerprint,title,first_seen,last_seen,status)
       VALUES ($1,$2,'Checkout failed',now(),now(),'investigated') RETURNING id`,
      [projectId, `digest-writer-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    episodeId = (await pool.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
       VALUES ($1,$2,2) RETURNING id`, [projectId, issueId],
    )).rows[0]!.id;
    frozen = {
      errorGroupId: issueId, episodeId, episodeSequence: 2, label: 'returned', issueId, kind: 'error',
      title: 'Checkout failed', outcome: 'verified_fix', summary: 'A null cart blocked payment.',
      prUrl: 'https://github.com/acme/shop/pull/42', affectedUsers: 9,
      occurrenceCount: 34,
      accounts: ['Acme'], lastSeen: '2026-08-20T08:00:00Z', decidedAt: '2026-08-20T08:30:00Z',
    };
    runId = (await pool.query<{ id: string }>(
      `INSERT INTO digest_runs (project_id,window_from,window_to,run_date,status)
       VALUES ($1,now()-interval '1 day',now(),current_date,'frozen') RETURNING id`, [projectId],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO digest_run_items (project_id,run_id,error_group_id,episode_id,candidate_snapshot)
       VALUES ($1,$2,$3,$4,$5::jsonb)`, [projectId, runId, issueId, episodeId, JSON.stringify(frozen)],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM digest_runs WHERE id=$1`, [runId]).catch(() => undefined);
    await pool.query(`DELETE FROM issue_episodes WHERE id=$1`, [episodeId]).catch(() => undefined);
    await pool.query(`DELETE FROM error_groups WHERE id=$1`, [issueId]).catch(() => undefined);
    await pool.query(`DELETE FROM projects WHERE id=$1`, [projectId]).catch(() => undefined);
    await pool.query(`DELETE FROM orgs WHERE id=$1`, [orgId]).catch(() => undefined);
    await pool.end();
    await closePool();
  });

  it('stores the grounded payload and every item outcome atomically', async () => {
    const payload = await writeDigest(runId, projectId, {
      loadRun: loadFrozenDigestRun,
      askModel: async () => ({
        included: [{
          errorGroupId: issueId, title: 'Checkout is blocked', copy: 'People at Acme cannot check out.', action: 'Review the verified fix.',
          claimedUsers: 9, accounts: ['Acme'], prUrl: frozen.prUrl,
        }],
        deferred: [],
      }),
      persist: persistWrittenDigest,
    });
    expect(payload.included[0]?.label).toBe('returned');

    const run = (await pool.query<{ status: string; payload: unknown }>(
      `SELECT status,payload FROM digest_runs WHERE id=$1`, [runId],
    )).rows[0]!;
    const item = (await pool.query<{ outcome: string | null; reason: string | null }>(
      `SELECT outcome,reason FROM digest_run_items WHERE run_id=$1 AND error_group_id=$2`, [runId, issueId],
    )).rows[0]!;
    expect(run.status).toBe('written');
    expect(run.payload).toEqual(payload);
    expect(item).toEqual({ outcome: 'included', reason: null });
  });
});
