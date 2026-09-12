import { describe, expect, it, vi } from 'vitest';
import { groundPayload, writeDigest, type DigestCandidate } from '../job.js';
import { DIGEST_PAYLOAD_SCHEMA } from '../schema.js';

const candidate: DigestCandidate = {
  promptVersion: 7, ticketId: 'ticket', generation: 1, evidenceVersion: 4,
  errorGroupId: 'group', kind: 'friction', label: 'new', outcome: 'awaiting_approval',
  title: 'Changing the date takes repeated clicks', summary: 'Unverified 99 clicks',
  confirmedNotes: ['Changing the month requires six clicks and 3 presses.'],
  steps: 'Open the calendar and click six times.', coverage: 0.67,
  why: 'The calendar exposes only month navigation.',
  affectedUsers: 3, verifiedUsers: 3, verifiedSessions: 4, accounts: ['Acme'],
  lastSeen: '', decidedAt: '',
};
function ground(copy: string, extra: Record<string, unknown> = {}, truth = candidate) {
  return groundPayload({ included: [{ errorGroupId: 'group', title: 'Changing the date takes repeated clicks',
    copy, why: candidate.why, ...extra }], deferred: [] }, [truth]);
}

describe('v7 ticket writer', () => {
  it('asks only for authored prose and identity', () => {
    expect(Object.keys(DIGEST_PAYLOAD_SCHEMA.properties.included.items.properties).sort())
      .toEqual(['copy', 'episodeId', 'errorGroupId', 'steps', 'title', 'why']);
  });
  it('accepts grounded interaction numbers without requiring an authored action', () => {
    const result = ground('Changing the month takes six clicks.', { steps: 'Press 3 times.' });
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).toMatchObject({ steps: 'Press 3 times.' });
    for (const key of ['action', 'claimedUsers', 'accounts', 'prUrl']) expect(result.included[0]).not.toHaveProperty(key);
  });
  it.each(['3 users struggled.', 'six affected users struggled.', '3 sessions were affected.',
    '３ users struggled.', '99 clicks were needed.', 'Seven clicks were needed.'])('rejects ungrounded or mechanical quantities: %s', copy => {
    expect(ground(copy).included).toHaveLength(0);
  });
  it('drops model-owned action/count/link fields from the v7 output', () => {
    const result = ground('Changing the month takes six clicks.', { action: 'Invented action', claimedUsers: 99, accounts: ['Wrong'], prUrl: 'https://wrong.test' });
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).not.toHaveProperty('action');
    expect(result.included[0]).not.toHaveProperty('claimedUsers');
  });
  it('rejects a why without a currently qualified cause', () => {
    expect(ground('Changing the date is laborious.', {}, { ...candidate, coverage: 0.49 }).included).toHaveLength(0);
  });
  it('requires the qualified why and bounds steps', () => {
    expect(ground('Changing the date is laborious.', { why: undefined }).included).toHaveLength(0);
    expect(ground('Changing the date is laborious.', { steps: 'x'.repeat(601) }).included).toHaveLength(0);
  });
  it('applies the same grounding to cached v7 prose without another model call', async () => {
    const askModel = vi.fn();
    const truth = { ...candidate, cachedCard: { title: candidate.title, copy: 'Changing the month takes six clicks.',
      why: candidate.why, steps: candidate.steps, authoredAt: '', fingerprint: 'cached' } };
    const deps = { loadRun: async () => ({ id: 'run', projectId: 'project', status: 'frozen' as const,
      candidates: [truth], payload: null }), askModel, persist: async () => true };
    expect((await writeDigest('run', 'project', deps)).included[0]).toMatchObject({ steps: candidate.steps });
    truth.cachedCard.copy = 'Changing dates affected six users.';
    expect((await writeDigest('run', 'project', deps)).included).toHaveLength(0);
    expect(askModel).not.toHaveBeenCalled();
  });
  it('uses the same prose-only output for fresh error candidates', () => {
    const result = ground('Changing dates stalls.', { why: undefined }, { ...candidate, ticketId: undefined,
      kind: 'error', why: undefined, rootCause: undefined });
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).not.toHaveProperty('action');
  });

});
