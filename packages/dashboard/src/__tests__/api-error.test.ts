import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

function stubFetch(status: number, body: string, contentType: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
    status,
    statusText: status === 502 ? 'Bad Gateway' : 'Error',
    headers: { 'Content-Type': contentType },
  })));
}

describe('APIError', () => {
  it('exposes code and extra fields from a JSON error body', async () => {
    stubFetch(400, JSON.stringify({ error: 'cannot see acme/web', code: 'repo_not_in_installation', add_repo_url: 'https://github.com/settings/installations/7' }), 'application/json');
    const { fetchJSON, APIError } = await import('../api');
    const err = await fetchJSON('/github/repos').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as InstanceType<typeof APIError>;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe('repo_not_in_installation');
    expect(apiErr.message).toBe('cannot see acme/web');
    expect(apiErr.details.add_repo_url).toBe('https://github.com/settings/installations/7');
  });

  it('collapses a non-JSON body to one line', async () => {
    stubFetch(502, '<!DOCTYPE html><html><body>Bad gateway</body></html>', 'text/html');
    const { fetchJSON, APIError } = await import('../api');
    const err = await fetchJSON('/github/repos').catch((error: unknown) => error) as InstanceType<typeof APIError>;
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toBe('API 502: Bad Gateway');
    expect(err.message).not.toContain('<');
    expect(err.code).toBeUndefined();
  });
});
