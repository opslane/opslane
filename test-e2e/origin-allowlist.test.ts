/**
 * E2E: a project with a browser origin allowlist must still accept
 * server-side SDK events, which carry neither Origin nor Referer (#104),
 * while browser-shaped requests stay gated and browser-only routes stay
 * strict.
 *
 * Required:
 *   DATABASE_URL   — Postgres connection string
 *   INGESTION_URL  — Base URL for ingestion API (default: http://localhost:8082)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  seedTenant, cleanupTenant, closePool, getPool, getConfig, postEvent,
  type TestTenant,
} from './helpers.js';

const ALLOWED_ORIGIN = 'https://app.allowlisted.example';

function errorPayload(message: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    platform: 'python',
    error: {
      type: 'ValueError',
      message,
      stack: `Traceback (most recent call last):\nValueError: ${message}`,
    },
    breadcrumbs: [],
    context: {},
  };
}

async function post(
  path: string,
  apiKey: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { ingestionUrl } = getConfig();
  return fetch(`${ingestionUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...headers },
    body: JSON.stringify(body),
  });
}

describe('origin allowlist with a server-side SDK', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await seedTenant('e2e/origin-allowlist');
    await getPool().query(
      `UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
      [tenant.projectId, [ALLOWED_ORIGIN]],
    );
  }, 30_000);

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('accepts a backend event that carries no Origin or Referer', async () => {
    const res = await postEvent(tenant.ingestKey, errorPayload('backend accepted'));
    expect(res.status).toBe(202);
  });

  it('accepts a browser event from an allowlisted origin', async () => {
    const res = await post('/api/v1/events', tenant.ingestKey, errorPayload('browser ok'),
      { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(202);
  });

  it('rejects a browser event from an origin not on the list', async () => {
    const res = await post('/api/v1/events', tenant.ingestKey, errorPayload('browser blocked'),
      { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a referer-only event from an origin not on the list', async () => {
    const res = await post('/api/v1/events', tenant.ingestKey, errorPayload('referer blocked'),
      { Referer: 'https://evil.example/checkout' });
    expect(res.status).toBe(403);
  });

  it('keeps browser-only routes strict for header-less callers', async () => {
    const res = await post('/api/v1/sessions/init', tenant.ingestKey, {});
    expect(res.status).toBe(403);
  });
});
