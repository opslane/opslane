// @vitest-environment node
/**
 * E2E: the credential boundary between an ingest key, a source-map key, a
 * revoked key, and a user session, exercised against the running container
 * rather than in-process. The Go route matrix (route_matrix_test.go) already
 * covers this in-process; this catches a routing or CORS mistake that would
 * only show up in the deployed service.
 *
 * Required:
 *   DATABASE_URL   — Postgres connection string
 *   INGESTION_URL  — Base URL for ingestion API (default: http://localhost:8082)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTenant,
  closePool,
  getConfig,
  seedTenant,
  type TestTenant,
} from './helpers.js';

const configured = !!process.env['DATABASE_URL'] && !!process.env['INGESTION_URL'];

describe.skipIf(!configured)('credential boundary', () => {
  let tenant: TestTenant;

  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    error: { type: 'Error', message: 'boundary probe', stack: 'at x (a.js:1:1)' },
  });

  function post(
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    const { ingestionUrl } = getConfig();
    return fetch(`${ingestionUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  beforeAll(async () => {
    tenant = await seedTenant('e2e/credential-boundary');
  }, 30_000);

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('accepts telemetry from the public key only', async () => {
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.ingestKey }, event)).status).toBe(202);
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.sourceMapKey }, event)).status).toBe(403);
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.revokedKey }, event)).status).toBe(401);
    // A session is for reading. It must not be a way to write telemetry.
    expect((await post('/api/v1/events', { Authorization: `Bearer ${tenant.userSession}` }, event)).status).toBe(401);
  });

  it('refuses incident reads to a VALID public key', async () => {
    // The existing negative test sends a malformed def_ key, which proves
    // nothing about a real key that authenticates fine elsewhere.
    const res = await fetch(
      `${getConfig().ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents`,
      { headers: { 'X-API-Key': tenant.ingestKey } },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('invalid_api_key');
  });

  it('answers ping for an ingest key and nothing else', async () => {
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.ingestKey })).status).toBe(204);
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.sourceMapKey })).status).toBe(403);
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.revokedKey })).status).toBe(401);
  });

  it('keeps the source-map upload route deleted', async () => {
    expect((await post('/api/v1/sourcemaps', { 'X-API-Key': tenant.ingestKey })).status).toBe(404);
    expect((await post('/api/v1/sourcemaps', { 'X-API-Key': tenant.sourceMapKey })).status).toBe(404);
  });

  it('refuses a wrong-scope key on replay and session routes', async () => {
    for (const path of ['/api/v1/replays/init', '/api/v1/sessions/init']) {
      const res = await post(path, {
        'X-API-Key': tenant.sourceMapKey,
        Origin: 'https://qa.example.com',
      }, '{}');
      expect(res.status, path).toBe(403);
      expect((await res.json()).code).toBe('insufficient_scope');
    }
  });
});
