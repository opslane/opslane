import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn() },
  safeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { billingEnabled, checkQuota } from '../billing.js';

describe('worker billing quota client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([undefined, '', '   '])('is a no-op without a non-blank key (%s)', async (key) => {
    if (key !== undefined) vi.stubEnv('AUTUMN_SECRET_KEY', key);
    else vi.stubEnv('AUTUMN_SECRET_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(billingEnabled()).toBe(false);
    await expect(checkQuota('org-1', 'Acme', 'merged_prs')).resolves.toEqual({
      allowed: true,
      failedOpen: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the customer and returns an explicit denied quota verdict', async () => {
    vi.stubEnv('AUTUMN_SECRET_KEY', '  sk_test  ');
    vi.stubEnv('AUTUMN_BASE_URL', 'https://autumn.test/');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"allowed":false}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkQuota('org-1', 'Acme', 'merged_prs')).resolves.toEqual({
      allowed: false,
      failedOpen: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://autumn.test/v1/customers.get_or_create');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://autumn.test/v1/balances.check');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer sk_test',
        'x-api-version': '2.3.0',
      }),
    });
  });

  it('falls back from empty optional env vars and sends an atomic investigation event', async () => {
    vi.stubEnv('AUTUMN_SECRET_KEY', 'sk_test');
    vi.stubEnv('AUTUMN_BASE_URL', '');
    vi.stubEnv('AUTUMN_FREE_PLAN_ID', '');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"allowed":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkQuota('org-1', 'Acme', 'investigations', { sendEvent: true })).resolves.toEqual({
      allowed: true,
      failedOpen: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.useautumn.com/v1/customers.get_or_create');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      customer_id: 'org-1',
      name: 'Acme',
      auto_enable_plan_id: 'free',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      customer_id: 'org-1',
      feature_id: 'investigations',
      send_event: true,
    });
  });

  it.each([
    ['network failure', [() => Promise.reject(new Error('offline'))]],
    ['customer failure', [() => Promise.resolve(new Response('', { status: 500 }))]],
    ['check failure', [
      () => Promise.resolve(new Response('{}', { status: 200 })),
      () => Promise.resolve(new Response('', { status: 503 })),
    ]],
    ['malformed boolean', [
      () => Promise.resolve(new Response('{}', { status: 200 })),
      () => Promise.resolve(new Response('{"allowed":"false"}', { status: 200 })),
    ]],
    ['missing verdict', [
      () => Promise.resolve(new Response('{}', { status: 200 })),
      () => Promise.resolve(new Response('{}', { status: 200 })),
    ]],
  ])('fails open and marks provider uncertainty on %s', async (_name, responses) => {
    vi.stubEnv('AUTUMN_SECRET_KEY', 'sk_test');
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockImplementationOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkQuota('org-1', 'Acme', 'merged_prs')).resolves.toEqual({
      allowed: true,
      failedOpen: true,
    });
  });
});
