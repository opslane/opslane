import { describe, expect, it } from 'vitest';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { IDLE_THRESHOLD_MS, renderTimeline } from '../renderer.js';

const t0 = 1_700_000_000_000;
const envelope = (events: unknown[]): SessionChunkEnvelope => ({
  events,
  meta: { chunked_at: t0, has_full_snapshot: true, sdk_version: 'test' },
});
const meta = (href: string, timestamp: number) => ({ type: 4, data: { href }, timestamp });
const snapshot = (timestamp: number) => ({
  type: 2,
  timestamp,
  data: { node: { id: 1, type: 0, childNodes: [
    { id: 2, type: 2, tagName: 'button', attributes: { class: 'save-btn' }, childNodes: [
      { id: 3, type: 3, textContent: 'Save asset' },
    ] },
  ] } },
});
const click = (selector: string, at: number) => ({
  type: 5,
  timestamp: at,
  data: { tag: 'opslane.telemetry', payload: { kind: 'click', clickId: 'c1', selector, cursor: 'pointer', at } },
});
const requestStart = (requestId: string, method: string, url: string, at: number) => ({
  type: 5,
  timestamp: at,
  data: { tag: 'opslane.telemetry', payload: { kind: 'request_start', requestId, method, url, at } },
});
const requestEnd = (requestId: string, status: number, at: number) => ({
  type: 5,
  timestamp: at,
  data: { tag: 'opslane.telemetry', payload: { kind: 'request_end', requestId, status, at } },
});
const rawInput = (id: number, timestamp: number) => ({
  type: 3,
  timestamp,
  data: { source: 5, id, text: '*' },
});

describe('renderTimeline', () => {
  it('numbers evidence and preserves route and selector anchors', () => {
    const result = renderTimeline([envelope([
      meta('https://app.example.com/assets?token=secret', t0),
      snapshot(t0 + 10),
      click('button.save-btn', t0 + 1_000),
    ])]);
    expect(result.text).toMatch(/^L1 /m);
    const line = result.lines.find((entry) => entry.text.includes('CLICK'));
    expect(line).toMatchObject({ selector: 'button.save-btn', route: '/assets' });
    expect(result.text).not.toContain('secret');
  });

  it('surfaces feedback text while never exposing typed values', () => {
    const result = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0 + 10),
      { type: 3, timestamp: t0 + 500, data: { source: 5, id: 2, text: 'SECRET' } },
      { type: 3, timestamp: t0 + 600, data: { source: 5, id: 2, text: 'SECRET2' } },
      { type: 3, timestamp: t0 + 2_000, data: { source: 0, adds: [
        { parentId: 1, node: { id: 9, type: 3, textContent: 'Error\u200b: bad\u0007 request failed' } },
      ], removes: [], texts: [], attributes: [] } },
    ])]);
    expect(result.text).toContain('typed in');
    expect(result.text).toContain('(2 keystrokes)');
    expect(result.text).toContain('UI TEXT APPEARED');
    expect(result.text).not.toMatch(/SECRET|[\u200b\u0007]/);
  });

  it('truncates deterministically', () => {
    const events: unknown[] = [meta('https://app.example.com/a', t0)];
    for (let i = 0; i < 120; i++) events.push(click(`#b${i}`, t0 + i * 2_000));
    const result = renderTimeline([envelope(events)], { maxLines: 20 });
    expect(result.lines).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });
});

describe('idle markers', () => {
  it('inserts a marker before the interaction that ends an over-threshold gap', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      click('button.save-btn', t0 + 2_764_000),
    ])]);
    const marker = rendered.lines.find((line) => line.kind === 'idle');
    expect(marker).toBeDefined();
    expect(marker!.text).toContain('[user idle 46m 3s — away from the app]');
    expect(marker!.selector).toBeNull();
    expect(rendered.text).toMatch(/L\d+ .*\[user idle 46m 3s — away from the app\]/);
    const markerIndex = rendered.lines.indexOf(marker!);
    expect(rendered.lines[markerIndex + 1]!.text).toContain('CLICK');
  });

  it('does not mark a gap at or under the threshold', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      click('button.save-btn', t0 + 1_000 + IDLE_THRESHOLD_MS),
    ])]);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
  });

  it('marks each long gap independently', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      click('button.save-btn', t0 + 122_000),
      click('button.save-btn', t0 + 243_000),
    ])]);
    expect(rendered.lines.filter((line) => line.kind === 'idle')).toHaveLength(2);
  });

  it('stays chronological when system lines land inside the gap', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      requestStart('r1', 'POST', '/api/save', t0 + 1_100),
      requestEnd('r1', 500, t0 + 90_000),
      click('button.save-btn', t0 + 122_000),
    ])]);
    const texts = rendered.lines.map((line) => line.text);
    const responseIndex = texts.findIndex((text) => text.includes('POST'));
    const markerIndex = rendered.lines.findIndex((line) => line.kind === 'idle');
    expect(markerIndex).toBeGreaterThan(responseIndex);
    expect(rendered.lines[markerIndex + 1]!.text).toContain('CLICK');
  });

  it('emits no marker when the gap-ending activity renders no line', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      rawInput(2, t0 + 122_000),
    ])]);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
    expect(rendered.lines[rendered.lines.length - 1]?.kind).not.toBe('idle');
  });
});
