import { describe, expect, it } from 'vitest';
import { parseDigestPayload } from '../schema.js';

describe('digest narrative card schema', () => {
  it('accepts legacy cards without narrative fields', () => {
    const parsed = parseDigestPayload({
      included: [{ errorGroupId: 'g1', title: 'Save fails', copy: 'Saving failed.', action: 'Review it.' }],
      deferred: [],
    });
    expect(parsed.included[0]).not.toHaveProperty('observationQuote');
  });

  it('carries the cause sentence through and drops a card whose cause is blank', () => {
    const parsed = parseDigestPayload({
      included: [
        { errorGroupId: 'g1', title: 'Save fails', copy: 'Saving failed.', why: 'The handler is unbound.', action: 'Review it.' },
        { errorGroupId: 'g2', title: 'Export fails', copy: 'Exports failed.', why: '   ', action: 'Review it.' },
      ],
      deferred: [],
    });
    expect(parsed.included).toHaveLength(1);
    expect(parsed.included[0]).toMatchObject({ why: 'The handler is unbound.' });
    expect(parsed.rejected).toEqual([{ errorGroupId: 'g2', reason: expect.any(String) }]);
  });

  it('accepts and preserves session intelligence fields', () => {
    const parsed = parseDigestPayload({
      included: [{
        errorGroupId: 'g1', title: 'Save feedback is unclear', copy: 'People could not tell whether saving worked.',
        action: 'Review the replay.', frictionCategory: 'no_feedback_after_action', route: '/assets',
        sessionCount: 3, identifiedCount: 2, observationQuote: 'The save action produced no visible confirmation.',
      }],
      deferred: [],
    });
    expect(parsed.included[0]).toMatchObject({
      frictionCategory: 'no_feedback_after_action', route: '/assets', sessionCount: 3, identifiedCount: 2,
      observationQuote: 'The save action produced no visible confirmation.',
    });
  });
});
