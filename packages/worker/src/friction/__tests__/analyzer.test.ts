import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { analyzeSession, RULE_VERSION } from '../analyzer.js';
import { frictionFingerprint, normalizePageUrl } from '../fingerprint.js';

function fixture(name: string): SessionChunkEnvelope[] {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as SessionChunkEnvelope[];
}

function clickEnvelope(clicks: Array<{ at: number; selector: string; cursor: string }>): SessionChunkEnvelope[] {
  return [{
    events: [
      { type: 4, data: { href: 'https://app.example.com/x' }, timestamp: 1720000000000 },
      ...clicks.map((click, index) => ({
        type: 5,
        timestamp: click.at,
        data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: `c${index}`, ...click } },
      })),
    ],
    meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: 1720000000000 },
  }];
}

describe('friction analyzer v2', () => {
  it('flags unanswered repeated clicks as one rage click', () => {
    const signals = analyzeSession(fixture('rage_dead_click'));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalType: 'rage_click',
      elementSelector: '[data-testid="save"]',
      pageUrlNormalized: '/checkout/:id',
      occurredAt: 1720000001800,
      occurrenceCount: 1,
      ruleVersion: RULE_VERSION,
    });
  });

  it('does not flag a responsive quantity stepper', () => {
    expect(analyzeSession(fixture('stepper_clicks'))).toEqual([]);
  });

  it('flags an unanswered pointer click', () => {
    expect(analyzeSession(fixture('dead_click'))).toEqual([
      expect.objectContaining({
        signalType: 'dead_click',
        elementSelector: '[data-testid="continue"]',
        occurredAt: 1720000001000,
      }),
    ]);
  });

  it('treats a causally linked async request as a response', () => {
    expect(analyzeSession(fixture('slow_async_click'))).toEqual([]);
  });

  it('does not let an unrelated poll suppress a dead click', () => {
    expect(analyzeSession(fixture('unrelated_poll'))).toEqual([
      expect.objectContaining({ signalType: 'dead_click' }),
    ]);
  });

  it('retires form abandonment detection', () => {
    expect(analyzeSession(fixture('form_abandon'))).toEqual([]);
  });

  it('filters text-cursor clicks before rage clustering', () => {
    expect(analyzeSession(clickEnvelope([
      { at: 1720000001000, selector: '.search', cursor: 'text' },
      { at: 1720000001200, selector: '.search', cursor: 'text' },
      { at: 1720000001400, selector: '.search', cursor: 'text' },
    ]))).toEqual([]);
    const mixed = analyzeSession(clickEnvelope([
      { at: 1720000001000, selector: '.search', cursor: 'pointer' },
      { at: 1720000001100, selector: '.search', cursor: 'text' },
      { at: 1720000001200, selector: '.search', cursor: 'pointer' },
      { at: 1720000001300, selector: '.search', cursor: 'text' },
    ]));
    expect(mixed.map((signal) => signal.signalType)).toEqual(['dead_click']);
    expect(mixed[0]?.occurrenceCount).toBe(2);
  });

  it('suppresses picker-answered dead clicks but not rage clicks', () => {
    const dead = clickEnvelope([
      { at: 1720000001000, selector: '.picker', cursor: 'pointer' },
      { at: 1720000004000, selector: '#react-select-9-option-0', cursor: 'pointer' },
    ]);
    expect(analyzeSession(dead)).toEqual([]);
    const rage = clickEnvelope([
      { at: 1720000001000, selector: '.picker', cursor: 'pointer' },
      { at: 1720000001200, selector: '.picker', cursor: 'pointer' },
      { at: 1720000001400, selector: '.picker', cursor: 'pointer' },
      { at: 1720000004000, selector: '#react-select-9-option-0', cursor: 'pointer' },
    ]);
    expect(analyzeSession(rage).map((signal) => signal.signalType)).toEqual(['rage_click']);
  });

  it('suppresses synthetic download anchors', () => {
    const signals = analyzeSession(clickEnvelope([
      { at: 1720000001000, selector: '#export', cursor: 'pointer' },
      { at: 1720000001005, selector: 'body > a', cursor: 'pointer' },
    ]));
    expect(signals.some((signal) => signal.elementSelector === 'body > a')).toBe(false);
  });

  it('records one timestamp per persisted occurrence unit', () => {
    const signals = analyzeSession(clickEnvelope([
      { at: 1720000001000, selector: '.save', cursor: 'pointer' },
      { at: 1720000061000, selector: '.save', cursor: 'pointer' },
    ]));
    expect(signals[0]?.occurredAts).toEqual([1720000001000, 1720000061000]);
    const rage = analyzeSession(clickEnvelope([
      { at: 1720000001000, selector: '.save', cursor: 'pointer' },
      { at: 1720000001200, selector: '.save', cursor: 'pointer' },
      { at: 1720000001400, selector: '.save', cursor: 'pointer' },
      { at: 1720000001600, selector: '.save', cursor: 'pointer' },
    ]));
    expect(rage[0]?.occurredAts).toEqual([1720000001600]);
  });

  it('does not flag a submitted form', () => {
    expect(analyzeSession(fixture('form_completed'))).toEqual([]);
  });

  it('changes whole-session truth when a late chunk contains the response', () => {
    const chunks = fixture('late_chunk_retraction');

    expect(analyzeSession(chunks.slice(0, 1))).toEqual([
      expect.objectContaining({ signalType: 'dead_click' }),
    ]);
    expect(analyzeSession(chunks)).toEqual([]);
  });

  it('folds repeated occurrences of one fingerprint and keeps the first occurrence time', () => {
    const chunks = fixture('rage_dead_click');
    chunks[0]?.events.push(
      { type: 5, data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: 'c5', selector: '[data-testid="save"]', cursor: 'pointer', at: 1720000004000 } }, timestamp: 1720000004000 },
      { type: 5, data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: 'c6', selector: '[data-testid="save"]', cursor: 'pointer', at: 1720000004250 } }, timestamp: 1720000004250 },
      { type: 5, data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: 'c7', selector: '[data-testid="save"]', cursor: 'pointer', at: 1720000004500 } }, timestamp: 1720000004500 },
    );

    expect(analyzeSession(chunks)).toEqual([
      expect.objectContaining({
        signalType: 'rage_click',
        occurrenceCount: 2,
        occurredAt: 1720000001800,
      }),
    ]);
  });

  it('is deterministic and ignores malformed or nested custom-event lookalikes', () => {
    const chunks = fixture('dead_click');
    chunks[0]?.events.unshift(
      { type: 2, data: { node: { type: 5, data: { tag: 'opslane.telemetry' } } }, timestamp: 1 },
      { type: 5, data: { tag: 'opslane.telemetry', payload: { kind: 'click' } }, timestamp: 2 },
    );

    expect(analyzeSession(chunks)).toEqual(analyzeSession(chunks));
    expect(analyzeSession(chunks)).toHaveLength(1);
  });
});

describe('friction analyzer trust-boundary bounds', () => {
  function clickChunk(payload: Record<string, unknown>): SessionChunkEnvelope[] {
    return [{
      events: [
        { type: 4, data: { href: 'https://app.example.com/checkout/42' }, timestamp: 1720000000000 },
        { type: 5, data: { tag: 'opslane.telemetry', payload }, timestamp: 1720000001000 },
      ],
      meta: { sdk_version: 'test', has_full_snapshot: true, chunked_at: 1720000000000 },
    }];
  }

  it('drops a click whose selector contains a NUL byte (Postgres would reject it)', () => {
    const signals = analyzeSession(clickChunk({
      kind: 'click', clickId: 'c1', selector: 'button\u0000drop', cursor: 'pointer', at: 1720000001000,
    }));
    expect(signals).toEqual([]);
  });

  it('drops a click whose timestamp would overflow to_timestamp', () => {
    const signals = analyzeSession(clickChunk({
      kind: 'click', clickId: 'c1', selector: '[data-testid="save"]', cursor: 'pointer', at: 1e20,
    }));
    expect(signals).toEqual([]);
  });
});

describe('friction fingerprinting', () => {
  it('uses rule version 4 for the host-free identity contract', () => {
    expect(RULE_VERSION).toBe(4);
  });

  it('normalizes variable URL portions without retaining query or hash', () => {
    expect(normalizePageUrl('https://app.example.com/orders/123?token=secret#detail')).toBe(
      '/orders/:id',
    );
    expect(normalizePageUrl('https://app.example.com/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/orders/:id',
    );
    expect(normalizePageUrl('/orders/123?token=secret')).toBe('/orders/:id');
  });

  it('makes a stable bounded fingerprint from the normalized dimensions', () => {
    const first = frictionFingerprint('dead_click', '#save', 'https://app.example.com/orders/:id');
    const second = frictionFingerprint('dead_click', '#save', 'https://app.example.com/orders/:id');

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(frictionFingerprint('rage_click', '#save', 'https://app.example.com/orders/:id')).not.toBe(first);
  });

  it('normalizes Forge context segments and react-select indexed ids', () => {
    expect(normalizePageUrl('https://x.test/foo/_ctx_H4sIAAAA/bar')).toBe('/foo/bar');
    expect(frictionFingerprint('dead_click', '#react-select-8-selected-value-3-remove', '/x'))
      .toBe(frictionFingerprint('dead_click', '#react-select-8-selected-value-7-remove', '/x'));
  });
});
