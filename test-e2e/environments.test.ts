// @vitest-environment node

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  listIncidents,
  listSessions,
  postEvent,
  seedEnvironment,
  seedTenant,
  seedUserWithJWT,
  type IngestKey,
  type TestTenant,
  type UserSession,
} from './helpers.js';

const configured = !!process.env['DATABASE_URL'] && !!process.env['INGESTION_URL'];

function metricValue(metrics: string, name: string, labels = ''): number {
  const escaped = `${name}${labels}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = metrics.match(new RegExp(`^${escaped}\\s+(\\d+)$`, 'm'));
  return match ? Number(match[1]) : 0;
}

describe.skipIf(!configured)('first-class environment ingestion', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let staging: { environmentId: string; ingestKey: IngestKey };
  let jwt: UserSession;

  async function scrapeMetrics(): Promise<string> {
    const response = await fetch(`${getConfig().ingestionUrl}/metrics`);
    expect(response.status).toBe(200);
    return response.text();
  }

  async function setPayloadOverride(enabled: boolean): Promise<void> {
    await getPool().query(
      `UPDATE projects SET allow_payload_environment = $2 WHERE id = $1`,
      [tenant.projectId, enabled],
    );
  }

  async function ingest(
    ingestKey: IngestKey,
    marker: string,
    options: { environment?: string; sessionId?: string; sharedFingerprint?: boolean } = {},
  ): Promise<{ eventId: string; groupId: string; environmentId: string }> {
    const message = options.sharedFingerprint ? marker : `${marker}-${crypto.randomUUID()}`;
    const response = await postEvent(ingestKey, {
      timestamp: new Date().toISOString(),
      error: {
        type: 'EnvironmentE2EError',
        message,
        stack: `EnvironmentE2EError: ${message}\n    at environmentE2E (src/environment-e2e.ts:1:1)`,
      },
      breadcrumbs: [],
      context: {},
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
    });
    if (response.status !== 202) {
      throw new Error(`event ingest failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json() as { event_id: string; error_group_id: string };
    const persisted = await getPool().query<{ environment_id: string }>(
      `SELECT environment_id FROM error_events WHERE id = $1`,
      [body.event_id],
    );
    return {
      eventId: body.event_id,
      groupId: body.error_group_id,
      environmentId: persisted.rows[0]!.environment_id,
    };
  }

  beforeAll(async () => {
    tenant = await seedTenant();
    staging = await seedEnvironment(tenant.projectId, 'staging');
    otherTenant = await seedTenant('other-org/other-repo');
    // Boundary: seedUserWithJWT signs a plain JWT string; this test's use of
    // it to read incidents/sessions is what makes it a session credential.
    const { jwt: rawJwt } = await seedUserWithJWT(tenant.orgId);
    jwt = rawJwt as UserSession;
  });

  afterAll(async () => {
    if (otherTenant) await cleanupTenant(otherTenant.orgId);
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('keeps one group across payload environments with exact per-environment counts', async () => {
    const marker = `environment-shared-${crypto.randomUUID()}`;
    const productionEvent = await ingest(tenant.ingestKey, marker, { sharedFingerprint: true });
    const stagingEvent = await ingest(staging.ingestKey, marker, {
      environment: 'staging',
      sharedFingerprint: true,
    });

    expect(stagingEvent.groupId).toBe(productionEvent.groupId);
    const all = await listIncidents(tenant.userSession, tenant.projectId);
    const production = await listIncidents(tenant.userSession, tenant.projectId, tenant.environmentId);
    const stagingOnly = await listIncidents(tenant.userSession, tenant.projectId, staging.environmentId);
    expect(all.find((incident) => incident.id === productionEvent.groupId)?.occurrence_count).toBe(2);
    expect(production.find((incident) => incident.id === productionEvent.groupId)?.occurrence_count).toBe(1);
    expect(stagingOnly.find((incident) => incident.id === productionEvent.groupId)?.occurrence_count).toBe(1);
  });

  it('resolves opted-in names and falls back invalid overrides to production', async () => {
    const before = await scrapeMetrics();
    const beforeDisabled = metricValue(
      before,
      'opslane_ingest_env_override_fallback_total',
      '{reason="disabled"}',
    );
    const beforeUnknown = metricValue(
      before,
      'opslane_ingest_env_override_fallback_total',
      '{reason="unknown_name"}',
    );
    const beforeInvalid = metricValue(
      before,
      'opslane_ingest_env_override_fallback_total',
      '{reason="invalid_name"}',
    );

    await setPayloadOverride(true);
    expect((await ingest(tenant.ingestKey, 'valid-override', { environment: 'staging' })).environmentId)
      .toBe(staging.environmentId);

    await setPayloadOverride(false);
    expect((await ingest(tenant.ingestKey, 'disabled-override', { environment: 'staging' })).environmentId)
      .toBe(tenant.environmentId);

    await setPayloadOverride(true);
    expect((await ingest(tenant.ingestKey, 'unknown-override', { environment: 'does-not-exist' })).environmentId)
      .toBe(tenant.environmentId);
    expect((await ingest(tenant.ingestKey, 'invalid-override', { environment: 'bad environment/name' })).environmentId)
      .toBe(tenant.environmentId);

    const after = await scrapeMetrics();
    expect(metricValue(after, 'opslane_ingest_env_override_fallback_total', '{reason="disabled"}'))
      .toBe(beforeDisabled + 1);
    expect(metricValue(after, 'opslane_ingest_env_override_fallback_total', '{reason="unknown_name"}'))
      .toBe(beforeUnknown + 1);
    expect(metricValue(after, 'opslane_ingest_env_override_fallback_total', '{reason="invalid_name"}'))
      .toBe(beforeInvalid + 1);
  });

  it('supports out-of-order events, makes the existing same-project session authoritative, and rejects cross-project claims', async () => {
    await setPayloadOverride(true);
    const sessionId = `env_e2e_${crypto.randomUUID().replaceAll('-', '')}`;
    const before = await scrapeMetrics();
    const divergenceBefore = metricValue(before, 'opslane_ingest_env_session_divergence_total');
    const conflictBefore = metricValue(before, 'opslane_ingest_session_cross_project_conflict_total');

    const beforeSession = await ingest(tenant.ingestKey, 'before-session', {
      environment: 'staging',
      sessionId,
    });
    expect(beforeSession.environmentId).toBe(staging.environmentId);

    const sessionInit = await fetch(`${getConfig().ingestionUrl}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        page_url: 'https://app.example.test/out-of-order',
        environment: 'production',
      }),
    });
    if (sessionInit.status !== 200) {
      throw new Error(`session init failed: ${sessionInit.status} ${await sessionInit.text()}`);
    }

    const afterSession = await ingest(tenant.ingestKey, 'after-session', {
      environment: 'staging',
      sessionId,
    });
    expect(afterSession.environmentId).toBe(tenant.environmentId);
    const productionSessions = await listSessions(
      jwt,
      tenant.projectId,
      tenant.environmentId,
    );
    const stagingSessions = await listSessions(
      jwt,
      tenant.projectId,
      staging.environmentId,
    );
    expect(productionSessions.some((session) => session.id === sessionId)).toBe(true);
    expect(stagingSessions.some((session) => session.id === sessionId)).toBe(false);

    const crossProjectInit = await fetch(`${getConfig().ingestionUrl}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': otherTenant.ingestKey },
      body: JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        page_url: 'https://other.example.test/conflict',
      }),
    });
    expect(crossProjectInit.status).toBe(409);

    const ownerReplay = await fetch(`${getConfig().ingestionUrl}/api/v1/replays/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({ session_id: sessionId, trigger_type: 'error' }),
    });
    expect(ownerReplay.status).toBe(201);

    const crossProjectReplay = await fetch(`${getConfig().ingestionUrl}/api/v1/replays/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': otherTenant.ingestKey },
      body: JSON.stringify({ session_id: sessionId, trigger_type: 'error' }),
    });
    expect(crossProjectReplay.status).toBe(404);

    const after = await scrapeMetrics();
    expect(metricValue(after, 'opslane_ingest_env_session_divergence_total'))
      .toBeGreaterThan(divergenceBefore);
    expect(metricValue(after, 'opslane_ingest_session_cross_project_conflict_total'))
      .toBe(conflictBefore + 1);
  });
});
