import { describe, expect, it } from 'vitest';
import { hasPromotionSupport } from '../promotion.js';

describe('narrative promotion support', () => {
  it('promotes at three sessions or two identified users', () => {
    expect(hasPromotionSupport({ sessions: 3, identifiedUsers: 0 })).toBe(true);
    expect(hasPromotionSupport({ sessions: 1, identifiedUsers: 2 })).toBe(true);
    expect(hasPromotionSupport({ sessions: 2, identifiedUsers: 1 })).toBe(false);
  });
});
