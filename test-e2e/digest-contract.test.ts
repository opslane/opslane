/**
 * E2E: Daily digest wire contract — destination defaults, synchronous digest
 * preview construction, and Slack Block Kit delivery through a real webhook.
 *
 * The stack must be booted with the sink's host on the webhook allowlist:
 *
 *   NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9999
 *
 * Required:
 *   DATABASE_URL       — Postgres connection string
 *   INGESTION_URL      — Base URL for ingestion API (default: http://localhost:8082)
 */

import http from 'node:http';
import crypto from 'node:crypto';
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

const SINK_PORT = 9999;
const SINK_HOST = process.env['E2E_WEBHOOK_SINK_HOST'] ?? `host.docker.internal:${SINK_PORT}`;

interface SinkHit {
  method: string;
  path: string;
  contentType: string;
  body: string;
}

interface DestinationResponse {
  id: string;
  event_types: string[];
}

interface DestinationListResponse {
  destinations: DestinationResponse[];
}

interface TestSendResponse {
  ok: boolean;
  classification: string;
}

describe('daily digest contract (Slack webhook delivery)', () => {
  let tenant: TestTenant;
  let jwt: string;
  let sink: http.Server;

  const sinkHits: SinkHit[] = [];
  const hookPath = `/e2e-digest-hook/${crypto.randomUUID()}`;

  function destinationsUrl(suffix = ''): string {
    const { ingestionUrl } = getConfig();
    return `${ingestionUrl}/api/v1/projects/${tenant.projectId}/notification-destinations${suffix}`;
  }

  async function seedDigestData(): Promise<void> {
    const db = getPool();
    const firstSessionId = `digest-${crypto.randomUUID()}`;
    const secondSessionId = `digest-${crypto.randomUUID()}`;
    const fingerprint = `digest-friction-${crypto.randomUUID()}`;

    await db.query(
      `INSERT INTO sessions (id, project_id, environment_id, started_at, page_url)
       VALUES
         ($1, $3, $4, now() - interval '3 hours', 'https://app.example.com/digest-contract'),
         ($2, $3, $4, now() - interval '2 hours', 'https://app.example.com/digest-contract')`,
      [firstSessionId, secondSessionId, tenant.projectId, tenant.environmentId],
    );

    const groupResult = await db.query<{ id: string }>(
      `INSERT INTO error_groups (
         project_id, environment_id, fingerprint, title, kind, status,
         signal_type, page_url_normalized, first_seen, last_seen,
         occurrence_count, affected_users_count
       ) VALUES (
         $1, $2, $3, 'Rage clicks in digest contract', 'friction', 'insight',
         'rage_click', '/digest-contract', now() - interval '3 hours',
         now() - interval '1 hour', 2, 0
       )
       RETURNING id`,
      [tenant.projectId, tenant.environmentId, fingerprint],
    );
    const frictionGroupId = groupResult.rows[0]!.id;

    await db.query(
      `INSERT INTO friction_signals (
         session_id, project_id, environment_id, rule_version, signal_type,
         fingerprint, page_url_normalized, occurred_at, occurrence_count,
         incident_id
       ) VALUES
         ($1, $3, $4, 1, 'rage_click', $5, '/digest-contract',
          now() - interval '2 hours', 2, $6),
         ($2, $3, $4, 1, 'rage_click', $5, '/digest-contract',
          now() - interval '1 hour', 3, $6)`,
      [
        firstSessionId,
        secondSessionId,
        tenant.projectId,
        tenant.environmentId,
        fingerprint,
        frictionGroupId,
      ],
    );

    await db.query(
      `INSERT INTO error_groups (
         project_id, environment_id, fingerprint, title, kind, status,
         first_seen, last_seen, occurrence_count, affected_users_count,
         needs_human_at, reason_code, reason_message, remediation
       ) VALUES (
         $1, $2, $3, 'Digest checkout failure needs review', 'error', 'needs_human',
         now() - interval '2 days', now() - interval '1 hour', 4, 0,
         now() - interval '1 hour', 'external_cause',
         'The checkout provider rejected the request.', 'Review the provider response.'
       )`,
      [tenant.projectId, tenant.environmentId, `digest-needs-human-${crypto.randomUUID()}`],
    );
  }

  async function testSend(destinationId: string): Promise<TestSendResponse> {
    const response = await fetch(destinationsUrl(`/${destinationId}/test`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ event_type: 'digest.daily' }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Sending digest preview failed (${response.status}): ${body}`);
    }
    return JSON.parse(body) as TestSendResponse;
  }

  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        sinkHits.push({
          method: req.method ?? '',
          path: req.url ?? '',
          contentType: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve, reject) => {
      sink.once('error', reject);
      sink.listen(SINK_PORT, '0.0.0.0', resolve);
    });

    tenant = await seedTenant();
    jwt = (await seedUserWithJWT(tenant.orgId)).jwt;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('round-trips subscriptions and explicitly delivers a digest preview', async () => {
    const createResponse = await fetch(destinationsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: 'digest contract sink',
        webhook_url: `http://${SINK_HOST}${hookPath}`,
      }),
    });
    const createBody = await createResponse.text();
    if (!createResponse.ok) {
      throw new Error(
        `Creating the webhook destination failed (${createResponse.status}): ${createBody}. ` +
          `The stack must be booted with NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=${SINK_HOST}.`,
      );
    }
    const destination = JSON.parse(createBody) as DestinationResponse;
    expect(destination.event_types).toHaveLength(2);
    expect(destination.event_types).toEqual(
      expect.arrayContaining(['issue.created', 'digest.daily']),
    );

    await seedDigestData();

    await expect(testSend(destination.id)).resolves.toMatchObject({
      ok: true,
      classification: 'delivered',
    });

    const firstHits = sinkHits.filter((hit) => hit.path === hookPath);
    expect(firstHits).toHaveLength(1);
    expect(firstHits[0]!.method).toBe('POST');
    expect(firstHits[0]!.contentType).toContain('application/json');
    const slackBody = JSON.parse(firstHits[0]!.body) as { blocks?: unknown };
    expect(Array.isArray(slackBody.blocks)).toBe(true);
    expect(firstHits[0]!.body).toContain('Daily digest');
    expect(firstHits[0]!.body).toContain('/digest-contract');
    expect(firstHits[0]!.body).toContain('Digest checkout failure needs review');

    const patchResponse = await fetch(destinationsUrl(`/${destination.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ event_types: ['issue.created'] }),
    });
    expect(patchResponse.status).toBe(200);

    await expect(testSend(destination.id)).resolves.toMatchObject({
      ok: true,
      classification: 'delivered',
    });
    expect(sinkHits.filter((hit) => hit.path === hookPath)).toHaveLength(2);

    const listResponse = await fetch(destinationsUrl(), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listResponse.ok).toBe(true);
    const listed = (await listResponse.json()) as DestinationListResponse;
    const roundTripped = listed.destinations.find((item) => item.id === destination.id);
    expect(roundTripped?.event_types).toEqual(['issue.created']);
  });
});
