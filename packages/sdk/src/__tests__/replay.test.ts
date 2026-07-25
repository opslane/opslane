import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, type eventWithTime } from '@rrweb/types';
import { clearBreadcrumbs } from '../breadcrumbs';
import { loadConfig, resetConfig } from '../config';
import { clearUser, setUser } from '../core';
import { destroy, init } from '../index';
import { emitTelemetry } from '../telemetry';
import { _rehydrateFromStorage, peekChunkSeq, resetSessionId } from '../session';
import {
  _resetReplayState,
  flushReplayBufferForError,
  startReplayCapture,
  stopReplayCapture,
} from '../replay';

type RecordOptions = {
  emit?: (event: eventWithTime, isCheckout?: boolean) => void;
  checkoutEveryNms?: number;
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
  recordCanvas?: boolean;
};

const rrwebState = vi.hoisted(() => {
  const state = {
    options: undefined as unknown,
    stop: vi.fn(),
    record: vi.fn(),
    takeFullSnapshot: vi.fn(),
    addCustomEvent: vi.fn(),
  };
  state.record.mockImplementation((options: unknown) => {
    state.options = options;
    return state.stop;
  });
  return state;
});

const chunkMocks = vi.hoisted(() => ({
  reset: vi.fn(),
  uploadChunk: vi.fn(),
  flushInline: vi.fn(),
}));

vi.mock('rrweb', () => ({
  record: rrwebState.record,
  takeFullSnapshot: rrwebState.takeFullSnapshot,
  addCustomEvent: rrwebState.addCustomEvent,
}));

vi.mock('../chunk-upload', () => ({
  _resetChunkUploadState: chunkMocks.reset,
  uploadChunk: chunkMocks.uploadChunk,
  flushInline: chunkMocks.flushInline,
}));

function recordOptions(): RecordOptions {
  expect(rrwebState.options).toBeTruthy();
  return rrwebState.options as RecordOptions;
}

function emit(event: eventWithTime, isCheckout?: boolean): void {
  recordOptions().emit?.(event, isCheckout);
}

function fullSnapshot(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
  } as unknown as eventWithTime;
}

function meta(timestamp: number): eventWithTime {
  return {
    type: EventType.Meta,
    timestamp,
    data: { href: 'https://example.test/', width: 1280, height: 720 },
  } as eventWithTime;
}

function incremental(timestamp: number, text = ''): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: 2, text },
  } as unknown as eventWithTime;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('continuous chunked recording', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    _resetReplayState();
    clearUser();
    sessionStorage.clear();
    resetSessionId();
    clearBreadcrumbs();
    resetConfig();
    loadConfig({ apiKey: 'key-abc', endpoint: 'https://ingest.example.com', replay: { enabled: true } });
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    chunkMocks.uploadChunk.mockReset().mockResolvedValue(true);
    chunkMocks.flushInline.mockReset().mockResolvedValue(true);
    chunkMocks.reset.mockClear();
    rrwebState.options = undefined;
    rrwebState.stop.mockClear();
    rrwebState.takeFullSnapshot.mockClear();
    rrwebState.addCustomEvent.mockClear();
    rrwebState.record.mockReset().mockImplementation((options: unknown) => {
      rrwebState.options = options;
      return rrwebState.stop;
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    destroy();
    stopReplayCapture();
    resetConfig();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function startEnabled(): Promise<void> {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ recording: true, chunk_interval_ms: 30_000, max_chunk_bytes: 5_242_880 }),
    });
    await startReplayCapture();
    await drainMicrotasks();
  }

  it('registers the session before recording', async () => {
    await startEnabled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/sessions/init');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      session_id: expect.any(String),
      started_at: expect.any(String),
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(rrwebState.record.mock.invocationCallOrder[0]);
  });

  it('sends sdk identity on session init', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    init({
      apiKey: 'k',
      endpoint: 'https://ingest.example.com',
      release: 'abc123',
      environment: 'development',
    });

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/v1/sessions/init'))).toBe(true);
    });

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/v1/sessions/init'))!;
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/v1/sessions/init'))).toHaveLength(1);
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.sdk).toEqual({ name: '@opslane/sdk', version: expect.any(String) });
    expect(body.release).toBe('abc123');
    expect(body.environment).toBe('development');
  });

  it('registers the session when replay is disabled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ recording: false }) });

    init({
      apiKey: 'k',
      endpoint: 'https://ingest.example.com',
      replay: { enabled: false },
    });

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/v1/sessions/init'))).toBe(true);
    });
    expect(rrwebState.record).not.toHaveBeenCalled();
  });

  it('starts a fresh registration after destroy while the previous request is pending', async () => {
    let resolveFirst!: (value: { ok: boolean; json: () => Promise<{ recording: boolean }> }) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ ok: true, json: async () => ({ recording: false }) });

    init({
      apiKey: 'old-key',
      endpoint: 'https://old.example.com',
      replay: { enabled: false },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    destroy();
    init({
      apiKey: 'new-key',
      endpoint: 'https://new.example.com',
      replay: { enabled: false },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://old.example.com');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('https://new.example.com');
    resolveFirst({ ok: true, json: async () => ({ recording: false }) });
  });

  it('keeps session reporting silent when reporting is disabled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ recording: true }) });

    init({
      apiKey: 'k',
      endpoint: 'https://ingest.example.com',
      reporting: { enabled: false },
    });
    await drainMicrotasks();

    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/v1/sessions/init'))).toBe(false);
    expect(rrwebState.record).not.toHaveBeenCalled();
  });

  it('sends the configured environment when registering a replay session', async () => {
    resetConfig();
    loadConfig({
      apiKey: 'key-abc',
      endpoint: 'https://ingest.example.com',
      environment: 'staging',
      replay: { enabled: true },
    });

    await startEnabled();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      environment: 'staging',
    });
  });

  it('registers the latest identity when it changes during initial session registration', async () => {
    let resolveInitial!: (value: { ok: boolean; json: () => Promise<{ recording: boolean }> }) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ recording: true }) });

    const starting = startReplayCapture();
    await drainMicrotasks();
    const firstID = (JSON.parse(fetchMock.mock.calls[0][1].body) as { session_id: string }).session_id;
    setUser({ id: 'alice' });
    resolveInitial({ ok: true, json: async () => ({ recording: true }) });
    await starting;

    const initCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/sessions/init'));
    expect(initCalls).toHaveLength(2);
    const latestID = (JSON.parse(initCalls[1][1].body) as { session_id: string }).session_id;
    expect(latestID).not.toBe(firstID);
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    emit(fullSnapshot(31_000), true);
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk).toHaveBeenCalledWith(latestID, 0, expect.any(Array), true);
  });

  it('does not start rrweb when disabled, unsupported, or killed server-side', async () => {
    resetConfig();
    loadConfig({ apiKey: 'k', endpoint: 'https://ingest.example.com', replay: { enabled: false } });
    await startReplayCapture();
    expect(rrwebState.record).not.toHaveBeenCalled();

    resetConfig();
    loadConfig({ apiKey: 'k', endpoint: 'https://ingest.example.com', replay: { enabled: true } });
    vi.stubGlobal('CompressionStream', undefined);
    await startReplayCapture();
    expect(rrwebState.record).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ recording: false }) });
    await startReplayCapture();
    expect(rrwebState.record).not.toHaveBeenCalled();
  });

  it('configures checkout snapshots and masking', async () => {
    await startEnabled();
    expect(recordOptions()).toMatchObject({
      checkoutEveryNms: 30_000,
      maskAllInputs: true,
      maskTextSelector: '.opslane-mask',
      blockSelector: '.opslane-block',
      recordCanvas: false,
    });
  });

  it('cuts independently playable chunks on checkout boundaries', async () => {
    await startEnabled();
    emit(meta(999), false);
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    emit(meta(30_999), true);
    emit(fullSnapshot(31_000), true);
    emit(incremental(31_500));
    emit(meta(60_999), true);
    emit(fullSnapshot(61_000), true);
    await drainMicrotasks();

    expect(chunkMocks.uploadChunk).toHaveBeenCalledTimes(2);
    expect(chunkMocks.uploadChunk.mock.calls.map((call) => call[1])).toEqual([0, 1]);
    for (const call of chunkMocks.uploadChunk.mock.calls) {
      expect((call[2] as eventWithTime[]).slice(0, 2).map((event) => event.type)).toEqual([
        EventType.Meta,
        EventType.FullSnapshot,
      ]);
      expect(call[3]).toBe(true);
    }
  });

  it('flushes the current Meta + FullSnapshot buffer immediately for an accepted error', async () => {
    await startEnabled();
    emit(meta(999), false);
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));

    flushReplayBufferForError();
    await drainMicrotasks();

    expect(chunkMocks.uploadChunk).toHaveBeenCalledTimes(1);
    expect(chunkMocks.uploadChunk.mock.calls[0]?.[1]).toBe(0);
    expect((chunkMocks.uploadChunk.mock.calls[0]?.[2] as eventWithTime[]).slice(0, 2).map((event) => event.type)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);
    expect(rrwebState.takeFullSnapshot).toHaveBeenCalledWith(true);
  });

  it('does not double-ship on two error flushes in the same turn', async () => {
    await startEnabled();
    emit(meta(999), false);
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));

    flushReplayBufferForError();
    flushReplayBufferForError();
    await drainMicrotasks();

    expect(chunkMocks.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('does not flush an empty or stopped capture', async () => {
    await startEnabled();
    flushReplayBufferForError();
    expect(chunkMocks.uploadChunk).not.toHaveBeenCalled();

    emit(meta(999), false);
    emit(fullSnapshot(1_000), true);
    stopReplayCapture();
    flushReplayBufferForError();
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk).not.toHaveBeenCalled();
  });

  it('does not upload an empty chunk on the first checkout', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk).not.toHaveBeenCalled();
  });

  it('resumes the sequence counter after a reload', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    emit(fullSnapshot(31_000), true);
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk.mock.calls[0][1]).toBe(0);

    stopReplayCapture();
    resetSessionId();
    _rehydrateFromStorage();
    chunkMocks.uploadChunk.mockClear();
    await startEnabled();
    emit(fullSnapshot(60_000), true);
    emit(incremental(60_500));
    emit(fullSnapshot(90_000), true);
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk.mock.calls[0][1]).toBe(1);
  });

  it('forces a checkout before a raw chunk exceeds the signed cap', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500, 'x'.repeat(21 * 1024 * 1024)));
    expect(rrwebState.takeFullSnapshot).toHaveBeenCalledWith(true);
  });

  it('stops when the server signals stop mid-session', async () => {
    await startEnabled();
    chunkMocks.uploadChunk.mockResolvedValue('stop');
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    emit(fullSnapshot(31_000), true);
    await drainMicrotasks();
    expect(rrwebState.stop).toHaveBeenCalled();
  });

  it('flushes inline when the page becomes hidden', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await drainMicrotasks();
    expect(chunkMocks.flushInline).toHaveBeenCalledWith(expect.any(String), 0, expect.any(Array));
    expect(rrwebState.takeFullSnapshot).toHaveBeenCalledWith(true);
  });

  it('falls back to the normal uploader when the inline tail cannot land', async () => {
    await startEnabled();
    chunkMocks.flushInline.mockResolvedValueOnce(false);
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await drainMicrotasks();
    expect(chunkMocks.uploadChunk).toHaveBeenCalledWith(expect.any(String), 0, expect.any(Array), true);
  });

  it('stops capture when the tail flush is told to stop', async () => {
    await startEnabled();
    chunkMocks.flushInline.mockResolvedValueOnce('stop');
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await drainMicrotasks();

    expect(rrwebState.stop).toHaveBeenCalled();
    expect(chunkMocks.uploadChunk).not.toHaveBeenCalled();
  });

  it('registers a new session when identity changes', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ recording: true }) });
    setUser({ id: 'alice' });
    await drainMicrotasks();
    const initCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/sessions/init'));
    expect(initCalls).toHaveLength(2);
    expect(chunkMocks.uploadChunk).toHaveBeenCalledTimes(1);
    expect(rrwebState.takeFullSnapshot).toHaveBeenCalledWith(true);
  });

  it('stops capture when closing the old identity is told to stop', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    chunkMocks.uploadChunk.mockResolvedValueOnce('stop');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ recording: true }) });

    setUser({ id: 'alice' });
    await drainMicrotasks();

    expect(rrwebState.stop).toHaveBeenCalled();
  });

  it('closes the old identity with its next seq without advancing the new session', async () => {
    await startEnabled();
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500));
    emit(fullSnapshot(31_000), true); // old session seq 0
    emit(incremental(31_500));
    await drainMicrotasks();
    chunkMocks.uploadChunk.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ recording: true }) });

    setUser({ id: 'alice' });
    await drainMicrotasks();

    expect(chunkMocks.uploadChunk.mock.calls[0]?.[1]).toBe(1);
    expect(peekChunkSeq()).toBe(0);
  });

  it('rotates idle capture without mixing old events into the new session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    await startEnabled();
    const firstInit = JSON.parse(fetchMock.mock.calls[0][1].body) as { session_id: string };
    emit(fullSnapshot(1_000), true);
    emit(incremental(1_500, 'old-session'));

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ recording: true }) });
    vi.setSystemTime(new Date('2026-07-14T12:31:00Z'));
    emit(incremental(2_000, 'idle-boundary'));
    await drainMicrotasks();

    const initCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/sessions/init'));
    expect(initCalls).toHaveLength(2);
    const secondInit = JSON.parse(initCalls[1][1].body) as { session_id: string };
    expect(secondInit.session_id).not.toBe(firstInit.session_id);
    expect(chunkMocks.uploadChunk).toHaveBeenCalledWith(
      firstInit.session_id,
      0,
      expect.arrayContaining([expect.objectContaining({ timestamp: 1_500 })]),
      true,
    );

    // Incrementals emitted while registration/snapshot rotation is incomplete
    // cannot form an independently playable chunk and must be discarded.
    emit(incremental(2_500, 'before-snapshot'));
    emit(fullSnapshot(3_000), true);
    emit(incremental(3_500, 'new-session'));
    emit(fullSnapshot(33_000), true);
    await drainMicrotasks();

    const newSessionCall = chunkMocks.uploadChunk.mock.calls.find((call) => call[0] === secondInit.session_id);
    expect(newSessionCall?.[1]).toBe(0);
    expect((newSessionCall?.[2] as eventWithTime[])[0].type).toBe(EventType.FullSnapshot);
    expect(JSON.stringify(newSessionCall?.[2])).not.toContain('before-snapshot');
    vi.useRealTimers();
  });

  it('routes telemetry into rrweb custom events', async () => {
    await startEnabled();
    emitTelemetry({ kind: 'click', clickId: 'c_1', selector: '#buy', cursor: 'pointer', at: 1 });
    expect(rrwebState.addCustomEvent).toHaveBeenCalledWith(
      'opslane.telemetry',
      expect.objectContaining({ kind: 'click', selector: '#buy' }),
    );
  });

});
