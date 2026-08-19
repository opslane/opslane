import { describe, expect, it } from 'vitest';
import { INQUIRY_REGROWTH, shouldReopenInquiry } from '../inquiry/job.js';

describe('reopen the inquiry gate', () => {
  it('does not reopen on one extra unit below half-again growth', () => {
    expect(INQUIRY_REGROWTH).toBe(1.5);
    expect(shouldReopenInquiry(5, 4)).toBe(false);
  });

  it('reopens exactly at the rounded-up half-again boundary', () => {
    expect(shouldReopenInquiry(3, 2)).toBe(true);
    expect(shouldReopenInquiry(4, 2)).toBe(true);
    expect(shouldReopenInquiry(7, 5)).toBe(false);
    expect(shouldReopenInquiry(8, 5)).toBe(true);
  });

  it('reopens when no earlier affected-unit count was recorded', () => {
    expect(shouldReopenInquiry(1, 0)).toBe(true);
  });
});
