import { describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '../db.js';

vi.mock('../product-context/job.js', () => ({ runProductContext: vi.fn() }));

const { runProductContext } = await import('../product-context/job.js');
const { processRouteMapJob } = await import('../route-map.js');

describe('processRouteMapJob', () => {
  it('runs the product-context implementation under the existing queue kind', async () => {
    const job: ClaimedJob = {
      id: 'job-1', workerId: 'worker-1', leaseGeneration: '3',
      errorGroupId: null, eventId: null, sourceId: null, projectId: 'project-1',
      jobType: 'route_map', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: null,
    };
    const signal = new AbortController().signal;

    await processRouteMapJob(job, signal);

    expect(runProductContext).toHaveBeenCalledWith(job, signal);
  });
});
