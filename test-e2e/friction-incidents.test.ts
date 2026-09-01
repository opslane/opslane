/**
 * Session narrative pipeline live-service gate.
 *
 * Deterministic chunks travel through ingestion -> MinIO -> scrubber, then the
 * production analysis, narrative, frame capture, signal, and promotion code
 * runs in-process against live PostgreSQL/MinIO. Model traffic goes through an
 * Anthropic-compatible loopback stub, including the image request.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  initSession,
  makeChunksScrubbable,
  seedTenant,
  uploadChunk,
  waitForScrubbedChunks,
  type TestTenant,
} from './helpers.js';

/* Production worker modules are loaded from dist so this proves the same
 * compiled surface the image runs. The worker entrypoint is VITEST-guarded. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerDb: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processSessionAnalysisJob: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processNarration: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processFrameVerification: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NarrativeClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readChunksBounded: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let captureFrames: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getMinIOConfig: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let putFrameObject: any;

async function loadWorkerPipeline(): Promise<void> {
  workerDb = await import('../packages/worker/dist/db.js');
  ({ processSessionAnalysisJob } = await import('../packages/worker/dist/index.js'));
  ({ processNarration } = await import('../packages/worker/dist/narrative/job.js'));
  ({ processFrameVerification } = await import('../packages/worker/dist/narrative/verify.js'));
  ({ NarrativeClient } = await import('../packages/worker/dist/narrative/client.js'));
  ({ readChunksBounded } = await import('../packages/worker/dist/friction/chunk-reader.js'));
  ({ captureFrames } = await import('../packages/worker/dist/narrative/frames/capture.js'));
  ({ getMinIOConfig, putFrameObject } = await import('../packages/worker/dist/minio-client.js'));
}

const RUN_ID = crypto.randomUUID().slice(0, 8);
const PAGE = 'https://app.example.com/assets';

function telemetryClick(at: number, id: string) {
  return {
    type: 5,
    timestamp: at,
    data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: id, selector: 'button.save', cursor: 'pointer', at } },
  };
}

function activeNarrativeChunk(t0: number) {
  return {
    events: [
      { type: 4, timestamp: t0, data: { href: PAGE, width: 1440, height: 900 } },
      { type: 2, timestamp: t0 + 10, data: { node: { id: 1, type: 0, childNodes: [
        { id: 2, type: 2, tagName: 'button', attributes: { class: 'save' }, childNodes: [{ id: 3, type: 3, textContent: 'Save asset' }] },
      ] } } },
      telemetryClick(t0 + 1_000, 'c1'),
      telemetryClick(t0 + 2_000, 'c2'),
      telemetryClick(t0 + 3_000, 'c3'),
      { type: 3, timestamp: t0 + 3_200, data: { source: 0, adds: [{ parentId: 1, node: { id: 9, type: 3, textContent: 'Saved successfully, but Name is required' } }], removes: [], texts: [], attributes: [] } },
    ],
    meta: { sdk_version: 'e2e', has_full_snapshot: true, chunked_at: t0 },
  };
}

async function startModelStub(): Promise<{ server: Server; baseURL: string }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ content?: string | Array<{ type?: string; text?: string }> }>;
    };
    const content = body.messages?.[0]?.content;
    const imageRequest = Array.isArray(content) && content.some((part) => part.type === 'image');
    const userText = typeof content === 'string'
      ? content
      : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    let text: string;
    if (imageRequest) {
      const observationID = /"id":"([^"]+)"/.exec(userText)?.[1] ?? '0-missing';
      text = JSON.stringify({ grades: [{ observationId: observationID, grade: 'confirmed', reason: 'The conflicting save and validation messages are visible.' }] });
    } else {
      const evidenceLine = /^(L\d+) .*UI TEXT APPEARED/m.exec(userText)?.[1] ?? 'L1';
      text = JSON.stringify({
        user_goal: 'Save an asset',
        narrative: 'The user tried to save an asset and received contradictory feedback.',
        observations: [{ category: 'validation_confusion', what: 'A success message appeared alongside a required-field error.', evidence_lines: [evidenceLine], severity: 'high' }],
        notable: true,
      });
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'msg_e2e', type: 'message', role: 'assistant', model: 'e2e-stub',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('model stub did not bind');
  return { server, baseURL: `http://127.0.0.1:${address.port}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claimJob(projectID: string, sessionID: string, jobType: string): Promise<any> {
  const workerID = `e2e-${RUN_ID}`;
  const { rows } = await getPool().query<{
    id: string; lease_generation: string;
  }>(`UPDATE error_group_jobs
      SET status='claimed', worker_id=$4, claimed_at=now(), lease_expires_at=now()+interval '10 minutes',
          lease_generation=lease_generation+1, updated_at=now()
      WHERE id=(SELECT id FROM error_group_jobs
        WHERE project_id=$1 AND session_id=$2 AND job_type=$3 AND status='pending'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, lease_generation::text`, [projectID, sessionID, jobType, workerID]);
  const row = rows[0];
  if (!row) throw new Error(`no ${jobType} job for ${sessionID}`);
  return {
    id: row.id, workerId: workerID, leaseGeneration: row.lease_generation,
    projectId: projectID, sessionId: sessionID, jobType, errorGroupId: null,
    eventId: null, sourceId: null, attempts: 0, maxAttempts: 3, guidance: null, triggeredBy: 'auto',
  };
}

async function finishJob(job: { id: string; workerId: string; leaseGeneration: string }): Promise<void> {
  if (!await workerDb.completeJob(job.id, job.workerId, job.leaseGeneration)) {
    throw new Error(`could not complete ${job.id}`);
  }
}

const describeLive = process.env['DATABASE_URL'] && (process.env['MINIO_ENDPOINT'] || process.env['REPLAY_STORE_ENDPOINT'])
  ? describe
  : describe.skip;

describeLive('session narratives — live-service pipeline', () => {
  let tenant: TestTenant;
  let modelServer: Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let modelClient: any;

  beforeAll(async () => {
    await loadWorkerPipeline();
    tenant = await seedTenant();
    const stub = await startModelStub();
    modelServer = stub.server;
    modelClient = new NarrativeClient({ model: 'e2e-stub', baseURL: stub.baseURL, apiKey: 'e2e', maxTokens: 2048, reasoning: 'off' });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    const db = getPool();
    await db.query(`UPDATE error_groups SET representative_signal_id=NULL WHERE project_id=$1`, [tenant.projectId]);
    await cleanupTenant(tenant.orgId);
    await closePool();
    await workerDb.closePool();
  });

  it('emits verified narrative signals and promotes on the third session', { timeout: 300_000 }, async () => {
    const storage = getMinIOConfig();
    if (!storage) throw new Error('MinIO configuration is required');
    const db = getPool();
    const sessionIDs: string[] = [];

    for (let index = 0; index < 3; index++) {
      const sessionID = `e2e_narrative_${RUN_ID}_${index}`;
      sessionIDs.push(sessionID);
      await initSession(tenant.ingestKey, sessionID, undefined, PAGE);
      await uploadChunk(tenant.ingestKey, sessionID, 0, activeNarrativeChunk(Date.now() - 10_000));
      await makeChunksScrubbable(sessionID);
      await waitForScrubbedChunks(sessionID, 1);
      await db.query(`UPDATE sessions SET status='closed' WHERE id=$1 AND project_id=$2`, [sessionID, tenant.projectId]);
      await db.query(`INSERT INTO error_group_jobs (project_id,session_id,job_type,status,triggered_by)
        VALUES ($1,$2,'session_analysis','pending','auto')`, [tenant.projectId, sessionID]);

      const analysisJob = await claimJob(tenant.projectId, sessionID, 'session_analysis');
      await processSessionAnalysisJob(analysisJob, new AbortController().signal);
      await finishJob(analysisJob);

      const narrateJob = await claimJob(tenant.projectId, sessionID, 'session_narrate');
      await processNarration(narrateJob, {
        client: modelClient,
        loadChunks: async (sid: string, pid: string) => readChunksBounded(await workerDb.getScrubbedChunksForSession(sid, pid)).then((result: { envelopes: unknown[] }) => result.envelopes),
        dailyCap: 2_000, wallClockBudgetMs: 30_000, appContext: '', projectName: 'E2E project',
      }, new AbortController().signal);
      await finishJob(narrateJob);

      const verifyJob = await claimJob(tenant.projectId, sessionID, 'session_verify_frames');
      await processFrameVerification(verifyJob, {
        client: modelClient,
        supported: true,
        loadChunks: async (sid: string, pid: string) => readChunksBounded(await workerDb.getScrubbedChunksForSession(sid, pid)).then((result: { envelopes: unknown[] }) => result.envelopes),
        capture: captureFrames,
        uploadFrame: (objectKey: string, png: Buffer) => putFrameObject(objectKey, png, storage),
        dailyCap: 2_000,
      }, new AbortController().signal);
      await finishJob(verifyJob);
    }

    const narratives = await db.query<{ status: string; verification_state: string }>(
      `SELECT status,verification_state FROM session_narratives WHERE project_id=$1 ORDER BY session_id`, [tenant.projectId]);
    expect(narratives.rows).toHaveLength(3);
    expect(narratives.rows.every((row) => row.status === 'ok' && row.verification_state === 'ok')).toBe(true);

    const signals = await db.query<{ signal_type: string; rule_version: number; observation_text: string | null }>(
      `SELECT signal_type,rule_version,observation_text FROM friction_signals
       WHERE project_id=$1 AND session_id=ANY($2::text[]) ORDER BY session_id`, [tenant.projectId, sessionIDs]);
    expect(signals.rows).toHaveLength(3);
    expect(signals.rows.every((row) => row.signal_type === 'validation_confusion' && row.rule_version === 6 && row.observation_text !== null)).toBe(true);

    const incident = await db.query<{ id: string; status: string }>(
      `SELECT id,status FROM error_groups WHERE project_id=$1 AND kind='friction' AND status<>'candidate'`, [tenant.projectId]);
    expect(incident.rows).toHaveLength(1);
    expect(incident.rows[0]!.status).toBe('queued');

    const { ingestionUrl } = getConfig();
    const response = await fetch(`${ingestionUrl}/api/v1/projects/${tenant.projectId}/sessions/${sessionIDs[0]}/narrative`, {
      headers: { Authorization: `Bearer ${tenant.userSession}` },
    });
    expect(response.status).toBe(200);
    const narrative = await response.json() as { observations: Array<{ category: string; grade?: string }> };
    expect(narrative.observations[0]).toMatchObject({ category: 'validation_confusion', grade: 'confirmed' });

    const frames = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM session_narratives,
       LATERAL jsonb_array_elements(verification->'frames') frame
       WHERE project_id=$1`, [tenant.projectId]);
    expect(Number(frames.rows[0]!.n)).toBeGreaterThan(0);
  });
});
