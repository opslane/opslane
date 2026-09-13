import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RenderedTimeline } from '../renderer.js';
import { validateNarrative } from '../validate.js';

const timeline: RenderedTimeline = {
  lines: Array.from({ length: 10 }, (_, index) => ({
    text: `line ${index + 1}`,
    selector: index === 4 ? 'button.save' : null,
    route: '/assets',
    atMs: 1_000 * index,
  })),
  text: '',
  truncated: false,
  startTs: 0,
};
const output = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  user_goal: 'Edit an asset',
  narrative: 'The user hit a confusing validation state.',
  observations: [{
    what: 'An error appears beside a success message.',
    evidence_lines: ['L5', 'L6'],
  }],
  notable: true,
  ...overrides,
});

describe('validateNarrative', () => {
  it('strips idle-marker citations and drops idle-only observations', () => {
    const withIdle: RenderedTimeline = {
      ...timeline,
      lines: timeline.lines.map((line, index) => index === 5 ? { ...line, kind: 'idle' as const } : line),
    };
    const stripped = validateNarrative(output(), withIdle);
    if (!stripped.ok) throw new Error(stripped.reason);
    expect(stripped.narrative.observations[0]!.evidenceLines).toEqual(['L5']);
    const idleOnly = validateNarrative(output({ observations: [{
      category: 'dead_end_state', what: 'User gave up.', evidence_lines: ['L6'], severity: 'medium',
    }] }), withIdle);
    if (!idleOnly.ok) throw new Error(idleOnly.reason);
    expect(idleOnly.narrative.observations).toHaveLength(0);
  });

  it('accepts valid output and assigns stable ids', () => {
    const result = validateNarrative(output(), timeline);
    if (!result.ok) throw new Error(result.reason);
    expect(result.narrative.observations[0]).toMatchObject({
      id: `0-${createHash('sha256').update('An error appears beside a success message.').digest('hex').slice(0, 4)}`,
      evidenceLines: ['L5', 'L6'],
    });
  });

  it('does not include model category or severity in v3 observations', () => {
    const result = validateNarrative(output({ observations: [{
      category: 'invented', severity: 'high', what: 'The page shows an error.', evidence_lines: ['L1'],
    }] }), timeline);
    if (!result.ok) throw new Error(result.reason);
    expect(result.narrative.observations[0]).not.toHaveProperty('category');
    expect(result.narrative.observations[0]).not.toHaveProperty('severity');
  });

  it('drops invalid citations and observations without evidence', () => {
    const result = validateNarrative(output({ observations: [
      { category: 'slow_response', what: 'Slow', evidence_lines: ['L2', 'L99'], severity: 'low' },
      { category: 'hard_blocker', what: 'Blocked', evidence_lines: ['L100'], severity: 'high' },
    ] }), timeline);
    if (!result.ok) throw new Error(result.reason);
    expect(result.droppedCitations).toBe(2);
    expect(result.narrative.observations).toHaveLength(1);
  });

  it('rejects malformed shapes and empty descriptions', () => {
    expect(validateNarrative('not json', timeline).ok).toBe(false);
    expect(validateNarrative(output({ observations: [
      { what: '', evidence_lines: ['L1'] },
    ] }), timeline).ok).toBe(false);
  });
});
