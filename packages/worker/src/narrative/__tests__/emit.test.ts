import { describe, expect, it } from 'vitest';
import { buildSignalRows, resolveAnchor } from '../emit.js';

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

  it('aggregates same-fingerprint observations and keeps the higher-severity quote', () => {
    const rows = buildSignalRows(timeline, [
      { id: 'a', category: 'validation_confusion', what: 'minor', evidenceLines: ['L1'], severity: 'low' },
      { id: 'b', category: 'validation_confusion', what: 'major', evidenceLines: ['L3'], severity: 'high' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrenceCount: 2, what: 'major', severity: 'high' });
    expect(rows[0]?.occurredAts).toEqual([1_000, 1_200]);
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
    }]);
    expect(rows[0]!.occurredAts).toEqual([121_000]);
  });
});
