import { describe, expect, it } from 'vitest';
import { CARD_CHECK_REASON_PREFIX, groundPayload } from '../job.js';
import type { DigestCandidate } from '../job.js';

/** A card that fails one of its own factual checks is demoted to its receipt,
 * never allowed to fail the run. This reads the reason back off the deferral. */
function demotedReason(payload: { included: unknown[]; deferred: Array<{ reason: string }> }): string {
  expect(payload.included).toHaveLength(0);
  expect(payload.deferred).toHaveLength(1);
  const reason = payload.deferred[0]!.reason;
  expect(reason.startsWith(CARD_CHECK_REASON_PREFIX)).toBe(true);
  return reason;
}

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
        action: 'Decide how to handle this.',
        sessionCount: 3,
        identifiedCount: 0,
      }],
      deferred: [],
    };
    const grounded = groundPayload(payload, [anonymousFrictionCandidate]);
    expect(grounded.included).toHaveLength(1);
    expect(grounded.included[0]!.identifiedCount).toBe(0);
  });

  // The message prints the measured visits and recoveries under the copy, so
  // they are no longer facts a card may state. Naming one is a duplicate of
  // that line, or a stale number replayed from cached prose.
  it('refuses the measured visit and recovery counts the message prints itself', () => {
    const measured: DigestCandidate = {
      ...anonymousFrictionCandidate,
      impactVisits: 17,
      impactRecovered: 14,
    };
    expect(demotedReason(groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'It hit 17 visits, and 14 recovered by finding another way through.',
        action: 'Decide how to handle this.',
      }],
      deferred: [],
    }, [measured]))).toMatch(/ungrounded number 17/);

    expect(demotedReason(groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'It hit 42 visits.',
        action: 'Decide how to handle this.',
      }],
      deferred: [],
    }, [measured]))).toMatch(/ungrounded number 42/);
  });

  // Copy and action carry no digits at all once the candidate is frozen under
  // the unified contract, grounded or not. Go's checkUnifiedWrittenCard bans
  // the same two fields.
  it('bans every digit from the copy and action of a unified card', () => {
    const unified: DigestCandidate = {
      ...anonymousFrictionCandidate,
      fingerprint: 'fingerprint-1',
      spellStartedAt: '2026-09-01T07:00:00Z',
      sessionCount: 3,
    };
    expect(demotedReason(groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'It happened in 3 sessions.',
        action: 'Decide how to handle this.',
      }],
      deferred: [],
    }, [unified]))).toMatch(/numeric glyph/);
  });

  it('grounds the cause sentence against the stored root cause', () => {
    const diagnosed: DigestCandidate = {
      ...anonymousFrictionCandidate,
      rootCause: 'LicenseWall renders the 2 contact addresses as plain text',
    };
    const grounded = groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'Users hit a license wall with no way forward.',
        why: 'Both 2 contact addresses render as plain text, so neither opens a mail client.',
        action: 'Decide how to handle this.',
      }],
      deferred: [],
    }, [diagnosed]);
    expect(grounded.included[0]).toMatchObject({
      why: 'Both 2 contact addresses render as plain text, so neither opens a mail client.',
    });

    expect(demotedReason(groundPayload({
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'Users hit a license wall with no way forward.',
        why: 'All 9 contact addresses render as plain text.',
        action: 'Decide how to handle this.',
      }],
      deferred: [],
    }, [diagnosed]))).toMatch(/ungrounded number 9/);
  });

  it('still rejects a card inventing a nonzero identified count', () => {
    const payload = {
      included: [{
        errorGroupId: 'g-anon',
        title: 'Support email is not clickable',
        copy: 'Users hit a license wall.',
        action: 'Decide how to handle this.',
        sessionCount: 3,
        identifiedCount: 3,
      }],
      deferred: [],
    };
    expect(demotedReason(groundPayload(payload, [anonymousFrictionCandidate]))).toMatch(/unsupported identified count/);
  });
});
