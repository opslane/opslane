import { describe, expect, it } from 'vitest';
import { observationFingerprint } from '../fingerprint.js';

describe('observationFingerprint', () => {
  it('uses selectors only for element-anchored categories', () => {
    expect(observationFingerprint('unclickable_affordance', 'button.save', '/assets'))
      .not.toBe(observationFingerprint('unclickable_affordance', 'a.logo', '/assets'));
    expect(observationFingerprint('validation_confusion', 'button.save', '/assets'))
      .toBe(observationFingerprint('validation_confusion', 'a.logo', '/assets'));
  });

  it('canonicalizes positional selectors', () => {
    expect(observationFingerprint('no_feedback_after_action', 'div:nth-of-type(3)>button.go', '/x'))
      .toBe(observationFingerprint('no_feedback_after_action', 'div:nth-of-type(9)>button.go', '/x'));
  });

  it('keeps category as an independent fingerprint axis', () => {
    expect(observationFingerprint('slow_response', null, '/assets'))
      .not.toBe(observationFingerprint('dead_end_state', null, '/assets'));
  });
});
