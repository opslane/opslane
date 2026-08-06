// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { destroy, init } from '../index';
import { buildPayload } from '../core';
import { clearNetworkTimings, finalizeTiming, snapshotNetworkTimings, startTiming } from '../network-timing';
import { TEST_PK } from './test-keys';

vi.mock('../transport', () => ({
  enqueueEvent: vi.fn(),
  flushEvents: vi.fn(),
  startTransport: vi.fn(),
  stopTransport: vi.fn(),
}));

describe('network timing teardown', () => {
  beforeEach(() => clearNetworkTimings());

  it('carries no history across destroy() and re-init()', () => {
    init({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
    const handle = startTiming('fetch', 'GET', 'https://app.example.com/api/before');
    finalizeTiming(handle, 'ok', 200);
    expect(snapshotNetworkTimings()).toHaveLength(1);

    destroy();
    expect(snapshotNetworkTimings()).toHaveLength(0);

    init({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
    const payload = buildPayload('TypeError', 'boom', '', {
      type: 'error', timestamp: new Date().toISOString(), category: 'exception', message: 'boom',
    });
    expect(payload).not.toHaveProperty('network_timings');
    destroy();
  });
});
