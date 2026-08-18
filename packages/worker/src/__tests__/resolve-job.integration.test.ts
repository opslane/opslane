import crypto from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, type ClaimedJob } from '../db.js';
import { runStackResolve } from '../resolve/job.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(!databaseUrl)('stack_resolve database contract', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('does not downgrade a resolved envelope when a retry finds no debug id', async () => {
    const suffix = crypto.randomUUID();
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`resolve-job-${suffix}`],
    );
    const orgId = org.rows[0]!.id;
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo)
       VALUES ($1, $2, 'opslane/test') RETURNING id`,
      [orgId, `resolve-job-${suffix}`],
    );
    const projectId = project.rows[0]!.id;
    const environment = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name)
       VALUES ($1, 'production') RETURNING id`,
      [projectId],
    );
    const event = await pool.query<{ id: string }>(
      `INSERT INTO error_events
         (project_id, environment_id, timestamp, error_type, error_message,
          stack_trace_raw, debug_meta)
       VALUES ($1, $2, now(), 'TypeError', 'boom', 'at app.js:1:1', '{"images":[]}'::jsonb)
       RETURNING id`,
      [projectId, environment.rows[0]!.id],
    );
    const eventId = event.rows[0]!.id;
    const envelope = {
      version: 2,
      frames: [{
        original_file: 'src/App.ts',
        original_function: 'render',
        original_line: 10,
        generated: { line: 1, column: 1 },
      }],
    };
    await pool.query(
      `INSERT INTO error_event_resolutions
         (project_id, event_id, status, envelope, resolver_version)
       VALUES ($1, $2, 'resolved', $3, 2)`,
      [projectId, eventId, envelope],
    );

    try {
      await runStackResolve({
        id: crypto.randomUUID(),
        workerId: 'resolve-integration',
        errorGroupId: null,
        eventId,
        sourceId: null,
        projectId,
        jobType: 'stack_resolve',
        attempts: 1,
        guidance: null,
        leaseGeneration: '1',
        triggeredBy: null,
        sessionId: null,
      } satisfies ClaimedJob);

      const stored = await pool.query<{ status: string; envelope: unknown }>(
        `SELECT status, envelope FROM error_event_resolutions
         WHERE project_id=$1 AND event_id=$2`,
        [projectId, eventId],
      );
      expect(stored.rows[0]).toEqual({ status: 'resolved', envelope });
    } finally {
      await pool.query(`DELETE FROM error_events WHERE project_id=$1`, [projectId]);
      await pool.query(`DELETE FROM environments WHERE project_id=$1`, [projectId]);
      await pool.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
      await pool.query(`DELETE FROM orgs WHERE id=$1`, [orgId]);
    }
  });
});
