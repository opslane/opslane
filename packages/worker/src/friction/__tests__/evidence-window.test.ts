import { describe, expect, it } from 'vitest';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { buildEvidenceWindows, EVIDENCE_WINDOW_MAX_EVENTS } from '../evidence-window.js';

const T0 = 1_754_000_000_000;
const telemetry = (at: number, payload: Record<string, unknown>) =>
  ({ type: 5, timestamp: at, data: { tag: 'opslane.telemetry', payload: { at, ...payload } } });
const envelope = (events: unknown[]): SessionChunkEnvelope => ({
  events, meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: T0 },
});

describe('buildEvidenceWindows', () => {
  it('bounds and chronologically orders each occurrence window', () => {
    const events = Array.from({ length: 50 }, (_, index) => telemetry(T0 - 20_000 + index * 1_000, {
      kind: 'click', clickId: `c${index}`, selector: '.x', cursor: 'pointer',
    }));
    const window = buildEvidenceWindows([envelope(events)], [T0])[0] ?? [];
    expect(window.length).toBeLessThanOrEqual(EVIDENCE_WINDOW_MAX_EVENTS);
    expect(window.every((event) => Math.abs(event.t - T0) <= 15_000)).toBe(true);
    expect([...window].sort((a, b) => a.t - b.t)).toEqual(window);
    expect(window.some((event) => event.t === T0)).toBe(true);
  });

  it('retains request pairs atomically while trimming', () => {
    const events: unknown[] = [];
    for (let index = 0; index < 40; index += 1) {
      events.push(
        telemetry(T0 + index, { kind: 'request_start', requestId: `r${index}`, clickId: null, method: 'GET', url: '/api' }),
        telemetry(T0 + index + 0.1, { kind: 'request_end', requestId: `r${index}`, status: 200 }),
      );
    }
    const window = buildEvidenceWindows([envelope(events)], [T0])[0] ?? [];
    const starts = window.filter((event) => event.kind === 'request_start').map((event) => event.requestId).sort();
    const ends = window.filter((event) => event.kind === 'request_end').map((event) => event.requestId).sort();
    expect(starts).toEqual(ends);
  });
});
