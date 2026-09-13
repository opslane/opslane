import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSignalRows, deriveNarrativeId, resolveAnchor } from '../emit.js';

const timeline = {
  startTs: 1_000,
  lines: [
    { t: 'page', s: null, r: '/assets', a: 1_000 },
    { t: 'click', s: 'button.save', r: '/assets', a: 1_100 },
    { t: 'message', s: null, r: '/assets', a: 1_200 },
  ],
};

describe('narrative signal emission', () => {
  it('resolves the route and selector from cited lines', () => {
    expect(resolveAnchor(['L1', 'L2'], timeline)).toEqual({
      route: '/assets', selector: 'button.save',
    });
  });

  it('emits distinct atomic observations even when they cite the same line', () => {
    const observations = [
      { id: 'a', what: 'The error overlaps the save button.', evidenceLines: ['L2'] },
      { id: 'b', what: 'The save button still says loading.', evidenceLines: ['L2'] },
    ];
    const rows = buildSignalRows(timeline, observations, 'session-1', 'narrative-1');
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({
        signalType: 'other', observationId: observations[index]!.id,
        narrativeId: 'narrative-1', evidenceLines: ['L2'], occurrenceCount: 1,
        occurredAts: [1_100],
      });
      expect(row.fingerprint).toBe(createHash('sha256')
        .update(`session-1|narrative-1|${observations[index]!.id}`).digest('hex').slice(0, 32));
    }
    expect(rows[0]!.fingerprint).not.toBe(rows[1]!.fingerprint);
    expect(buildSignalRows(timeline, observations, 'session-2', 'narrative-1')[0]!.fingerprint)
      .not.toBe(rows[0]!.fingerprint);
    expect(buildSignalRows(timeline, observations, 'session-1', 'narrative-2')[0]!.fingerprint)
      .not.toBe(rows[0]!.fingerprint);
  });

  it('derives a stable UUID-shaped narrative identity from session, version and creation time', () => {
    const createdAt = '2026-09-11 12:34:56.123456+00';
    const expectedHex = createHash('sha256').update(`session-1|3|${createdAt}`).digest('hex').slice(0, 32);
    const identity = deriveNarrativeId('session-1', createdAt, 3);
    expect(identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveNarrativeId('session-1', createdAt, 2)).not.toBe(identity);
    expect(identity.replaceAll('-', '')).toBe(expectedHex);
    expect(deriveNarrativeId('session-1', createdAt, 3)).toBe(identity);
    expect(deriveNarrativeId('session-1', '2026-09-11 12:34:57+00', 3)).not.toBe(identity);
  });
});

describe('idle lines as evidence', () => {
  const idleTimeline = {
    startTs: 1_000,
    lines: [
      { t: 'clicked button.save', s: 'button.save', r: '/assets', a: 1_000 },
      { t: '[user idle 2m 0s — away from the app]', s: null, r: '/assets', a: 1_000, k: 'idle' as const },
      { t: 'clicked button.save', s: 'button.save', r: '/checkout', a: 121_000 },
    ],
  };

  it('resolveAnchor skips idle lines for both route and selector', () => {
    expect(resolveAnchor(['L2', 'L3'], idleTimeline)).toEqual({
      route: '/checkout', selector: 'button.save',
    });
  });

  it('occurredAt comes from the first non-idle cited line', () => {
    const rows = buildSignalRows(idleTimeline, [{
      id: 'obs-1', category: 'no_feedback_after_action', what: 'x',
      evidenceLines: ['L2', 'L3'], severity: 'low',
    }], 'session-1', 'narrative-1');
    expect(rows[0]!.occurredAts).toEqual([121_000]);
  });
});
