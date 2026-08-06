import { describe, expect, it } from 'vitest';
import { expectedToOutcome, scoreTrials } from '../investigation-runner.js';

describe('expectedToOutcome', () => {
  it('maps fixture labels onto diagnosis outcomes', () => {
    expect(expectedToOutcome('fix_pr')).toBe('code_fix');
    expect(expectedToOutcome('conclusion')).toBe('not_actionable');
    expect(expectedToOutcome('needs_human')).toBe('needs_more_context');
  });
});

describe('scoreTrials', () => {
  it('counts only exact outcome matches', () => {
    expect(scoreTrials('conclusion', ['not_actionable', 'not_actionable', 'code_fix']))
      .toEqual({ passes: 2, trials: 3 });
  });

  it('scores zero when nothing matches', () => {
    expect(scoreTrials('fix_pr', ['not_actionable', 'needs_more_context']))
      .toEqual({ passes: 0, trials: 2 });
  });
});
