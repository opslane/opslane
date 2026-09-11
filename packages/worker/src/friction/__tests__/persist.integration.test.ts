import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSignalRows, deriveNarrativeId } from '../../narrative/emit.js';
import type { SessionRow } from '../../db.js';
import { writeObservationSignals, type ObservationSignalRow } from '../persist.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDb('atomic observation persistence', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let session: SessionRow;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    client = await pool.connect();
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('atomic-observation-test') RETURNING id`,
    );
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'atomic-observations', 'octocat/hello', 'main') RETURNING id`,
      [org.rows[0]!.id],
    );
    const environment = await client.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [project.rows[0]!.id],
    );
    const result = await client.query<SessionRow>(
      `INSERT INTO sessions (id, project_id, environment_id, started_at)
       VALUES ($1, $2, $3, now()) RETURNING *, started_at::text`,
      [`atomic-${randomUUID()}`, project.rows[0]!.id, environment.rows[0]!.id],
    );
    session = result.rows[0]!;
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  it('keeps one row per observation and returns the same signal IDs on retries', async () => {
    const narrativeId = randomUUID();
    const rows: ObservationSignalRow[] = ['first', 'second'].map((observationId) => ({
      signalType: 'narrative', fingerprint: randomUUID().replaceAll('-', ''),
      observationId, narrativeId, evidenceLines: ['L1'],
      elementSelector: 'button.save', pageUrlNormalized: '/assets',
      occurredAts: [Date.parse(session.started_at)], occurrenceCount: 1,
      what: `${observationId} difficulty on the same screen`,
    }));
    const first = await writeObservationSignals(client, session, rows);
    expect(first).toEqual(rows.map((row) => ({
      signalId: expect.stringMatching(/^[0-9a-f-]{36}$/), observationId: row.observationId,
    })));
    expect(first[0]!.signalId).not.toBe(first[1]!.signalId);
    // Identity is the narrative/observation tuple, even if a retry recomputes other fields.
    const retry = await writeObservationSignals(client, session, rows.map((row) => ({
      ...row, fingerprint: randomUUID().replaceAll('-', ''), what: 'retry must not overwrite',
    })));
    expect(retry).toEqual(first);
    const stored = await client.query(
      `SELECT observation_id, narrative_id, evidence_lines, occurrence_count, observation_text, severity
       FROM friction_signals WHERE session_id = $1 ORDER BY observation_id`, [session.id],
    );
    expect(stored.rows).toEqual(rows.map((row) => ({
      observation_id: row.observationId, narrative_id: narrativeId, evidence_lines: ['L1'],
      occurrence_count: 1, observation_text: row.what, severity: null,
    })));
  });

  it('writes stored v2 observations through the same atomic writer', async () => {
    const observations = [
      { id: 'v2-a', category: 'slow_response' as const, severity: 'high' as const,
        what: 'The save control shows a spinner.', evidenceLines: ['L1'] },
      { id: 'v2-b', category: 'slow_response' as const, severity: 'low' as const,
        what: 'The form shows an error beneath the spinner.', evidenceLines: ['L1'] },
    ];
    const narrativeId = deriveNarrativeId(session.id, '2026-09-11 12:34:56.123456+00', 2);
    const rows = buildSignalRows({ startTs: 1_000, lines: [
      { t: 'save', s: 'button.save', r: '/assets', a: 1_000 },
    ] }, observations, session.id, narrativeId);
    const written = await writeObservationSignals(client, session, rows);
    expect(written).toHaveLength(2);
    expect(await writeObservationSignals(client, session, rows)).toEqual(written);
    const stored = await client.query(
      `SELECT signal_type, observation_id, narrative_id, evidence_lines, severity
       FROM friction_signals WHERE session_id = $1 AND narrative_id = $2 ORDER BY observation_id`,
      [session.id, narrativeId],
    );
    expect(stored.rows).toEqual(observations.map((observation) => ({
      signal_type: 'narrative', observation_id: observation.id, narrative_id: narrativeId,
      evidence_lines: ['L1'], severity: observation.severity,
    })));
  });
});
