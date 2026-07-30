/**
 * E2E: Notifications contract — a new issue is delivered to a Slack webhook
 * destination through the transactional outbox and fenced dispatcher.
 *
 * The test runs an in-process HTTP sink that stands in for hooks.slack.com.
 * The stack must be booted with the sink's host on the webhook allowlist:
 *
 *   NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9999
 *
 * (`host.docker.internal` resolves natively on Docker Desktop; on Linux the
 * ingestion service maps it via extra_hosts host-gateway.)
 *
 * Contract under test:
 * 1. issue.created reaches the sink as Block Kit JSON, delivery row terminal.
 * 2. A repeat occurrence of the same group produces no second delivery.
 * 3. The webhook URL secret never surfaces (fingerprint is redacted).
 * 4. Deleting the destination stops delivery for future issues.
 *
 * Required:
 *   DATABASE_URL       — Postgres connection string
 *   INGESTION_URL      — Base URL for ingestion API (default: http://localhost:8082)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getConfig,
  getPool,
  seedTenant,
  seedUserWithJWT,
  postEvent,
  cleanupTenant,
  closePool,
  type TestTenant,
} from './helpers.js';

const SINK_PORT = 9999;
// The host:port the ingestion CONTAINER uses to reach this process. Must be
// on the stack's NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS allowlist.
const SINK_HOST = process.env['E2E_WEBHOOK_SINK_HOST'] ?? `host.docker.internal:${SINK_PORT}`;

interface SinkHit {
  path: string;
  contentType: string;
  body: string;
}

interface DeliveryRow {
  status: string;
  attempts: number;
  last_error: string | null;
}

function eventPayload(errorType: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    error: {
      type: errorType,
      message: `${errorType} from notifications contract e2e`,
      stack: `${errorType}: contract\n    at smoke (https://app.example.com/assets/smoke.js:1:1)`,
    },
    breadcrumbs: [],
    context: { url: 'https://app.example.com/smoke', user_agent: 'Mozilla/5.0' },
    sdk_version: '1.0.0',
  };
}

describe('notifications contract (Slack webhook delivery)', () => {
  let tenant: TestTenant;
  let jwt: string;
  let projectName: string;
  let destinationId: string;
  let createFingerprint: string;

  const sinkHits: SinkHit[] = [];
  let sink: http.Server;
  // Unique per run so hits from other stacks/runs sharing the port never match.
  const hookPath = `/e2e-hook/${crypto.randomUUID()}`;

  function destinationsUrl(suffix = ''): string {
    const { ingestionUrl } = getConfig();
    return `${ingestionUrl}/api/v1/projects/${tenant.projectId}/notification-destinations${suffix}`;
  }

  async function deliveryRows(): Promise<DeliveryRow[]> {
    const { rows } = await getPool().query<DeliveryRow>(
      `SELECT d.status, d.attempts, d.last_error
       FROM outbound_deliveries d
       JOIN outbound_events e ON d.event_id = e.id
       WHERE e.project_id = $1`,
      [tenant.projectId]
    );
    return rows;
  }

  async function pollDelivered(timeoutMs = 30_000): Promise<DeliveryRow> {
    // Dispatcher claim tick is 5s; one delivery fits well inside 30s.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await deliveryRows();
      const delivered = rows.find((r) => r.status === 'delivered');
      if (delivered) return delivered;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(
      `No delivered outbound_deliveries row for project ${tenant.projectId} within ${timeoutMs}ms: ` +
        JSON.stringify(await deliveryRows())
    );
  }

  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        sinkHits.push({
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
    const nameResult = await getPool().query<{ name: string }>(
      `SELECT name FROM projects WHERE id = $1`,
      [tenant.projectId]
    );
    projectName = nameResult.rows[0]!.name;

    const createResponse = await fetch(destinationsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: 'e2e sink',
        webhook_url: `http://${SINK_HOST}${hookPath}`,
      }),
    });
    const createBody = await createResponse.text();
    if (!createResponse.ok) {
      throw new Error(
        `Creating the webhook destination failed (${createResponse.status}): ${createBody}. ` +
          `The stack must be booted with NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=${SINK_HOST} ` +
          `so the test sink passes webhook URL validation.`
      );
    }
    const created = JSON.parse(createBody) as { id: string; config_fingerprint: string };
    destinationId = created.id;
    createFingerprint = created.config_fingerprint;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('delivers issue.created to the webhook as Block Kit', async () => {
    const response = await postEvent(tenant.ingestKey, eventPayload('NotifyContractError'));
    expect(response.ok).toBe(true);

    const delivered = await pollDelivered();
    expect(delivered.attempts).toBe(1);
    expect(delivered.last_error).toBeNull();

    const hits = sinkHits.filter((h) => h.path === hookPath);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.contentType).toContain('application/json');
    const blocks = (JSON.parse(hits[0]!.body) as { blocks: Array<{ type: string }> }).blocks;
    expect(hits[0]!.body).toContain(`New issue in ${projectName}`);
    expect(hits[0]!.body).toContain('NotifyContractError');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('does not deliver again for a repeat occurrence of the same group', async () => {
    const response = await postEvent(tenant.ingestKey, eventPayload('NotifyContractError'));
    expect(response.ok).toBe(true);
    const { error_group_id } = (await response.json()) as { error_group_id: string };

    // Grouping and outbox publish are transactional with ingestion, so these
    // are stable as soon as the POST returns.
    const groupResult = await getPool().query<{ occurrence_count: number }>(
      `SELECT occurrence_count FROM error_groups WHERE id = $1`,
      [error_group_id]
    );
    expect(groupResult.rows[0]!.occurrence_count).toBeGreaterThanOrEqual(2);
    expect(await deliveryRows()).toHaveLength(1);
    expect(sinkHits.filter((h) => h.path === hookPath)).toHaveLength(1);
  });

  it('never surfaces the webhook URL secret', async () => {
    const secretPathPart = hookPath.split('/').pop()!;
    expect(createFingerprint).not.toContain(secretPathPart);

    const listResponse = await fetch(destinationsUrl(), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(listResponse.ok).toBe(true);
    const listBody = await listResponse.text();
    expect(listBody).not.toContain(secretPathPart);
  });

  it('stops delivering after the destination is deleted', async () => {
    const deleteResponse = await fetch(destinationsUrl(`/${destinationId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(deleteResponse.ok).toBe(true);

    const response = await postEvent(tenant.ingestKey, eventPayload('PostDeleteError'));
    expect(response.ok).toBe(true);

    // No enabled destination ⇒ publish writes no outbox rows for the new group,
    // and the destination delete cascaded away its old delivery rows.
    const eventsResult = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbound_events WHERE project_id = $1`,
      [tenant.projectId]
    );
    expect(Number(eventsResult.rows[0]!.count)).toBe(1);
    expect(await deliveryRows()).toHaveLength(0);
    expect(sinkHits.filter((h) => h.path === hookPath)).toHaveLength(1);
  });
});
