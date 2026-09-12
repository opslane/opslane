/** Real SDK recordings through compiled worker handlers and Go publication/purge. */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import type { ClaimedJob } from '../packages/worker/dist/db.js';
import type { DigestCandidate } from '../packages/worker/dist/digest-writer/job.js';
import type { NarrativeModelResult } from '../packages/worker/dist/narrative/client.js';
import { cleanupTenant, closePool, getConfig, getPool, listIncidents,
  makeChunksScrubbable, seedTenant, waitForScrubbedChunks, type TestTenant } from './helpers.js';
import { startFixture, type FixtureServer } from './browser-helpers.js';

const exec = promisify(execFile);
const ROOT = resolve(__dirname, '..');
const FIXTURE = resolve(ROOT, 'test-fixtures/vue-app');
const SOURCE_FILE = 'src/components/FrictionLab.vue';
const RUN_ID = crypto.randomUUID().slice(0, 8);
const signal = new AbortController().signal;

async function loadPipeline() {
  const [db, entry, narrate, verify, client, chunks, frames, storage, match, confirm, investigate, tickets, writer, embeddings] = await Promise.all([
    import('../packages/worker/dist/db.js'), import('../packages/worker/dist/index.js'),
    import('../packages/worker/dist/narrative/job.js'), import('../packages/worker/dist/narrative/verify.js'),
    import('../packages/worker/dist/narrative/client.js'), import('../packages/worker/dist/friction/chunk-reader.js'),
    import('../packages/worker/dist/narrative/frames/capture.js'), import('../packages/worker/dist/minio-client.js'),
    import('../packages/worker/dist/friction/match-job.js'), import('../packages/worker/dist/friction/confirm-job.js'),
    import('../packages/worker/dist/friction/investigate-ticket.js'), import('../packages/worker/dist/friction/tickets-db.js'),
    import('../packages/worker/dist/digest-writer/job.js'), import('../packages/worker/dist/embeddings.js'),
  ]);
  return { db, entry, narrate, verify, client, chunks, frames, storage, match, confirm, investigate, tickets, writer, embeddings };
}
type Pipeline = Awaited<ReturnType<typeof loadPipeline>>;

async function goHelper(project: string, mode: string, args: string[] = []): Promise<unknown> {
  const { stdout } = await exec('go', ['run', '../../test-e2e/known-problems-helper.go', '-mode', mode, '-project', project, ...args], {
    cwd: resolve(ROOT, 'packages/ingestion'),
    env: { ...process.env, DASHBOARD_URL: 'https://dashboard.example.test',
      JWT_SECRET: process.env['JWT_SECRET'] ?? 'opslane-dev-jwt-secret-key-minimum-32-bytes-long' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}
function modelResult(value: unknown): NarrativeModelResult {
  return { text: JSON.stringify(value), inputTokens: 10, outputTokens: 10,
    cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn' };
}
function block<T>(user: string, name: string): T {
  const content = user.split(`${name}_START\n`)[1]?.split(`\n${name}_END`)[0];
  if (content === undefined) throw new Error(`missing model input ${name}`);
  return JSON.parse(content.replace(/^<untrusted_data>\n/, '').replace(/\n<\/untrusted_data>$/, '')) as T;
}

/** Claim only the real pending job produced by the preceding stage. */
async function claim(project: string, jobType: ClaimedJob['jobType'], sessionId: string | null, ticketId: string | null = null): Promise<ClaimedJob> {
  const result = await getPool().query<ClaimedJob>(`UPDATE error_group_jobs
    SET status='claimed',worker_id=$5,claimed_at=now(),lease_expires_at=now()+interval '10 minutes',
        lease_generation=lease_generation+1,updated_at=now()
    WHERE id=(SELECT id FROM error_group_jobs WHERE project_id=$1 AND job_type=$2
      AND session_id IS NOT DISTINCT FROM $3::text AND ticket_id IS NOT DISTINCT FROM $4::uuid
      AND status='pending' AND available_at<=clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,project_id AS "projectId",error_group_id AS "errorGroupId",session_id AS "sessionId",
      ticket_id AS "ticketId",publication_generation AS "publicationGeneration",batch_id AS "batchId",
      event_id AS "eventId",source_id AS "sourceId",job_type AS "jobType",attempts,max_attempts AS "maxAttempts",
      guidance,triggered_by AS "triggeredBy",worker_id AS "workerId",lease_generation::text AS "leaseGeneration",payload`,
  [project, jobType, sessionId, ticketId, `known-problems-smoke-${RUN_ID}`]);
  if (!result.rows[0]) throw new Error(`no pending ${jobType} job for ${sessionId ?? ticketId}; stop all worker containers before this smoke`);
  return result.rows[0];
}
async function runJob(p: Pipeline, job: ClaimedJob, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    if (!await p.db.completeJob(job.id, job.workerId, job.leaseGeneration)) throw new Error(`completion rejected for ${job.id}`);
  } catch (error) {
    if (!(error instanceof p.db.JobCompletedInTransaction)) throw error;
  }
  expect((await getPool().query<{ status: string }>('SELECT status FROM error_group_jobs WHERE id=$1', [job.id])).rows[0]?.status).toBe('completed');
}

const describeLive = process.env['DATABASE_URL'] && (process.env['MINIO_ENDPOINT'] || process.env['REPLAY_STORE_ENDPOINT']) ? describe : describe.skip;
describeLive('known problems — real recording pipeline', () => {
  let p: Pipeline;
  let tenant: TestTenant;
  let fixture: FixtureServer;
  let browser: Browser;
  let server: Server;
  let narrativeClient: InstanceType<Pipeline['client']['NarrativeClient']>;
  let problem: 'purchase' | 'stepper' = 'purchase';
  const dimensions: number[][] = [];
  const purchase = { name: 'Complete purchase leaves checkout unchanged', control: 'Complete purchase',
    what_happened: 'Clicking Complete purchase repeatedly leaves checkout unchanged.',
    steps: 'Open checkout and click Complete purchase.', kind: 'defect' as const };
  const stepper = { name: 'Advancing the stepper requires repeated clicks', control: 'Next step',
    what_happened: 'Advancing the stepper requires repeated Next step clicks.',
    steps: 'Open the stepper and click Next step repeatedly.', kind: 'ux_insight' as const };

  beforeAll(async () => {
    if (process.env['E2E_IN_PROCESS_WORKER'] !== '1') throw new Error('Stop the worker container and set E2E_IN_PROCESS_WORKER=1 for the known-problems smoke.');
    p = await loadPipeline();
    tenant = await seedTenant();
    const vue = (await import('@vitejs/plugin-vue')).default;
    fixture = await startFixture({ fixtureDir: FIXTURE, apiKey: tenant.ingestKey,
      ingestionUrl: getConfig().ingestionUrl, environment: 'production', entryPattern: /\/main\.ts$/,
      plugins: [vue(), { name: 'expose-sdk-flush', transform(code, id) {
        if (!/\/main\.ts$/.test(id)) return;
        return `${code}\nimport { flushReplayBufferForError as smokeFlush } from '@opslane/sdk/_replay';\nObject.assign(window, { __opslaneSmokeFlush: smokeFlush });`;
      } }],
    });
    browser = await (await import('@playwright/test')).chromium.launch();
    server = createServer(async (request, response) => {
      try {
        const buffers: Buffer[] = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as {
          messages: Array<{ content: string | Array<{ type: string; text?: string; source?: { data: string } }> }>;
        };
        const content = body.messages[0].content;
        const images = typeof content === 'string' ? [] : content.filter(part => part.type === 'image');
        const user = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('\n');
        let value: unknown;
        if (images.length) {
          for (const image of images) {
            const png = Buffer.from(image.source!.data, 'base64');
            dimensions.push([png.readUInt32BE(16), png.readUInt32BE(20)]);
          }
          value = { grades: block<Array<{ id: string }>>(user, 'OBSERVATIONS').map(o => ({ observationId: o.id,
            grade: 'confirmed', reason: 'The recorded control and result are visible.' })) };
        } else {
          const target = problem === 'purchase' ? 'complete-purchase' : 'friction-stepper-next';
          const line = user.split('\n').find(text => /^L\d+ /.test(text) && /CLICK/.test(text) && text.includes(target));
          if (!line) throw new Error(`real recording contains no ${target} click`);
          value = { user_goal: problem === 'purchase' ? 'Complete a purchase' : 'Advance the stepper',
            narrative: (problem === 'purchase' ? purchase : stepper).what_happened,
            observations: [{ what: (problem === 'purchase' ? purchase : stepper).what_happened,
              evidence_lines: [line.split(' ')[0]] }], notable: true };
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'msg_smoke', type: 'message', role: 'assistant', model: 'e2e-stub',
          content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 } }));
      } catch (error) {
        response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('model stub failed to bind');
    narrativeClient = new p.client.NarrativeClient({ model: 'e2e-stub', apiKey: 'e2e',
      baseURL: `http://127.0.0.1:${address.port}`, maxTokens: 2048, reasoning: 'off' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fixture?.close();
    if (server) await new Promise<void>(done => server.close(() => done()));
    if (tenant) {
      const sessions = await getPool().query<{ id: string }>('SELECT id FROM sessions WHERE project_id=$1', [tenant.projectId]);
      for (const { id } of sessions.rows) {
        await getPool().query("UPDATE sessions SET started_at=now()-interval '91 days' WHERE id=$1 AND project_id=$2", [id, tenant.projectId]);
        await goHelper(tenant.projectId, 'purge', ['-session', id]);
      }
      await getPool().query('DELETE FROM friction_investigation_results WHERE ticket_id IN (SELECT id FROM friction_tickets WHERE project_id=$1)', [tenant.projectId]);
      await cleanupTenant(tenant.orgId);
    }
    await closePool();
    await p?.db.closePool();
  }, 120_000);

  async function recordAndMatch(index: number): Promise<string> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let sessionId = '';
    try {
      await page.goto(fixture.url);
      await page.waitForFunction(() => (window as unknown as { __opslaneReplayReady?: boolean }).__opslaneReplayReady === true);
      await page.click('[data-testid="nav-friction"]');
      await page.selectOption('[data-testid="friction-user-select"]', `batch4-user-${index + 1}`);
      await page.click('[data-testid="friction-user-apply"]');
      await expect.poll(async () => {
        const result = await getPool().query<{ id: string }>(`SELECT s.id FROM sessions s JOIN end_users u ON u.id=s.end_user_id
          WHERE s.project_id=$1 AND u.external_user_id=$2 ORDER BY s.started_at DESC LIMIT 1`, [tenant.projectId, `batch4-user-${index + 1}`]);
        sessionId = result.rows[0]?.id ?? '';
        return sessionId;
      }, { timeout: 30_000 }).not.toBe('');
      const target = problem === 'purchase' ? '#complete-purchase' : '[data-testid="friction-stepper-next"]';
      for (let click = 0; click < 5; click++) await page.click(target);
      await page.evaluate(() => (window as unknown as { __opslaneSmokeFlush(): void }).__opslaneSmokeFlush());
      await expect.poll(async () => Number((await getPool().query<{ n: string }>(
        'SELECT count(*)::text AS n FROM session_chunks WHERE session_id=$1 AND uploaded_at IS NOT NULL', [sessionId])).rows[0].n), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
    await getPool().query("UPDATE sessions SET status='closed' WHERE id=$1 AND project_id=$2", [sessionId, tenant.projectId]);
    await makeChunksScrubbable(sessionId);
    const count = Number((await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM session_chunks WHERE session_id=$1', [sessionId])).rows[0].n);
    await waitForScrubbedChunks(sessionId, count);
    const analysis = await claim(tenant.projectId, 'session_analysis', sessionId);
    await runJob(p, analysis, () => p.entry.processSessionAnalysisJob({ ...analysis, sessionId }, signal));
    const loadChunks = async (sid: string, pid: string) => (await p.chunks.readChunksBounded(await p.db.getScrubbedChunksForSession(sid, pid))).envelopes;
    const narrate = await claim(tenant.projectId, 'session_narrate', sessionId);
    await runJob(p, narrate, () => p.narrate.processNarration({ ...narrate, sessionId }, {
      client: narrativeClient, loadChunks, dailyCap: 2000, wallClockBudgetMs: 30_000, appContext: '', projectName: 'Known problems smoke',
    }, signal));
    const storage = p.storage.getMinIOConfig();
    if (!storage) throw new Error('MinIO configuration required');
    const verify = await claim(tenant.projectId, 'session_verify_frames', sessionId);
    await runJob(p, verify, () => p.verify.processFrameVerification({ ...verify, sessionId }, {
      client: narrativeClient, loadChunks, supported: true, capture: p.frames.captureFrames,
      uploadFrame: (key, png) => p.storage.putFrameObject(key, png, storage), dailyCap: 2000,
    }, signal));
    const match = await claim(tenant.projectId, 'friction_match', sessionId);
    await runJob(p, match, () => p.match.processFrictionMatch({ ...match, sessionId }, {
      cheap: { modelName: 'e2e-stub', complete: async ({ user }) => {
        const observations = block<Array<{ id: string; what: string }>>(user, 'OBSERVATIONS');
        const candidates = block<Array<{ id: string; control: string }>>(user, 'CANDIDATES');
        const definition = problem === 'purchase' ? purchase : stepper;
        const same = candidates.find(candidate => candidate.control === definition.control);
        return modelResult({ decisions: observations.map(o => same
          ? { kind: 'matched', observation_id: o.id, ticket_id: same.id }
          : { kind: 'draft', observation_id: o.id, draft: { name: definition.name, control: definition.control, steps: definition.steps } }) });
      } },
      strong: { modelName: 'e2e-stub', complete: async ({ user }) => modelResult({
        decisions: block<Array<{ observationId: string }>>(user, 'DRAFTS').map(draft => ({
          kind: 'create', observation_id: draft.observationId, ticket: problem === 'purchase' ? purchase : stepper,
        })),
      }) },
      embed: async () => { throw new p.embeddings.EmbeddingsUnavailable('Deterministic smoke uses route shortlists.'); },
    }, signal));
    return sessionId;
  }

  it('publishes only confirmed problems with a covering cause and archives after recording purge', { timeout: 600_000 }, async () => {
    const recordings: string[] = [];
    for (let i = 0; i < 3; i++) recordings.push(await recordAndMatch(i));
    const db = getPool();
    const tickets = await db.query<{ id: string; status: string; matched_count: number }>('SELECT id,status,matched_count FROM friction_tickets WHERE project_id=$1', [tenant.projectId]);
    expect(tickets.rows).toHaveLength(1);
    expect(tickets.rows[0]).toMatchObject({ status: 'tracking', matched_count: 3 });
    const ticketId = tickets.rows[0].id;
    expect((await db.query("SELECT id FROM error_group_jobs WHERE ticket_id=$1 AND job_type='friction_confirm' AND status='pending'", [ticketId])).rows).toHaveLength(1);
    const confirm = await claim(tenant.projectId, 'friction_confirm', null, ticketId);
    let confirmationReads = 0;
    await runJob(p, confirm, () => p.confirm.processFrictionConfirm({ ...confirm, ticketId }, {
      ...p.confirm.frictionConfirmDepsFromEnv(), dailyCap: 2000,
      client: { modelName: 'e2e-stub', complete: async ({ user, images }) => {
        expect(images?.length).toBeGreaterThan(0);
        confirmationReads++;
        const signals = block<Array<{ id: string }>>(user, 'SIGNALS');
        const timeline = user.split('TIMELINE_START\n')[1].split('\nTIMELINE_END')[0];
        const click = timeline.split('\n').find(text => /^L\d+:/.test(text) && text.includes('CLICK') && text.includes('complete-purchase'));
        const line = click?.split(':')[0];
        if (!line) throw new Error('confirmation timeline has no purchase click');
        return modelResult({ outcome: 'confirmed', signalIds: signals.map(s => s.id), evidenceLines: [line],
          note: 'The user clicks Complete purchase repeatedly and checkout stays unchanged.', costToUser: 'lost_time' });
      } },
    }, signal));
    expect(confirmationReads).toBe(3);
    const live = await db.query<{ id: string; publication_generation: number; investigation_status: string }>(
      'SELECT id,publication_generation,investigation_status FROM error_groups WHERE ticket_id=$1', [ticketId]);
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0]).toMatchObject({ publication_generation: 1, investigation_status: 'pending' });
    const groupId = live.rows[0].id;
    const evidence = await db.query<{ signal_id: string }>('SELECT signal_id FROM friction_incident_evidence WHERE error_group_id=$1', [groupId]);
    expect(evidence.rows).toHaveLength(3);
    const before = await goHelper(tenant.projectId, 'freeze', ['-at', new Date().toISOString()]) as { candidates: DigestCandidate[] };
    expect(before.candidates.some(c => c.ticketId === ticketId)).toBe(false);
    const investigation = await claim(tenant.projectId, 'investigate', null, ticketId);
    const group = await p.db.getErrorGroup(groupId, tenant.projectId);
    if (!group) throw new Error('published group missing');
    const source = await readFile(resolve(FIXTURE, SOURCE_FILE), 'utf8');
    expect(source).toContain('function deadClick');
    await runJob(p, investigation, () => p.investigate.processTicketInvestigation({ ...investigation,
      ticketId, errorGroupId: groupId, publicationGeneration: 1 }, group, signal, {
      apiKey: 'e2e', checkout: async () => ({ headSha: 'a'.repeat(40), tree: SOURCE_FILE, close: async () => {},
        reader: { readFile: async path => { if (path !== SOURCE_FILE) throw new Error('unknown fixture path'); return source; },
          grep: async () => source, list: async () => SOURCE_FILE, exists: async paths => paths.filter(path => path === SOURCE_FILE) } }),
      investigate: async (_key, input) => {
        expect(new Set(input.confirmedSignalIds)).toEqual(new Set(evidence.rows.map(row => row.signal_id)));
        const ids = input.confirmedSignalIds!;
        return { status: 'verdict', investigatedCommit: input.investigatedCommit, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
          verdict: { codeCause: true, explains: ids.slice(0, 2), doesNotExplain: ids.slice(2), confidence: 'high',
            reason: 'The purchase click handler has an empty body.', agentTaskBrief: 'Connect the purchase button to checkout submission and show the result.',
            evidence: [{ path: SOURCE_FILE, detail: 'deadClick has an empty body.', symptomLink: 'Clicking the purchase control cannot submit checkout.' }] } };
      },
    }));
    expect((await db.query<{ investigation_status: string; n: number }>(
      'SELECT investigation_status,jsonb_array_length(explained_signal_ids) AS n FROM error_groups WHERE id=$1', [groupId])).rows[0])
      .toEqual({ investigation_status: 'done', n: 2 });
    // A run is immutable per project/day. The next day's freeze observes the verdict.
    const after = await goHelper(tenant.projectId, 'freeze', ['-at', new Date(Date.now() + 86_400_000).toISOString()]) as { runId: string; candidates: DigestCandidate[] };
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0]).toMatchObject({ ticketId, generation: 1, verifiedUsers: 3, verifiedSessions: 3 });
    expect(after.candidates[0].coverage).toBeCloseTo(2 / 3);
    await p.writer.writeDigest(after.runId, tenant.projectId, {
      loadRun: p.writer.loadFrozenDigestRun, persist: p.writer.persistWrittenDigest,
      askModel: async candidates => ({ included: candidates.map(c => ({ errorGroupId: c.errorGroupId,
        title: 'Complete purchase leaves checkout unchanged', copy: 'Clicking Complete purchase repeatedly leaves checkout unchanged.',
        why: c.why, steps: c.steps })), deferred: [] }),
    });
    // Invalid encrypted fixture config cannot send a message; inspect the real outbox.
    await db.query(`INSERT INTO notification_destinations(id,project_id,type,name,config_encrypted,config_fingerprint,event_types)
      VALUES(gen_random_uuid(),$1,'slack','known-problems-smoke',decode('00','hex'),$2,ARRAY['digest.daily'])`, [tenant.projectId, RUN_ID]);
    const rendered = await goHelper(tenant.projectId, 'publish', ['-run', after.runId]) as {
      event: { digest: { schema_version: number; generated_cards: unknown[]; receipt_items?: unknown[] } }; slack: unknown;
    };
    await db.query('UPDATE notification_destinations SET enabled=false WHERE project_id=$1', [tenant.projectId]);
    expect(rendered.event.digest.schema_version).toBe(5);
    expect(rendered.event.digest.generated_cards).toHaveLength(1);
    expect(rendered.event.digest.receipt_items ?? []).toHaveLength(0);
    const slack = JSON.stringify(rendered.slack);
    expect(slack).toContain('3 users');
    expect(slack).toContain('3 sessions');
    expect(slack).not.toMatch(/visits/i);
    expect(slack.match(/Create fix PR/g)).toHaveLength(1);
    expect(slack).toContain('fixIntent=');
    expect(dimensions.length).toBeGreaterThanOrEqual(3);
    expect(dimensions.every(([width, height]) => width <= 720 && height <= 450)).toBe(true);
    const narratives = await db.query<{ status: string; verification_state: string }>(
      'SELECT status,verification_state FROM session_narratives WHERE project_id=$1 AND session_id=ANY($2::text[])', [tenant.projectId, recordings]);
    expect(narratives.rows).toHaveLength(3);
    expect(narratives.rows.every(row => row.status === 'ok' && row.verification_state === 'ok')).toBe(true);
    problem = 'stepper';
    await recordAndMatch(3);
    const internal = await db.query<{ id: string; status: string }>('SELECT id,status FROM friction_tickets WHERE project_id=$1 AND id<>$2', [tenant.projectId, ticketId]);
    expect(internal.rows).toHaveLength(1);
    expect(internal.rows[0].status).toBe('tracking');
    expect((await listIncidents(tenant.userSession, tenant.projectId)).map(incident => incident.id)).toEqual([groupId]);
    await db.query("UPDATE sessions SET started_at=now()-interval '91 days' WHERE id=$1 AND project_id=$2", [recordings[0], tenant.projectId]);
    const purged = await goHelper(tenant.projectId, 'purge', ['-session', recordings[0]]) as { removedObjects: number };
    expect(purged.removedObjects).toBeGreaterThan(1);
    expect((await db.query('SELECT id FROM sessions WHERE id=$1', [recordings[0]])).rows).toHaveLength(0);
    expect((await db.query<{ status: string }>('SELECT status FROM error_groups WHERE id=$1', [groupId])).rows[0].status).toBe('archived');
    expect((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM friction_checks WHERE ticket_id=$1 AND outcome='confirmed'", [ticketId])).rows[0].n).toBe('2');
  });
});
