import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
describeDb('friction bucket retirement', () => {
  it('archives only retired buckets, cancels only their active fix/investigate jobs and invalidates their cache idempotently', async () => {
    const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    try {
      // Shadow production tables on this connection. The script cannot reach retained rows.
      for (const table of ['error_groups', 'error_group_jobs', 'digest_card_copy']) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      const projectId = randomUUID();
      const eligible = ['candidate', 'queued', 'analyzing', 'awaiting_approval', 'insight', 'needs_human', 'investigated'];
      const cases = [
        ...eligible.map(status => ({ status, kind: 'friction', ticket: null, retire: true })),
        ...['pr_created', 'pr_draft', 'fixing', 'archived', 'resolved', 'new'].map(status => ({ status, kind: 'friction', ticket: null, retire: false })),
        { status: 'queued', kind: 'error', ticket: null, retire: false },
        { status: 'queued', kind: 'friction', ticket: randomUUID(), retire: false },
      ];
      const expected = [];
      for (const row of cases) {
        const id = randomUUID();
        await client.query(`INSERT INTO error_groups(id,project_id,fingerprint,title,first_seen,last_seen,status,kind,ticket_id,reason_code,reason_message,remediation)
          VALUES($1::uuid,$2,$1::text,'test',now(),now(),$3,$4,$5,'test','test','test')`, [id, projectId, row.status, row.kind, row.ticket]);
        for (const jobType of ['investigate', 'fix', 'stack_resolve']) {
          for (const status of ['pending', 'claimed', 'completed', 'failed']) {
            await client.query(`INSERT INTO error_group_jobs(project_id,error_group_id,job_type,status,worker_id,lease_expires_at)
              VALUES($1,$2,$3,$4,'old-worker',now()+interval '5 minutes')`, [projectId, id, jobType, status]);
          }
        }
        await client.query(`INSERT INTO digest_card_copy(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
          VALUES($1,now(),'test','test','test','test','test',1)`, [id]);
        expected.push({ id, ...row });
      }
      const sql = await readFile(new URL('../../../../../scripts/retire-friction-buckets.sql', import.meta.url), 'utf8');
      await client.query(sql);
      for (const row of expected) {
        const group = (await client.query('SELECT status,status_before_archive,archived_at FROM error_groups WHERE id=$1', [row.id])).rows[0];
        expect(group.status).toBe(row.retire ? 'archived' : row.status);
        expect(group.status_before_archive).toBe(row.retire ? row.status : null);
        expect(group.archived_at !== null).toBe(row.retire);
        const jobs = (await client.query(`SELECT job_type,status,lease_expires_at,last_error FROM error_group_jobs WHERE error_group_id=$1`, [row.id])).rows;
        expect(jobs.filter(job => job.last_error === 'retired_friction_bucket')).toHaveLength(row.retire ? 4 : 0);
        for (const job of jobs.filter(job => job.last_error === 'retired_friction_bucket')) {
          expect(job.status).toBe('failed');
          expect(job.lease_expires_at).toBeNull();
          expect(['investigate', 'fix']).toContain(job.job_type);
        }
        expect(jobs.filter(job => job.status === 'completed')).toHaveLength(3);
        expect(jobs.filter(job => job.status === 'pending')).toHaveLength(row.retire ? 1 : 3);
        expect(jobs.filter(job => job.status === 'claimed')).toHaveLength(row.retire ? 1 : 3);
        expect((await client.query('SELECT invalidated_at IS NOT NULL AS invalid FROM digest_card_copy WHERE error_group_id=$1', [row.id])).rows[0].invalid).toBe(row.retire);
      }
      const snapshot = async () => {
        const rows: unknown[] = [];
        for (const table of ['error_groups', 'error_group_jobs', 'digest_card_copy']) {
          rows.push((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
        }
        return rows;
      };
      const before = await snapshot();
      await client.query(sql);
      expect(await snapshot()).toEqual(before);
    } finally { await client.end(); }
  });
});
