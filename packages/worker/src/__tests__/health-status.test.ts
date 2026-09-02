import { describe, it, expect } from 'vitest';
import { computeHealthStatus, formatDeadLetterCounts } from '../index.js';
import type { QueueDepthRow } from '../db.js';

const WINDOW = 60_000;
const BOOT = 1_000_000;

function depth(eligible: number): QueueDepthRow[] {
  return [{ jobType: 'session_analysis', eligible, backedOff: 0, oldestEligibleSeconds: 10 }];
}

/** Healthy steady state: sampled just now, well past boot, backlog waiting but
 *  the worker is claiming. Each test perturbs exactly one field. */
function baseline(): Parameters<typeof computeHealthStatus>[0] {
  const now = BOOT + WINDOW * 10;
  return {
    queueDepth: depth(5),
    claimRatePerMinute: 12,
    jobsInFlight: 1,
    queueSampleAt: now,
    now,
    startedAt: BOOT,
    sampleIntervalMs: WINDOW,
  };
}

describe('computeHealthStatus', () => {
  it('reports ok when the queue is being drained', () => {
    expect(computeHealthStatus(baseline())).toBe('ok');
  });

  it('reports stalled only when work is eligible, nothing is claimed, and nothing is in flight', () => {
    expect(
      computeHealthStatus({ ...baseline(), claimRatePerMinute: 0, jobsInFlight: 0 }),
    ).toBe('stalled');
  });

  it('does not report stalled while a long job is in flight', () => {
    // The regression this guards: a multi-minute fix job produces zero claims
    // across several windows while the queue still holds eligible work.
    expect(
      computeHealthStatus({ ...baseline(), claimRatePerMinute: 0, jobsInFlight: 1 }),
    ).toBe('ok');
  });

  it('does not report stalled when nothing is eligible', () => {
    expect(
      computeHealthStatus({
        ...baseline(),
        queueDepth: depth(0),
        claimRatePerMinute: 0,
        jobsInFlight: 0,
      }),
    ).toBe('ok');
  });

  it('counts eligible work across every job type', () => {
    const rows: QueueDepthRow[] = [
      { jobType: 'investigate', eligible: 0, backedOff: 3, oldestEligibleSeconds: null },
      { jobType: 'session_analysis', eligible: 2, backedOff: 0, oldestEligibleSeconds: 90 },
    ];
    expect(
      computeHealthStatus({
        ...baseline(),
        queueDepth: rows,
        claimRatePerMinute: 0,
        jobsInFlight: 0,
      }),
    ).toBe('stalled');
  });

  it('ignores backed-off rows, which are waiting on retry windows rather than starved', () => {
    const rows: QueueDepthRow[] = [
      { jobType: 'investigate', eligible: 0, backedOff: 40, oldestEligibleSeconds: null },
    ];
    expect(
      computeHealthStatus({
        ...baseline(),
        queueDepth: rows,
        claimRatePerMinute: 0,
        jobsInFlight: 0,
      }),
    ).toBe('ok');
  });

  it('reports unknown before the first successful sample', () => {
    // Postgres unreachable at boot: getQueueDepth and claimJob fail together, so
    // an empty queueDepth must not be read as "no work".
    expect(computeHealthStatus({ ...baseline(), queueSampleAt: null, queueDepth: [] })).toBe(
      'unknown',
    );
  });

  it('reports unknown once the sample goes stale', () => {
    const b = baseline();
    expect(
      computeHealthStatus({ ...b, queueSampleAt: b.now - WINDOW * 2 - 1 }),
    ).toBe('unknown');
  });

  it('still trusts a sample that is merely one window old', () => {
    const b = baseline();
    expect(computeHealthStatus({ ...b, queueSampleAt: b.now - WINDOW })).toBe('ok');
  });

  it('does not report stalled during the first window after boot', () => {
    // claimRatePerMinute is only computed at the first sample tick, so before
    // then it reads 0 for a worker that has been claiming fine since boot.
    const now = BOOT + WINDOW - 1;
    expect(
      computeHealthStatus({
        ...baseline(),
        now,
        queueSampleAt: now,
        claimRatePerMinute: 0,
        jobsInFlight: 0,
      }),
    ).toBe('ok');
  });

  it('starts reporting stalled once the first window has elapsed', () => {
    const now = BOOT + WINDOW;
    expect(
      computeHealthStatus({
        ...baseline(),
        now,
        queueSampleAt: now,
        claimRatePerMinute: 0,
        jobsInFlight: 0,
      }),
    ).toBe('stalled');
  });
});

describe('formatDeadLetterCounts', () => {
  it('uses the health endpoint snake_case contract', () => {
    expect(formatDeadLetterCounts([
      { jobType: 'investigate', deadLetterClass: 'limit', count: 2 },
    ])).toEqual([
      { job_type: 'investigate', class: 'limit', count: 2 },
    ]);
  });
});
