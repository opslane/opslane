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
    category: 'validation_confusion',
    what: 'An error appears beside a success message.',
    evidence_lines: ['L5', 'L6'],
    severity: 'high',
  }],
  notable: true,
  ...overrides,
});

describe('validateNarrative', () => {
  it('accepts valid output and assigns stable ids', () => {
    const result = validateNarrative(output(), timeline);
    if (!result.ok) throw new Error(result.reason);
    expect(result.narrative.observations[0]).toMatchObject({
      id: expect.stringMatching(/^0-[0-9a-f]{4}$/),
      evidenceLines: ['L5', 'L6'],
    });
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

  it('rejects malformed shapes and unknown categories', () => {
    expect(validateNarrative('not json', timeline).ok).toBe(false);
    expect(validateNarrative(output({ observations: [
      { category: 'invented', what: 'x', evidence_lines: ['L1'], severity: 'low' },
    ] }), timeline).ok).toBe(false);
  });
});
