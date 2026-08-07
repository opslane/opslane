import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNetworkTimings,
  discardTiming,
  finalizeTiming,
  markHeaders,
  snapshotNetworkTimings,
  startTiming,
} from '../network-timing';

describe('network timing store', () => {
  beforeEach(() => clearNetworkTimings());

  it('records a completed request', () => {
    const handle = startTiming('fetch', 'GET', 'https://api.test/a');
    markHeaders(handle);
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(entry.transport).toBe('fetch');
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('https://api.test/a');
    expect(entry.outcome).toBe('ok');
    expect(entry.status).toBe(200);
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(entry.started_at_ms).toBeGreaterThan(0);
  });

  it('omits ttfb_ms and status when never observed', () => {
    const handle = startTiming('fetch', 'POST', 'https://api.test/b');
    finalizeTiming(handle, 'timeout');

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('timeout');
    expect(entry).not.toHaveProperty('ttfb_ms');
    expect(entry).not.toHaveProperty('status');
  });

  it('scrubs the query string and truncates oversized values', () => {
    const handle = startTiming('fetch', 'GET', 'https://api.test/c?token=secret#x');
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(entry.url).not.toContain('secret');

    clearNetworkTimings();
    const long = startTiming('xhr', 'propfind-very-long-method', `https://api.test/${'a'.repeat(4000)}`);
    finalizeTiming(long, 'ok', 200);

    const [big] = snapshotNetworkTimings();
    expect(big.url.length).toBe(2048);
    expect(big.method).toBe('PROPFIND-VERY-LO');
  });

  it('truncates the url by utf-8 bytes, not utf-16 units', () => {
    const handle = startTiming('fetch', 'GET', `https://api.test/${'é'.repeat(2000)}`);
    finalizeTiming(handle, 'ok', 200);

    const [entry] = snapshotNetworkTimings();
    expect(new TextEncoder().encode(entry.url).length).toBeLessThanOrEqual(2048);
    expect(entry.url).not.toMatch(/�$/);
  });

  it('keeps one long-running active request across 20 later completions', () => {
    const slow = startTiming('fetch', 'POST', 'https://api.test/slow');
    for (let i = 0; i < 20; i += 1) {
      const fast = startTiming('fetch', 'GET', `https://api.test/fast-${i}`);
      finalizeTiming(fast, 'ok', 200);
    }

    const snapshot = snapshotNetworkTimings();
    expect(snapshot[0].url).toBe('https://api.test/slow');
    expect(snapshot[0].outcome).toBe('in_flight');
    expect(snapshot).toHaveLength(20);
    expect(slow).toBeGreaterThanOrEqual(0);
  });

  it('refuses new requests at capacity and keeps the oldest twenty', () => {
    const handles = [];
    for (let i = 0; i < 25; i += 1) handles.push(startTiming('fetch', 'GET', `https://api.test/active-${i}`));

    expect(handles[19]).not.toBe(-1);
    expect(handles[20]).toBe(-1);
    expect(handles[24]).toBe(-1);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(20);
    expect(snapshot.every((e) => e.outcome === 'in_flight')).toBe(true);
    expect(snapshot[0].url).toBe('https://api.test/active-0');
    expect(snapshot[19].url).toBe('https://api.test/active-19');
    expect(snapshot.some((e) => e.url === 'https://api.test/active-20')).toBe(false);
  });

  it('no-ops on the untracked handle', () => {
    for (let i = 0; i < 20; i += 1) startTiming('fetch', 'GET', `https://api.test/a-${i}`);
    const untracked = startTiming('fetch', 'GET', 'https://api.test/refused');
    expect(untracked).toBe(-1);

    markHeaders(untracked);
    finalizeTiming(untracked, 'ok', 200);
    discardTiming(untracked);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(20);
    expect(snapshot.some((e) => e.url === 'https://api.test/refused')).toBe(false);
  });

  it('snapshots in-flight elapsed time from the monotonic clock', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    startTiming('fetch', 'POST', 'https://api.test/slow');
    nowSpy.mockReturnValue(11002);

    const [entry] = snapshotNetworkTimings();
    expect(entry.outcome).toBe('in_flight');
    expect(entry.duration_ms).toBe(10002);
    nowSpy.mockRestore();
  });

  it('clamps elapsed values at the ingestion ceiling', () => {
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    const handle = startTiming('fetch', 'GET', 'https://api.test/forever');
    nowSpy.mockReturnValue(900000);
    finalizeTiming(handle, 'timeout');

    expect(snapshotNetworkTimings()[0].duration_ms).toBe(600000);
    nowSpy.mockRestore();
  });

  it('does not reuse handles after clearing', () => {
    const stale = startTiming('fetch', 'GET', 'https://api.test/old');
    clearNetworkTimings();
    const fresh = startTiming('fetch', 'GET', 'https://api.test/new');
    expect(fresh).not.toBe(stale);

    finalizeTiming(stale, 'ok', 200);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].url).toBe('https://api.test/new');
    expect(snapshot[0].outcome).toBe('in_flight');
  });

  it('finalizes at most once', () => {
    const handle = startTiming('xhr', 'GET', 'https://api.test/d');
    finalizeTiming(handle, 'timeout');
    finalizeTiming(handle, 'ok', 200);

    const snapshot = snapshotNetworkTimings();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].outcome).toBe('timeout');
  });

  it('discards a record without recording it', () => {
    const handle = startTiming('xhr', 'GET', 'https://api.test/e');
    discardTiming(handle);
    expect(snapshotNetworkTimings()).toHaveLength(0);
  });

  it('clears both collections', () => {
    startTiming('fetch', 'GET', 'https://api.test/f');
    const done = startTiming('fetch', 'GET', 'https://api.test/g');
    finalizeTiming(done, 'ok', 200);

    clearNetworkTimings();
    expect(snapshotNetworkTimings()).toEqual([]);
  });
});
