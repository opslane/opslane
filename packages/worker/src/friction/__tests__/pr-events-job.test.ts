import { describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '../../db.js';

vi.mock('../fix-attempts.js', () => ({
  applyPrEvent: vi.fn(),
  lockJob: vi.fn(),
  transaction: vi.fn(),
}));

const { processPrEventJob } = await import('../pr-events-job.js');
const { transaction } = await import('../fix-attempts.js');

const job: ClaimedJob = {
  id: 'job-1',
  workerId: 'worker-1',
  errorGroupId: 'group-1',
  eventId: null,
  sourceId: null,
  projectId: 'project-1',
  jobType: 'friction_pr_event',
  attempts: 0,
  guidance: null,
  leaseGeneration: '1',
  triggeredBy: null,
  sessionId: null,
  ticketId: 'ticket-1',
  fixAttemptId: 'attempt-1',
  publicationGeneration: 1,
};

describe('processPrEventJob', () => {
  it.each([
    ['no payload', undefined],
    ['a null payload', null],
    ['an array payload', ['event-1']],
    ['an empty payload', {}],
    ['a non-string eventId', { eventId: 7 }],
  ])('rejects %s before opening a transaction', async (_name, payload) => {
    await expect(processPrEventJob({ ...job, payload })).rejects.toThrow('PR event job missing eventId');
    expect(transaction).not.toHaveBeenCalled();
  });
});
