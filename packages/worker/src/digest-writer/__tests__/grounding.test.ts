import { describe, expect, it } from 'vitest';
import { groundPayload } from '../job.js';
import type { DigestCandidate } from '../job.js';

// The frozen candidate crosses a Go json boundary where omitempty drops zero
// counts. An all-anonymous friction incident therefore has identifiedCount
// undefined on the truth while the writer input (and the model's echo) says 0.
const anonymousFrictionCandidate: DigestCandidate = {
  errorGroupId: 'g-anon',
  kind: 'friction',
  status: 'awaiting_approval',
  label: 'new',
  outcome: 'awaiting_approval',
  title: 'Hard blocker on /assets',
  summary: 'Users hit a license wall',
  rootCause: 'LicenseWall renders the contact address as plain text',
  frictionCategory: 'hard_blocker',
  route: '/assets',
  sessionCount: 3,
  // identifiedCount deliberately absent: Go omitempty dropped the zero
  observationQuote: 'Users repeatedly clicked the support email expecting a link',
  affectedUsers: 0,
  accounts: [],
  lastSeen: '2026-09-01T00:00:00Z',
  decidedAt: '2026-09-01T00:00:00Z',
};

describe('groundPayload zero-count normalization', () => {
  it('accepts a card echoing identifiedCount 0 when omitempty dropped the zero from truth', () => {
    const payload = {
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'Users hit a license wall and clicked the plain-text support address with no way forward.',
        action: 'Review the investigation.',
        sessionCount: 3,
        identifiedCount: 0,
      }],
      deferred: [],
    };
    const grounded = groundPayload(payload, [anonymousFrictionCandidate]);
    expect(grounded.included).toHaveLength(1);
    expect(grounded.included[0]!.identifiedCount).toBe(0);
  });

  it('grounds the measured visit and recovery counts the template stopped printing', () => {
    const measured: DigestCandidate = {
      ...anonymousFrictionCandidate,
      impactVisits: 17,
      impactRecovered: 14,
    };
    const grounded = groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'It hit 17 visits, and 14 recovered by finding another way through.',
        action: 'Review the investigation.',
      }],
      deferred: [],
    }, [measured]);
    expect(grounded.included).toHaveLength(1);

    expect(() => groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'It hit 42 visits.',
        action: 'Review the investigation.',
      }],
      deferred: [],
    }, [measured])).toThrow(/ungrounded number 42/);
  });

  it('still rejects a card inventing a nonzero identified count', () => {
    const payload = {
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'Users hit a license wall.',
        action: 'Review the investigation.',
        sessionCount: 3,
        identifiedCount: 3,
      }],
      deferred: [],
    };
    expect(() => groundPayload(payload, [anonymousFrictionCandidate])).toThrow(/unsupported identified count/);
  });
});
