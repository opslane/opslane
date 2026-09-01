import { describe, expect, it } from 'vitest';
import type { SessionChunkEnvelope } from '@opslane/shared';
import { renderTimeline } from '../renderer.js';

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
