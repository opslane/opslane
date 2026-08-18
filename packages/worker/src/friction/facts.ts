import { createHash } from 'node:crypto';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { extractTelemetryEvents } from './analyzer.js';
import { normalizeEntryPath, normalizePageUrl } from './fingerprint.js';

export type Coverage = 'complete' | 'partial' | 'no_replay';
export type ActivityClass = 'active' | 'light_touch' | 'zero_interaction' | 'idle_tab' | 'unknown';

export interface FailedRequestFact {
  requestIdHash: string;
  pageRoute: string;
  method: string;
  endpointPattern: string;
  status: number;
  actionKind: 'click' | 'form_submit' | null;
  actionSelector: string | null;
  actionLink: 'direct' | 'none';
  occurredAt: string;
}

export interface SuccessfulWriteRollup {
  pageRoute: string;
  method: string;
  endpointPattern: string;
  statusClass: number;
  count: number;
}

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
  failures: FailedRequestFact[];
  successes: SuccessfulWriteRollup[];
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

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isFailure(status: number): boolean {
  // 0 is a transport-level refusal. Statuses past 599 are nonstandard junk
  // (proxy 999 and friends) and stay excluded, as the pre-fact gate did.
  return status === 0 || (status >= 400 && status < 600);
}

// Detailed failure facts are derived from browser-controlled telemetry, so a
// hostile or broken client could otherwise write unbounded rows per session.
// Counters stay exact past the cap; only the detailed rows are bounded, most
// recent kept to match the read side's recency order.
const MAX_STORED_FAILURE_FACTS = 1000;

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
    failures: [],
    successes: [],
  };
  const pageOrigins = new Set<string>();
  const pages: Array<{ at: number; route: string }> = [];
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
        pages.push({ at: ts, route: normalizePageUrl(data['href']) });
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

  // The SDK records the raw string handed to fetch, so requests arrive as
  // absolute URLs, root-relative paths, slash-less document-relative paths
  // ('api/assets'), or protocol-relative '//host/path'. Resolving against the
  // page origin judges all of them the way the browser did; only a URL that
  // cannot be resolved at all falls back to the root-relative check.
  const basePageOrigin = (entryPageHref !== null ? originOf(entryPageHref) : null)
    ?? pageOrigins.values().next().value ?? null;
  const resolveRequestUrl = (url: string): URL | null => {
    try { return new URL(url); } catch { /* not absolute */ }
    if (basePageOrigin !== null) {
      try { return new URL(url, basePageOrigin); } catch { /* unresolvable */ }
    }
    return null;
  };
  const sameOrigin = (resolved: URL | null, rawUrl: string): boolean => {
    if (resolved !== null) return pageOrigins.has(resolved.origin);
    return rawUrl.startsWith('/') && !rawUrl.startsWith('//');
  };
  pages.sort((left, right) => left.at - right.at);
  const routeAt = (at: number): string => {
    let route = '';
    for (const page of pages) {
      if (page.at > at) break;
      route = page.route;
    }
    return route;
  };
  const clicksById = new Map<string, string>();
  const startById = new Map<string, {
    method: string;
    url: string;
    clickId: string | null;
    route: string;
    startedAt: number;
  }>();
  const successRollups = new Map<string, SuccessfulWriteRollup>();
  const consumedRequests = new Set<string>();
  for (const { event } of extractTelemetryEvents(chunks)) {
    if (event.kind === 'click') {
      facts.clickCount += 1;
      clicksById.set(event.clickId, event.selector);
    }
    if (event.kind === 'request_start') {
      startById.set(event.requestId, {
        method: event.method.toUpperCase(),
        url: event.url,
        clickId: event.clickId,
        route: routeAt(event.at),
        startedAt: event.at,
      });
    }
    if (event.kind === 'request_end') {
      const start = startById.get(event.requestId);
      if (!start) {
        // Either the start never arrived or a duplicate end already consumed
        // it. Only the never-started case is a countable unattributed failure;
        // a duplicate end is telemetry noise and must not double-count or
        // produce a second fact row with the same request hash.
        if (!consumedRequests.has(event.requestId) && isFailure(event.status)) {
          facts.unattributedFailedRequestCount += 1;
        }
        continue;
      }
      consumedRequests.add(event.requestId);
      startById.delete(event.requestId);
      const resolved = resolveRequestUrl(start.url);
      if (!sameOrigin(resolved, start.url)) continue;
      const isWrite = WRITE_METHODS.has(start.method);
      const endpointPattern = normalizePageUrl(resolved !== null ? resolved.href : start.url);
      if (event.status >= 200 && event.status < 300 && isWrite) {
        facts.successfulWriteCount += 1;
        const statusClass = Math.floor(event.status / 100);
        const key = JSON.stringify([start.route, start.method, endpointPattern, statusClass]);
        const current = successRollups.get(key);
        if (current) current.count += 1;
        else {
          successRollups.set(key, {
            pageRoute: start.route,
            method: start.method,
            endpointPattern,
            statusClass,
            count: 1,
          });
        }
      }
      if (isFailure(event.status)) {
        if (isWrite) facts.failedWriteCount += 1;
        if (event.status >= 400 && event.status < 500) facts.failedRequest4xxCount += 1;
        if (event.status >= 500 && event.status < 600) facts.failedRequest5xxCount += 1;
        const actionSelector = start.clickId === null ? null : clicksById.get(start.clickId) ?? null;
        facts.failures.push({
          requestIdHash: createHash('sha256')
            .update(`${event.requestId}:${start.startedAt}`)
            .digest('hex'),
          pageRoute: start.route,
          method: start.method,
          endpointPattern,
          status: event.status,
          actionKind: actionSelector === null ? null : 'click',
          actionSelector,
          actionLink: actionSelector === null ? 'none' : 'direct',
          occurredAt: new Date(event.at).toISOString(),
        });
      }
    }
  }
  facts.successes = [...successRollups.values()];
  if (facts.failures.length > MAX_STORED_FAILURE_FACTS) {
    facts.failures = facts.failures.slice(-MAX_STORED_FAILURE_FACTS);
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
