import type { eventWithTime } from '@rrweb/types';

const ACTIVE_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 9]);
const CRASH_TAIL_MS = 5000;

/** rrweb event types: 2 = FullSnapshot, 3 = IncrementalSnapshot, 4 = Meta. */
export function isActiveEvent(event: eventWithTime): boolean {
  if (event.type === 2 || event.type === 4) return true;
  if (event.type === 3 && event.data) {
    const source = (event.data as { source?: number }).source;
    return source !== undefined && ACTIVE_SOURCES.has(source);
  }
  return false;
}

export function sortedReplayEvents(events: eventWithTime[]): eventWithTime[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

/** Old recordings omitted rrweb's viewport Meta event, producing a 0x0 iframe. */
export function ensureReplayMeta(events: eventWithTime[]): eventWithTime[] {
  if (events.length === 0 || events.some((event) => event.type === 4)) return events;
  const synthetic = {
    type: 4,
    data: { width: 1280, height: 720 },
    timestamp: events[0].timestamp,
  } as eventWithTime;
  return [synthetic, ...events];
}

/**
 * The recorded viewport, taken from rrweb's first Meta event. The player scales
 * the replay to fit its container using this as the source coordinate space, so
 * that the replayed cursor (drawn in recorded coordinates) stays aligned with
 * the reflowed page. Falls back to the same 1280x720 default ensureReplayMeta
 * injects for recordings that never carried a Meta event.
 */
export function replayViewport(events: eventWithTime[]): { width: number; height: number } {
  const meta = events.find((event) => event.type === 4);
  const data = meta?.data as { width?: number; height?: number } | undefined;
  // All-or-nothing: a Meta event missing either dimension is not a usable
  // viewport, so fall back to a coherent default pair rather than mixing a real
  // width with a default height (which would distort the aspect ratio).
  if (data && data.width && data.width > 0 && data.height && data.height > 0) {
    return { width: data.width, height: data.height };
  }
  return { width: 1280, height: 720 };
}

export function replayDurationMs(events: eventWithTime[]): number {
  if (!events || events.length < 2) return 0;
  return Math.max(0, events[events.length - 1].timestamp - events[0].timestamp);
}

export function crashSeekMs(events: eventWithTime[], crashTimestamp?: number): number {
  const duration = replayDurationMs(events);
  if (duration <= 0) return 0;
  if (crashTimestamp === undefined) {
    return Math.max(0, duration - CRASH_TAIL_MS);
  }
  const offset = crashTimestamp - events[0].timestamp;
  return Math.min(Math.max(0, offset), duration);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
