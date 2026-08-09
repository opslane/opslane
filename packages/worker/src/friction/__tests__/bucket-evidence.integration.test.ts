import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';
import { getPool, closePool, getSessionForAnalysis } from '../../db.js';
import { processFrictionOutcomes, type AdjudicationRuntime } from '../promotion.js';
import { countEligibleUsers } from '../promotion-db.js';
import { RULE_VERSION } from '../analyzer.js';
import {
  ADJUDICATION_PROMPT_VERSION,
  type Adjudicator,
  type AdjudicationInput,
  type AdjudicationVerdict,
} from '../adjudicator.js';
import { purgeStaleTenants } from './tenant-purge.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const ORG_NAME = 'bucket-evidence-test';
const FINGERPRINT = 'accumulate-fp';

/**
 * End-to-end proof through the real orchestration in `processFrictionOutcomes`,
 * with the model replaced by a counting stub.
 *
 * The defect this pins: threshold counting read only `pending` signals, so each
 * verdict permanently deleted its own evidence and the bucket refilled from
 * zero. One production problem was adjudicated 68 times and rejected every time
 * for "only 5 users". Evidence must now survive verdicts, and re-adjudication
 * must be gated on genuine growth rather than on the pool refilling.
 */
describeDb('bucket evidence accumulation end to end', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;
  let environmentId: string;

  const calls: AdjudicationInput[] = [];

  /** Counts calls so the suite can assert how often the model was actually
   * asked. Carries the production prompt version, because the watermark key
   * includes it: a stub on a different version would silently re-judge. */
  function stubAdjudicator(accepted: boolean): Adjudicator {
    return {
      modelId: 'stub-model',
      promptVersion: ADJUDICATION_PROMPT_VERSION,
      async adjudicate(input: AdjudicationInput): Promise<AdjudicationVerdict> {
        calls.push(input);
        return { accepted, reason: accepted ? 'stub accept' : 'stub reject' };
      },
    };
  }

  const runtime: AdjudicationRuntime = {
    windowMode: 'off',
    dailyCap: 500,
    loadWindows: async () => [],
  };

  beforeAll(async () => {
    pool = getPool();
    // A previous run that died mid-file leaks this tenant; purging by org name
    // makes that self-heal instead of failing the insert below.
    await purgeStaleTenants(pool, ORG_NAME);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [ORG_NAME],
    );
    orgId = org.rows[0]!.id;
    // projects.github_repo is NOT NULL (001_baseline.sql:20).
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo)
       VALUES ($1, 'bucket-evidence', 'acme/bucket-evidence') RETURNING id`,
      [orgId],
    );
    projectId = project.rows[0]!.id;
    const env = await pool.query<{ id: string }>(
      `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
      [projectId],
    );
    environmentId = env.rows[0]!.id;
  });

  /**
   * Full teardown, in FK order. Leaving `session_analysis` jobs in 'claimed'
   * consumes fleet-wide SESSION_ANALYSIS_MAX_CONCURRENT slots and poisons every
   * later suite; leaking sessions and end_users skews other tests' counts.
   * error_groups.representative_signal_id and the generation's mirror of it
   * both point at friction_signals, so they are nulled before signals go.
   */
  async function purge(): Promise<void> {
    await pool.query(
      `UPDATE error_groups SET representative_signal_id = NULL WHERE project_id = $1`,
      [projectId],
    );
    await pool.query(
      `UPDATE friction_adjudication_generations SET representative_signal_id = NULL
       WHERE project_id = $1`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM friction_generation_evidence WHERE project_id = $1`, [projectId],
    );
    await pool.query(`DELETE FROM friction_bucket_state WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM friction_signals WHERE project_id = $1`, [projectId]);
    await pool.query(
      `DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [projectId],
    );
    await pool.query(`DELETE FROM error_group_jobs WHERE project_id = $1`, [projectId]);
    await pool.query(
      `DELETE FROM error_group_affected_users WHERE error_group_id IN
         (SELECT id FROM error_groups WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM error_group_environments WHERE error_group_id IN
         (SELECT id FROM error_groups WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM end_users WHERE project_id = $1`, [projectId]);
    // Reserving a model call writes a per-project budget row. It has no FK to
    // projects, so it survives the tenant unless it is deleted explicitly.
    await pool.query(`DELETE FROM adjudication_call_budget WHERE project_id = $1`, [projectId]);
  }

  afterAll(async () => {
    await purge();
    await pool.query(`DELETE FROM environments WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    calls.length = 0;
    await purge();
  });

  /** Seeds one session with one new identified user and one pending signal in
   * the bucket, then runs the real promotion path over that session exactly as
   * a session_analysis job would. */
  async function addUserSessionAndProcess(
    adjudicator: Adjudicator = stubAdjudicator(false),
  ): Promise<void> {
    const suffix = crypto.randomUUID();
    const user = await pool.query<{ id: string }>(
      `INSERT INTO end_users (project_id, external_user_id, first_seen, last_seen)
       VALUES ($1, $2, now(), now()) RETURNING id`,
      [projectId, `u-${suffix}`],
    );
    const sessionId = `sess-${suffix}`;
    await pool.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, status, chunk_count)
       VALUES ($1, $2, $3, now(), 'analyzed', 1)`,
      [sessionId, projectId, environmentId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (project_id, job_type, session_id, status)
       VALUES ($1, 'session_analysis', $2, 'claimed') RETURNING id`,
      [projectId, sessionId],
    );
    await pool.query(
      `INSERT INTO friction_signals
         (session_id, project_id, environment_id, end_user_id, rule_version,
          signal_type, fingerprint, element_selector, page_url_normalized,
          occurred_at, occurrence_count, adjudication_status)
       VALUES ($1, $2, $3, $4, $5, 'dead_click', $6, 'button.save', '/x',
               now(), 1, 'pending')`,
      [sessionId, projectId, environmentId, user.rows[0]!.id, RULE_VERSION, FINGERPRINT],
    );
    const session = await getSessionForAnalysis(sessionId, projectId);
    expect(session).not.toBeNull();
    await processFrictionOutcomes(session!, job.rows[0]!.id, adjudicator, runtime);
  }

  async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  it('adjudicates once at the threshold, not once per session after it', async () => {
    for (let i = 0; i < 9; i++) await addUserSessionAndProcess();
    // Users 1-4 are below the threshold of 5. The fifth triggers one call and
    // watermarks the bucket at 5. Users 6 and 7 sit below ceil(5 * 1.5) = 8.
    // The eighth triggers exactly one more and watermarks at 8; the ninth is
    // below ceil(8 * 1.5) = 12. Before this fix, every session from the fifth
    // on refilled a bucket its own verdict had just emptied.
    expect(calls.length).toBe(2);
    expect(calls[0]?.bucketSummary?.distinctUsers).toBe(5);
    expect(calls[1]?.bucketSummary?.distinctUsers).toBe(8);
  });

  it('records the evidence it was shown', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM friction_generation_evidence WHERE project_id = $1`,
      [projectId],
    );
    expect(rows[0]!.n).toBe(5);
  });

  it('writes a watermark at the evidence level it judged', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{
      evaluated_users: number;
      prompt_version: number;
      rule_version: number;
      last_generation_id: string | null;
    }>(
      `SELECT evaluated_users, prompt_version, rule_version, last_generation_id
       FROM friction_bucket_state
       WHERE project_id = $1 AND fingerprint = $2`,
      [projectId, FINGERPRINT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evaluated_users).toBe(5);
    // The watermark key is scoped by both versions, so a bump on either must
    // let the bucket be judged again.
    expect(rows[0]!.prompt_version).toBe(ADJUDICATION_PROMPT_VERSION);
    expect(rows[0]!.rule_version).toBe(RULE_VERSION);
    expect(rows[0]!.last_generation_id).not.toBeNull();
  });

  it('still counts users whose signals were rejected', async () => {
    for (let i = 0; i < 5; i++) await addUserSessionAndProcess();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT end_user_id)::int AS n FROM friction_signals
       WHERE project_id = $1 AND fingerprint = $2 AND adjudication_status = 'rejected'`,
      [projectId, FINGERPRINT],
    );
    expect(rows[0]!.n).toBe(5);
    // This is the production defect stated as the eligibility query itself:
    // all five rejected users are still evidence for the next verdict.
    const eligible = await withClient((c) =>
      countEligibleUsers(c, {
        projectId,
        environmentId,
        fingerprint: FINGERPRINT,
        ruleVersion: RULE_VERSION,
      }),
    );
    expect(eligible).toBe(5);
  });

  it('leaves no rows behind for the tenant after purge', async () => {
    await addUserSessionAndProcess();
    await purge();
    const { rows } = await pool.query<{ table_name: string; n: number }>(
      `SELECT 'friction_signals' AS table_name, count(*)::int AS n
         FROM friction_signals WHERE project_id = $1
       UNION ALL SELECT 'friction_bucket_state', count(*)::int
         FROM friction_bucket_state WHERE project_id = $1
       UNION ALL SELECT 'friction_generation_evidence', count(*)::int
         FROM friction_generation_evidence WHERE project_id = $1
       UNION ALL SELECT 'friction_adjudication_generations', count(*)::int
         FROM friction_adjudication_generations WHERE project_id = $1
       UNION ALL SELECT 'error_group_jobs', count(*)::int
         FROM error_group_jobs WHERE project_id = $1
       UNION ALL SELECT 'error_groups', count(*)::int
         FROM error_groups WHERE project_id = $1
       UNION ALL SELECT 'sessions', count(*)::int
         FROM sessions WHERE project_id = $1
       UNION ALL SELECT 'end_users', count(*)::int
         FROM end_users WHERE project_id = $1
       UNION ALL SELECT 'adjudication_call_budget', count(*)::int
         FROM adjudication_call_budget WHERE project_id = $1`,
      [projectId],
    );
    expect(rows.filter((row) => row.n !== 0)).toEqual([]);
  });
});
