/**
 * E2E: the dominant receipts-only digest shape agrees across Slack, the read
 * API, and MCP. The fixture carries the same actionable evidence and decision
 * gates as the production lane; publication is inserted at the durable outbox
 * seam so the test does not require a model-authored card or scheduler timing.
 *
 * The stack must allow E2E_WEBHOOK_SINK_HOST (default
 * host.docker.internal:9997) as an unsafe test webhook host.
 */

import crypto from 'node:crypto';
import http from 'node:http';
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

const SINK_PORT = 9997;
const SINK_HOST = process.env['E2E_WEBHOOK_SINK_HOST'] ?? `host.docker.internal:${SINK_PORT}`;

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await read();
  }
  return value;
}

describe('receipts-only digest day', () => {
  let tenant: TestTenant;
  let jwt: string;
  let sink: http.Server;
  const hits: string[] = [];
  const hookPath = `/e2e-receipts-only/${crypto.randomUUID()}`;

  beforeAll(async () => {
    sink = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url === hookPath) hits.push(Buffer.concat(chunks).toString());
        response.writeHead(200).end('ok');
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
    if (tenant) {
      await getPool().query('DELETE FROM digest_runs WHERE project_id = $1', [tenant.projectId]);
      await cleanupTenant(tenant.orgId);
    }
    await closePool();
  });

  it('names the same waiting incident in Slack, API, and MCP', async () => {
    const { ingestionUrl } = getConfig();
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
    const destinationResponse = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/notification-destinations`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'receipts-only digest sink',
          webhook_url: `http://${SINK_HOST}${hookPath}`,
          event_types: ['digest.daily'],
        }),
      },
    );
    const destinationText = await destinationResponse.text();
    if (!destinationResponse.ok) {
      throw new Error(`destination create failed (${destinationResponse.status}): ${destinationText}`);
    }
    const destination = JSON.parse(destinationText) as { id: string };

    const db = getPool();
    const group = await db.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
          occurrence_count,impact_class,impact_visits,impact_visits_recovered,root_cause,
          suggested_mitigation,actionable_since)
       VALUES ($1,$2,$3,'Dead checkout control','friction','awaiting_approval',
          now()-interval '2 days',now()-interval '1 hour',198,'blocked',23,4,
          'The checkout control does not submit.','Repair the submit handler.',now()-interval '2 days')
       RETURNING id::text`,
      [tenant.projectId, tenant.environmentId, `receipts-only-${crypto.randomUUID()}`],
    );
    const incidentId = group.rows[0]!.id;
    const episode = await db.query<{ id: string }>(
      `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
       VALUES ($1,$2,1) RETURNING id::text`,
      [tenant.projectId, incidentId],
    );
    await db.query(
      `INSERT INTO diagnosis_decisions
         (error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,model,prompt_version)
       VALUES ($1,$2,$3,'not_actionable','validated actionable finding',
         '{"evidence":[{"path":"src/checkout.ts","detail":"submit has no handler","symptomLink":"dead control"}]}'::jsonb,
         'e2e-fixture','receipts-only-v4')`,
      [incidentId, tenant.projectId, episode.rows[0]!.id],
    );

    const runDate = new Date().toISOString().slice(0, 10);
    const payload = {
      version: 1,
      event_type: 'digest.daily',
      run_id: '' as string,
      project: { id: tenant.projectId, name: 'Receipts-only project' },
      dashboard_url: 'https://app.example.com',
      digest: {
        schema_version: 4,
        date: runDate,
        generated_cards: [],
        receipt_items: [{
          kind: 'friction',
          incident_id: incidentId,
          title: 'Dead checkout control',
          occurrence_count: 198,
          impact_class: 'blocked',
          impact_visits: 23,
          impact_visits_recovered: 4,
          receipt_state: 'awaiting_approval',
          root_cause_excerpt: 'The checkout control does not submit.',
          mitigation_excerpt: 'Repair the submit handler.',
          has_validated_diagnosis: true,
          actionable_since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        }],
      },
    };
    const run = await db.query<{ id: string }>(
      `INSERT INTO digest_runs
         (project_id,window_from,window_to,run_date,status,rendered_payload)
       VALUES ($1,now()-interval '1 day',now(),$2::date,'delivered',$3::jsonb)
       RETURNING id::text`,
      [tenant.projectId, runDate, JSON.stringify(payload)],
    );
    payload.run_id = run.rows[0]!.id;
    await db.query('UPDATE digest_runs SET rendered_payload=$2::jsonb WHERE id=$1', [run.rows[0]!.id, JSON.stringify(payload)]);
    const event = await db.query<{ id: string }>(
      `INSERT INTO outbound_events (project_id,event_type,dedup_key,payload)
       VALUES ($1,'digest.daily',$2,$3::jsonb) RETURNING id::text`,
      [tenant.projectId, `e2e-receipts-only:${crypto.randomUUID()}`, JSON.stringify(payload)],
    );
    await db.query(
      'INSERT INTO outbound_deliveries (event_id,destination_id) VALUES ($1,$2)',
      [event.rows[0]!.id, destination.id],
    );

    const delivered = await eventually(
      async () => (await db.query<{ status: string }>('SELECT status FROM outbound_deliveries WHERE event_id=$1', [event.rows[0]!.id])).rows[0]?.status,
      (status) => status === 'delivered',
    );
    expect(delivered).toBe('delivered');
    const slackBody = (await eventually(() => hits.at(-1), (body) => body !== undefined))!;
    expect(slackBody).toContain('Needs a decision');
    expect(slackBody).toContain(incidentId);

    const latestResponse = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/digest/latest`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(latestResponse.ok).toBe(true);
    const latest = await latestResponse.json() as { receipts: Array<{ incident_id: string }> };
    expect(latest.receipts.map((item) => item.incident_id)).toEqual([incidentId]);

    const keyResponse = await fetch(`${ingestionUrl}/api/v1/projects/${tenant.projectId}/api-keys`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ label: 'receipts-only MCP', scope: 'api' }),
    });
    const key = await keyResponse.json() as { token: string };
    expect(keyResponse.ok).toBe(true);
    const mcpHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key.token}`,
    };
    const initialize = await fetch(`${ingestionUrl}/mcp`, {
      method: 'POST', headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
    });
    expect(initialize.ok).toBe(true);
    const call = await fetch(`${ingestionUrl}/mcp`, {
      method: 'POST', headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'opslane_digest', arguments: {} } }),
    });
    const callText = await call.text();
    expect(call.ok).toBe(true);
    expect(callText).toContain(incidentId);
    expect(callText).toContain('Waiting on a decision');
  });
});
