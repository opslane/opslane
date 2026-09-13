// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubInstallUrl } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub install API', () => {
  it('mints the install link with an authenticated POST', async () => {
    const response = { install_url: 'https://github.com/apps/opslane/installations/new?state=s' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubInstallUrl()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/github/install-url', expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{}',
    }));
  });
});
