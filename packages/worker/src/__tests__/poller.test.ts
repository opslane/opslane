import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaimedJob } from '../db.js';
import { NonRetryableJobError } from '../harness/errors.js';

// Mock the db module before importing poller
vi.mock('../db.js', () => ({
  JobRescheduledError: class JobRescheduledError extends Error {},
  LeaseLostError: class LeaseLostError extends Error {},
  claimJob: vi.fn(),
  heartbeat: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  rescheduleJob: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mock setup
const { claimJob, heartbeat, completeJob, failJob, rescheduleJob } = await import('../db.js');
const { createPoller } = await import('../poller.js');
const { logger } = await import('../logger.js');

const mockClaimJob = vi.mocked(claimJob);
const mockHeartbeat = vi.mocked(heartbeat);
const mockCompleteJob = vi.mocked(completeJob);
const mockFailJob = vi.mocked(failJob);
const mockRescheduleJob = vi.mocked(rescheduleJob);

function makeJob(overrides?: Partial<ClaimedJob>): ClaimedJob {
  return {
    id: 'job-1',
    workerId: 'test-worker',
    errorGroupId: 'eg-1',
    eventId: null,
    sourceId: null,
    projectId: 'proj-1',
    jobType: 'investigate',
    attempts: 0,
    guidance: null,
    leaseGeneration: '1',
    triggeredBy: null,
    sessionId: null,
    ...overrides,
  };
}

describe('poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockHeartbeat.mockResolvedValue(true);
    mockCompleteJob.mockResolvedValue(true);
    mockFailJob.mockResolvedValue(true);
    mockRescheduleJob.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('should call processJob when a job is available', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let microtasks flush (the immediate tick is async)
    await vi.advanceTimersByTimeAsync(0);

    expect(mockClaimJob).toHaveBeenCalledWith('test-worker', 30_000);
    expect(processJob).toHaveBeenCalledWith(job, expect.any(AbortSignal));

    // Let the async job processing complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCompleteJob).toHaveBeenCalledWith('job-1', 'test-worker', '1');

    await poller.stop();
  });

  it('should not call processJob when no job is available', async () => {
    mockClaimJob.mockResolvedValueOnce(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockClaimJob).toHaveBeenCalled();
    expect(processJob).not.toHaveBeenCalled();

    await poller.stop();
  });

  it('should call failJob when processJob throws', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockRejectedValue(
      new Error('Pipeline exploded')
    );

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);
    // Let the error handling complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFailJob).toHaveBeenCalledWith(
      'job-1', 'test-worker', '1', 'Pipeline exploded', undefined,
    );
    expect(mockCompleteJob).not.toHaveBeenCalled();

    await poller.stop();
  });

  it('exhausts a NonRetryableJobError in one attempt with its class', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new NonRetryableJobError(
        'Inquiry ran out of turns',
        'limit',
        { stop: 'turns_exhausted', costUsd: 0.31 },
      ));
    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFailJob).toHaveBeenCalledWith(
      job.id,
      'test-worker',
      job.leaseGeneration,
      'Inquiry ran out of turns',
      { exhaust: true, deadLetterClass: 'limit' },
    );
    await poller.stop();
  });

  it('retries an ordinary failure through the queue', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error('socket hang up'));
    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFailJob).toHaveBeenCalledWith(
      job.id, 'test-worker', job.leaseGeneration, 'socket hang up', undefined,
    );
    await poller.stop();
  });

  it('should start heartbeat interval for active jobs', async () => {
    const job = makeJob();
    // processJob will take a while (we'll resolve it manually)
    let resolveProcessJob: (() => void) | undefined;
    const processJobPromise = new Promise<void>((resolve) => {
      resolveProcessJob = resolve;
    });

    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockReturnValue(processJobPromise);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let claim + processJob start
    await vi.advanceTimersByTimeAsync(0);

    expect(processJob).toHaveBeenCalledWith(job, expect.any(AbortSignal));

    // Advance past one heartbeat interval (30000/3 = 10000ms)
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockHeartbeat).toHaveBeenCalledWith('job-1', 'test-worker', '1', 30_000);

    // Resolve the job so cleanup happens
    resolveProcessJob!();
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();
  });

  it('aborts without completing when a heartbeat reports lease loss', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    mockHeartbeat.mockResolvedValueOnce(false);
    let observedSignal: AbortSignal | undefined;
    const processJob = vi.fn(
      async (_job: ClaimedJob, signal: AbortSignal): Promise<void> => {
        observedSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    );
    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(observedSignal?.aborted).toBe(true);
    expect(mockCompleteJob).not.toHaveBeenCalled();
    expect(mockFailJob).not.toHaveBeenCalled();
    await poller.stop();
  });

  it('aborts without completing when the heartbeat query fails', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);
    mockHeartbeat.mockRejectedValueOnce(new Error('database unavailable'));
    let observedSignal: AbortSignal | undefined;
    const processJob = vi.fn(
      async (_job: ClaimedJob, signal: AbortSignal): Promise<void> => {
        observedSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    );
    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(observedSignal?.aborted).toBe(true);
    expect(mockCompleteJob).not.toHaveBeenCalled();
    expect(mockFailJob).not.toHaveBeenCalled();
    await poller.stop();
  });

  it('does not report completion when the terminal write loses the lease', async () => {
    mockClaimJob.mockResolvedValueOnce(makeJob());
    mockCompleteJob.mockResolvedValueOnce(false);
    const processJob = vi.fn().mockResolvedValue(undefined);
    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith(
      'Completion rejected: lease lost',
      expect.objectContaining({ job_id: 'job-1' }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'Completed job',
      expect.anything(),
    );
    await poller.stop();
  });

  it('should poll on recurring interval', async () => {
    mockClaimJob.mockResolvedValue(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Immediate tick
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClaimJob).toHaveBeenCalledTimes(1);

    // After 1s interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob).toHaveBeenCalledTimes(2);

    // After another 1s interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob).toHaveBeenCalledTimes(3);

    await poller.stop();
  });

  it('should stop polling after stop() is called', async () => {
    mockClaimJob.mockResolvedValue(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();

    const callCount = mockClaimJob.mock.calls.length;

    // Advance time — should NOT trigger more claims
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockClaimJob).toHaveBeenCalledTimes(callCount);
  });

  it('drains consecutive jobs without waiting for the poll interval', async () => {
    mockClaimJob
      .mockResolvedValueOnce(makeJob({ id: 'job-1' }))
      .mockResolvedValueOnce(makeJob({ id: 'job-2' }))
      .mockResolvedValueOnce(makeJob({ id: 'job-3' }))
      .mockResolvedValue(null);
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(processJob).toHaveBeenCalledTimes(3);
    expect(mockCompleteJob).toHaveBeenCalledWith('job-1', 'test-worker', '1');
    expect(mockCompleteJob).toHaveBeenCalledWith('job-3', 'test-worker', '1');

    await poller.stop();
  });

  it('sleeps a full interval after an empty claim', async () => {
    mockClaimJob.mockResolvedValueOnce(null).mockResolvedValueOnce(makeJob());
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(processJob).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(processJob).toHaveBeenCalledTimes(1);

    await poller.stop();
  });

  it('stop() resolves during an idle sleep without advancing the clock', async () => {
    mockClaimJob.mockResolvedValue(null);
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();
    const callsAfterStop = mockClaimJob.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockClaimJob.mock.calls.length).toBe(callsAfterStop);
  });

  it('hands back a job claimed during shutdown without consuming an attempt', async () => {
    const job = makeJob();
    let releaseClaim: (claimed: ClaimedJob) => void = () => {};
    mockClaimJob.mockImplementationOnce(
      () => new Promise<ClaimedJob>((resolve) => { releaseClaim = resolve; }),
    );
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = poller.stop();
    releaseClaim(job);
    await stopping;

    expect(processJob).not.toHaveBeenCalled();
    expect(mockRescheduleJob).toHaveBeenCalledWith(job, expect.any(Date));
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it('backs off instead of hot-spinning when claimJob rejects', async () => {
    mockClaimJob.mockRejectedValue(new Error('ECONNREFUSED'));
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
      random: () => 0.5,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClaimJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(mockClaimJob).toHaveBeenCalledTimes(3);

    await poller.stop();
  });

  it('resets claim-error backoff after a successful claim', async () => {
    mockClaimJob
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeJob())
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
      random: () => 0.5,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const callsBeforeReset = mockClaimJob.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob.mock.calls.length).toBeGreaterThan(callsBeforeReset);

    await poller.stop();
  });

  it('pauses after three consecutive non-completions', async () => {
    mockClaimJob.mockResolvedValue(makeJob());
    mockCompleteJob.mockResolvedValue(false);
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
      random: () => 0.5,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(processJob).toHaveBeenCalledTimes(3);
    const callsAtTrip = mockClaimJob.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClaimJob.mock.calls.length).toBe(callsAtTrip);

    await vi.advanceTimersByTimeAsync(5000);
    expect(processJob).toHaveBeenCalledTimes(4);

    await poller.stop();
  });

  it('resets the breaker after one successful completion', async () => {
    mockClaimJob.mockResolvedValue(makeJob());
    mockCompleteJob
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 5000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
      random: () => 0.5,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(processJob).toHaveBeenCalledTimes(6);

    await poller.stop();
  });

  it('runs two jobs at once when concurrency is 2', async () => {
    let inFlight = 0;
    let peak = 0;
    const jobs = [makeJob({ id: 'job-1' }), makeJob({ id: 'job-2' })];
    mockClaimJob.mockImplementation(async () => jobs.shift() ?? null);
    const release: Array<() => void> = [];
    const processJob = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
    });
    const poller = createPoller({
      intervalMs: 1_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob,
      concurrency: 2,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(2);
    release.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    await poller.stop();
  });

  it('stays serial by default', async () => {
    let inFlight = 0;
    let peak = 0;
    const jobs = [makeJob({ id: 'job-1' }), makeJob({ id: 'job-2' })];
    mockClaimJob.mockImplementation(async () => jobs.shift() ?? null);
    const processJob = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    const poller = createPoller({
      intervalMs: 1_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(1);
    await poller.stop();
  });

  it('stop() waits for every in-flight job across loops', async () => {
    const jobs = [makeJob({ id: 'job-1' }), makeJob({ id: 'job-2' })];
    mockClaimJob.mockImplementation(async () => jobs.shift() ?? null);
    const release: Array<() => void> = [];
    let finished = 0;
    const processJob = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      finished += 1;
    });
    const poller = createPoller({
      intervalMs: 1_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob,
      concurrency: 2,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveLength(2);
    const stopped = poller.stop();
    release.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(finished).toBe(2);
    expect(mockCompleteJob).toHaveBeenCalledTimes(2);
  });

  it('stop() wakes every sleeping loop, not just the last to sleep', async () => {
    mockClaimJob.mockResolvedValue(null);
    const poller = createPoller({
      intervalMs: 60_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob: vi.fn(),
      concurrency: 3,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // all three loops claim null and sleep
    const stopped = poller.stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(stopped).resolves.toBeUndefined();
  });

  it('clamps a wild concurrency value to the documented bounds', async () => {
    mockClaimJob.mockResolvedValue(null);
    const poller = createPoller({
      intervalMs: 60_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob: vi.fn(),
      concurrency: 5_000,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // 16 loops, not 5000: each issues exactly one claim before sleeping.
    expect(mockClaimJob).toHaveBeenCalledTimes(16);
    const stopped = poller.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['non-numeric', Number.NaN],
  ])('falls back to one loop for a %s concurrency value', async (_name, value) => {
    mockClaimJob.mockResolvedValue(null);
    const poller = createPoller({
      intervalMs: 60_000,
      leaseDurationMs: 30_000,
      workerId: 'w',
      processJob: vi.fn(),
      concurrency: value,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClaimJob).toHaveBeenCalledTimes(1);
    const stopped = poller.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
  });

  it('keeps claim-error backoff per loop: two failing loops claim twice as often as one', async () => {
    // With per-loop counters, each loop backs off from its own error count;
    // if the counters regressed to shared closure state, the combined count
    // would inflate both loops' delays and halve the claim rate. random: () => 0
    // removes the jitter so the arithmetic is exact.
    const countAttempts = async (concurrency: number): Promise<number> => {
      vi.clearAllMocks();
      mockClaimJob.mockRejectedValue(new Error('db down'));
      const poller = createPoller({
        intervalMs: 1_000,
        leaseDurationMs: 30_000,
        workerId: 'w',
        processJob: vi.fn(),
        concurrency,
        random: () => 0,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(30_000);
      const attempts = mockClaimJob.mock.calls.length;
      const stopped = poller.stop();
      await vi.advanceTimersByTimeAsync(0);
      await stopped;
      return attempts;
    };
    const single = await countAttempts(1);
    const dual = await countAttempts(2);
    expect(dual).toBe(single * 2);
  });
});
