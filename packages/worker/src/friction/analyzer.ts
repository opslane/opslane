import type {
  FrictionSignalType,
  SessionChunkEnvelope,
  SessionTelemetryEvent,
} from '@opslane/shared';
import { frictionFingerprint, normalizePageUrl } from './fingerprint.js';

export const RULE_VERSION = 2;

const CLICK_CLUSTER_GAP_MS = 1_000;
const RAGE_MIN_CLICKS = 3;
const RESPONSE_WINDOW_MS = 1_000;
const OPTION_ANSWER_WINDOW_MS = 5_000;
const SYNTHETIC_ANCHOR_WINDOW_MS = 50;

export interface DetectedSignal {
  signalType: FrictionSignalType;
  fingerprint: string;
  elementSelector: string | null;
  pageUrlNormalized: string;
  occurredAt: number;
  occurredAts: number[];
  occurrenceCount: number;
  ruleVersion: number;
}

export interface TimedSessionTelemetryEvent {
  event: SessionTelemetryEvent;
  timestamp: number;
}

interface RawEvent {
  type: number;
  data: Record<string, unknown>;
  timestamp: number;
}

interface PageEntry {
  timestamp: number;
  href: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Trust-boundary bounds: telemetry is browser-controlled, so a NUL selector
// (rejected by Postgres text) or an out-of-range timestamp (overflows
// to_timestamp in persist.ts) would poison every retry until dead-lettered.
// Reject them here so a malformed event is dropped, not persisted.
const MAX_SELECTOR_LEN = 1024;
const MAX_EPOCH_MS = 4_102_444_800_000; // 2100-01-01, comfortably past any real session

function isSaneEpochMs(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

function isSaneSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SELECTOR_LEN && !value.includes('\u0000');
}

export function isSessionTelemetryEvent(value: unknown): value is SessionTelemetryEvent {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || !isSaneEpochMs(value['at'])) {
    return false;
  }

  switch (value['kind']) {
    case 'click':
      return (
        typeof value['clickId'] === 'string' &&
        isSaneSelector(value['selector']) &&
        typeof value['cursor'] === 'string'
      );
    case 'request_start':
      return (
        typeof value['requestId'] === 'string' &&
        (typeof value['clickId'] === 'string' || value['clickId'] === null) &&
        typeof value['method'] === 'string' &&
        typeof value['url'] === 'string'
      );
    case 'request_end':
      return typeof value['requestId'] === 'string' && isFiniteNumber(value['status']);
    case 'form_submit':
      return typeof value['selector'] === 'string';
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

/** Extracts only top-level rrweb custom telemetry events. */
export function extractTelemetryEvents(
  chunks: SessionChunkEnvelope[],
): TimedSessionTelemetryEvent[] {
  const telemetry: TimedSessionTelemetryEvent[] = [];
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      const raw = asRawEvent(value);
      if (raw?.type !== 5 || raw.data['tag'] !== 'opslane.telemetry') continue;
      const payload = raw.data['payload'];
      if (!isSessionTelemetryEvent(payload)) continue;
      telemetry.push({ event: payload, timestamp: raw.timestamp });
    }
  }
  return telemetry.sort((a, b) => a.event.at - b.event.at || a.timestamp - b.timestamp);
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((values[middle] ?? Infinity) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function hasTimestampInWindow(values: number[], start: number, end: number): boolean {
  const index = lowerBound(values, start);
  return index < values.length && (values[index] ?? Infinity) <= end;
}

function pageAt(pages: PageEntry[], timestamp: number): string {
  let low = 0;
  let high = pages.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((pages[middle]?.timestamp ?? Infinity) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return normalizePageUrl(pages[low - 1]?.href ?? '');
}

function foldSignal(signals: Map<string, DetectedSignal>, signal: DetectedSignal): void {
  const current = signals.get(signal.fingerprint);
  if (!current) {
    signals.set(signal.fingerprint, signal);
    return;
  }
  current.occurrenceCount += signal.occurrenceCount;
  current.occurredAts.push(...signal.occurredAts);
  current.occurredAts.sort((a, b) => a - b);
  current.occurredAt = Math.min(current.occurredAt, signal.occurredAt);
}

function makeSignal(
  signalType: FrictionSignalType,
  selector: string | null,
  pageUrl: string,
  occurredAt: number,
): DetectedSignal {
  return {
    signalType,
    fingerprint: frictionFingerprint(signalType, selector, pageUrl),
    elementSelector: selector,
    pageUrlNormalized: pageUrl,
    occurredAt,
    occurredAts: [occurredAt],
    occurrenceCount: 1,
    ruleVersion: RULE_VERSION,
  };
}

/** Pure and deterministic over scrubbed chunks. Late chunks may change the answer. */
export function analyzeSession(chunks: SessionChunkEnvelope[]): DetectedSignal[] {
  const telemetry = extractTelemetryEvents(chunks);
  const mutations: number[] = [];
  const pages: PageEntry[] = [];

  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      const raw = asRawEvent(value);
      if (!raw) continue;
      if (raw.type === 3 && raw.data['source'] === 0) mutations.push(raw.timestamp);
      if (raw.type === 4 && typeof raw.data['href'] === 'string') {
        pages.push({ timestamp: raw.timestamp, href: raw.data['href'] });
      }
    }
  }

  mutations.sort((a, b) => a - b);
  pages.sort((a, b) => a.timestamp - b.timestamp);

  const requestStartsByClickId = new Map<string, number[]>();
  const clicksBySelector = new Map<string, Array<Extract<SessionTelemetryEvent, { kind: 'click' }>>>();
  const optionClickTimes = telemetry
    .filter(({ event }) => event.kind === 'click' && isOptionSelector(event.selector))
    .map(({ event }) => event.at)
    .sort((a, b) => a - b);
  const allClickTimes = telemetry
    .filter(({ event }) => event.kind === 'click')
    .map(({ event }) => event.at)
    .sort((a, b) => a - b);

  for (const { event } of telemetry) {
    if (event.kind === 'request_start' && event.clickId !== null) {
      const starts = requestStartsByClickId.get(event.clickId) ?? [];
      starts.push(event.at);
      requestStartsByClickId.set(event.clickId, starts);
    } else if (event.kind === 'click') {
      if (event.cursor === 'text' || isOptionSelector(event.selector)) continue;
      if (
        event.selector === 'body > a' &&
        hasTimestampInWindow(allClickTimes, event.at - SYNTHETIC_ANCHOR_WINDOW_MS, event.at - 1)
      ) continue;
      const clicks = clicksBySelector.get(event.selector) ?? [];
      clicks.push(event);
      clicksBySelector.set(event.selector, clicks);
    }
  }

  for (const starts of requestStartsByClickId.values()) starts.sort((a, b) => a - b);

  const answered = (click: Extract<SessionTelemetryEvent, { kind: 'click' }>): boolean => {
    const windowEnd = click.at + RESPONSE_WINDOW_MS;
    if (hasTimestampInWindow(mutations, click.at, windowEnd)) return true;
    const requestStarts = requestStartsByClickId.get(click.clickId) ?? [];
    return hasTimestampInWindow(requestStarts, click.at, windowEnd);
  };
  const deadClickAnswered = (
    click: Extract<SessionTelemetryEvent, { kind: 'click' }>,
  ): boolean => answered(click) || hasTimestampInWindow(
    optionClickTimes,
    click.at,
    click.at + OPTION_ANSWER_WINDOW_MS,
  );

  const signals = new Map<string, DetectedSignal>();
  for (const clicks of clicksBySelector.values()) {
    clicks.sort((a, b) => a.at - b.at || a.clickId.localeCompare(b.clickId));
    let clusterStart = 0;
    while (clusterStart < clicks.length) {
      let clusterEnd = clusterStart + 1;
      while (
        clusterEnd < clicks.length &&
        (clicks[clusterEnd]?.at ?? Infinity) - (clicks[clusterEnd - 1]?.at ?? -Infinity) <=
          CLICK_CLUSTER_GAP_MS
      ) {
        clusterEnd += 1;
      }

      const cluster = clicks.slice(clusterStart, clusterEnd);
      if (cluster.length >= RAGE_MIN_CLICKS) {
        const lastClick = cluster[cluster.length - 1];
        if (lastClick && !answered(lastClick)) {
          const pageUrl = pageAt(pages, lastClick.at);
          foldSignal(signals, makeSignal('rage_click', lastClick.selector, pageUrl, lastClick.at));
        }
      } else {
        for (const click of cluster) {
          if (click.cursor !== 'pointer' || deadClickAnswered(click)) continue;
          const pageUrl = pageAt(pages, click.at);
          foldSignal(signals, makeSignal('dead_click', click.selector, pageUrl, click.at));
        }
      }
      clusterStart = clusterEnd;
    }
  }

  return [...signals.values()].sort(
    (a, b) =>
      a.occurredAt - b.occurredAt ||
      a.signalType.localeCompare(b.signalType) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
}

function isOptionSelector(selector: string): boolean {
  return /#react-select-.*-option-/.test(selector)
    || /\[role=["']?option/.test(selector)
    || /\brole=option\b/.test(selector);
}
