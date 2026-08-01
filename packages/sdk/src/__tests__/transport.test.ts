import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueEvent,
  flushEvents,
  flushOnUnload,
  startTransport,
  stopTransport,
  getQueueLength,
  _resetQueue,
} from '../transport';
import { loadConfig, resetConfig, getConfig } from '../config';
import { _resetThrottle } from '../throttle';
import { setUser, clearUser } from '../core';
import type { ErrorEventPayload } from '@opslane/shared';
import { TEST_PK } from './test-keys';
import { REGISTRY_GLOBAL } from '../build/registry-contract';

const replayMocks = vi.hoisted(() => ({
  flushReplayBufferForError: vi.fn(),
}));

vi.mock('../replay', () => replayMocks);

// Counter gives each event a unique stack frame so the identical-error throttle
// (default 1000ms) does not collapse multi-event tests. The suite also disables
// the throttle via errorThrottleMs:0 in beforeEach; throttle logic is unit-tested
// separately in throttle.test.ts.
let eventSeq = 0;
function makeEvent(overrides?: Partial<ErrorEventPayload>): ErrorEventPayload {
  eventSeq += 1;
  return {
    timestamp: new Date().toISOString(),
    error: {
      type: 'Error',
      message: 'test error',
      stack: `Error: test error\n    at test.js:${eventSeq}:1`,
    },
    breadcrumbs: [],
    context: {
      url: 'https://app.example.com',
      user_agent: 'test-agent',
    },
    sdk_version: '0.0.1',
    ...overrides,
  };
}

describe('Transport Layer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetQueue();
    _resetThrottle();
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      errorThrottleMs: 0, // disable throttle here; it has its own unit test
    });
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    vi.useFakeTimers();
    replayMocks.flushReplayBufferForError.mockReset();
  });

  afterEach(() => {
    stopTransport();
    _resetQueue();
    resetConfig();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
  });

  it('should enqueue events and flush sends them individually via fetch', async () => {
    enqueueEvent(makeEvent());
    enqueueEvent(makeEvent({ error: { type: 'TypeError', message: 'x', stack: '' } }));

    await flushEvents();

    // Each event sent as a separate request (ingestion expects single object)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url1, options1] = fetchMock.mock.calls[0];
    expect(url1).toBe('https://ingest.example.com/api/v1/events');
    expect(options1.method).toBe('POST');
    expect(options1.headers['Content-Type']).toBe('application/json');
    expect(options1.headers['X-API-Key']).toBe(TEST_PK);

    const body1 = JSON.parse(options1.body);
    expect(body1.error.type).toBe('Error');

    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.error.type).toBe('TypeError');
  });

  it('should flush when batch size is reached', async () => {
    for (let i = 0; i < 10; i++) {
      enqueueEvent(makeEvent());
    }

    // Flush should have been triggered by reaching maxBatchSize (10)
    // Need to let the microtask queue drain
    await vi.advanceTimersByTimeAsync(0);

    // Each event sent individually
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error.type).toBe('Error');
  });

  it('should flush on timer interval', async () => {
    startTransport();
    enqueueEvent(makeEvent());

    // Not flushed yet (only 1 event, below maxBatchSize)
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance past flushInterval (5000ms)
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should not send empty batches', async () => {
    await flushEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should clear queue after successful flush', async () => {
    enqueueEvent(makeEvent());
    await flushEvents();

    expect(getQueueLength()).toBe(0);
  });

  it('flushes the replay buffer after a replay-trigger error is accepted', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK, replay: { enabled: true } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'evt-1', group_id: 'grp-1' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));

    enqueueEvent(makeEvent(), 'uncaught_error');
    await flushEvents();

    expect(replayMocks.flushReplayBufferForError).toHaveBeenCalledTimes(1);
  });

  it('does not flush replay capture when error ingest is rejected', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK, replay: { enabled: true } });
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    enqueueEvent(makeEvent(), 'uncaught_error');
    await flushEvents();

    expect(replayMocks.flushReplayBufferForError).not.toHaveBeenCalled();
  });

  it('should keep events in queue on network failure and retry on next flush', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: no jitter
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    enqueueEvent(makeEvent());
    await flushEvents();

    // Event should still be in queue
    expect(getQueueLength()).toBe(1);

    // Fix the network and flush again — but wait out the backoff window first.
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await vi.advanceTimersByTimeAsync(1000);
    await flushEvents();

    expect(getQueueLength()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('applies backoff after a failure: an immediate re-flush is gated', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK });
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter, deterministic
    fetchMock.mockRejectedValueOnce(new Error('down'));
    enqueueEvent(makeEvent());
    await flushEvents();                 // fails → backoff opens
    expect(getQueueLength()).toBe(1);

    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    await flushEvents();                 // immediately → GATED, no new fetch
    expect(getQueueLength()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // past base backoff
    await flushEvents();                 // now allowed → drains
    expect(getQueueLength()).toBe(0);
  });

  it('resets backoff after a successful flush', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK });
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    enqueueEvent(makeEvent());
    await flushEvents();                 // success
    enqueueEvent(makeEvent());
    await flushEvents();                 // not gated
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should drop events if queue exceeds 100', () => {
    for (let i = 0; i < 110; i++) {
      enqueueEvent(makeEvent());
    }
    // Queue should max out at 100
    expect(getQueueLength()).toBeLessThanOrEqual(100);
  });

  it('should stop the flush timer on stopTransport', async () => {
    startTransport();
    enqueueEvent(makeEvent());
    stopTransport();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should never throw even if fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('total failure'));

    enqueueEvent(makeEvent());
    // flushEvents itself should NOT throw
    await expect(flushEvents()).resolves.toBeUndefined();
  });

  it('should late-bind user context to events captured before setUser', async () => {
    // Simulate: error fires before setUser() is called
    enqueueEvent(makeEvent({
      context: undefined as unknown as ErrorEventPayload['context'],
    }));

    // User authenticates later
    setUser({ id: 'u-42', email: 'alice@acme.com', account: { id: 'acme', name: 'Acme Corp' } });

    await flushEvents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.context.user).toEqual({
      id: 'u-42',
      email: 'alice@acme.com',
      account_id: 'acme',
      account_name: 'Acme Corp',
    });

    clearUser();
  });

  it('should not overwrite existing user context at flush time', async () => {
    // Event already has user context from capture time
    const event = makeEvent({
      context: {
        url: 'https://app.example.com',
        user_agent: 'test-agent',
        user: { id: 'original-user', email: 'orig@example.com' },
      },
    });
    enqueueEvent(event);

    // Different user set later
    setUser({ id: 'later-user', email: 'later@example.com' });

    await flushEvents();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.context.user.id).toBe('original-user');

    clearUser();
  });

  it('should not inject user context if clearUser was called before flush', async () => {
    // Event captured without user context
    enqueueEvent(makeEvent());

    // User was set then cleared before flush
    setUser({ id: 'u-temp' });
    clearUser();

    await flushEvents();

    // getCurrentUser() is null at flush time, so no injection
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.context.user).toBeUndefined();
  });

  it('flushOnUnload sends queued events with keepalive and drains the queue', () => {
    enqueueEvent(makeEvent());
    enqueueEvent(makeEvent());

    flushOnUnload();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(getQueueLength()).toBe(0);
  });

  it('flushOnUnload stops at the keepalive byte budget instead of sending everything', () => {
    // ~30KB each → cumulative exceeds the ~60KB keepalive budget by the 3rd.
    const big = 'x'.repeat(30 * 1024);
    enqueueEvent(makeEvent({ error: { type: 'E', message: big, stack: '' } }));
    enqueueEvent(makeEvent({ error: { type: 'E', message: big, stack: '' } }));
    enqueueEvent(makeEvent({ error: { type: 'E', message: big, stack: '' } }));

    flushOnUnload();

    // At least one sent, but not all three (budget bounds the aggregate).
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock.mock.calls.length).toBeLessThan(3);
    // Non-destructive: the over-budget events stay queued, not dropped.
    expect(getQueueLength()).toBeGreaterThan(0);
  });

  it('flushOnUnload never throws and requeues failed sends (tab may resume)', async () => {
    // visibilitychange→hidden fires on ordinary tab-switches the page resumes
    // from. A transient send failure must NOT permanently lose the event — it is
    // requeued so the next normal flush retries it.
    fetchMock.mockRejectedValue(new Error('network blip'));
    enqueueEvent(makeEvent());

    expect(() => flushOnUnload()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(getQueueLength()).toBe(1);
  });

  it('flushOnUnload sends even while a normal flush is in flight (bypasses flushing guard)', async () => {
    // Make the first (normal-flush) fetch hang so `flushing` stays true.
    let resolveHang: (v: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => { resolveHang = r; }),
    );
    enqueueEvent(makeEvent());
    void flushEvents(); // splices queue, sets flushing=true, awaits the hung fetch
    await vi.advanceTimersByTimeAsync(0);

    // A new event arrives and the page unloads while the normal flush is stuck.
    enqueueEvent(makeEvent());
    flushOnUnload();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const unloadCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(unloadCall[1].keepalive).toBe(true);

    resolveHang(new Response('ok', { status: 200 }));
  });

  it('flushes queued events on pagehide via keepalive', () => {
    startTransport();
    enqueueEvent(makeEvent());

    window.dispatchEvent(new Event('pagehide'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  });

  it('flushes (non-destructively) on visibilitychange→hidden but not on →visible', () => {
    startTransport();
    enqueueEvent(makeEvent());

    // Becoming visible must NOT flush.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).not.toHaveBeenCalled();

    // Becoming hidden flushes with keepalive (covers mobile termination).
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  });

  it('drops the event when beforeSend returns null', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK, beforeSend: () => null });
    enqueueEvent(makeEvent());
    await flushEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getQueueLength()).toBe(0);
  });

  it('scrubs the event before send (query string stripped from context.url)', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK });
    enqueueEvent(makeEvent({ context: { url: 'https://app.com/p?token=abc', user_agent: 'ua' } }));
    await flushEvents();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.context.url).toBe('https://app.com/p');
  });

  it('assembles debug images after scrubbing and before beforeSend', async () => {
    const codeFile = 'https://app.com/assets/index.js';
    const debugId = '01234567-89ab-cdef-0123-456789abcdef';
    (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] = {
      [codeFile]: [debugId],
    };
    const beforeSend = vi.fn((event: ErrorEventPayload) => event);
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com',
      apiKey: TEST_PK,
      beforeSend,
      errorThrottleMs: 0,
    });
    const stack = `Error: boom\n    at fn (${codeFile}:1:2)`;

    enqueueEvent(
      makeEvent({
        error: { type: 'Error', message: 'boom', stack },
      }),
    );
    await flushEvents();

    expect(beforeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        debug_meta: {
          images: [
            { type: 'sourcemap', code_file: codeFile, debug_id: debugId },
          ],
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error.stack).toBe(stack);
  });

  it('reports zero matches when scrubbing changes a registered URL', async () => {
    const codeFile = 'https://app.com/assets/index.js?token=secret';
    (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] = {
      [codeFile]: ['01234567-89ab-cdef-0123-456789abcdef'],
    };
    const stack = `Error: boom\n    at fn (${codeFile}:1:2)`;

    enqueueEvent(
      makeEvent({
        error: { type: 'Error', message: 'boom', stack },
      }),
    );
    await flushEvents();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error.stack).not.toBe(stack);
    expect(body.debug_meta).toEqual({ images: [] });
  });

  it('beforeSend can transform the event', async () => {
    resetConfig();
    loadConfig({
      endpoint: 'https://ingest.example.com', apiKey: TEST_PK,
      beforeSend: (e) => ({ ...e, error: { ...e.error, message: 'REDACTED' } }),
    });
    enqueueEvent(makeEvent());
    await flushEvents();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.error.message).toBe('REDACTED');
  });

  it('drops events when sampleRate excludes them', async () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK, sampleRate: 0.5 });
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.9); // 0.9 >= 0.5 → drop
    enqueueEvent(makeEvent());
    await flushEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    rnd.mockReturnValue(0.1); // 0.1 < 0.5 → keep
    enqueueEvent(makeEvent());
    await flushEvents();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sampleRate defaults to 1 (keep everything)', () => {
    resetConfig();
    loadConfig({ endpoint: 'https://ingest.example.com', apiKey: TEST_PK });
    expect(getConfig().sampleRate).toBe(1);
  });
});
