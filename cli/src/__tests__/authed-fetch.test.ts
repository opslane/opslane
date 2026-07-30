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
