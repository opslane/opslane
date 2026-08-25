import { describe, expect, it } from 'vitest';
import type { eventWithTime } from '@rrweb/types';
import { crashSeekMs, ensureReplayMeta, formatTime, isActiveEvent, replayDurationMs, replayViewport, sortedReplayEvents } from './replay-utils';

const ev = (timestamp: number, type: number, source?: number): eventWithTime =>
  ({ timestamp, type, data: source === undefined ? {} : { source } } as unknown as eventWithTime);

describe('formatTime', () => {
  it('formats m:ss', () => expect(formatTime(75)).toBe('1:15'));
  it('formats h:mm:ss', () => expect(formatTime(3661)).toBe('1:01:01'));
  it('clamps negatives', () => expect(formatTime(-5)).toBe('0:00'));
});

describe('replayDurationMs', () => {
  it('is last minus first', () => {
    expect(replayDurationMs([ev(1000, 2), ev(4000, 3, 1)])).toBe(3000);
  });

  it('is 0 for fewer than two events', () => {
    expect(replayDurationMs([ev(1000, 2)])).toBe(0);
  });
});

describe('crashSeekMs', () => {
  const events = [ev(1000, 2), ev(2000, 3, 1), ev(9000, 3, 1)];

  it('seeks to crash offset within bounds', () => {
    expect(crashSeekMs(events, 5000)).toBe(4000);
  });

  it('clamps a crash before the start to 0', () => {
    expect(crashSeekMs(events, 500)).toBe(0);
  });

  it('clamps a crash past the end to the duration', () => {
    expect(crashSeekMs(events, 999999)).toBe(8000);
  });

  it('defaults to about 5s before the end when no crash timestamp exists', () => {
    expect(crashSeekMs(events, undefined)).toBe(3000);
  });

  it('defaults to 0 when the recording is shorter than 5s', () => {
    expect(crashSeekMs([ev(1000, 2), ev(3000, 3, 1)], undefined)).toBe(0);
  });
});

describe('isActiveEvent', () => {
  it('treats full snapshot as active', () => expect(isActiveEvent(ev(1, 2))).toBe(true));
  it('treats input as active', () => expect(isActiveEvent(ev(1, 3, 5))).toBe(true));
  it('treats non-interactive incremental as inactive', () => expect(isActiveEvent(ev(1, 3, 0))).toBe(false));
});

describe('sortedReplayEvents', () => {
  it('sorts defensively by timestamp', () => {
    expect(sortedReplayEvents([ev(3000, 3, 1), ev(1000, 2)]).map((event) => event.timestamp)).toEqual([1000, 3000]);
  });
});

describe('ensureReplayMeta', () => {
  it('prepends exactly one viewport event to a Meta-less stream', () => {
    const events = [ev(1000, 2), ev(2000, 3, 1)];
    const result = ensureReplayMeta(events);
    expect(result.map((event) => event.type)).toEqual([4, 2, 3]);
    expect(result[0]).toMatchObject({
      timestamp: 1000,
      data: { width: 1280, height: 720 },
    });
    expect(events).toHaveLength(2);
  });

  it('leaves a stream with Meta untouched', () => {
    const events = [ev(1000, 4), ev(1000, 2)];
    expect(ensureReplayMeta(events)).toBe(events);
  });
});

describe('replayViewport', () => {
  const meta = (width: number, height: number): eventWithTime =>
    ({ timestamp: 1000, type: 4, data: { width, height } } as unknown as eventWithTime);

  it('reads the recorded viewport from the first Meta event', () => {
    expect(replayViewport([meta(1050, 820), ev(1000, 2)])).toEqual({ width: 1050, height: 820 });
  });

  it('falls back to 1280x720 when no Meta event is present', () => {
    expect(replayViewport([ev(1000, 2), ev(2000, 3, 1)])).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to defaults for a zero or missing dimension', () => {
    expect(replayViewport([meta(0, 0)])).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to a coherent pair when only one dimension is valid', () => {
    expect(replayViewport([meta(1050, 0)])).toEqual({ width: 1280, height: 720 });
    expect(replayViewport([meta(0, 820)])).toEqual({ width: 1280, height: 720 });
  });
});
