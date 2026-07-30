import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRepoURL, setup } from '../setup.js';
import { loadPendingSession, savePendingSession } from '../pending.js';
import { loadAgentCredentials, saveAgentCredentials } from '../agent-credentials.js';
import { persistTokensTo } from '../auth.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

const pollId = '123e4567-e89b-42d3-a456-426614174000';
const apiUrl = 'https://api.opslane.com';

describe('normalizeRepoURL', () => {
  it.each([
    ['https://github.com/acme/my-app.git', 'acme/my-app'],
    ['git@github.com:acme/my-app.git', 'acme/my-app'],
    ['https://github.com/acme/my-app', 'acme/my-app'],
    ['acme/my-app', 'acme/my-app'],
    ['https://gitlab.com/acme/my-app', null],
  ])('normalizes %s', (input, expected) => expect(normalizeRepoURL(input)).toBe(expected));
});

describe('agent setup protocol', () => {
  let directory: string;
  let credentialsPath: string;
  let pendingDir: string;
  let tokenPath: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opslane-setup-'));
    credentialsPath = join(directory, 'agent-credentials.json');
    pendingDir = join(directory, 'pending');
    tokenPath = join(directory, 'credentials.json');
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const authBody = {
    status: 'auth_required', auth_url: 'https://api.opslane.com/agent/auth/x',
    poll_id: pollId, poll_token: 'poll-secret', message: 'authorize',
  };

  it('--start writes pending state and emits exactly one stdout document', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(authBody), { status: 201 }));
    await setup({ start: true, repo: 'acme/app', apiUrl, credentialsPath, pendingDir, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject(authBody);
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toMatchObject({ poll_token: 'poll-secret', repo: 'acme/app' });
  });

  it('--poll inherits origin/token and saves completed credentials', async () => {
    await savePendingSession({
      poll_id: pollId, poll_token: 'poll-secret', api_url: 'http://localhost:8082',
      repo: 'acme/app', created_at: new Date().toISOString(),
    }, pendingDir);
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ 'X-Opslane-Poll-Token': 'poll-secret' });
      return new Response(JSON.stringify({
        status: 'completed', org_id: 'org-1', project_id: 'project-1',
        api_key: 'key-new', repo: 'acme/app',
      }));
    });
    await setup({ poll: pollId, apiUrl: 'https://wrong.test', credentialsPath, pendingDir, fetchFn });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('http://localhost:8082');
    await expect(loadAgentCredentials({
      filePath: credentialsPath, apiUrl: 'http://localhost:8082', repo: 'acme/app',
    })).resolves.toMatchObject({ api_key: 'key-new' });
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toBeNull();
  });

  it('stores the development key, keeps polling through key_ok, and completes on app_reporting', async () => {
    await savePendingSession({
      poll_id: pollId, poll_token: 'poll-secret', api_url: apiUrl,
      repo: 'acme/app', created_at: new Date().toISOString(),
    }, pendingDir);
    const tenant = { org_id: 'org-1', project_id: 'project-1', repo: 'acme/app' };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'provisioned', api_key: 'dev-key', ...tenant })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'key_ok', api_key: 'dev-key', ...tenant })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'app_reporting', ...tenant })));

    await setup({
      poll: pollId, credentialsPath, pendingDir, fetchFn,
      pollIntervalMs: 0, sleepFn: async () => undefined,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    await expect(loadAgentCredentials({ filePath: credentialsPath, apiUrl, repo: 'acme/app' }))
      .resolves.toMatchObject({ api_key: 'dev-key', project_id: 'project-1' });
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toBeNull();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'completed' });
  });

  it('maps completed without a key to key_unavailable and deletes pending state', async () => {
    await savePendingSession({ poll_id: pollId, poll_token: 'x', api_url: apiUrl, repo: 'acme/app', created_at: new Date().toISOString() }, pendingDir);
    await setup({
      poll: pollId, credentialsPath, pendingDir,
      fetchFn: async () => new Response(JSON.stringify({ status: 'completed', project_id: 'project-1' })),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'key_unavailable', project_id: 'project-1' });
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toBeNull();
  });

  it('does not complete app_reporting without a delivered or previously saved key', async () => {
    await savePendingSession({ poll_id: pollId, poll_token: 'x', api_url: apiUrl, repo: 'acme/app', created_at: new Date().toISOString() }, pendingDir);
    await setup({
      poll: pollId, credentialsPath, pendingDir,
      fetchFn: async () => new Response(JSON.stringify({
        status: 'app_reporting', org_id: 'org-1', project_id: 'project-1', repo: 'acme/app',
      })),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'key_unavailable', project_id: 'project-1',
    });
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toBeNull();
  });

  it('maps not_found and invalid timeout to stable statuses', async () => {
    await setup({ poll: pollId, pendingDir, timeout: 'nope' });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).status).toBe('usage_error');
    log.mockClear(); vi.mocked(process.exit).mockClear();
    await savePendingSession({ poll_id: pollId, poll_token: 'x', api_url: apiUrl, repo: 'acme/app', created_at: new Date().toISOString() }, pendingDir);
    await setup({ poll: pollId, pendingDir, fetchFn: async () => new Response(JSON.stringify({ status: 'not_found' }), { status: 404 }) });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).status).toBe('not_found');
  });

  it('rejects an invalid blocking timeout before network or pending-file side effects', async () => {
    const fetchFn = vi.fn();
    await setup({
      repo: 'acme/app', apiUrl, timeout: 'nope', credentialsPath, pendingDir, fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'usage_error' });
    await expect(loadPendingSession(pollId, pendingDir)).resolves.toBeNull();
  });

  it('maps an invalid API URL to usage_error without making a request', async () => {
    const fetchFn = vi.fn();
    await setup({ start: true, repo: 'acme/app', apiUrl: 'file:///tmp/opslane', fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'usage_error' });
  });

  it('blocking setup sends auth_required to stderr and only completion to stdout', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(authBody), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', org_id: 'org-1', project_id: 'project-1', api_key: 'key', repo: 'acme/app',
      })));
    await setup({ repo: 'acme/app', apiUrl, credentialsPath, pendingDir, fetchFn, pollIntervalMs: 0 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0])).status).toBe('auth_required');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).status).toBe('completed');
  });

  it('--force preserves the old key when the server refuses a new session', async () => {
    await saveAgentCredentials({ org_id: 'org-1', project_id: 'project-1', api_key: 'old-key', repo: 'acme/app', api_url: apiUrl }, credentialsPath);
    await setup({
      force: true, repo: 'acme/app', apiUrl, credentialsPath, pendingDir,
      fetchFn: async () => new Response(JSON.stringify({ status: 'already_configured', repo: 'acme/app' })),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    await expect(loadAgentCredentials({ filePath: credentialsPath, apiUrl, repo: 'acme/app' }))
      .resolves.toMatchObject({ api_key: 'old-key' });
  });

  it('validates an existing ingest key through the ingest ping', async () => {
    await saveAgentCredentials({
      org_id: 'org-1',
      project_id: 'project-1',
      api_key: TEST_PUBLIC_KEY,
      repo: 'acme/app',
      api_url: apiUrl,
    }, credentialsPath);
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'X-API-Key': TEST_PUBLIC_KEY },
      });
      return new Response(null, { status: 204 });
    });

    await setup({ repo: 'acme/app', apiUrl, credentialsPath, pendingDir, fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(`${apiUrl}/api/v1/ingest/ping`, {
      method: 'POST',
      headers: { 'X-API-Key': TEST_PUBLIC_KEY },
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'already_configured',
      project_id: 'project-1',
    });
  });

  it.each([
    [new Response(JSON.stringify({ status: 'rate_limited', retry_after: 7 }), { status: 429, headers: { 'Retry-After': '60' } }), 'rate_limited', { retry_after: 7 }],
    [new Response('not-json', { status: 500 }), 'internal_error', { message: 'unparseable server response' }],
    [new Response(JSON.stringify({ status: 'internal_error', message: 'server failed' }), { status: 500 }), 'internal_error', { message: 'server failed' }],
    [new Response(JSON.stringify({ status: 'surprise' }), { status: 418 }), 'internal_error', { message: 'unrecognized setup response' }],
  ] as const)('maps initial setup response to %s', async (response, expectedStatus, expectedFields) => {
    await setup({
      start: true, repo: 'acme/app', apiUrl, credentialsPath, pendingDir,
      fetchFn: async () => response.clone(),
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: expectedStatus,
      ...expectedFields,
    });
  });

  it('backs off on poll rate limits and then completes', async () => {
    await savePendingSession({ poll_id: pollId, poll_token: 'x', api_url: apiUrl, repo: 'acme/app', created_at: new Date().toISOString() }, pendingDir);
    const sleepFn = vi.fn(async () => undefined);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'rate_limited', retry_after: 2 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', org_id: 'org', project_id: 'project', api_key: 'key', repo: 'acme/app',
      })));
    await setup({ poll: pollId, credentialsPath, pendingDir, fetchFn, sleepFn });
    expect(sleepFn).toHaveBeenCalledWith(2_000);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).status).toBe('completed');
  });

  it('--relink mints and saves a key only after authenticated success', async () => {
    await persistTokensTo(tokenPath, apiUrl, {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000,
    });
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v1/projects')) return new Response(JSON.stringify([{ id: 'project-1', github_repo: 'Acme/App' }]));
      if (url.endsWith('/environments')) return new Response(JSON.stringify([{ id: 'env-dev', name: 'development' }, { id: 'env-prod', name: 'production' }]));
      expect(url).toContain('/environments/env-dev/api-keys');
      return new Response(JSON.stringify({ raw_key: 'fresh-key' }), { status: 201 });
    });
    await setup({ relink: true, repo: 'acme/app', apiUrl, credentialsPath, tokenPath, fetchFn });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'relinked', api_key: 'fresh-key' });
    await expect(loadAgentCredentials({ filePath: credentialsPath, apiUrl, repo: 'acme/app' }))
      .resolves.toMatchObject({ api_key: 'fresh-key', project_id: 'project-1' });
  });

  it('--relink reports the active-org mismatch without replacing an old key', async () => {
    await saveAgentCredentials({ org_id: 'org', project_id: 'project', api_key: 'old-key', repo: 'acme/app', api_url: apiUrl }, credentialsPath);
    await persistTokensTo(tokenPath, apiUrl, {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000,
    });
    await setup({
      relink: true, repo: 'acme/app', apiUrl, credentialsPath, tokenPath,
      fetchFn: async () => new Response(JSON.stringify([])),
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).status).toBe('project_not_in_active_org');
    await expect(loadAgentCredentials({ filePath: credentialsPath, apiUrl, repo: 'acme/app' }))
      .resolves.toMatchObject({ api_key: 'old-key' });
  });
});
