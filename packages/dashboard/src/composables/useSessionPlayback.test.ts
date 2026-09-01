import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import type { SessionChunkMeta, SessionDetail } from '../types/api';

const api = vi.hoisted(() => {
  class MockAPIError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  }
  return {
    APIError: MockAPIError,
    getSession: vi.fn(),
    getSessionChunk: vi.fn(),
  };
});

vi.mock('../api', () => api);

import {
  MAX_SESSION_POLLS,
  SESSION_POLL_INTERVAL_MS,
  useSessionPlayback,
} from './useSessionPlayback';

const MiB = 1024 * 1024;

const chunk = (seq: number, overrides: Partial<SessionChunkMeta> = {}): SessionChunkMeta => ({
  seq,
  decoded_size_bytes: 1,
  has_full_snapshot: true,
  first_event_ms: seq * 1_000,
  last_event_ms: seq * 1_000 + 999,
  ...overrides,
});

const detail = (chunks: SessionChunkMeta[]): SessionDetail => ({
  id: 'session-1',
  started_at: '2026-07-15T00:00:00Z',
  last_chunk_at: '2026-07-15T00:01:00Z',
  status: 'closed',
  chunk_count: chunks.length,
  playable_chunk_count: chunks.length,
  bytes_stored: 100,
  error_count: 0,
  rage_click_count: 0,
  dead_click_count: 0,
  form_abandon_count: 0,
  coverage: null,
  activity_class: null,
  failed_request_count: 0,
  successful_write_count: 0,
  unverified_signal_count: 0,
  observation_count: 0,
  chunks,
});

const envelope = (timestamp: number) => ({
  events: [{ type: 2, timestamp, data: { node: {} } }],
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('useSessionPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.getSession.mockReset();
    api.getSessionChunk.mockReset();
    api.getSessionChunk.mockImplementation((_project: string, _session: string, seq: number) => (
      Promise.resolve(envelope(seq * 1_000))
    ));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls an empty full session until chunks become playable', async () => {
    api.getSession
      .mockResolvedValueOnce(detail([]))
      .mockResolvedValueOnce(detail([chunk(0)]));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(playback.state.value).toBe('processing');

    await vi.advanceTimersByTimeAsync(SESSION_POLL_INTERVAL_MS);
    await settle();
    expect(playback.state.value).toBe('ready');
    expect(playback.pollAttempt.value).toBe(1);
    scope.stop();
  });

  it('stops after the bounded full-session poll budget', async () => {
    api.getSession.mockResolvedValue(detail([]));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    for (let i = 0; i < MAX_SESSION_POLLS; i++) {
      await vi.advanceTimersByTimeAsync(SESSION_POLL_INTERVAL_MS);
      await settle();
    }
    expect(playback.state.value).toBe('unavailable');
    expect(playback.terminalUnavailable.value).toBe(true);
    expect(playback.pollsRemaining.value).toBe(0);
    scope.stop();
  });

  it('does not mistake old playable footage for error-window coverage', async () => {
    const old = chunk(0, { first_event_ms: 1_000, last_event_ms: 2_000 });
    const covering = chunk(1, { first_event_ms: 99_000, last_event_ms: 101_000 });
    api.getSession
      .mockResolvedValueOnce(detail([old]))
      .mockResolvedValueOnce(detail([old]))
      .mockResolvedValueOnce(detail([old, covering]));
    api.getSessionChunk.mockResolvedValue({ events: [
      { type: 2, timestamp: 99_000, data: {} },
      { type: 3, timestamp: 101_000, data: { source: 1 } },
    ] });
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1', {
      windowed: true,
      errorAt: '1970-01-01T00:01:40.000Z',
    }))!;
    await settle();
    expect(playback.state.value).toBe('processing');
    expect(api.getSessionChunk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_POLL_INTERVAL_MS);
    await settle();
    expect(playback.state.value).toBe('processing');
    await vi.advanceTimersByTimeAsync(SESSION_POLL_INTERVAL_MS);
    await settle();

    expect(playback.state.value).toBe('ready');
    expect(playback.approximate.value).toBe(false);
    expect(playback.seekMs.value).toBe(100_000);
    expect(api.getSessionChunk).toHaveBeenCalledTimes(1);
    expect(api.getSessionChunk).toHaveBeenCalledWith('project-1', 'session-1', 1);
    scope.stop();
  });

  it('degrades to nearest footage after the coverage poll budget', async () => {
    const old = chunk(0, { first_event_ms: 1_000, last_event_ms: 2_000 });
    api.getSession.mockResolvedValue(detail([old]));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1', {
      windowed: true,
      errorAt: '1970-01-01T00:03:20.000Z',
    }))!;
    await settle();
    for (let i = 0; i < MAX_SESSION_POLLS; i++) {
      await vi.advanceTimersByTimeAsync(SESSION_POLL_INTERVAL_MS);
      await settle();
    }
    expect(playback.state.value).toBe('ready');
    expect(playback.approximate.value).toBe(true);
    expect(playback.terminalUnavailable.value).toBe(false);
    scope.stop();
  });

  it('loads one bounded segment at a time and releases the previous events', async () => {
    const chunks = [
      chunk(0, { decoded_size_bytes: 40 * MiB }),
      chunk(1, { decoded_size_bytes: 40 * MiB }),
      chunk(2, { decoded_size_bytes: 40 * MiB }),
    ];
    api.getSession.mockResolvedValue(detail(chunks));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(playback.segments.value).toHaveLength(3);
    const firstEvents = playback.events.value;

    await playback.loadSegment(1);
    expect(playback.events.value).not.toBe(firstEvents);
    expect(playback.events.value[0].timestamp).toBe(1_000);
    expect(api.getSessionChunk.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    scope.stop();
  });

  it('does not let an older segment load overwrite a newer selection', async () => {
    const chunks = [
      chunk(0, { decoded_size_bytes: 40 * MiB }),
      chunk(1, { decoded_size_bytes: 40 * MiB }),
      chunk(2, { decoded_size_bytes: 40 * MiB }),
    ];
    let resolveOne: ((value: ReturnType<typeof envelope>) => void) | undefined;
    let resolveTwo: ((value: ReturnType<typeof envelope>) => void) | undefined;
    api.getSession.mockResolvedValue(detail(chunks));
    api.getSessionChunk.mockImplementation((_project: string, _session: string, seq: number) => {
      if (seq === 0) return Promise.resolve(envelope(0));
      return new Promise((resolve) => {
        if (seq === 1) resolveOne = resolve;
        if (seq === 2) resolveTwo = resolve;
      });
    });
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();

    const olderLoad = playback.loadSegment(1);
    await settle();
    const newerLoad = playback.loadSegment(2);
    await settle();
    resolveTwo?.(envelope(2_000));
    await newerLoad;
    expect(playback.activeSegment.value).toBe(2);
    expect(playback.events.value.map((event) => event.timestamp)).toEqual([2_000]);

    resolveOne?.(envelope(1_000));
    await olderLoad;
    expect(playback.activeSegment.value).toBe(2);
    expect(playback.events.value.map((event) => event.timestamp)).toEqual([2_000]);
    scope.stop();
  });

  it('plays successful chunks and reports a partial segment', async () => {
    api.getSession.mockResolvedValue(detail([chunk(0), chunk(1)]));
    api.getSessionChunk.mockImplementation((_project: string, _session: string, seq: number) => (
      seq === 0 ? Promise.resolve(envelope(1_000)) : Promise.reject(new Error('missing'))
    ));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(playback.state.value).toBe('partial');
    expect(playback.missingChunks.value).toEqual({ missing: 1, total: 2 });
    expect(playback.events.value).toHaveLength(1);
    scope.stop();
  });

  it('limits chunk requests to four concurrent fetches', async () => {
    const chunks = Array.from({ length: 5 }, (_, seq) => chunk(seq));
    const releases: Array<(() => void) | undefined> = [];
    api.getSession.mockResolvedValue(detail(chunks));
    api.getSessionChunk.mockImplementation((_project: string, _session: string, seq: number) => (
      new Promise((resolve) => {
        releases[seq] = () => resolve(envelope(seq * 1_000));
      })
    ));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(api.getSessionChunk).toHaveBeenCalledTimes(4);

    releases[0]?.();
    await settle();
    expect(api.getSessionChunk).toHaveBeenCalledTimes(5);
    releases.slice(1).forEach((release) => release?.());
    await settle();
    expect(playback.state.value).toBe('ready');
    scope.stop();
  });

  it.each([
    ['all chunk requests fail', () => Promise.reject(new Error('missing'))],
    ['all decoded envelopes are empty', () => Promise.resolve({ events: [] })],
  ])('marks terminal unavailability when %s', async (_label, implementation) => {
    api.getSession.mockResolvedValue(detail([chunk(0)]));
    api.getSessionChunk.mockImplementation(implementation);
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(playback.state.value).toBe('unavailable');
    expect(playback.terminalUnavailable.value).toBe(true);
    scope.stop();
  });

  it('marks a missing pointer session terminal so callers can use legacy replay', async () => {
    api.getSession.mockRejectedValue(new api.APIError(404, 'not found'));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'missing', {
      windowed: true,
      errorAt: '2026-07-15T00:00:00Z',
    }))!;
    await settle();
    expect(playback.state.value).toBe('unavailable');
    expect(playback.terminalUnavailable.value).toBe(true);
    scope.stop();
  });

  it('keeps transient session API failures distinct from terminal fallback', async () => {
    api.getSession.mockRejectedValue(new api.APIError(500, 'server error'));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1'))!;
    await settle();
    expect(playback.state.value).toBe('error');
    expect(playback.terminalUnavailable.value).toBe(false);
    scope.stop();
  });

  it('keeps a full-session deep link segmented and seeks in its matching segment', async () => {
    const chunks = [
      chunk(0, { decoded_size_bytes: 40 * MiB, first_event_ms: 1_000, last_event_ms: 2_000 }),
      chunk(1, { decoded_size_bytes: 40 * MiB, first_event_ms: 10_000, last_event_ms: 11_000 }),
    ];
    api.getSession.mockResolvedValue(detail(chunks));
    api.getSessionChunk.mockImplementation((_project: string, _session: string, seq: number) => (
      Promise.resolve({ events: [
        { type: 2, timestamp: seq === 0 ? 1_000 : 10_000, data: {} },
        { type: 3, timestamp: seq === 0 ? 2_000 : 11_000, data: { source: 1 } },
      ] })
    ));
    const scope = effectScope();
    const playback = scope.run(() => useSessionPlayback('project-1', 'session-1', {
      windowed: false,
      seekAtMs: 10_500,
    }))!;
    await settle();
    expect(playback.segments.value).toHaveLength(2);
    expect(playback.activeSegment.value).toBe(1);
    expect(playback.seekMs.value).toBe(10_500);
    expect(api.getSessionChunk).toHaveBeenCalledWith('project-1', 'session-1', 1);
    scope.stop();
  });
});
