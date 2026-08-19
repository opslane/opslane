/**
 * E2E: Daily digest wire contract — destination defaults, synchronous digest
 * preview construction, and Slack Block Kit delivery through a real webhook.
 *
 * The stack must be booted with the sink's host on the webhook allowlist:
 *
 *   NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9998
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

// 9998, not 9999: notifications-contract.test.ts binds 9999, and vitest runs
// test files in parallel, so sharing the port makes whichever suite loses the
// race die on EADDRINUSE. Both ports are on the stack's webhook allowlist.
const SINK_PORT = 9998;
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
         occurrence_count, affected_users_count, root_cause,
         impact_class, impact_visits, impact_visits_recovered
       ) VALUES (
         $1, $2, $3, 'Rage clicks in digest contract', 'friction', 'insight',
         'rage_click', '/digest-contract', now() - interval '3 hours',
         now() - interval '1 hour', 2, 0,
         'The checkout control did not handle repeated activation.',
         'degraded', 2, 1
       )
       RETURNING id`,
      [tenant.projectId, tenant.environmentId, fingerprint],
    );
    const frictionGroupId = groupResult.rows[0]!.id;

    await db.query(
      `INSERT INTO diagnosis_decisions (
         error_group_id, project_id, outcome, decision_reason, diagnosis,
         model, prompt_version, basis, confidence
       ) VALUES (
         $1, $2, 'not_actionable', 'digest contract receipt',
         $3::jsonb, 'e2e-fixture', 'digest-contract-v2', 'investigation', 'high'
       )`,
      [
        frictionGroupId,
        tenant.projectId,
        JSON.stringify({
          evidence: [
            {
              path: 'src/checkout.ts',
              detail: 'The activation path ignores a repeated click.',
              symptomLink: 'Repeated clicks produce the observed friction signal.',
            },
          ],
        }),
      ],
    );
    // Digest eligibility derives from the latest factual and inquiry
    // decisions on the issue's newest episode (Slice 7B); digest_readiness is
    // retired and ignored.
    const { rows: episodeRows } = await db.query(
      `INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
       VALUES ($1, $2, 1)
       RETURNING id`,
      [tenant.projectId, frictionGroupId],
    );
    const episodeId = episodeRows[0].id;
    await db.query(
      `INSERT INTO issue_decisions
         (project_id, episode_id, decision, reason, users_7d, anon_7d, rule_version)
       VALUES ($1, $2, 'open_inquiry', 'digest contract fixture', 2, 0, 1)`,
      [tenant.projectId, episodeId],
    );
    await db.query(
      `INSERT INTO issue_inquiry_decisions
         (project_id, episode_id, decision, reason, evaluated_units,
          evidence_signature, model, prompt_version)
       VALUES ($1, $2, 'investigate', 'digest contract fixture', 2,
               'digest-contract-fixture', 'fixture', 1)`,
      [tenant.projectId, episodeId],
    );

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
    expect(firstHits[0]!.body).toContain(
      'No fix PRs awaiting review, 1 issue needs a decision.',
    );
    expect(firstHits[0]!.body).toContain('Rage clicks in digest contract');
    // The seeded issue carries a validated diagnosis, which is the only reason
    // it is in the digest at all, so the card must say a cause was found. The
    // old copy here was 'Investigation report ready.', which said nothing
    // actionable; the copy it was briefly replaced with denied the cause the
    // very next line goes on to state.
    expect(firstHits[0]!.body).toContain('Cause found; no fix opened yet. Details in the issue.');
    expect(firstHits[0]!.body).not.toContain('We could not establish a cause');
    expect(firstHits[0]!.body).not.toContain('older issues still awaiting your review');

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
