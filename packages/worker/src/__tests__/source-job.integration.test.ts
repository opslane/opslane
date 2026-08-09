import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, updateGroupAndCreateFixJob, type JobLease } from '../db.js';

describe.skipIf(!process.env['DATABASE_URL'])('fix job source attribution', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    const org = await getPool().query<{ id: string }>(
      'INSERT INTO orgs (name) VALUES ($1) RETURNING id',
      [`source-job-${crypto.randomUUID()}`],
    );
    orgId = org.rows[0]!.id;
    const project = await getPool().query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, $2, 'test/repo') RETURNING id`,
      [orgId, `source-job-${crypto.randomUUID()}`],
    );
    projectId = project.rows[0]!.id;
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM error_group_jobs WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM error_groups WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await getPool().query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await closePool();
  });

  async function fixture(existingFix: boolean): Promise<{
    groupId: string;
    sourceJobId: string;
    otherSourceJobId: string;
    existingFixJobId: string | null;
    lease: JobLease;
  }> {
    const group = await getPool().query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, status)
       VALUES ($1, $2, 'source attribution', now(), now(), 'analyzing') RETURNING id`,
      [projectId, `source-${crypto.randomUUID()}`],
    );
    const groupId = group.rows[0]!.id;
    const source = await getPool().query<{ id: string }>(
      `INSERT INTO error_group_jobs
         (error_group_id, project_id, job_type, status, worker_id,
          lease_generation, lease_expires_at)
       VALUES ($1, $2, 'investigate', 'claimed', 'source-worker', 1,
               now() + interval '5 minutes') RETURNING id`,
      [groupId, projectId],
    );
    const other = await getPool().query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type)
       VALUES ($1, $2, 'investigate') RETURNING id`,
      [groupId, projectId],
    );
    let existingFixJobId: string | null = null;
    if (existingFix) {
      const fix = await getPool().query<{ id: string }>(
        `INSERT INTO error_group_jobs (error_group_id, project_id, job_type)
         VALUES ($1, $2, 'fix') RETURNING id`,
        [groupId, projectId],
      );
      existingFixJobId = fix.rows[0]!.id;
    }
    const sourceJobId = source.rows[0]!.id;
    return {
      groupId,
      sourceJobId,
      otherSourceJobId: other.rows[0]!.id,
      existingFixJobId,
      lease: {
        id: sourceJobId,
        workerId: 'source-worker',
        leaseGeneration: '1',
        projectId,
        errorGroupId: groupId,
        sessionId: null,
      },
    };
  }

  it('stores source_job_id on a newly created fix job', async () => {
    const data = await fixture(false);
    const result = await updateGroupAndCreateFixJob(
      data.groupId,
      projectId,
      { rootCause: 'x', confidence: 'high', sourceJobId: data.sourceJobId },
      data.lease,
    );
    expect(result.created).toBe(true);
    const fixJobId = result.created ? result.fixJobId : '';
    const row = await getPool().query<{ source_job_id: string | null }>(
      'SELECT source_job_id FROM error_group_jobs WHERE id = $1',
      [fixJobId],
    );
    expect(row.rows[0]?.source_job_id).toBe(data.sourceJobId);
  });

  it('backfills a reused pending fix only when source_job_id is null', async () => {
    const data = await fixture(true);
    const first = await updateGroupAndCreateFixJob(
      data.groupId,
      projectId,
      { rootCause: 'x', confidence: 'high', sourceJobId: data.sourceJobId },
      data.lease,
    );
    expect(first).toEqual({ created: true, fixJobId: data.existingFixJobId });

    await updateGroupAndCreateFixJob(
      data.groupId,
      projectId,
      { rootCause: 'x', confidence: 'high', sourceJobId: data.otherSourceJobId },
      data.lease,
    );
    const row = await getPool().query<{ source_job_id: string | null }>(
      'SELECT source_job_id FROM error_group_jobs WHERE id = $1',
      [data.existingFixJobId],
    );
    expect(row.rows[0]?.source_job_id).toBe(data.sourceJobId);
  });
});
