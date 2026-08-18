import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../db.js';
import { replaceSessionFacts } from '../facts/persist.js';
import type { SessionFacts } from '../friction/facts.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('session fact persistence', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const sessionIds: string[] = [];
  let orgId: string;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`facts-persist-${crypto.randomUUID()}`],
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, 'facts', '') RETURNING id`,
      [orgId],
    )).rows[0]!.id;
    environmentId = (await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId],
    )).rows[0]!.id;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [sessionIds]);
    sessionIds.length = 0;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM environments WHERE id = $1`, [environmentId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await pool.end();
    await closePool();
  });

  async function seedSession(): Promise<string> {
    const sessionId = `facts-${crypto.randomUUID()}`;
    sessionIds.push(sessionId);
    await pool.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
       VALUES ($1,$2,$3,now(),'analyzed')`,
      [sessionId, projectId, environmentId],
    );
    return sessionId;
  }

  function factsWith(overrides: Partial<SessionFacts> = {}): SessionFacts & { ruleVersion: number } {
    return {
      entryPath: '/assets', clickCount: 0, inputEventCount: 0, pageEventCount: 1,
      failedRequest4xxCount: 0, failedRequest5xxCount: 0,
      unattributedFailedRequestCount: 0, successfulWriteCount: 0, failedWriteCount: 0,
      firstEventMs: null, lastEventMs: null, failures: [], successes: [],
      ruleVersion: 4,
      ...overrides,
    };
  }

  const failure = (requestIdHash: string) => ({
    requestIdHash,
    pageRoute: '/assets/:id/edit',
    method: 'PUT',
    endpointPattern: '/api/assets/:id',
    status: 400,
    actionKind: 'click' as const,
    actionSelector: '[data-testid="save"]',
    actionLink: 'direct' as const,
    occurredAt: '2026-08-18T00:00:00.000Z',
  });

  it('stores one row per failed request and rolls up successful writes', async () => {
    const sessionId = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({
      failures: [failure('failure-1'), failure('failure-2')],
      successes: [{
        pageRoute: '/assets/new', method: 'POST', endpointPattern: '/api/assets',
        statusClass: 2, count: 5,
      }],
    }));

    const failures = await pool.query(
      `SELECT * FROM session_request_failures WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );
    const rollups = await pool.query<{ occurrence_count: number }>(
      `SELECT occurrence_count FROM session_write_rollups WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );
    expect(failures.rowCount).toBe(2);
    expect(rollups.rowCount).toBe(1);
    expect(rollups.rows[0]?.occurrence_count).toBe(5);
  });

  it('replaces the whole fact set when a late chunk arrives', async () => {
    const sessionId = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({ failures: [failure('old')] }));
    await replaceSessionFacts(projectId, sessionId, factsWith({
      failures: [failure('new-1'), failure('new-2')],
    }));

    const stored = await pool.query<{ request_id_hash: string }>(
      `SELECT request_id_hash FROM session_request_failures
       WHERE project_id=$1 AND session_id=$2 ORDER BY request_id_hash`,
      [projectId, sessionId],
    );
    expect(stored.rows.map((row) => row.request_id_hash)).toEqual(['new-1', 'new-2']);
  });

  it('never stores an endpoint host or query string', async () => {
    const sessionId = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({
      failures: [{
        ...failure('secret'),
        endpointPattern: 'https://app.example.com/api/assets/42?token=secret',
      }],
    }));

    const stored = await pool.query<{ endpoint_pattern: string }>(
      `SELECT endpoint_pattern FROM session_request_failures
       WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );
    expect(stored.rows[0]?.endpoint_pattern).toBe('/api/assets/:id');
  });

  it('expires facts with the session', async () => {
    const sessionId = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({ failures: [failure('expiring')] }));
    await pool.query(`DELETE FROM sessions WHERE id=$1 AND project_id=$2`, [sessionId, projectId]);

    const stored = await pool.query(
      `SELECT 1 FROM session_request_failures WHERE project_id=$1 AND session_id=$2`,
      [projectId, sessionId],
    );
    expect(stored.rowCount).toBe(0);
  });
});
