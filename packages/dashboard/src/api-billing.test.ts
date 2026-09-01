// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBillingCheckout,
  getBillingSummary,
  openBillingPortal,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('billing API', () => {
  it('loads the summary and starts checkout and portal sessions', async () => {
    const summary = {
      plan_id: 'free',
      features: [{ feature_id: 'merged_prs', allowed: true, granted: 2, usage: 1 }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => summary })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ url: 'https://pay.example.test' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ url: 'https://portal.example.test' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getBillingSummary()).resolves.toEqual(summary);
    await expect(createBillingCheckout()).resolves.toEqual({ url: 'https://pay.example.test' });
    await expect(openBillingPortal()).resolves.toEqual({ url: 'https://portal.example.test' });

    expect(fetchMock.mock.calls).toEqual([
      ['/api/v1/billing/summary', expect.objectContaining({ credentials: 'include' })],
      ['/api/v1/billing/checkout', expect.objectContaining({
        method: 'POST', credentials: 'include', body: '{}',
      })],
      ['/api/v1/billing/portal', expect.objectContaining({
        method: 'POST', credentials: 'include', body: '{}',
      })],
    ]);
  });
});
