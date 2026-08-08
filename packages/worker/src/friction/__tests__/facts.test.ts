import { describe, expect, it } from 'vitest';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { classifyActivity, deriveCoverage, extractSessionFacts, formatSessionContext } from '../facts.js';
import { normalizeEntryPath } from '../fingerprint.js';

const T0 = 1_754_000_000_000;
const telemetry = (at: number, payload: Record<string, unknown>) =>
  ({ type: 5, timestamp: at, data: { tag: 'opslane.telemetry', payload: { at, ...payload } } });
const page = (at: number, href: string) => ({ type: 4, timestamp: at, data: { href } });
const envelope = (events: unknown[]): SessionChunkEnvelope => ({
  events,
  meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: T0 },
});

describe('session facts', () => {
  it('accounts for same-origin failures and writes', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1, { kind: 'request_start', requestId: 'r1', clickId: null, method: 'GET', url: '/api/a' }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'r1', status: 500 }),
      telemetry(T0 + 3, { kind: 'request_start', requestId: 'r2', clickId: null, method: 'POST', url: 'https://app.example.com/api/save' }),
      telemetry(T0 + 4, { kind: 'request_end', requestId: 'r2', status: 201 }),
      telemetry(T0 + 5, { kind: 'request_start', requestId: 'r3', clickId: null, method: 'POST', url: 'https://other.example/api/save' }),
      telemetry(T0 + 6, { kind: 'request_end', requestId: 'r3', status: 400 }),
      telemetry(T0 + 7, { kind: 'request_end', requestId: 'ghost', status: 401 }),
    ])]);
    expect(facts.failedRequest5xxCount).toBe(1);
    expect(facts.failedRequest4xxCount).toBe(0);
    expect(facts.successfulWriteCount).toBe(1);
    expect(facts.unattributedFailedRequestCount).toBe(1);
  });

  it('uses the earliest normalized entry path', () => {
    const facts = extractSessionFacts([envelope([
      page(T0 + 10, 'https://x.test/other'),
      page(T0, 'https://x.test/assets/123/_ctx_blob/edit?tab=1'),
    ])]);
    expect(facts.entryPath).toBe('/assets/:id/edit');
    expect(normalizeEntryPath('not a url')).toBeNull();
  });

  it('derives coverage and activity from complete evidence only', () => {
    const empty = extractSessionFacts([]);
    expect(deriveCoverage({ totalChunkCount: 3, envelopeCount: 0, truncated: false })).toBe('no_replay');
    expect(deriveCoverage({ totalChunkCount: 2, envelopeCount: 1, truncated: false })).toBe('partial');
    expect(deriveCoverage({ totalChunkCount: 1, envelopeCount: 1, truncated: false })).toBe('complete');
    expect(classifyActivity({ ...empty, clickCount: 9 }, 'partial')).toBe('unknown');
    expect(classifyActivity({ ...empty, clickCount: 2, inputEventCount: 1 }, 'complete')).toBe('active');
    expect(classifyActivity({ ...empty, firstEventMs: T0, lastEventMs: T0 + 11 * 60_000 }, 'complete')).toBe('idle_tab');
  });

  it('formats prompt context and omits zero counts', () => {
    expect(formatSessionContext({
      coverage: 'complete', activityClass: 'active', entryPath: '/getting-started',
      failedRequest4xxCount: 6, failedRequest5xxCount: 0, successfulWriteCount: 2,
    })).toBe('Session context: active session entering at /getting-started; 6 same-origin failed requests; 2 successful writes; coverage complete.');
  });
});
