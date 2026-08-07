import { describe, expect, it } from 'vitest';
import { report, scoreCase, splitFor } from '../score.mjs';

describe('scoreCase', () => {
  const truth = ['packages/ui/signature-render.tsx'];

  it('scores the first citation', () => {
    expect(scoreCase([{ path: 'packages/ui/signature-render.tsx' }, { path: 'other.ts' }], truth).hit).toBe(true);
  });

  // The prompt asks for every file expected to change and the old scorer counted
  // a hit if ANY matched, so padding the list raised the score for free.
  it('does not count a match found only in a trailing citation', () => {
    expect(scoreCase([{ path: 'wrong.ts' }, { path: 'packages/ui/signature-render.tsx' }], truth).hit).toBe(false);
  });

  it('matches on a path suffix', () => {
    expect(scoreCase([{ path: 'signature-render.tsx', line: 42 }], truth).hit).toBe(true);
  });

  // The scorer and the router must read the same field. When the scorer split a
  // decorated string itself, it reported a HIT on a case the router had sent to
  // needs_more_context, hiding a real regression for a whole run.
  it('reads the same `path` field the router reads', () => {
    expect(scoreCase([{ path: 'packages/ui/signature-render.tsx', note: 'anything' }], truth).primary)
      .toBe('packages/ui/signature-render.tsx');
  });

  it('handles no citations', () => {
    expect(scoreCase([], truth)).toEqual({ hit: false, primary: null });
  });
});

describe('report', () => {
  const results = [
    { hit: true, answered: true, strength: 'suggestive', costUsd: 0.5 },
    { hit: false, answered: true, strength: 'insufficient', costUsd: 0.4 },
    { hit: false, answered: false, strength: null, costUsd: 0.1 },
  ];

  it('gives both denominators and separates insufficient from no answer', () => {
    const out = report(results, { total: 3 });

    expect(out).toContain('1/3');
    expect(out).toContain('1/2');
    expect(out).toContain('insufficient: 1');
    expect(out).toContain('no adjudication: 1');
    expect(out).toContain('$1.00');
  });

  // A hit can only come from an answered run; counting otherwise once produced
  // more hits than answered cases.
  it('never reports more hits than answered cases', () => {
    const out = report([{ hit: true, answered: false, strength: null, costUsd: 0 }], { total: 1 });

    expect(out).toContain('0/1 of all cases');
    expect(out).toContain('0/0 of answered');
  });

  it('marks a partial run in the report body, not just a side log', () => {
    expect(report(results, { total: 22 })).toContain('PARTIAL');
  });
});

describe('splitFor', () => {
  it('labels each repository from the frozen manifest', () => {
    expect(splitFor('documenso/documenso')).toBe('holdout');
    expect(splitFor('dubinc/dub')).toBe('tuning');
  });

  it('refuses an unknown repository rather than guessing', () => {
    expect(() => splitFor('acme/unknown')).toThrow(/holdout.json/);
  });
});
