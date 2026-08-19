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
import {
  closePool as closeWorkerPool,
  updateGroupInvestigation,
  updateGroupStatus,
} from '../packages/worker/src/db.js';

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
  let postTriageDestinationId: string;
  let createFingerprint: string;

  const sinkHits: SinkHit[] = [];
  let sink: http.Server;
  // Unique per run so hits from other stacks/runs sharing the port never match.
  const hookPath = `/e2e-hook/${crypto.randomUUID()}`;
  const postTriageHookPath = `/e2e-hook/${crypto.randomUUID()}`;

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

  async function waitForSinkHits(
    path: string,
    count: number,
    timeoutMs = 30_000,
  ): Promise<SinkHit[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hits = sinkHits.filter((hit) => hit.path === path);
      if (hits.length >= count) return hits;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const actual = sinkHits.filter((hit) => hit.path === path).length;
    throw new Error(`Expected ${count} sink hit(s) for ${path}, got ${actual}`);
  }

  async function createTerminalJob(groupId: string): Promise<string> {
    return (await getPool().query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, job_type, available_at)
       VALUES ($1, $2, 'fix', now() + interval '1 day') RETURNING id`,
      [groupId, tenant.projectId],
    )).rows[0]!.id;
  }

  // The keyless CI lane runs a live worker. It claims the investigate job that
  // ingestion enqueues on a new group and terminates it as needs_human
  // (missing_llm_key), which correctly pages post_triage destinations. That is
  // real product behaviour, but this suite drives its own terminals, so it
  // takes the auto-enqueued job out of the worker's reach first. Without this
  // the worker's alert lands before the test's and every assertion here races.
  async function claimAutoJobs(groupId: string): Promise<void> {
    await getPool().query(
      `UPDATE error_group_jobs SET status = 'completed', updated_at = now()
       WHERE error_group_id = $1 AND project_id = $2 AND status IN ('pending', 'claimed')`,
      [groupId, tenant.projectId],
    );
  }

  // Every test uses a distinct error type, so the body is a reliable marker for
  // "this test's group" on a sink shared by both destinations.
  function hitsFor(path: string, marker: string): SinkHit[] {
    return sinkHits.filter((hit) => hit.path === path && hit.body.includes(marker));
  }

  async function waitForHitFor(path: string, marker: string, timeoutMs = 30_000): Promise<SinkHit> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = hitsFor(path, marker);
      if (found.length > 0) return found.at(-1)!;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`No sink hit on ${path} containing ${marker} within ${timeoutMs}ms`);
  }

  async function countTriagedEvents(groupId: string): Promise<number> {
    return Number((await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbound_events
       WHERE project_id = $1 AND event_type = 'issue.triaged'
         AND payload->'issue'->>'id' = $2`,
      [tenant.projectId, groupId],
    )).rows[0]!.count);
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

    const postTriageResponse = await fetch(destinationsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: 'e2e post-triage sink',
        webhook_url: `http://${SINK_HOST}${postTriageHookPath}`,
        event_types: ['issue.created'],
        delivery_policy: 'post_triage',
      }),
    });
    if (!postTriageResponse.ok) {
      throw new Error(`Creating post-triage destination failed: ${await postTriageResponse.text()}`);
    }
    postTriageDestinationId = ((await postTriageResponse.json()) as { id: string }).id;
  });

  afterAll(async () => {
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
    await closeWorkerPool();
  });

  // Capture boundary (Slice 2): at-ingest issue creation and its outbox
  // deliveries are removed; issues return with settlement (Slice 4) and
  // customer delivery moves to the daily publication path (Slice 10).
  it.skip('delivers issue.created to the webhook as Block Kit [suspended until Slice 10]', async () => {
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

  it.skip('does not deliver again for a repeat occurrence of the same group [suspended until Slice 10]', async () => {
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

  it.skip('routes immediate and post-triage deliveries without crossing streams [suspended until Slice 10]', async () => {
    const immediateHitsBefore = sinkHits.filter((hit) => hit.path === hookPath).length;
    const response = await postEvent(tenant.ingestKey, eventPayload('PostTriageContractError'));
    expect(response.ok).toBe(true);
    const { error_group_id: groupId } = (await response.json()) as { error_group_id: string };
    await claimAutoJobs(groupId);

    // Ingest publishes only to the immediate destination.
    await waitForSinkHits(hookPath, immediateHitsBefore + 1);
    expect(sinkHits.filter((hit) => hit.path === hookPath)).toHaveLength(immediateHitsBefore + 1);
    const crossed = hitsFor(postTriageHookPath, 'PostTriageContractError').map((hit) =>
      hit.body.slice(0, 300),
    );
    expect(
      crossed,
      `post-triage sink received ${crossed.length} body(ies) before any terminal transition: ${JSON.stringify(crossed)}`,
    ).toHaveLength(0);

    const jobId = await createTerminalJob(groupId);
    await updateGroupStatus(groupId, tenant.projectId, 'needs_human', {
      reason: {
        reason_code: 'insufficient_context',
        reason_message: 'This model-written detail must not be delivered',
        remediation: 'Review manually',
      },
      terminalFixJobId: jobId,
    });

    // Scoped to this group: the worker legitimately pages post_triage for the
    // other groups in this file, so an absolute list can hold its messages too.
    const hit = await waitForHitFor(postTriageHookPath, 'PostTriageContractError');
    expect(hitsFor(postTriageHookPath, 'PostTriageContractError')).toHaveLength(1);
    expect(hit.body).toContain('Needs review — no verified cause');
    expect(hit.body).not.toContain('model-written detail');
    // The immediate destination received only its ingest-time message.
    expect(sinkHits.filter((hit) => hit.path === hookPath)).toHaveLength(immediateHitsBefore + 1);

    const routed = await getPool().query<{ event_type: string; destination_id: string }>(
      `SELECT e.event_type, d.destination_id
       FROM outbound_events e JOIN outbound_deliveries d ON d.event_id = e.id
       WHERE e.project_id = $1 AND e.payload->'issue'->>'id' = $2
       ORDER BY e.event_type`,
      [tenant.projectId, groupId],
    );
    expect(routed.rows).toEqual([
      { event_type: 'issue.created', destination_id: destinationId },
      { event_type: 'issue.triaged', destination_id: postTriageDestinationId },
    ]);
  });

  it.skip('keeps insight outcomes out of post-triage alerts and in the daily digest [suspended until Slice 10]', async () => {
    const immediateHitsBefore = sinkHits.filter((hit) => hit.path === hookPath).length;
    const postTriageHitsBefore = sinkHits.filter((hit) => hit.path === postTriageHookPath).length;
    const response = await postEvent(tenant.ingestKey, eventPayload('InsightDigestContractError'));
    expect(response.ok).toBe(true);
    const { error_group_id: groupId } = (await response.json()) as { error_group_id: string };
    await claimAutoJobs(groupId);
    await waitForSinkHits(hookPath, immediateHitsBefore + 1);

    const jobId = await createTerminalJob(groupId);
    await updateGroupInvestigation(groupId, tenant.projectId, 'insight', {
      rootCause: 'A third-party response explains the issue',
      confidence: 'high',
      decision: {
        outcome: 'not_actionable',
        decisionReason: 'The failure originates in a third-party service',
        causeLocation: 'https://api.example.com/checkout',
        diagnosis: {
          evidence: [
            {
              path: 'src/checkout.ts',
              detail: 'The local request is valid and the provider rejects it',
              symptomLink: 'The provider response matches the reported checkout failure',
            },
          ],
        },
        model: 'e2e-fixture',
        promptVersion: 'notifications-contract-v1',
        jobId,
        basis: 'cause_outside_codebase',
        confidence: 'high',
      },
    });
    const insightRows = (await getPool().query<{ dedup_key: string; payload: unknown }>(
      `SELECT dedup_key, payload FROM outbound_events
       WHERE project_id = $1 AND event_type = 'issue.triaged'
         AND payload->'issue'->>'id' = $2`,
      [tenant.projectId, groupId],
    )).rows;
    expect(
      insightRows,
      `insight outcome emitted issue.triaged: ${JSON.stringify(insightRows)}`,
    ).toHaveLength(0);
    expect(hitsFor(postTriageHookPath, 'InsightDigestContractError')).toHaveLength(0);

    const digestResponse = await fetch(destinationsUrl(`/${postTriageDestinationId}/test`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ event_type: 'digest.daily' }),
    });
    expect(digestResponse.ok).toBe(true);
    const digestHit = await waitForHitFor(postTriageHookPath, 'InsightDigestContractError');
    expect(digestHit.body).toContain('InsightDigestContractError');
  });

  it.skip('alerts once when a fix job dies with worker_runtime_error [suspended until Slice 10]', async () => {
    const immediateHitsBefore = sinkHits.filter((hit) => hit.path === hookPath).length;
    const postTriageHitsBefore = sinkHits.filter((hit) => hit.path === postTriageHookPath).length;
    const response = await postEvent(tenant.ingestKey, eventPayload('WorkerRuntimeContractError'));
    expect(response.ok).toBe(true);
    const { error_group_id: groupId } = (await response.json()) as { error_group_id: string };
    await claimAutoJobs(groupId);
    await waitForSinkHits(hookPath, immediateHitsBefore + 1);

    await updateGroupStatus(groupId, tenant.projectId, 'needs_human', {
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: 'The worker process exited unexpectedly',
        remediation: 'Inspect the worker logs and retry',
      },
      terminalFixJobId: await createTerminalJob(groupId),
    });

    const hit = await waitForHitFor(postTriageHookPath, 'WorkerRuntimeContractError');
    expect(hit.body).toContain('Needs review — investigation crashed');
    expect(await countTriagedEvents(groupId)).toBe(1);
  });

  it.skip('renders a PR-bearing outcome as Fix PR opened [suspended until Slice 10]', async () => {
    const immediateHitsBefore = sinkHits.filter((hit) => hit.path === hookPath).length;
    const postTriageHitsBefore = sinkHits.filter((hit) => hit.path === postTriageHookPath).length;
    const response = await postEvent(tenant.ingestKey, eventPayload('FixPRContractError'));
    expect(response.ok).toBe(true);
    const { error_group_id: groupId } = (await response.json()) as { error_group_id: string };
    await claimAutoJobs(groupId);
    await waitForSinkHits(hookPath, immediateHitsBefore + 1);

    await updateGroupStatus(groupId, tenant.projectId, 'pr_created', {
      confidence: 'low',
      pr_url: 'https://github.com/opslane/example/pull/42',
      pr_number: 42,
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'Model prose must not control the alert label',
        remediation: 'Review the draft',
      },
      terminalFixJobId: await createTerminalJob(groupId),
    });

    const hit = await waitForHitFor(postTriageHookPath, 'FixPRContractError');
    expect(hit.body).toContain('Fix PR opened');
    expect(hit.body).not.toContain('low confidence');
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
    const immediateHitsBefore = sinkHits.filter((hit) => hit.path === hookPath).length;
    const postTriageHitsBefore = sinkHits.filter((hit) => hit.path === postTriageHookPath).length;
    const deleteResponse = await fetch(destinationsUrl(`/${destinationId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(deleteResponse.ok).toBe(true);
    const deletePostTriageResponse = await fetch(destinationsUrl(`/${postTriageDestinationId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(deletePostTriageResponse.ok).toBe(true);

    const eventsBefore = Number((await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbound_events WHERE project_id = $1`,
      [tenant.projectId],
    )).rows[0]!.count);

    const response = await postEvent(tenant.ingestKey, eventPayload('PostDeleteError'));
    expect(response.ok).toBe(true);

    // No enabled destination ⇒ publish writes no outbox rows for the new group,
    // and the destination delete cascaded away its old delivery rows.
    const eventsResult = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbound_events WHERE project_id = $1`,
      [tenant.projectId]
    );
    expect(Number(eventsResult.rows[0]!.count)).toBe(eventsBefore);
    expect(await deliveryRows()).toHaveLength(0);
    expect(sinkHits.filter((hit) => hit.path === hookPath)).toHaveLength(immediateHitsBefore);
    expect(sinkHits.filter((hit) => hit.path === postTriageHookPath)).toHaveLength(
      postTriageHitsBefore,
    );
  });
});
