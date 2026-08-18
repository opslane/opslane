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

  it('counts a refused DELETE as a failed write', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets/1'),
      telemetry(T0 + 1, {
        kind: 'request_start', requestId: 'delete-1', clickId: null,
        method: 'DELETE', url: '/api/assets/1',
      }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'delete-1', status: 400 }),
    ])]);

    expect(facts.failedWriteCount).toBe(1);
  });

  it('counts a status-zero transport refusal as a failed write', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1, {
        kind: 'request_start', requestId: 'create-1', clickId: null,
        method: 'POST', url: '/api/assets',
      }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'create-1', status: 0 }),
    ])]);

    expect(facts.failedWriteCount).toBe(1);
  });

  it('does not treat an unparseable URL as same-origin', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1, {
        kind: 'request_start', requestId: 'bad-url-1', clickId: null,
        method: 'POST', url: '::::not-a-url',
      }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'bad-url-1', status: 500 }),
    ])]);

    expect(facts.failedWriteCount).toBe(0);
  });

  it('extracts privacy-bounded request facts with only explicit click links', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets/42/edit?tab=details'),
      telemetry(T0 + 1, {
        kind: 'click', clickId: 'click-1', selector: '[data-testid="save"]', cursor: 'pointer',
      }),
      telemetry(T0 + 2, {
        kind: 'request_start', requestId: 'failure-1', clickId: 'click-1',
        method: 'PUT', url: 'https://app.example.com/api/assets/42?token=secret',
      }),
      telemetry(T0 + 3, { kind: 'request_end', requestId: 'failure-1', status: 400 }),
      telemetry(T0 + 4, {
        kind: 'request_start', requestId: 'failure-2', clickId: null,
        method: 'DELETE', url: '/api/assets/43?token=secret',
      }),
      telemetry(T0 + 5, { kind: 'request_end', requestId: 'failure-2', status: 0 }),
      telemetry(T0 + 6, {
        kind: 'request_start', requestId: 'success-1', clickId: null,
        method: 'POST', url: '/api/assets?source=form',
      }),
      telemetry(T0 + 7, { kind: 'request_end', requestId: 'success-1', status: 201 }),
      telemetry(T0 + 8, {
        kind: 'request_start', requestId: 'success-2', clickId: null,
        method: 'POST', url: '/api/assets?source=retry',
      }),
      telemetry(T0 + 9, { kind: 'request_end', requestId: 'success-2', status: 204 }),
    ])]);

    expect(facts.failures).toHaveLength(2);
    expect(facts.failures[0]).toMatchObject({
      pageRoute: '/assets/:id/edit',
      method: 'PUT',
      endpointPattern: '/api/assets/:id',
      status: 400,
      actionKind: 'click',
      actionSelector: '[data-testid="save"]',
      actionLink: 'direct',
    });
    expect(facts.failures[0]?.requestIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(facts.failures[1]).toMatchObject({
      method: 'DELETE',
      endpointPattern: '/api/assets/:id',
      status: 0,
      actionKind: null,
      actionSelector: null,
      actionLink: 'none',
    });
    expect(JSON.stringify(facts.failures)).not.toContain('app.example.com');
    expect(JSON.stringify(facts.failures)).not.toContain('token');
    expect(facts.successes).toEqual([{
      pageRoute: '/assets/:id/edit',
      method: 'POST',
      endpointPattern: '/api/assets',
      statusClass: 2,
      count: 2,
    }]);
  });

  it('keeps repeated SDK request ids distinct across page reloads', () => {
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1, {
        kind: 'request_start', requestId: 'f_1', clickId: null,
        method: 'POST', url: '/api/assets',
      }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'f_1', status: 400 }),
      page(T0 + 10_000, 'https://app.example.com/assets'),
      telemetry(T0 + 10_001, {
        kind: 'request_start', requestId: 'f_1', clickId: null,
        method: 'POST', url: '/api/assets',
      }),
      telemetry(T0 + 10_002, { kind: 'request_end', requestId: 'f_1', status: 400 }),
    ])]);

    expect(facts.failures).toHaveLength(2);
    expect(new Set(facts.failures.map((failure) => failure.requestIdHash)).size).toBe(2);
  });

  it('ignores a duplicate request_end instead of emitting a colliding fact row', () => {
    // Telemetry is browser-controlled: a repeated end for one start must not
    // double-count or produce two failure rows with one request hash, which
    // would poison the persistence transaction on its primary key.
    const facts = extractSessionFacts([envelope([
      page(T0, 'https://app.example.com/assets'),
      telemetry(T0 + 1, {
        kind: 'request_start', requestId: 'dup-1', clickId: null,
        method: 'POST', url: '/api/assets',
      }),
      telemetry(T0 + 2, { kind: 'request_end', requestId: 'dup-1', status: 500 }),
      telemetry(T0 + 3, { kind: 'request_end', requestId: 'dup-1', status: 500 }),
    ])]);

    expect(facts.failures).toHaveLength(1);
    expect(facts.failedWriteCount).toBe(1);
    expect(facts.unattributedFailedRequestCount).toBe(0);
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
