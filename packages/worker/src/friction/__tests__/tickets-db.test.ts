import { afterEach, describe, expect, it, vi } from 'vitest';
import { insightInvestigateUsers, investigationAllowed } from '../tickets-db.js';

describe('insightInvestigateUsers', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['unset', undefined, 5],
    ['custom', '8', 8],
    ['zero', '0', 5],
    ['negative', '-3', 5],
    ['fractional', '2.5', 5],
    ['garbage', 'five', 5],
  ])('%s → %s', (_name, value, expected) => {
    if (value === undefined) vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '');
    else vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', value);
    expect(insightInvestigateUsers()).toBe(expected);
  });
  it('gates insights only', () => {
    vi.stubEnv('FRICTION_INSIGHT_INVESTIGATE_USERS', '5');
    expect(investigationAllowed({ kind: 'defect' }, 0)).toBe(true);
    expect(investigationAllowed({ kind: 'ux_insight' }, 4)).toBe(false);
    expect(investigationAllowed({ kind: 'ux_insight' }, 5)).toBe(true);
  });
});
