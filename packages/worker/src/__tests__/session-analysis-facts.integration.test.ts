import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getSessionAnalysis, upsertSessionAnalysis } from '../db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('session_analysis facts upsert', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  let orgId: string;
  let projectId: string;
  let environmentId: string;
  const sessionId = `facts-${crypto.randomUUID()}`;

  beforeAll(async () => {
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [`facts-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, 'facts') RETURNING id`, [orgId],
    )).rows[0]!.id;
    environmentId = (await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, [projectId],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
       VALUES ($1,$2,$3,'2026-08-01T00:00:00Z','analyzed')`,
      [sessionId, projectId, environmentId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    await pool.query(`DELETE FROM environments WHERE id = $1`, [environmentId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  it('updates facts idempotently while keeping session-start attribution stable', async () => {
    const base = {
      sessionId, projectId, environmentId, sessionStartedAt: '2026-08-01T00:00:00Z',
      coverage: 'complete' as const, activityClass: 'active' as const, entryPath: '/assets',
      clickCount: 3, inputEventCount: 0, pageEventCount: 1,
      failedRequest4xxCount: 0, failedRequest5xxCount: 0,
      unattributedFailedRequestCount: 0, successfulWriteCount: 1, failedWriteCount: 0,
      ruleVersion: 2,
    };
    await upsertSessionAnalysis(base);
    await upsertSessionAnalysis({
      ...base, sessionStartedAt: '2026-08-02T00:00:00Z', clickCount: 9,
      coverage: 'partial', activityClass: 'unknown',
    });
    const row = await getSessionAnalysis(sessionId, projectId);
    expect(row?.clickCount).toBe(9);
    expect(row?.coverage).toBe('partial');
    expect(row?.sessionStartedAt).toContain('2026-08-01');
    const count = await pool.query(`SELECT 1 FROM session_analysis WHERE session_id = $1`, [sessionId]);
    expect(count.rowCount).toBe(1);
  });
});
