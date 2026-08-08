import type { SessionChunkEnvelope } from '@opslane/shared';
import { extractTelemetryEvents } from './analyzer.js';
import { normalizeEntryPath } from './fingerprint.js';

export type Coverage = 'complete' | 'partial' | 'no_replay';
export type ActivityClass = 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';

export interface SessionFacts {
  entryPath: string | null;
  clickCount: number;
  inputEventCount: number;
  pageEventCount: number;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  unattributedFailedRequestCount: number;
  successfulWriteCount: number;
  failedWriteCount: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}

export interface SessionContextInput {
  coverage: Coverage;
  activityClass: ActivityClass;
  entryPath: string | null;
  failedRequest4xxCount: number;
  failedRequest5xxCount: number;
  successfulWriteCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function extractSessionFacts(chunks: SessionChunkEnvelope[]): SessionFacts {
  const facts: SessionFacts = {
    entryPath: null,
    clickCount: 0,
    inputEventCount: 0,
    pageEventCount: 0,
    failedRequest4xxCount: 0,
    failedRequest5xxCount: 0,
    unattributedFailedRequestCount: 0,
    successfulWriteCount: 0,
    failedWriteCount: 0,
    firstEventMs: null,
    lastEventMs: null,
  };
  const pageOrigins = new Set<string>();
  let entryPageHref: string | null = null;
  let entryPageTs = Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.events)) continue;
    for (const value of chunk.events) {
      if (!isRecord(value) || typeof value['timestamp'] !== 'number') continue;
      const ts = value['timestamp'];
      if (Number.isFinite(ts)) {
        facts.firstEventMs = facts.firstEventMs === null ? ts : Math.min(facts.firstEventMs, ts);
        facts.lastEventMs = facts.lastEventMs === null ? ts : Math.max(facts.lastEventMs, ts);
      }
      const data = value['data'];
      if (value['type'] === 4 && isRecord(data) && typeof data['href'] === 'string') {
        facts.pageEventCount += 1;
        const origin = originOf(data['href']);
        if (origin) pageOrigins.add(origin);
        if (ts < entryPageTs) {
          entryPageTs = ts;
          entryPageHref = data['href'];
        }
      }
      if (value['type'] === 3 && isRecord(data) && data['source'] === 5) {
        facts.inputEventCount += 1;
      }
    }
  }
  if (entryPageHref !== null) facts.entryPath = normalizeEntryPath(entryPageHref);

  const sameOrigin = (url: string): boolean => {
    const origin = originOf(url);
    return origin === null || pageOrigins.has(origin);
  };
  const startById = new Map<string, { method: string; url: string }>();
  for (const { event } of extractTelemetryEvents(chunks)) {
    if (event.kind === 'click') facts.clickCount += 1;
    if (event.kind === 'request_start') {
      startById.set(event.requestId, { method: event.method.toUpperCase(), url: event.url });
    }
    if (event.kind === 'request_end') {
      const start = startById.get(event.requestId);
      if (!start) {
        if (event.status >= 400) facts.unattributedFailedRequestCount += 1;
        continue;
      }
      if (!sameOrigin(start.url)) continue;
      const isWrite = WRITE_METHODS.has(start.method);
      if (event.status >= 200 && event.status < 300 && isWrite) facts.successfulWriteCount += 1;
      if (event.status >= 400 && event.status < 600) {
        if (isWrite) facts.failedWriteCount += 1;
        if (event.status < 500) facts.failedRequest4xxCount += 1;
        else facts.failedRequest5xxCount += 1;
      }
    }
  }
  return facts;
}

export function classifyActivity(facts: SessionFacts, coverage: Coverage): ActivityClass {
  if (coverage !== 'complete') return 'unknown';
  const interactions = facts.clickCount + facts.inputEventCount;
  if (interactions >= 3) return 'active';
  if (interactions >= 1) return 'light_touch';
  const span = facts.firstEventMs !== null && facts.lastEventMs !== null
    ? facts.lastEventMs - facts.firstEventMs
    : 0;
  return span >= 10 * 60_000 ? 'idle_tab' : 'zero_interaction';
}

export function deriveCoverage(input: {
  totalChunkCount: number;
  envelopeCount: number;
  truncated: boolean;
}): Coverage {
  if (input.envelopeCount === 0) return 'no_replay';
  if (input.truncated || input.envelopeCount < input.totalChunkCount) return 'partial';
  return 'complete';
}

export function formatSessionContext(row: SessionContextInput): string {
  const parts = [
    `${row.activityClass} session${row.entryPath ? ` entering at ${row.entryPath}` : ''}`,
  ];
  const failures = row.failedRequest4xxCount + row.failedRequest5xxCount;
  if (failures > 0) parts.push(`${failures} same-origin failed requests`);
  if (row.successfulWriteCount > 0) parts.push(`${row.successfulWriteCount} successful writes`);
  parts.push(`coverage ${row.coverage}`);
  return `Session context: ${parts.join('; ')}.`;
}
