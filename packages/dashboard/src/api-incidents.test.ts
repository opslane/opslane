// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSampleEvent, listIncidents, triggerFix } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown): object {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

describe('incident API', () => {
  it('submits a signed digest intent through the authenticated POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ job_id: 'job' }));
    vi.stubGlobal('fetch', fetchMock);
    await triggerFix('p1', 'i1', undefined, 'signed.intent');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/p1/incidents/i1/fix',
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ intent: 'signed.intent' }) }));
  });

  it('includes the platform filter when set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    await listIncidents('p1', { platform: 'python' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1/incidents?platform=python',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('omits the platform filter when unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    await listIncidents('p1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1/incidents',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('fetches an incident sample event', async () => {
    const event = {
      timestamp: '2026-07-19T00:00:00Z',
      platform: 'python',
      error: { type: 'ValueError', message: 'boom', stack: 'Traceback' },
      breadcrumbs: [],
      context: {},
    };
    const fetchMock = vi.fn().mockResolvedValue(response(event));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSampleEvent('p1', 'i1')).resolves.toEqual(event);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1/incidents/i1/sample-event',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
