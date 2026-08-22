import { describe, expect, it, vi } from 'vitest';
import { authedFetch } from '../authed-fetch.js';

describe('authedFetch', () => {
  it('sends the session as a Bearer token', async () => {
    const fetchFn = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response('{}', { status: 200 }));

    await authedFetch('https://api.test/x', {
      apiUrl: 'https://api.test',
      fetchFn,
      loadToken: async () => ({
        accessToken: 'tok',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect((init.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
  });

  it('forwards an explicit method and body', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await authedFetch('https://api.example.com/thing', {
      apiUrl: 'https://api.example.com',
      fetchFn,
      loadToken: async () => ({ accessToken: 'tok' }),
      method: 'POST',
    });

    expect(seen[0]?.init?.method).toBe('POST');
    expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('still defaults to GET', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await authedFetch('https://api.example.com/thing', {
      apiUrl: 'https://api.example.com',
      fetchFn,
      loadToken: async () => ({ accessToken: 'tok' }),
    });

    expect(seen[0]?.method).toBeUndefined();
  });

  it('reports a missing session instead of sending nothing', async () => {
    const fetchFn = vi.fn();

    await expect(authedFetch('https://api.test/x', {
      apiUrl: 'https://api.test',
      fetchFn,
      loadToken: async () => null,
    })).rejects.toThrow(/opslane login/);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
