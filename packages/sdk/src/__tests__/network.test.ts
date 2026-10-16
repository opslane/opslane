import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  patchFetch,
  unpatchFetch,
  patchXHR,
  unpatchXHR,
  sdkFetch,
  trackRequest,
  requestStarted,
  requestEnded,
} from '../network';
import { setTelemetrySink, type TelemetryEvent } from '../telemetry';
import { clearBreadcrumbs, getBreadcrumbs } from '../breadcrumbs';
import { loadConfig, resetConfig } from '../config';
import { TEST_PK } from './test-keys';
import { clearNetworkTimings, snapshotNetworkTimings } from '../network-timing';

describe('Network Interceptor', () => {
  beforeEach(() => {
    clearBreadcrumbs();
    clearNetworkTimings();
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
  });

  afterEach(() => {
    unpatchFetch();
    unpatchXHR();
    clearBreadcrumbs();
    clearNetworkTimings();
    resetConfig();
    vi.restoreAllMocks();
  });

  describe('fetch interceptor', () => {
    it('should record a breadcrumb for successful fetch calls', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const originalFetch = vi.fn().mockResolvedValue(mockResponse);
      globalThis.fetch = originalFetch;

      patchFetch();

      await fetch('https://api.example.com/users', { method: 'GET' });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('fetch');
      expect(crumbs[0].category).toBe('fetch');
      expect(crumbs[0].message).toBe('GET https://api.example.com/users');
      expect(crumbs[0].data).toEqual({
        method: 'GET',
        url: 'https://api.example.com/users',
        status_code: 200,
      });
      expect(crumbs[0].level).toBe('info');
    });

    it('should record a breadcrumb for failed fetch calls', async () => {
      const originalFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      globalThis.fetch = originalFetch;

      patchFetch();

      try {
        await fetch('https://api.example.com/down');
      } catch {
        // expected
      }

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('fetch');
      expect(crumbs[0].level).toBe('error');
      expect(crumbs[0].data!.error).toBe('Failed to fetch');
    });

    it('should default to GET when no method is specified', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      await fetch('https://api.example.com/data');

      const crumbs = getBreadcrumbs();
      expect(crumbs[0].data!.method).toBe('GET');
    });

    it('should handle Request objects as input', async () => {
      const mockResponse = new Response('ok', { status: 201 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      const req = new Request('https://api.example.com/items', {
        method: 'POST',
      });
      await fetch(req);

      const crumbs = getBreadcrumbs();
      expect(crumbs[0].data!.method).toBe('POST');
      expect(crumbs[0].data!.url).toBe('https://api.example.com/items');
    });

    it('should NOT intercept requests to the SDK endpoint', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();
      await fetch('https://ingest.example.com/api/v1/events', {
        method: 'POST',
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(0);
    });

    it('should restore original fetch on unpatch', () => {
      const originalFetch = vi.fn();
      globalThis.fetch = originalFetch;

      patchFetch();
      unpatchFetch();

      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('bypasses telemetry and breadcrumbs for SDK-owned storage traffic', async () => {
      const originalFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      globalThis.fetch = originalFetch;
      patchFetch();
      await sdkFetch('https://storage.example.com/chunk', { method: 'POST' });
      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(getBreadcrumbs()).toHaveLength(0);
    });

    it('should never throw even if breadcrumb adding fails', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      patchFetch();

      // Should not throw
      await expect(fetch('https://api.example.com/safe')).resolves.toBeTruthy();
    });
  });

  describe('XMLHttpRequest interceptor', () => {
    it('should record a breadcrumb for XHR requests', () => {
      patchXHR();

      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://api.example.com/data');

      // Simulate the load event
      Object.defineProperty(xhr, 'status', { value: 200, writable: true });
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
      xhr.dispatchEvent(new Event('loadend'));

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].type).toBe('xhr');
      expect(crumbs[0].category).toBe('xhr');
      expect(crumbs[0].message).toBe('GET https://api.example.com/data');
      expect(crumbs[0].data).toEqual({
        method: 'GET',
        url: 'https://api.example.com/data',
        status_code: 200,
      });
    });

    it('should NOT intercept XHR to the SDK endpoint', () => {
      patchXHR();

      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://ingest.example.com/api/v1/events');

      Object.defineProperty(xhr, 'status', { value: 200, writable: true });
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
      xhr.dispatchEvent(new Event('loadend'));

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(0);
    });

    it('should restore original XHR.open on unpatch', () => {
      const originalOpen = XMLHttpRequest.prototype.open;
      patchXHR();
      unpatchXHR();

      expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    });
  });
});

describe('fetch timing capture', () => {
  beforeEach(() => {
    clearNetworkTimings();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
  });
  afterEach(() => {
    unpatchFetch();
    vi.unstubAllGlobals();
  });

  it('records ok with status and ttfb', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://app.example.com/api/items');

    const [entry] = snapshotNetworkTimings();
    expect(entry.transport).toBe('fetch');
    expect(entry.outcome).toBe('ok');
    expect(entry.status).toBe(200);
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
  });

  it('records http_error for a 4xx/5xx response', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 503, ok: false, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://app.example.com/api/items');

    expect(snapshotNetworkTimings()[0].outcome).toBe('http_error');
  });

  it('records an opaque response as ok with no status', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 0, ok: false, type: 'opaque' }) as Response);
    patchFetch();
    await fetch('https://cdn.example.com/pixel.gif');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('ok');
    expect(entry).not.toHaveProperty('status');
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'abort'],
    ['TypeError', 'network_error'],
  ] as const)('classifies a %s rejection as %s with no ttfb', async (name, expected) => {
    vi.stubGlobal('fetch', async () => {
      const error = new Error('boom');
      error.name = name;
      throw error;
    });
    patchFetch();
    await expect(fetch('https://app.example.com/api/items')).rejects.toThrow('boom');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe(expected);
    expect(entry).not.toHaveProperty('ttfb_ms');
  });

  it("does not time the SDK's own endpoint", async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, type: 'basic' }) as Response);
    patchFetch();
    await fetch('https://api.test/api/v1/events');

    expect(snapshotNetworkTimings()).toHaveLength(0);
  });
});

class FakeXHR {
  readyState = 0;
  status = 0;
  private listeners = new Map<string, Array<() => void>>();
  open(_method: string, _url: string): void {}
  send(): void {}
  addEventListener(type: string, fn: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  setReadyState(state: number): void {
    this.readyState = state;
    this.emit('readystatechange');
  }
}

describe('xhr timing capture', () => {
  beforeEach(() => {
    clearNetworkTimings();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://api.test', errorThrottleMs: 0 });
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    patchXHR();
  });
  afterEach(() => {
    unpatchXHR();
    vi.unstubAllGlobals();
  });

  function drive(terminal: string, status: number, withHeaders: boolean): void {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    xhr.send();
    if (withHeaders) xhr.setReadyState(2);
    xhr.status = status;
    xhr.emit(terminal);
    xhr.emit('loadend');
  }

  it.each([
    ['load', 200, 'ok'],
    ['load', 500, 'http_error'],
    ['timeout', 0, 'timeout'],
    ['abort', 0, 'abort'],
    ['error', 0, 'network_error'],
  ] as const)('maps %s/%i to %s', (terminal, status, expected) => {
    drive(terminal, status, false);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].transport).toBe('xhr');
    expect(snapshot[0].outcome).toBe(expected);
  });

  it('records ttfb from HEADERS_RECEIVED, so a body-phase timeout is distinguishable', () => {
    drive('timeout', 0, true);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('timeout');
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not double-finalize when loadend follows a terminal event', () => {
    drive('timeout', 0, false);
    expect(snapshotNetworkTimings()).toHaveLength(1);
  });

  it('falls back to network_error when loadend fires with no terminal event', () => {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    xhr.send();
    xhr.emit('loadend');

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].outcome).toBe('network_error');
  });

  it('omits status 0 on load', () => {
    drive('load', 0, false);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('ok');
    expect(entry).not.toHaveProperty('status');
  });

  it('continues timing when an XHR instance is reused', () => {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    xhr.open('GET', 'https://app.example.com/api/first');
    xhr.send();
    xhr.status = 200;
    xhr.emit('load');
    xhr.emit('loadend');

    xhr.open('POST', 'https://app.example.com/api/second');
    xhr.send();
    xhr.emit('timeout');
    xhr.emit('loadend');

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((entry) => entry.outcome)).toEqual(['timeout', 'ok']);
    expect(snapshot.map((entry) => entry.url)).toEqual([
      'https://app.example.com/api/second',
      'https://app.example.com/api/first',
    ]);
  });

  it('discards the record and rethrows when send() throws synchronously', () => {
    class ThrowingXHR extends FakeXHR {
      send(): void {
        throw new Error('InvalidStateError');
      }
    }
    unpatchXHR();
    vi.stubGlobal('XMLHttpRequest', ThrowingXHR);
    patchXHR();

    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof ThrowingXHR)();
    xhr.open('GET', 'https://app.example.com/api/items');
    expect(() => xhr.send()).toThrow('InvalidStateError');

    expect(snapshotNetworkTimings()).toHaveLength(0);
  });
});

describe('generic request-timing hooks (issue #465)', () => {
  let telemetryEvents: TelemetryEvent[];

  beforeEach(() => {
    clearBreadcrumbs();
    clearNetworkTimings();
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
    });
    telemetryEvents = [];
    setTelemetrySink((ev) => telemetryEvents.push(ev));
  });

  afterEach(() => {
    setTelemetrySink(null);
    clearBreadcrumbs();
    clearNetworkTimings();
    resetConfig();
  });

  describe('trackRequest', () => {
    it('records telemetry, timing, and breadcrumb for successful async operations', async () => {
      const result = await trackRequest(
        { method: 'POST', url: 'https://api.example.com/custom-rpc' },
        async () => {
          return { data: 'ok', status: 201 };
        }
      );

      expect(result).toEqual({ data: 'ok', status: 201 });

      const startEvent = telemetryEvents.find((e) => e.kind === 'request_start');
      const endEvent = telemetryEvents.find((e) => e.kind === 'request_end');

      expect(startEvent).toMatchObject({
        kind: 'request_start',
        method: 'POST',
        url: 'https://api.example.com/custom-rpc',
      });
      expect(endEvent).toMatchObject({
        kind: 'request_end',
        requestId: (startEvent as { requestId: string }).requestId,
        status: 201,
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0]).toMatchObject({
        type: 'fetch',
        category: 'fetch',
        message: 'POST https://api.example.com/custom-rpc',
        level: 'info',
        data: {
          method: 'POST',
          url: 'https://api.example.com/custom-rpc',
          status_code: 201,
        },
      });

      const timings = snapshotNetworkTimings();
      expect(timings).toHaveLength(1);
      expect(timings[0].outcome).toBe('ok');
      expect(timings[0].status).toBe(201);
    });

    it('defaults status to 200 when return value has no status property', async () => {
      const result = await trackRequest(
        { method: 'GET', url: 'https://api.example.com/items' },
        async () => ['item1', 'item2']
      );

      expect(result).toEqual(['item1', 'item2']);

      const endEvent = telemetryEvents.find((e) => e.kind === 'request_end');
      expect(endEvent).toMatchObject({
        kind: 'request_end',
        status: 200,
      });

      const timings = snapshotNetworkTimings();
      expect(timings[0].status).toBe(200);
      expect(timings[0].outcome).toBe('ok');
    });

    it('records telemetry, timing, and error breadcrumb and rethrows when run throws', async () => {
      const err = new Error('Bridge timeout');
      err.name = 'TimeoutError';

      await expect(
        trackRequest(
          { method: 'PUT', url: 'https://api.example.com/save' },
          async () => {
            throw err;
          }
        )
      ).rejects.toThrow('Bridge timeout');

      const startEvent = telemetryEvents.find((e) => e.kind === 'request_start');
      const endEvent = telemetryEvents.find((e) => e.kind === 'request_end');

      expect(startEvent).toMatchObject({
        kind: 'request_start',
        method: 'PUT',
        url: 'https://api.example.com/save',
      });
      expect(endEvent).toMatchObject({
        kind: 'request_end',
        requestId: (startEvent as { requestId: string }).requestId,
        status: 0,
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0]).toMatchObject({
        type: 'fetch',
        level: 'error',
        message: 'PUT https://api.example.com/save',
        data: {
          method: 'PUT',
          url: 'https://api.example.com/save',
          error: 'Bridge timeout',
        },
      });

      const timings = snapshotNetworkTimings();
      expect(timings).toHaveLength(1);
      expect(timings[0].outcome).toBe('timeout');
    });

    it('ignores SDK ingest endpoint URLs and emits no telemetry', async () => {
      const result = await trackRequest(
        { method: 'POST', url: 'https://ingest.example.com/api/v1/events' },
        async () => 'sdk-response'
      );

      expect(result).toBe('sdk-response');
      expect(telemetryEvents).toHaveLength(0);
      expect(getBreadcrumbs()).toHaveLength(0);
      expect(snapshotNetworkTimings()).toHaveLength(0);
    });
  });

  describe('requestStarted & requestEnded', () => {
    it('supports two-call pattern with explicit status code', () => {
      const handle = requestStarted({
        method: 'delete',
        url: 'https://api.example.com/resource/42',
      });

      expect(handle.ignored).toBe(false);
      expect(handle.method).toBe('DELETE');
      expect(handle.requestId).toMatch(/^m_\d+$/);

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0]).toMatchObject({
        kind: 'request_start',
        requestId: handle.requestId,
        method: 'DELETE',
        url: 'https://api.example.com/resource/42',
      });

      requestEnded(handle, { status: 404 });

      expect(telemetryEvents).toHaveLength(2);
      expect(telemetryEvents[1]).toMatchObject({
        kind: 'request_end',
        requestId: handle.requestId,
        status: 404,
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].level).toBe('warning');
      expect(crumbs[0].data?.status_code).toBe(404);

      const timings = snapshotNetworkTimings();
      expect(timings).toHaveLength(1);
      expect(timings[0].outcome).toBe('http_error');
      expect(timings[0].status).toBe(404);
    });

    it('supports two-call pattern with error result', () => {
      const handle = requestStarted({
        method: 'GET',
        url: 'https://api.example.com/network-fail',
      });

      requestEnded(handle, { error: new TypeError('Failed to fetch') });

      expect(telemetryEvents).toHaveLength(2);
      expect(telemetryEvents[1]).toMatchObject({
        kind: 'request_end',
        requestId: handle.requestId,
        status: 0,
      });

      const crumbs = getBreadcrumbs();
      expect(crumbs).toHaveLength(1);
      expect(crumbs[0].level).toBe('error');

      const timings = snapshotNetworkTimings();
      expect(timings[0].outcome).toBe('network_error');
    });

    it('ignores SDK endpoint in requestStarted and no-ops on requestEnded', () => {
      const handle = requestStarted({
        method: 'POST',
        url: 'https://ingest.example.com/api/v1/sessions',
      });

      expect(handle.ignored).toBe(true);
      expect(handle.requestId).toBe('');
      expect(telemetryEvents).toHaveLength(0);

      requestEnded(handle, { status: 200 });

      expect(telemetryEvents).toHaveLength(0);
      expect(getBreadcrumbs()).toHaveLength(0);
      expect(snapshotNetworkTimings()).toHaveLength(0);
    });
  });
});

