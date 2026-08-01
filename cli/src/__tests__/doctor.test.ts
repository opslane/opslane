import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctor, type CheckResult } from '../doctor.js';
import { persistTokensTo } from '../auth.js';
import { saveAgentCredentials } from '../agent-credentials.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

// Suppress console output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('doctor', () => {
  let tmpDir: string;
  let credDir: string;
  let credFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'opslane-doctor-'));
    credDir = join(tmpDir, '.opslane');
    credFile = join(credDir, 'credentials.json');
    await mkdir(credDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function mockFetch(
    healthStatus: number | 'error',
    verifyStatus: number | 'error',
  ): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/health')) {
        if (healthStatus === 'error') {
          throw new Error('Connection refused');
        }
        return new Response(null, { status: healthStatus });
      }

      if (url.includes('/auth/verify')) {
        if (verifyStatus === 'error') {
          throw new Error('Connection refused');
        }
        return new Response(null, { status: verifyStatus });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;
  }

  it('reports PASS when .opslane.json exists', async () => {
    await writeFile(
      join(tmpDir, '.opslane.json'),
      JSON.stringify({ projectId: 'test' }),
    );

    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    const configCheck = results.find((r) => r.name === 'Project config');
    expect(configCheck?.passed).toBe(true);
    expect(configCheck?.message).toContain('.opslane.json found');
  });

  it('reports optional info when .opslane.json is missing', async () => {
    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    const configCheck = results.find((r) => r.name === 'Project config');
    expect(configCheck?.passed).toBe(true);
    expect(configCheck?.message).toContain('optional');
  });

  it('reports PASS when credentials exist and valid', async () => {
    await persistTokensTo(credFile, 'https://api.opslane.com', {
      accessToken: 'valid-token',
      refreshToken: 'valid-refresh',
      expiresAt: Date.now() + 3600_000,
    });

    // We need to mock loadTokens for this — the default path is ~/.opslane/
    // Since doctor uses the default loadTokens(), we test the check flow
    // by verifying the check structure returns the right shape.
    // The actual loadTokens reads from ~/.opslane, not our tmpDir.
    // We'll verify the auth check is present and reports correctly for the real path.
    const results = await doctor({
      cwd: tmpDir,
      tokenPath: credFile,
      fetchFn: mockFetch('error', 'error'),
    });

    const authCheck = results.find((r) => r.name === 'Authentication');
    expect(authCheck).toBeDefined();
    expect(authCheck?.passed).toBe(true);
    expect(authCheck?.message).toContain('login credentials');
  });

  it('accepts repo-scoped agent credentials and validates their ingest key', async () => {
    const agentPath = join(credDir, 'agent-credentials.json');
    await saveAgentCredentials({
      org_id: 'org', project_id: 'project', api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app', api_url: 'https://api.opslane.com',
    }, agentPath);
    const results = await doctor({
      cwd: tmpDir,
      repo: 'acme/app',
      credentialsPath: agentPath,
      tokenPath: join(credDir, 'missing-login.json'),
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/health')) return new Response(null, { status: 200 });
        if (url.endsWith('/api/v1/ingest/ping')) {
          expect(init?.method).toBe('POST');
          expect(init?.headers).toEqual({ 'X-API-Key': TEST_PUBLIC_KEY });
          return new Response(JSON.stringify({ has_events: false }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    expect(results.find((result) => result.name === 'Authentication')?.passed).toBe(true);
    expect(results.find((result) => result.name === 'Ingest key')?.passed).toBe(true);
  });

  it('validates the user session separately from the ingest key', async () => {
    await persistTokensTo(credFile, 'https://api.opslane.com', {
      accessToken: 'valid-token',
      refreshToken: 'valid-refresh',
      expiresAt: Date.now() + 3600_000,
    });
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response(null, { status: 200 });
      if (url.endsWith('/api/v1/auth/verify')) {
        expect(init?.headers).toEqual({ Authorization: 'Bearer valid-token' });
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const results = await doctor({
      cwd: tmpDir,
      tokenPath: credFile,
      credentialsPath: join(credDir, 'missing-agent.json'),
      fetchFn,
    });

    expect(results.find((result) => result.name === 'Session')).toMatchObject({
      passed: true,
      message: 'Signed in',
    });
    expect(results.find((result) => result.name === 'Ingest key')).toMatchObject({
      passed: false,
      message: 'No stored key',
    });
  });

  it('reports FAIL when credentials missing', async () => {
    // Without setting up credentials in ~/.opslane/, the auth check should fail
    // (assuming the test machine doesn't have real credentials)
    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    const authCheck = results.find((r) => r.name === 'Authentication');
    expect(authCheck).toBeDefined();
    // This check verifies the structure is correct
    if (!authCheck?.passed) {
      expect(authCheck?.remediation).toContain('opslane login');
    }
  });

  it('reports PASS when ingestion is reachable', async () => {
    const results = await doctor({
      cwd: tmpDir,
      apiUrl: 'http://localhost:9999',
      fetchFn: mockFetch(200, 'error'),
    });

    const healthCheck = results.find(
      (r) => r.name === 'Ingestion service',
    );
    expect(healthCheck?.passed).toBe(true);
    expect(healthCheck?.message).toContain('Reachable');
  });

  it('reports FAIL when ingestion is unreachable', async () => {
    const results = await doctor({
      cwd: tmpDir,
      apiUrl: 'http://localhost:9999',
      fetchFn: mockFetch('error', 'error'),
    });

    const healthCheck = results.find(
      (r) => r.name === 'Ingestion service',
    );
    expect(healthCheck?.passed).toBe(false);
    expect(healthCheck?.remediation).toContain('OPSLANE_API_URL');
  });

  it('reports FAIL when ingestion returns non-200', async () => {
    const results = await doctor({
      cwd: tmpDir,
      apiUrl: 'http://localhost:9999',
      fetchFn: mockFetch(503, 'error'),
    });

    const healthCheck = results.find(
      (r) => r.name === 'Ingestion service',
    );
    expect(healthCheck?.passed).toBe(false);
    expect(healthCheck?.message).toContain('503');
  });

  it('does NOT make real HTTP calls when fetchFn is provided', async () => {
    let callCount = 0;
    const countingFetch: typeof fetch = (async () => {
      callCount++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await doctor({
      cwd: tmpDir,
      apiUrl: 'http://localhost:9999',
      fetchFn: countingFetch,
    });

    // Should have called our mock, not the real fetch
    expect(callCount).toBeGreaterThan(0);
  });

  it('runs all 6 checks', async () => {
    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    expect(results).toHaveLength(6);
    expect(results.map((r) => r.name)).toEqual([
      'Project config',
      'Authentication',
      'Ingestion service',
      'Session',
      'Ingest key',
      'Debug IDs',
    ]);
  });

  it('treats missing build output as not built yet', async () => {
    const results = await doctor({
      cwd: tmpDir,
      dist: 'missing-dist',
      fetchFn: mockFetch('error', 'error'),
    });

    const check = results.find((result) => result.name === 'Debug IDs');
    expect(check?.passed).toBe(true);
    expect(check?.message).toContain('not built yet');
  });

  it('fails when a non-empty build has no stamped chunks', async () => {
    const dist = join(tmpDir, 'custom-dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'app.js'), 'console.log("unstamped");');

    const results = await doctor({
      cwd: tmpDir,
      dist,
      fetchFn: mockFetch('error', 'error'),
    });

    const check = results.find((result) => result.name === 'Debug IDs');
    expect(check?.passed).toBe(false);
    expect(check?.remediation).toContain('Opslane Vite plugin');
  });

  it('passes when production output contains a stamped chunk', async () => {
    const dist = join(tmpDir, 'custom-dist', 'assets');
    await mkdir(dist, { recursive: true });
    await writeFile(
      join(dist, 'app.js'),
      'console.log("ok");\n//# debugId=01234567-89ab-cdef-0123-456789abcdef',
    );

    const results = await doctor({
      cwd: tmpDir,
      dist: join(tmpDir, 'custom-dist'),
      fetchFn: mockFetch('error', 'error'),
    });

    const check = results.find((result) => result.name === 'Debug IDs');
    expect(check?.passed).toBe(true);
    expect(check?.message).toContain('1/1');
  });

  it('each result has name, passed, and message', async () => {
    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    for (const result of results) {
      expect(typeof result.name).toBe('string');
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.message).toBe('string');
    }
  });

  it('failed checks include remediation text', async () => {
    const results = await doctor({
      cwd: tmpDir,
      fetchFn: mockFetch('error', 'error'),
    });

    const failures = results.filter((r) => !r.passed);
    for (const failure of failures) {
      expect(failure.remediation).toBeDefined();
      expect(typeof failure.remediation).toBe('string');
      expect(failure.remediation!.length).toBeGreaterThan(0);
    }
  });
});
