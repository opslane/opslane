/**
 * Batch 4 synthetic live-service gate (issue #56).
 *
 * SYNTHETIC coverage: deterministic gzipped rrweb/telemetry chunks travel the
 * REAL ingestion → MinIO → scrubber path, then the PRODUCTION session-analysis
 * pipeline (chunk read → analyzer → persistence → adjudication orchestration)
 * runs IN-PROCESS with an injected deterministic adjudicator against the live
 * PostgreSQL/MinIO state.
 *
 * This proves storage and orchestration logic. It deliberately does NOT claim
 * to test the running worker's poller/dispatcher — that is the separately
 * recorded manual browser dogfood in the Batch 4 evidence contract.
 *
 * Requires the compose stack (postgres, minio, ingestion) plus env:
 *   DATABASE_URL, INGESTION_URL, MINIO_ENDPOINT (host-reachable),
 *   MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getConfig,
  getPool,
  closePool,
  seedTenant,
  seedEnvironment,
  initSession,
  uploadChunk,
  makeChunksScrubbable,
  waitForScrubbedChunks,
  cleanupTenant,
  type TestTenant,
} from './helpers.js';
// Production worker pipeline, loaded from the built package inside beforeAll
// (dynamic so environments that skip this suite never need worker/dist; the
// worker entrypoint is VITEST-guarded, so importing never boots the poller).
/* eslint-disable @typescript-eslint/no-explicit-any */
let workerDb: any;
let readChunksBounded: any;
let analyzeSession: any;
let RULE_VERSION: number;
let writeFrictionSignals: any;
let processFrictionOutcomes: any;

async function loadWorkerPipeline(): Promise<void> {
  workerDb = await import('../packages/worker/dist/db.js');
  ({ readChunksBounded } = await import('../packages/worker/dist/friction/chunk-reader.js'));
  ({ analyzeSession, RULE_VERSION } = await import('../packages/worker/dist/friction/analyzer.js'));
  ({ writeFrictionSignals } = await import('../packages/worker/dist/friction/persist.js'));
  ({ processFrictionOutcomes } = await import('../packages/worker/dist/friction/promotion.js'));
}

const RUN_ID = crypto.randomUUID().slice(0, 8);
const PAGE = 'https://app.example.com/checkout';

const stubAdjudicator = {
  modelId: 'e2e-deterministic-stub',
  promptVersion: 1,
  adjudicate: async () => ({ accepted: true, reason: 'e2e deterministic accept' }),
};

function telemetryClick(at: number, clickId: string, selector: string) {
  return {
    type: 5,
    timestamp: at,
    data: {
      tag: 'opslane.telemetry',
      payload: { kind: 'click', clickId, selector, cursor: 'pointer', at },
    },
  };
}

/** Three unanswered clicks on one selector inside 1s gaps → one rage_click. */
function rageChunk(t0: number, selector = `#buy-now-${RUN_ID}`) {
  return {
    events: [
      { type: 4, timestamp: t0 - 50, data: { href: PAGE, width: 1280, height: 720 } },
      { type: 2, timestamp: t0 - 50, data: {} },
      telemetryClick(t0, 'c1', selector),
      telemetryClick(t0 + 300, 'c2', selector),
      telemetryClick(t0 + 600, 'c3', selector),
    ],
    meta: { sdk_version: 'e2e', has_full_snapshot: true, chunked_at: t0 },
  };
}

/** A stepper: every click answered by a request within the response window. */
function stepperChunk(t0: number) {
  const selector = `#stepper-${RUN_ID}`;
  const events: unknown[] = [
    { type: 4, timestamp: t0 - 50, data: { href: PAGE, width: 1280, height: 720 } },
    { type: 2, timestamp: t0 - 50, data: {} },
  ];
  for (let i = 0; i < 3; i++) {
    const at = t0 + i * 300;
    events.push(telemetryClick(at, `s${i}`, selector));
    events.push({
      type: 5,
      timestamp: at + 50,
      data: {
        tag: 'opslane.telemetry',
        payload: {
          kind: 'request_start',
          requestId: `r${i}`,
          clickId: `s${i}`,
          method: 'POST',
          url: `${PAGE}/step`,
          at: at + 50,
        },
      },
    });
  }
  return { events, meta: { sdk_version: 'e2e', has_full_snapshot: true, chunked_at: t0 } };
}

/** Runs the production analysis pipeline in-process for one session. */
async function analyzeSessionInProcess(sessionId: string, projectId: string): Promise<void> {
  const db = getPool();
  const jobRes = await db.query<{ id: string }>(
    `INSERT INTO error_group_jobs (project_id, status, job_type, session_id)
     VALUES ($1, 'claimed', 'session_analysis', $2) RETURNING id`,
    [projectId, sessionId]
  );
  const session = await workerDb.getSessionForAnalysis(sessionId, projectId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const chunks = await workerDb.getScrubbedChunksForSession(sessionId, projectId);
  const read = await readChunksBounded(chunks);
  const signals = analyzeSession(read.envelopes);
  await writeFrictionSignals(session, signals, RULE_VERSION);
  await processFrictionOutcomes(session, jobRes.rows[0]!.id, stubAdjudicator);
}

async function driveRageSession(
  apiKey: string,
  projectId: string,
  userId: string,
  opts: { selector?: string; environment?: string } = {}
): Promise<string> {
  const sessionId = `e2e_fr_${RUN_ID}_${crypto.randomUUID().slice(0, 8)}`;
  await initSession(apiKey, sessionId, { id: userId }, PAGE, opts.environment);
  await uploadChunk(apiKey, sessionId, 0, rageChunk(Date.now() - 5_000, opts.selector));
  await makeChunksScrubbable(sessionId);
  await waitForScrubbedChunks(sessionId, 1);
  await analyzeSessionInProcess(sessionId, projectId);
  return sessionId;
}

const describeLive = process.env['DATABASE_URL'] && process.env['MINIO_ENDPOINT']
  ? describe
  : describe.skip;

describeLive('friction incidents — synthetic live-service gate', () => {
  let tenant: TestTenant;
  let staging: { environmentId: string; apiKey: string };

  beforeAll(async () => {
    await loadWorkerPipeline();
    tenant = await seedTenant();
    staging = await seedEnvironment(tenant.projectId, 'staging');
  });

  afterAll(async () => {
    const db = getPool();
    await db.query(
      `UPDATE friction_adjudication_generations SET representative_signal_id = NULL WHERE project_id = $1`,
      [tenant.projectId]
    );
    await db.query(
      `UPDATE error_groups SET representative_signal_id = NULL WHERE project_id = $1`,
      [tenant.projectId]
    );
    await db.query(`DELETE FROM friction_signals WHERE project_id = $1`, [tenant.projectId]);
    await db.query(`DELETE FROM friction_adjudication_generations WHERE project_id = $1`, [tenant.projectId]);
    await db.query(
      `DELETE FROM error_group_affected_users WHERE error_group_id IN
         (SELECT id FROM error_groups WHERE project_id = $1)`,
      [tenant.projectId]
    );
    await db.query(`DELETE FROM session_chunks WHERE project_id = $1`, [tenant.projectId]);
    await db.query(`DELETE FROM sessions WHERE project_id = $1`, [tenant.projectId]);
    await cleanupTenant(tenant.orgId);
    await closePool();
    await workerDb.closePool();
  });

  it(
    'four users stay invisible; the fifth promotes exactly one friction incident',
    { timeout: 240_000 },
    async () => {
      for (let i = 1; i <= 4; i++) {
        await driveRageSession(tenant.apiKey, tenant.projectId, `batch4-user-${i}`);
      }

      // Positive-scope negative proof: no published friction incident.
      const db = getPool();
      const before = await db.query(
        `SELECT id FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status <> 'candidate'`,
        [tenant.projectId]
      );
      expect(before.rows).toHaveLength(0);
      // The hidden candidate exists but carries zero impact.
      const candidate = await db.query<{ occurrence_count: number; affected_users_count: number }>(
        `SELECT occurrence_count, affected_users_count FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status = 'candidate'`,
        [tenant.projectId]
      );
      expect(candidate.rows).toHaveLength(1);
      expect(candidate.rows[0]!.occurrence_count).toBe(0);
      expect(candidate.rows[0]!.affected_users_count).toBe(0);

      // Fifth user crosses the threshold.
      await driveRageSession(tenant.apiKey, tenant.projectId, `batch4-user-5`);

      const after = await db.query<{
        id: string;
        status: string;
        occurrence_count: number;
        affected_users_count: number;
        environment_id: string;
        pr_url: string | null;
        pr_number: number | null;
      }>(
        `SELECT id, status, occurrence_count, affected_users_count, environment_id, pr_url, pr_number
         FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status <> 'candidate'`,
        [tenant.projectId]
      );
      expect(after.rows).toHaveLength(1);
      const incident = after.rows[0]!;
      expect(incident.status).toBe('queued');
      expect(incident.occurrence_count).toBe(5);
      expect(incident.affected_users_count).toBe(5);
      expect(incident.environment_id).toBe(tenant.environmentId);
      expect(incident.pr_url).toBeNull();
      expect(incident.pr_number).toBeNull();

      // Exactly one investigate job; never a fix job (auto-fix gate).
      const jobs = await db.query<{ job_type: string; n: string }>(
        `SELECT job_type, count(*)::text AS n FROM error_group_jobs
         WHERE error_group_id = $1 GROUP BY job_type`,
        [incident.id]
      );
      expect(jobs.rows).toEqual([{ job_type: 'investigate', n: '1' }]);

      // Every promoted session is pinned to the exact 90-day horizon.
      const pins = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sessions s
         JOIN friction_signals fs ON fs.session_id = s.id
         WHERE fs.incident_id = $1
           AND s.retain_until = s.started_at + interval '90 days'`,
        [incident.id]
      );
      expect(Number(pins.rows[0]!.n)).toBe(5);

      // The read API returns the incident with kind and hides the path here:
      // an ordinary candidate UUID 404s (checked in the staging test below).
      const { ingestionUrl } = getConfig();
      const listRes = await fetch(
        `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents`,
        { headers: { Authorization: `Bearer ${tenant.sessionToken}` } }
      );
      expect(listRes.status).toBe(200);
      const incidents = (await listRes.json()) as Array<{ id: string; kind: string }>;
      const found = incidents.find((i) => i.id === incident.id);
      expect(found?.kind).toBe('friction');
    }
  );

  it(
    'environments never combine: staging needs its own five users',
    { timeout: 240_000 },
    async () => {
      const db = getPool();
      const prodIncident = await db.query<{ id: string; affected_users_count: number }>(
        `SELECT id, affected_users_count FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status <> 'candidate'`,
        [tenant.projectId]
      );

      // Two staging users: same fingerprint, no promotion, production untouched.
      for (let i = 1; i <= 2; i++) {
        await driveRageSession(staging.apiKey, tenant.projectId, `batch4-staging-${i}`, {
          environment: 'staging',
        });
      }
      const between = await db.query<{ id: string; affected_users_count: number }>(
        `SELECT id, affected_users_count FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status <> 'candidate'`,
        [tenant.projectId]
      );
      expect(between.rows).toHaveLength(1);
      expect(between.rows[0]!.affected_users_count).toBe(
        prodIncident.rows[0]!.affected_users_count
      );

      // The staging candidate is hidden: its detail endpoint 404s.
      const stagingCandidate = await db.query<{ id: string }>(
        `SELECT id FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status = 'candidate'
           AND environment_id = $2`,
        [tenant.projectId, staging.environmentId]
      );
      expect(stagingCandidate.rows).toHaveLength(1);
      const { ingestionUrl } = getConfig();
      const detail = await fetch(
        `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents/${stagingCandidate.rows[0]!.id}`,
        { headers: { Authorization: `Bearer ${tenant.sessionToken}` } }
      );
      expect(detail.status).toBe(404);

      // Three more staging users promote a second, environment-distinct incident.
      for (let i = 3; i <= 5; i++) {
        await driveRageSession(staging.apiKey, tenant.projectId, `batch4-staging-${i}`, {
          environment: 'staging',
        });
      }
      const finalRows = await db.query<{ environment_id: string; affected_users_count: number }>(
        `SELECT environment_id, affected_users_count FROM error_groups
         WHERE project_id = $1 AND kind = 'friction' AND status <> 'candidate'
         ORDER BY created_at`,
        [tenant.projectId]
      );
      expect(finalRows.rows).toHaveLength(2);
      expect(finalRows.rows.map((r) => r.environment_id).sort()).toEqual(
        [tenant.environmentId, staging.environmentId].sort()
      );
      for (const row of finalRows.rows) expect(row.affected_users_count).toBe(5);
    }
  );

  it(
    'a signal inside ±30s of a same-session error folds instead of promoting',
    { timeout: 120_000 },
    async () => {
      const { ingestionUrl } = getConfig();
      const db = getPool();
      const selector = `#fold-target-${RUN_ID}`;
      const sessionId = `e2e_fold_${RUN_ID}`;
      const t0 = Date.now() - 60_000;

      await initSession(tenant.apiKey, sessionId, { id: 'batch4-fold-user' }, PAGE);
      // Error 10 seconds after the rage click, same session, client timestamp.
      const errorRes = await fetch(`${ingestionUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.apiKey },
        body: JSON.stringify({
          timestamp: new Date(t0 + 10_600).toISOString(),
          error: { type: 'TypeError', message: `fold-me-${RUN_ID}`, stack: 'at a (src/a.ts:1:1)' },
          session_id: sessionId,
        }),
      });
      expect(errorRes.status).toBe(202);
      const errorBody = (await errorRes.json()) as { error_group_id: string };

      await uploadChunk(tenant.apiKey, sessionId, 0, rageChunk(t0, selector));
      await makeChunksScrubbable(sessionId);
      await waitForScrubbedChunks(sessionId, 1);
      await analyzeSessionInProcess(sessionId, tenant.projectId);

      const signal = await db.query<{
        adjudication_status: string;
        adjudication_scope: string;
        incident_id: string;
      }>(
        `SELECT adjudication_status, adjudication_scope, incident_id
         FROM friction_signals
         WHERE project_id = $1 AND session_id = $2`,
        [tenant.projectId, sessionId]
      );
      expect(signal.rows).toHaveLength(1);
      expect(signal.rows[0]!.adjudication_status).toBe('accepted');
      expect(signal.rows[0]!.adjudication_scope).toBe('fold');
      expect(signal.rows[0]!.incident_id).toBe(errorBody.error_group_id);

      // Folding never creates a friction incident for this fingerprint.
      const standalone = await db.query(
        `SELECT id FROM error_groups
         WHERE project_id = $1 AND kind = 'friction'
           AND fingerprint LIKE '%' || $2 || '%'`,
        [tenant.projectId, selector]
      );
      expect(standalone.rows).toHaveLength(0);

      // The fold pinned the session to the 90-day evidence horizon.
      const pin = await db.query<{ pinned: boolean }>(
        `SELECT retain_until = started_at + interval '90 days' AS pinned
         FROM sessions WHERE id = $1`,
        [sessionId]
      );
      expect(pin.rows[0]!.pinned).toBe(true);
    }
  );

  it(
    'an error outside the ±30s window does not fold',
    { timeout: 120_000 },
    async () => {
      const { ingestionUrl } = getConfig();
      const db = getPool();
      const selector = `#no-fold-${RUN_ID}`;
      const sessionId = `e2e_nofold_${RUN_ID}`;
      const t0 = Date.now() - 120_000;

      await initSession(tenant.apiKey, sessionId, { id: 'batch4-nofold-user' }, PAGE);
      await fetch(`${ingestionUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.apiKey },
        body: JSON.stringify({
          timestamp: new Date(t0 + 45_000).toISOString(),
          error: { type: 'TypeError', message: `too-far-${RUN_ID}`, stack: 'at a (src/a.ts:1:1)' },
          session_id: sessionId,
        }),
      });
      await uploadChunk(tenant.apiKey, sessionId, 0, rageChunk(t0, selector));
      await makeChunksScrubbable(sessionId);
      await waitForScrubbedChunks(sessionId, 1);
      await analyzeSessionInProcess(sessionId, tenant.projectId);

      const signal = await db.query<{ adjudication_status: string; incident_id: string | null }>(
        `SELECT adjudication_status, incident_id FROM friction_signals
         WHERE project_id = $1 AND session_id = $2`,
        [tenant.projectId, sessionId]
      );
      expect(signal.rows).toHaveLength(1);
      // Below the five-user threshold, the signal stays pending and unattached.
      expect(signal.rows[0]!.adjudication_status).toBe('pending');
      expect(signal.rows[0]!.incident_id).toBeNull();
    }
  );

  it('the stepper fixture produces no signal and no incident', { timeout: 120_000 }, async () => {
    const db = getPool();
    const sessionId = `e2e_stepper_${RUN_ID}`;
    await initSession(tenant.apiKey, sessionId, { id: 'batch4-stepper-user' }, PAGE);
    await uploadChunk(tenant.apiKey, sessionId, 0, stepperChunk(Date.now() - 5_000));
    await makeChunksScrubbable(sessionId);
    await waitForScrubbedChunks(sessionId, 1);
    await analyzeSessionInProcess(sessionId, tenant.projectId);

    const signals = await db.query(
      `SELECT id FROM friction_signals WHERE project_id = $1 AND session_id = $2`,
      [tenant.projectId, sessionId]
    );
    expect(signals.rows).toHaveLength(0);
  });
});
