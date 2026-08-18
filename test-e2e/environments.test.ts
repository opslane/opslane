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
  seedTenant,
  seedUserWithJWT,
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
  let stagingEnvironmentId = '';
  let jwt: UserSession;

  async function scrapeMetrics(): Promise<string> {
    const response = await fetch(`${getConfig().ingestionUrl}/metrics`);
    expect(response.status).toBe(200);
    return response.text();
  }

  async function ingest(
    ingestKey: TestTenant['ingestKey'],
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

  async function listObservedEnvironments(
    usedBy: 'incidents' | 'sessions',
  ): Promise<Array<{ id: string; name: string }>> {
    const response = await fetch(
      `${getConfig().ingestionUrl}/api/v1/projects/${tenant.projectId}/environments?used_by=${usedBy}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { environments: Array<{ id: string; name: string }> };
    return body.environments;
  }

  beforeAll(async () => {
    tenant = await seedTenant();
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

  it('keeps one capture bucket across payload environments with exact per-environment counts', async () => {
    const project = await getPool().query<{ default_environment_id: string }>(
      `SELECT default_environment_id FROM projects WHERE id = $1`, [tenant.projectId],
    );
    expect(project.rows[0]?.default_environment_id).toBe(tenant.environmentId);
    const beforeDiscovery = await getPool().query(
      `SELECT id FROM environments WHERE project_id = $1 AND name = 'staging'`, [tenant.projectId],
    );
    expect(beforeDiscovery.rowCount).toBe(0);
    const marker = `environment-shared-${crypto.randomUUID()}`;
    const productionEvent = await ingest(tenant.ingestKey, marker, { sharedFingerprint: true });
    const stagingEvent = await ingest(tenant.ingestKey, marker, {
      environment: 'staging',
      sharedFingerprint: true,
    });
    stagingEnvironmentId = stagingEvent.environmentId;

    expect(stagingEvent.groupId).toBe(productionEvent.groupId);
    // Capture boundary (Slice 2): ingestion stores observations without
    // creating incidents, so the per-environment proof reads stored capture
    // state. Incident-level occurrence filtering returns with identity
    // settlement in Slice 4.
    const bucket = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM error_capture_buckets
        WHERE project_id = $1 AND raw_fingerprint = $2`,
      [tenant.projectId, productionEvent.groupId],
    );
    expect(bucket.rows[0]?.n).toBe(1);
    const perEnvironment = await getPool().query<{ environment_id: string; n: number }>(
      `SELECT environment_id, count(*)::int AS n FROM error_events
        WHERE project_id = $1 AND error_message = $2
        GROUP BY environment_id`,
      [tenant.projectId, marker],
    );
    const counts = new Map(perEnvironment.rows.map((row) => [row.environment_id, row.n]));
    expect(counts.get(tenant.environmentId)).toBe(1);
    expect(counts.get(stagingEvent.environmentId)).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('uses exact labels, discovers valid names, and falls back invalid labels to the default', async () => {
    const before = await scrapeMetrics();
    const beforeCreated = metricValue(before, 'opslane_ingest_environment_resolution_total', '{outcome="created"}');
    const beforeInvalid = metricValue(before, 'opslane_ingest_environment_resolution_total', '{outcome="invalid_label"}');
    expect((await ingest(tenant.ingestKey, 'valid-override', { environment: 'staging' })).environmentId)
      .toBe(stagingEnvironmentId);
    const discovered = await ingest(tenant.ingestKey, 'new-label', { environment: 'qa-west' });
    expect(discovered.environmentId).not.toBe(tenant.environmentId);
    expect((await ingest(tenant.ingestKey, 'invalid-override', { environment: 'bad environment/name' })).environmentId)
      .toBe(tenant.environmentId);

    const after = await scrapeMetrics();
    expect(metricValue(after, 'opslane_ingest_environment_resolution_total', '{outcome="created"}'))
      .toBe(beforeCreated + 1);
    expect(metricValue(after, 'opslane_ingest_environment_resolution_total', '{outcome="invalid_label"}'))
      .toBe(beforeInvalid + 1);
  });

  it('applies a changed default prospectively', async () => {
    const historical = await ingest(tenant.ingestKey, 'before-default-change');
    expect(historical.environmentId).toBe(tenant.environmentId);
    await getPool().query(
      `UPDATE projects p SET default_environment_id = e.id
       FROM environments e WHERE p.id = $1 AND e.project_id = p.id AND e.name = 'staging'`,
      [tenant.projectId],
    );
    const after = await ingest(tenant.ingestKey, 'after-default-change');
    expect(after.environmentId).toBe(stagingEnvironmentId);
    const unchanged = await getPool().query<{ environment_id: string }>(
      `SELECT environment_id FROM error_events WHERE id = $1`, [historical.eventId],
    );
    expect(unchanged.rows[0]?.environment_id).toBe(tenant.environmentId);
    await getPool().query(
      `UPDATE projects SET default_environment_id = $2 WHERE id = $1`,
      [tenant.projectId, tenant.environmentId],
    );
  });

  it('supports out-of-order events, makes the existing same-project session authoritative, and rejects cross-project claims', async () => {
    const sessionId = `env_e2e_${crypto.randomUUID().replaceAll('-', '')}`;
    const before = await scrapeMetrics();
    const divergenceBefore = metricValue(before, 'opslane_ingest_env_session_divergence_total');
    const conflictBefore = metricValue(before, 'opslane_ingest_session_cross_project_conflict_total');

    const beforeSession = await ingest(tenant.ingestKey, 'before-session', {
      environment: 'staging',
      sessionId,
    });
    expect(beforeSession.environmentId).toBe(stagingEnvironmentId);

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
      stagingEnvironmentId,
    );
    expect(productionSessions.some((session) => session.id === sessionId)).toBe(true);
    expect(stagingSessions.some((session) => session.id === sessionId)).toBe(false);

    const sessionOnlyLabel = `session-only-${crypto.randomUUID()}`;
    const sessionOnlyInit = await fetch(`${getConfig().ingestionUrl}/api/v1/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.ingestKey },
      body: JSON.stringify({
        session_id: `env_e2e_${crypto.randomUUID().replaceAll('-', '')}`,
        started_at: new Date().toISOString(),
        page_url: 'https://app.example.test/session-only',
        environment: sessionOnlyLabel,
      }),
    });
    expect(sessionOnlyInit.status).toBe(200);
    // Capture boundary (Slice 2): used_by=incidents derives from settled
    // issues (error_group_environments), which repopulate in Slice 4. The
    // stored observations still prove staging errors landed in staging.
    const stagingEvents = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM error_events
        WHERE project_id = $1 AND environment_id = $2`,
      [tenant.projectId, stagingEnvironmentId],
    );
    expect(stagingEvents.rows[0]!.n).toBeGreaterThan(0);
    const sessionEnvironments = await listObservedEnvironments('sessions');
    expect(sessionEnvironments.map(({ id }) => id)).toContain(tenant.environmentId);
    expect(sessionEnvironments.map(({ name }) => name)).toContain(sessionOnlyLabel);
    expect(sessionEnvironments.map(({ id }) => id)).not.toContain(stagingEnvironmentId);

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

  it('does not expose manual environment creation', async () => {
    const response = await fetch(
      `${getConfig().ingestionUrl}/api/v1/projects/${tenant.projectId}/environments`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: '{"name":"manual"}' },
    );
    expect(response.status).toBe(404);
  });
});
