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
let nextFeedbackNodeId = 900; // above the snapshot's ids so feedback nodes never collide
const feedback = (text: string, timestamp: number) => ({
  type: 3, timestamp,
  data: { source: 0, adds: [{ parentId: 1, node: { id: nextFeedbackNodeId++, type: 3, textContent: text } }], removes: [], texts: [], attributes: [] },
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

  it('does not call a wait on an in-flight request idle, before the response or the click after it', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      requestStart('r1', 'POST', '/api/save', t0 + 1_100),
      requestEnd('r1', 500, t0 + 90_000),
      click('button.save-btn', t0 + 122_000),
    ])]);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
    expect(rendered.lines.find((line) => line.text.includes('POST'))?.text).toContain('SLOW 88.9s');
  });

  it('marks the stretch after a waited-on response once the user goes quiet again', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      requestStart('r1', 'POST', '/api/save', t0 + 1_100),
      requestEnd('r1', 500, t0 + 90_000),
      click('button.save-btn', t0 + 400_000),
    ])]);
    const markers = rendered.lines.filter((line) => line.kind === 'idle');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain('[user idle 5m 10s — away from the app]');
    expect(rendered.lines[rendered.lines.indexOf(markers[0]!) + 1]!.text).toContain('CLICK');
  });

  it('marks a silence that ends with the page updating itself', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      feedback('2 out of 10 assets match your filter criteria', t0 + 1_000 + 32 * 60_000),
    ])]);
    const markerIndex = rendered.lines.findIndex((line) => line.kind === 'idle');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(rendered.lines[markerIndex]!.text).toContain('[user idle 32m 0s — away from the app]');
    expect(rendered.lines[markerIndex + 1]!.text).toContain('UI TEXT APPEARED');
  });

  it('does not mark a silence at or under the threshold before a self-update', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      feedback('2 out of 10 assets match your filter criteria', t0 + 1_000 + IDLE_THRESHOLD_MS),
    ])]);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
  });

  it('marks every long quiet stretch inside one silence', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      feedback('Save failed', t0 + 62_000),
      feedback('Save failed again', t0 + 1_921_000),
    ])]);
    const markers = rendered.lines.filter((line) => line.kind === 'idle').map((line) => line.text);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toContain('[user idle 1m 1s — away from the app]');
    expect(markers[1]).toContain('[user idle 30m 59s — away from the app]');
  });

  it('still marks an activity gap when a system line lands early in it', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      requestStart('r1', 'POST', '/api/save', t0 + 1_100),
      requestEnd('r1', 500, t0 + 2_000),
      click('button.save-btn', t0 + 122_000),
    ])]);
    const markerIndex = rendered.lines.findIndex((line) => line.kind === 'idle');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(rendered.lines[markerIndex]!.text).toContain('[user idle 2m 1s — away from the app]');
    expect(rendered.lines[markerIndex + 1]!.text).toContain('CLICK');
  });

  it('marks an absence between two clicks that frequent background updates would otherwise hide', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      click('button.refresh', t0),
      ...Array.from({ length: 19 }, (_, i) => feedback(`${i} out of 10 assets match`, t0 + (i + 1) * 30_000)),
      click('button.refresh', t0 + 600_000),
    ])]);
    const markers = rendered.lines.filter((line) => line.kind === 'idle');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain('[user idle 10m 0s — away from the app]');
    expect(rendered.lines[rendered.lines.indexOf(markers[0]!) + 1]!.text).toContain('CLICK');
  });

  it('emits no marker before the first user action', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      requestStart('r1', 'GET', '/api/list', t0 + 100),
      requestEnd('r1', 200, t0 + 90_000),
      feedback('Save failed', t0 + 200_000),
    ])]);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
  });

  it('orders late-flushed typed lines chronologically so a marker can sit between them and later feedback', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0),
      snapshot(t0),
      rawInput(2, t0 + 2_000),
      rawInput(2, t0 + 3_000),
      feedback('Save failed', t0 + 122_000),
    ])]);
    const texts = rendered.lines.map((line) => line.text);
    const typedIndex = texts.findIndex((text) => text.includes('typed in'));
    const feedbackIndex = texts.findIndex((text) => text.includes('Save failed'));
    const markerIndex = rendered.lines.findIndex((line) => line.kind === 'idle');
    expect(typedIndex).toBeGreaterThan(-1);
    expect(typedIndex).toBeLessThan(markerIndex);
    expect(markerIndex).toBeLessThan(feedbackIndex);
    const stamps = rendered.lines.map((line) => line.atMs).filter((at): at is number => at !== null && Number.isFinite(at));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
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

describe('idle marker hardening', () => {
  it('does not fabricate a marker from a non-numeric click timestamp', () => {
    const badClick = { type: 5, timestamp: t0 + 2_000, data: { tag: 'opslane.telemetry',
      payload: { kind: 'click', clickId: 'cx', selector: 'button.save-btn', cursor: 'pointer' } } };
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000), badClick, click('button.save-btn', t0 + 3_000),
    ])]);
    // the bad click still renders (pre-existing t+NaNs behavior); the new
    // guarantee is that no idle marker is fabricated from it
    expect(rendered.text).not.toContain('[user idle');
  });

  it('marks the silence after a lone keystroke, before the feedback that ends it', () => {
    // the keystroke at t+122s is a user action: the 1s→122s silence has no line
    // to attach a marker to, while the 122s→400s silence gets one
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      rawInput(2, t0 + 122_000),
      feedback('Save failed', t0 + 400_000),
    ])]);
    const markers = rendered.lines.filter((line) => line.kind === 'idle');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain('[user idle 4m 38s — away from the app]');
    expect(rendered.lines[rendered.lines.indexOf(markers[0]!) + 1]!.text).toContain('Save failed');
  });

  it('keeps a non-finite line in its slot while reordering typed lines around it', () => {
    // the click has no payload stamp, so its line is inert; the keystrokes that
    // follow it are flushed last with their first stamp and must sort back
    // before the feedback without disturbing the click's slot
    const badClick = { type: 5, timestamp: t0 + 1_500, data: { tag: 'opslane.telemetry',
      payload: { kind: 'click', clickId: 'cx', selector: 'button.save-btn', cursor: 'pointer' } } };
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      badClick,
      rawInput(2, t0 + 2_000), rawInput(2, t0 + 3_000),
      feedback('Save failed', t0 + 10_000),
    ])]);
    const texts = rendered.lines.map((line) => line.text);
    expect(texts.findIndex((text) => text.includes('CLICK'))).toBe(1);
    expect(texts.findIndex((text) => text.includes('typed in'))).toBeLessThan(texts.findIndex((text) => text.includes('Save failed')));
  });

  it('leaves a payload stamp outside the session window in place and gives it no marker', () => {
    const forged = { type: 5, timestamp: t0 + 4_000, data: { tag: 'opslane.telemetry',
      payload: { kind: 'click', at: -5, clickId: 'cx', selector: 'button.evil', cursor: 'pointer' } } };
    const nullAt = { type: 5, timestamp: t0 + 5_000, data: { tag: 'opslane.telemetry',
      payload: { kind: 'click', at: null, clickId: 'cy', selector: 'button.null', cursor: 'pointer' } } };
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      forged,
      nullAt,
      feedback('Save failed', t0 + 122_000),
    ])]);
    const texts = rendered.lines.map((line) => line.text);
    expect(texts[1]).toContain('button.save-btn');
    expect(texts.findIndex((text) => text.includes('button.evil'))).toBe(2);
    expect(texts.findIndex((text) => text.includes('button.null'))).toBe(3);
    expect(rendered.text).not.toContain('[user idle 29');
    expect(rendered.lines.filter((line) => line.kind === 'idle').map((line) => line.text)).toEqual([
      expect.stringContaining('[user idle 2m 1s — away from the app]'),
    ]);
  });

  it('drops an event with a non-numeric outer timestamp instead of letting it poison startTs', () => {
    const rendered = renderTimeline([envelope([
      { type: 4, timestamp: 'abc', data: { href: 'https://app.example.com/assets' } },
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000),
    ])]);
    expect(rendered.startTs).toBe(t0);
    expect(rendered.text).not.toContain('NaN');
  });

  it('gives up markers before evidence at the byte budget', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      ...Array.from({ length: 6 }, (_, i) => feedback(`Save failed ${i}`, t0 + 1_000 + (i + 1) * 61_000)),
    ])], { maxBytes: 420 });
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(false);
    expect(rendered.lines.filter((line) => line.text.includes('Save failed'))).toHaveLength(6);
    expect(rendered.truncated).toBe(false);
  });

  it('markers do not displace trailing real lines at the maxLines budget', () => {
    const rendered = renderTimeline([envelope([
      meta('https://app.example.com/assets', t0), snapshot(t0),
      click('button.save-btn', t0 + 1_000),
      click('button.save-btn', t0 + 122_000),
      click('button.save-btn', t0 + 123_000),
    ])], { maxLines: 4 });
    // all four real lines survive; the marker rides on top of the budget
    expect(rendered.lines.filter((line) => line.kind !== 'idle')).toHaveLength(4);
    expect(rendered.lines.some((line) => line.kind === 'idle')).toBe(true);
  });
});
