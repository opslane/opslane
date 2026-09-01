import type { SessionChunkEnvelope, SessionTelemetryEvent } from '@opslane/shared';

/** Whole-session facts and narrative signals now share generation 6. */
export const RULE_VERSION = 6;

export interface TimedSessionTelemetryEvent {
  event: SessionTelemetryEvent;
  timestamp: number;
}

interface RawEvent {
  type: number;
  data: Record<string, unknown>;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const MAX_SELECTOR_LEN = 1_024;
const MAX_EPOCH_MS = 4_102_444_800_000;

function isSaneEpochMs(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

function isSaneSelector(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SELECTOR_LEN
    && !value.includes('\u0000');
}

export function isSessionTelemetryEvent(value: unknown): value is SessionTelemetryEvent {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || !isSaneEpochMs(value['at'])) {
    return false;
  }
  switch (value['kind']) {
    case 'click':
      return typeof value['clickId'] === 'string'
        && isSaneSelector(value['selector'])
        && typeof value['cursor'] === 'string';
    case 'request_start':
      return typeof value['requestId'] === 'string'
        && (typeof value['clickId'] === 'string' || value['clickId'] === null)
        && typeof value['method'] === 'string'
        && typeof value['url'] === 'string';
    case 'request_end':
      return typeof value['requestId'] === 'string' && isFiniteNumber(value['status']);
    case 'form_submit':
      return isSaneSelector(value['selector']);
    default:
      return false;
  }
}

function asRawEvent(value: unknown): RawEvent | null {
  if (!isRecord(value) || !isFiniteNumber(value['type']) || !isFiniteNumber(value['timestamp'])) {
    return null;
  }
  const data = value['data'];
  if (!isRecord(data)) return null;
  return { type: value['type'], data, timestamp: value['timestamp'] };
}

/** Extracts the scrubbed SDK telemetry used by session-facts persistence. */
export function extractTelemetryEvents(
  chunks: SessionChunkEnvelope[],
): TimedSessionTelemetryEvent[] {
  const telemetry: TimedSessionTelemetryEvent[] = [];
  for (const chunk of chunks) {
    for (const value of chunk.events) {
      const raw = asRawEvent(value);
      if (raw?.type !== 5 || raw.data['tag'] !== 'opslane.telemetry') continue;
      const payload = raw.data['payload'];
      if (!isSessionTelemetryEvent(payload)) continue;
      telemetry.push({ event: payload, timestamp: raw.timestamp });
    }
  }
  return telemetry.sort((left, right) => left.event.at - right.event.at
    || left.timestamp - right.timestamp);
}
