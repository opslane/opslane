import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  seedTenant,
  seedUserWithJWT,
  type TestTenant,
} from './helpers.js';

describe('session replay pointer contract', () => {
  let tenant: TestTenant;
  let jwt: string;

  beforeAll(async () => {
    tenant = await seedTenant();
    jwt = (await seedUserWithJWT(tenant.orgId)).jwt;
  });

  afterAll(async () => {
    // sessions reference environments without ON DELETE CASCADE; the shared
    // pre-Batch-2 tenant cleanup does not know about them yet.
    await getPool().query(`DELETE FROM sessions WHERE project_id = $1`, [tenant.projectId]);
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  // Capture boundary (Slice 2): the pointer read resolves through the incident
  // surface, which returns with identity settlement. The event-link half of
  // this contract is covered by TestReplayInitPreservesPendingErrorEventWithoutInventingGroup.
  it.skip('resolves an early error to a committed chunk and serves it through the scrubbed read path [suspended until Slice 4]', async () => {
    const { ingestionUrl } = getConfig();
    const sessionId = 'e2e_replay_session';
    const errorAt = new Date().toISOString();

    const sessionInit = await fetch(`${ingestionUrl}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({
        session_id: sessionId,
        started_at: errorAt,
        page_url: 'https://app.example.com/profile?secret=query',
      }),
    });
    expect(sessionInit.status).toBe(200);
    expect((await sessionInit.json()).recording).toBe(true);

    const ingest = await fetch(`${ingestionUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({
        timestamp: errorAt,
        error: { type: 'TypeError', message: 'session-pointer-contract', stack: 'at a (src/a.ts:1:1)' },
        breadcrumbs: [],
        context: {},
        session_id: sessionId,
      }),
    });
    expect(ingest.status).toBe(202);
    const event = await ingest.json() as { event_id: string; error_group_id: string; group_id: string };
    expect(event.error_group_id).toBe(event.group_id);

    // Pointer identity is available before the first chunk is readable.
    const incidentBeforeChunk = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents/${event.error_group_id}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(incidentBeforeChunk.status).toBe(200);
    const pointerBody = await incidentBeforeChunk.json() as {
      session_pointer?: { session_id: string; error_at: string };
      replay_id?: string;
    };
    expect(pointerBody.session_pointer?.session_id).toBe(sessionId);
    // The public pointer is RFC3339 second precision; the source event may
    // carry milliseconds.
    expect(Math.abs(Date.parse(pointerBody.session_pointer?.error_at ?? '') - Date.parse(errorAt))).toBeLessThan(1_000);
    expect(pointerBody.replay_id).toBeUndefined();

    const errorAtMs = Date.parse(errorAt);
    const secret = 'ghp_e2eplantedsecret123';
    const recording = JSON.stringify({
      events: [
        { type: 4, timestamp: errorAtMs - 1_000, data: { width: 1280, height: 720 } },
        { type: 2, timestamp: errorAtMs - 1_000, data: { note: secret } },
        { type: 3, timestamp: errorAtMs, data: { source: 5 } },
      ],
      meta: { sdk_version: 'e2e', has_full_snapshot: true, chunked_at: errorAtMs },
    });
    const compressed = gzipSync(recording);

    // Mirror the SDK's normal early-error flush: one raw-gzip request.
    const upload = await fetch(
      `${ingestionUrl}/api/v1/sessions/${sessionId}/chunks/0?has_full_snapshot=1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'X-API-Key': tenant.ingestKey },
        body: compressed,
      },
    );
    expect(upload.status).toBe(200);

    const db = getPool();
    const committed = await db.query<{
      size_bytes: string;
      has_full_snapshot: boolean;
      retain_until: Date | null;
    }>(
      `SELECT c.size_bytes, c.has_full_snapshot, s.retain_until
         FROM session_chunks c
         JOIN sessions s ON s.id = c.session_id
        WHERE c.session_id = $1 AND c.seq = 0`,
      [sessionId],
    );
    expect(Number(committed.rows[0]?.size_bytes)).toBe(compressed.byteLength);
    expect(committed.rows[0]?.has_full_snapshot).toBe(true);
    expect(committed.rows[0]?.retain_until).toBeTruthy();

    // The scrubber contract is covered in its own package. Mark this committed
    // object readable deterministically so this E2E focuses on pointer/read APIs.
    await db.query(
      `UPDATE session_chunks
          SET scrubbed_at = now(), first_event_ms = $3, last_event_ms = $4, decoded_size_bytes = $5
        WHERE session_id = $1 AND seq = $2`,
      [sessionId, 0, errorAtMs - 1_000, errorAtMs, Buffer.byteLength(recording)],
    );

    const session = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/sessions/${sessionId}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(session.status).toBe(200);
    const sessionBody = await session.json() as {
      playable_chunk_count: number;
      chunks: Array<{ seq: number; first_event_ms: number; last_event_ms: number }>;
    };
    expect(sessionBody.playable_chunk_count).toBe(1);
    expect(sessionBody.chunks).toEqual([
      expect.objectContaining({ seq: 0, first_event_ms: errorAtMs - 1_000, last_event_ms: errorAtMs }),
    ]);

    const chunk = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/sessions/${sessionId}/chunks/0`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(chunk.status).toBe(200);
    const chunkText = await chunk.text();
    expect(chunkText).not.toContain(secret);
    const decoded = JSON.parse(chunkText) as { events: Array<{ type: number }> };
    expect(decoded.events.slice(0, 2).map((item) => item.type)).toEqual([4, 2]);
  });

  it('keeps the legacy one-shot init route alive for older SDKs', async () => {
    const { ingestionUrl } = getConfig();
    const init = await fetch(`${ingestionUrl}/api/v1/replays/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({
        session_id: 'legacy_sdk_session',
        trigger_type: 'error',
      }),
    });
    expect(init.status).toBe(201);
    const body = await init.json() as { replay_id?: string; upload_url?: string };
    expect(body.replay_id).toEqual(expect.any(String));
    expect(body.upload_url).toEqual(expect.any(String));
  });
});
