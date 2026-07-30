/**
 * E2E: Python SDK smoke — real Flask fixture app + real SDK → real ingestion.
 *
 * Two legs:
 * 1. Live Flask leg (needs a Python with flask importable): spawns
 *    python-smoke-runner.py, which serves test-fixtures/flask-app with the
 *    real opslane SDK attached, then triggers errors over real HTTP and
 *    verifies grouping, platform read-through/filter, the sample-event read
 *    path, redaction (client-side, write-side, and read-side), and the
 *    session-only auth contract. Skipped with a message when flask is absent.
 * 2. Wire-level adversarial leg (no Python required): hand-built payloads a
 *    hostile non-SDK client could send, asserting the server's
 *    defense-in-depth holds without any client cooperation.
 *
 * Required:
 *   DATABASE_URL     — Postgres connection string
 *   INGESTION_URL    — Base URL for ingestion API (default: http://localhost:8082)
 * Optional:
 *   OPSLANE_PYTHON   — Python interpreter with flask installed (default: python3)
 *   JWT_SECRET       — must match the stack's secret (default: compose dev secret)
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  seedTenant,
  seedUserWithJWT,
  cleanupTenant,
  closePool,
  getConfig,
  getPool,
  postEvent,
  type TestTenant,
} from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'python-smoke-runner.py');

const PYTHON = process.env['OPSLANE_PYTHON'] ?? 'python3';
const HAS_FLASK = (() => {
  try {
    execFileSync(PYTHON, ['-c', 'import flask'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();
if (!HAS_FLASK) {
  console.warn(
    `python-smoke: skipping live Flask leg — "${PYTHON}" cannot import flask. ` +
    'Point OPSLANE_PYTHON at an interpreter with flask installed to run it.'
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const DEFAULT_JWT_SECRET = 'opslane-dev-jwt-secret-key-minimum-32-bytes-long';

/** Mint an HS256 session JWT with arbitrary claims/secret (for adversarial cases). */
function mintJWT(
  claims: Record<string, unknown>,
  secret = process.env['JWT_SECRET'] ?? DEFAULT_JWT_SECRET,
): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest().toString('base64url');
  return `${signingInput}.${sig}`;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close();
        reject(new Error('could not allocate a port'));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function pollFor<T>(
  fetchValue: () => Promise<T>,
  ready: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fetchValue();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

interface IncidentRow {
  id: string;
  title: string;
  kind: string;
  platform?: string;
  occurrence_count: number;
}

async function listIncidentsRaw(
  sessionToken: string,
  projectId: string,
  query = '',
): Promise<{ status: number; incidents: IncidentRow[] }> {
  const { ingestionUrl } = getConfig();
  const res = await fetch(
    `${ingestionUrl}/api/v1/projects/${projectId}/incidents${query}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } },
  );
  if (!res.ok) return { status: res.status, incidents: [] };
  return { status: res.status, incidents: (await res.json()) as IncidentRow[] };
}

function sampleEventUrl(projectId: string, incidentId: string): string {
  const { ingestionUrl } = getConfig();
  return `${ingestionUrl}/api/v1/projects/${projectId}/incidents/${incidentId}/sample-event`;
}

interface SampleEventBody {
  timestamp: string;
  platform: string;
  error: { type: string; message: string; stack: string };
  breadcrumbs: unknown[];
  context: Record<string, unknown>;
}

function requestHeadersOf(body: SampleEventBody): Record<string, unknown> {
  const request = body.context['request'];
  if (typeof request !== 'object' || request === null) return {};
  const headers = (request as Record<string, unknown>)['headers'];
  if (typeof headers !== 'object' || headers === null) return {};
  return headers as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Leg 1: live Flask app + real SDK
// ---------------------------------------------------------------------------

describe.runIf(HAS_FLASK)('python SDK live smoke (Flask fixture → ingestion)', () => {
  let tenant: TestTenant;
  let jwt: string;
  let flask: ChildProcess | null = null;
  let boomIncident: IncidentRow;
  let secretIncident: IncidentRow;

  beforeAll(async () => {
    tenant = await seedTenant('e2e/python-smoke');
    ({ jwt } = await seedUserWithJWT(tenant.orgId));

    const port = await getFreePort();
    const appUrl = `http://127.0.0.1:${port}`;
    flask = spawn(PYTHON, [RUNNER], {
      env: {
        ...process.env,
        OPSLANE_API_KEY: tenant.ingestKey,
        OPSLANE_ENDPOINT: getConfig().ingestionUrl,
        PORT: String(port),
      },
      stdio: 'ignore',
    });

    await pollFor(
      async () => {
        try {
          return (await fetch(`${appUrl}/health`)).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
      'flask fixture app to boot',
      20_000,
    );

    // First occurrence: benign. Second occurrence: adversarial headers — the
    // sample event tracks the LAST occurrence, so the served sample must be
    // the one that carried secrets.
    expect((await fetch(`${appUrl}/boom`)).status).toBe(500);
    expect(
      (
        await fetch(`${appUrl}/boom`, {
          headers: {
            // Stripped client-side by the SDK's own deny-list:
            Authorization: 'Bearer client-side-should-strip',
            // NOT in the SDK's client-side list — reaches the server, which
            // must redact it at write time and drop the key at read time:
            'X-Vault-Token': 'fake-vault-secret-e2e',
            // Benign marker — must SURVIVE filtering (prove we filter
            // selectively, not by dropping everything):
            'X-E2E-Benign': 'benign-value-visible',
          },
        })
      ).status,
    ).toBe(500);
    // Distinct incident whose message and traceback carry planted fake secrets.
    expect((await fetch(`${appUrl}/boom-secret`)).status).toBe(500);

    // SDK transport is async — wait until both incidents landed and grouped.
    const incidents = await pollFor(
      async () => (await listIncidentsRaw(tenant.userSession, tenant.projectId)).incidents,
      (rows) =>
        rows.length === 2 &&
        rows.some((r) => r.title.includes('seeded failure') && r.occurrence_count >= 2) &&
        rows.some((r) => r.title.includes('connect to')),
      'both python incidents to be ingested and grouped',
    );
    boomIncident = incidents.find((r) => r.title.includes('seeded failure'))!;
    secretIncident = incidents.find((r) => r.title.includes('connect to'))!;
  }, 90_000);

  afterAll(async () => {
    flask?.kill();
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('groups repeated Flask errors into one python incident', () => {
    expect(boomIncident.kind).toBe('error');
    expect(boomIncident.platform).toBe('python');
    expect(boomIncident.occurrence_count).toBeGreaterThanOrEqual(2);
    expect(boomIncident.title).toBe('ValueError: seeded failure for SDK testing');
  });

  it('platform filter matches python, excludes javascript, rejects garbage', async () => {
    const python = await listIncidentsRaw(tenant.userSession, tenant.projectId, '?platform=python');
    expect(python.incidents.map((r) => r.platform)).toEqual(['python', 'python']);

    const js = await listIncidentsRaw(tenant.userSession, tenant.projectId, '?platform=javascript');
    expect(js.incidents).toHaveLength(0);

    const garbage = await listIncidentsRaw(
      tenant.userSession, tenant.projectId, '?platform=Not%20A%20Token',
    );
    expect(garbage.status).toBe(400);
  });

  it('serves the traceback to a session user, uncacheable', async () => {
    const res = await fetch(sampleEventUrl(tenant.projectId, boomIncident.id), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as SampleEventBody;
    expect(body.platform).toBe('python');
    expect(body.error.type).toBe('ValueError');
    expect(body.error.stack.startsWith('Traceback (most recent call last):')).toBe(true);
    expect(body.error.stack).toContain('in boom');
    expect(Array.isArray(body.breadcrumbs)).toBe(true);
    const request = body.context['request'] as Record<string, unknown>;
    expect(request['method']).toBe('GET');
    expect(request['path']).toBe('/boom');
  });

  it('filters denied headers but keeps benign ones', async () => {
    const res = await fetch(sampleEventUrl(tenant.projectId, boomIncident.id), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const raw = JSON.stringify(await res.clone().json());
    expect(raw).not.toContain('client-side-should-strip'); // SDK stripped it
    expect(raw).not.toContain('fake-vault-secret-e2e'); // server denied it
    expect(raw).toContain('benign-value-visible'); // benign survives

    const headers = requestHeadersOf((await res.json()) as SampleEventBody);
    expect(Object.keys(headers)).not.toContain('authorization');
    expect(Object.keys(headers)).not.toContain('x-vault-token');
  });

  it('redacts planted secrets in the error message and stack', async () => {
    const res = await fetch(sampleEventUrl(tenant.projectId, secretIncident.id), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.clone().json());
    expect(raw).not.toContain('plantedfakepassword'); // DSN credential
    expect(raw).not.toContain('ghp_plantedfakee2esecret123'); // API token

    const body = (await res.json()) as SampleEventBody;
    expect(body.error.type).toBe('ValueError'); // still identifiable
    expect(body.error.message).toContain('[REDACTED]');
    expect(body.error.stack.startsWith('Traceback (most recent call last):')).toBe(true);
  });

  it('rejects every non-session credential', async () => {
    const url = sampleEventUrl(tenant.projectId, boomIncident.id);
    const attempts: Array<[string, Record<string, string>]> = [
      ['SDK API key', { 'X-API-Key': tenant.ingestKey }],
      ['no credentials', {}],
      ['garbage bearer', { Authorization: 'Bearer not-a-jwt' }],
      [
        'wrong signing secret',
        {
          Authorization: `Bearer ${mintJWT(
            {
              sub: crypto.randomUUID(),
              org_id: tenant.orgId,
              email: 'attacker@e2e.test',
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'attacker-controlled-secret-thats-long-enough',
          )}`,
        },
      ],
      [
        'expired session',
        {
          Authorization: `Bearer ${mintJWT({
            sub: crypto.randomUUID(),
            org_id: tenant.orgId,
            email: 'expired@e2e.test',
            iat: Math.floor(Date.now() / 1000) - 7200,
            exp: Math.floor(Date.now() / 1000) - 3600,
          })}`,
        },
      ],
    ];
    for (const [label, headers] of attempts) {
      const res = await fetch(url, { headers });
      expect(res.status, `${label} must be rejected`).toBe(401);
    }
  });

  it('does not disclose incidents across projects or invent them', async () => {
    // Sibling project in the SAME org: accessible to the caller, so a 403
    // would not fire first — this isolates the incident lookup's 404 path.
    const sibling = await getPool().query<{ id: string }>(
      `INSERT INTO projects (org_id, name) VALUES ($1, $2) RETURNING id`,
      [tenant.orgId, `python-smoke-sibling-${crypto.randomUUID().slice(0, 8)}`],
    );
    const crossProject = await fetch(
      sampleEventUrl(sibling.rows[0]!.id, boomIncident.id),
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(crossProject.status).toBe(404);

    const unknown = await fetch(
      sampleEventUrl(tenant.projectId, crypto.randomUUID()),
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(unknown.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Leg 2: wire-level adversarial payloads (no Python required)
// ---------------------------------------------------------------------------

describe('python wire adversarial (hostile non-SDK client)', () => {
  let tenant: TestTenant;
  let jwt: string;

  beforeAll(async () => {
    tenant = await seedTenant('e2e/python-wire-adversarial');
    ({ jwt } = await seedUserWithJWT(tenant.orgId));
  }, 30_000);

  afterAll(async () => {
    if (tenant) await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('cannot smuggle secrets past the read API with malformed shapes', async () => {
    // The SDK strips secrets client-side; a hostile client does not. Headers
    // as an array-of-pairs bypass any map-shaped filter, and non-array
    // breadcrumbs break any consumer that trusts the contract blindly.
    const res = await postEvent(tenant.ingestKey, {
      timestamp: new Date().toISOString(),
      platform: 'python',
      error: {
        type: 'RuntimeError',
        message: 'malformed shapes',
        stack: 'Traceback (most recent call last):\nRuntimeError: malformed shapes',
      },
      breadcrumbs: { not: 'an array' },
      context: {
        request: {
          method: 'GET',
          path: '/x',
          headers: [['Authorization', 'array-smuggled-secret']],
        },
      },
    });
    expect(res.status).toBe(202);
    const { group_id } = (await res.json()) as { group_id: string };

    const sample = await fetch(sampleEventUrl(tenant.projectId, group_id), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(sample.status).toBe(200);
    const raw = await sample.clone().text();
    expect(raw).not.toContain('array-smuggled-secret');

    const body = (await sample.json()) as SampleEventBody;
    expect(body.breadcrumbs).toEqual([]); // normalized, never the raw object
    const headers = requestHeadersOf(body);
    expect(Object.keys(headers)).toHaveLength(0); // dropped, never verbatim
  });

  it('shows one end user across JS and Python incidents with platforms', async () => {
    const userId = `cross-stack-${crypto.randomUUID().slice(0, 8)}`;
    const jsRes = await postEvent(tenant.ingestKey, {
      timestamp: new Date().toISOString(),
      error: {
        type: 'TypeError',
        message: 'cross-stack javascript',
        stack: 'at fn (/src/app.js:1:1)',
      },
      breadcrumbs: [],
      context: { user: { id: userId } },
    });
    expect(jsRes.status).toBe(202);
    const pyRes = await postEvent(tenant.ingestKey, {
      timestamp: new Date().toISOString(),
      platform: 'python',
      error: {
        type: 'ValueError',
        message: 'cross-stack python',
        stack: 'Traceback (most recent call last):\nValueError: cross-stack python',
      },
      breadcrumbs: [],
      context: { user: { id: userId } },
    });
    expect(pyRes.status).toBe(202);

    const timeline = await listIncidentsRaw(
      tenant.userSession, tenant.projectId, `?end_user_id=${userId}`,
    );
    expect(timeline.incidents).toHaveLength(2);
    expect(new Set(timeline.incidents.map((r) => r.platform))).toEqual(
      new Set(['javascript', 'python']),
    );
  });
});
