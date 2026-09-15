import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSignalRows, deriveNarrativeId } from '../../narrative/emit.js';
import type { SessionRow } from '../../db.js';
import { writeObservationSignals } from '../persist.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;

type Written = Awaited<ReturnType<typeof writeObservationSignals>>;

// Concurrent writers must commit on separate connections, so this suite cannot
// share the rolled-back transaction that persist.integration.test.ts uses.
describeDb('atomic observation persistence under concurrent writers', () => {
  // Timing-dependent, not a deterministic reproduction. Before the fix, 4
  // writers started together raised the duplicate-key error in most rounds, so
  // 25 rounds failed on every measured run.
  const ROUNDS = 25;
  const WRITERS = 4;
  let pool: pg.Pool;
  let orgId: string | undefined;
  let projectId: string | undefined;
  let environmentId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: WRITERS + 2 });
    orgId = (await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('persist-concurrency-test') RETURNING id`,
    )).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, 'persist-concurrency') RETURNING id`, [orgId],
    )).rows[0]!.id;
    environmentId = (await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, [projectId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await pool.query('DELETE FROM friction_signals WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM environments WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
        // Deleting a project writes a tombstone through a trigger (030_sourcemap_files.sql).
        await pool.query('DELETE FROM sourcemap_tombstones WHERE project_id = $1', [projectId]);
      }
      if (orgId) await pool.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    } finally {
      await pool?.end();
    }
  });

  it('returns one shared signal per observation when writers race on the same narrative', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const session = (await pool.query<SessionRow>(
        `INSERT INTO sessions (id, project_id, environment_id, started_at)
         VALUES ($1, $2, $3, now()) RETURNING *, started_at::text`,
        [`race-${randomUUID()}`, projectId, environmentId],
      )).rows[0]!;
      const narrativeId = deriveNarrativeId(session.id, '2026-09-15 12:00:00.000001+00', 2);
      const rows = buildSignalRows(
        { startTs: 1_000, lines: [{ t: 'save', s: 'button.save', r: '/assets', a: 1_000 }] },
        [
          { id: 'o1', what: 'Save shows an error', evidenceLines: ['L1'] },
          { id: 'o2', what: 'Search repeats results', evidenceLines: ['L1'] },
        ],
        session.id,
        narrativeId,
      );
      // Check out every connection first, so all writers send their INSERTs together.
      const checkouts = await Promise.allSettled(Array.from({ length: WRITERS }, () => pool.connect()));
      const clients = checkouts
        .filter((result): result is PromiseFulfilledResult<pg.PoolClient> => result.status === 'fulfilled')
        .map((result) => result.value);
      let settled: PromiseSettledResult<Written>[];
      try {
        const refused = checkouts.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (refused) throw refused.reason;
        // allSettled drains every writer before the connections are released.
        settled = await Promise.allSettled(
          clients.map((client) => writeObservationSignals(client, session, rows)),
        );
      } finally {
        for (const client of clients) client.release();
      }
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      const written = settled.map((result) => (result as PromiseFulfilledResult<Written>).value);
      for (const result of written) expect(result).toEqual(written[0]);
      const stored = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM friction_signals WHERE session_id = $1', [session.id],
      );
      expect(stored.rows[0]!.n).toBe(2);
    }
  }, 60_000);
});
