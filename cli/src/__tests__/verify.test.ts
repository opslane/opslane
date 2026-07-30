import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyConnection } from '../verify.js';
import { saveAgentCredentials } from '../agent-credentials.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

vi.spyOn(console, 'log').mockImplementation(() => {});

describe('verifyConnection', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-verify-'));
    credFile = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when no credentials found', async () => {
    const result = await verifyConnection({
      credentialsPath: join(tmpDir, 'missing.json'),
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    expect(result.status).toBe('no_credentials');
    expect(result.message).toContain('credentials');
  });

  it('returns ok with has_events when API is reachable', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const result = await verifyConnection({
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      loadToken: async () => ({ accessToken: 'session-token' }),
      fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : '';
        if (url.includes('/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.includes('/event-count')) {
          expect(init?.headers).toEqual({ Authorization: 'Bearer session-token' });
          return new Response(JSON.stringify({ has_events: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    expect(result.status).toBe('ok');
    expect(result.api_reachable).toBe(true);
    expect(result.has_events).toBe(true);
    expect(result.message).toContain('Events received');
  });

  it('returns error when health check fails', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const result = await verifyConnection({
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      fetchFn: async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : '';
        if (url.includes('/health')) {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 404 });
      },
    });
    expect(result.status).toBe('error');
    expect(result.api_reachable).toBe(false);
    expect(result.message).toContain('unhealthy');
  });

  it('returns error when no user session is available for the project read', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const result = await verifyConnection({
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      loadToken: async () => null,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    expect(result).toMatchObject({
      status: 'error',
      api_reachable: true,
      has_events: false,
    });
    expect(result.message).toContain('opslane login');
  });

  it('returns error when the session-authenticated project read is rejected', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'proj-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: 'http://localhost:8082',
    }, credFile);

    const result = await verifyConnection({
      credentialsPath: credFile,
      apiUrl: 'http://localhost:8082',
      repo: 'acme/app',
      loadToken: async () => ({ accessToken: 'expired-session' }),
      fetchFn: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/health')) return new Response(null, { status: 200 });
        return new Response(JSON.stringify({ error: 'invalid or expired token' }), {
          status: 401,
        });
      },
    });

    expect(result).toMatchObject({
      status: 'error',
      api_reachable: true,
      has_events: false,
      message: 'invalid or expired token',
    });
  });
});
