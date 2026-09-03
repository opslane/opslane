import type { ClaimedJob } from './db.js';
import {
  claimJob,
  heartbeat,
  completeJob,
  failJob,
  rescheduleJob,
  LeaseLostError,
} from './db.js';
import { logger } from './logger.js';
import { NonRetryableJobError } from './harness/errors.js';

export interface Poller {
  start(): void;
  stop(): Promise<void>;
}

export interface PollerOptions {
  /** How long to wait before checking an empty queue again (ms). */
  intervalMs: number;
  /** How long the lease is valid (ms). */
  leaseDurationMs: number;
  /** Unique identifier for this worker instance. */
  workerId: string;
  /** Callback invoked when a job is claimed. */
  processJob: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  /** Fired once per successful claim, before processing. Metrics only. */
  onClaim?: (job: ClaimedJob) => void;
  /**
   * Number of concurrent claim loops in this process (integer, 1-16; other
   * values fall back to 1, oversize values clamp to 16 with a warning).
   * Loops claim through claimJob, whose advisory-lock-serialized admission
   * enforces the fleet-wide lane caps regardless of this value; the
   * uncapped interactive lanes (investigate/fix) are bounded only by this
   * number times the replica count. The pg pool (driver default max 10)
   * holds connections per query, not per job. Defaults to 1: today's
   * serial worker.
   */
  concurrency?: number;
  /**
   * Fault-injection seam for reliability tests only. Runs after processJob
   * resolves and before the completion write, so a test can simulate a crash
   * or lease loss at that exact boundary. Never set in production.
   */
  beforeComplete?: (job: ClaimedJob) => Promise<void>;
  /** Injection seam for deterministic jitter in tests. Returns [0, 1). */
  random?: () => number;
  /**
   * Bounded wait for the loop to finish on stop(). Must be below the
   * platform's container termination grace period. Defaults to 25s.
   */
  shutdownGraceMs?: number;
}

type JobOutcome = 'completed' | 'failed' | 'aborted';

export function createPoller(options: PollerOptions): Poller {
  const {
    intervalMs,
    leaseDurationMs,
    workerId,
    processJob,
    onClaim,
    beforeComplete,
  } = options;
  const random = options.random ?? Math.random;
  const shutdownGraceMs = options.shutdownGraceMs ?? 25_000;
  const CLAIM_ERROR_BASE_MS = 1_000;
  const CLAIM_ERROR_CAP_MS = 60_000;
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_CAP_MS = 300_000;
  const MAX_CONCURRENCY = 16;

  let concurrency: number;
  if (options.concurrency === undefined) {
    concurrency = 1;
  } else if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    logger.warn('Invalid concurrency; running one loop', { requested: options.concurrency });
    concurrency = 1;
  } else if (options.concurrency > MAX_CONCURRENCY) {
    logger.warn('Concurrency clamped', { requested: options.concurrency, max: MAX_CONCURRENCY });
    concurrency = MAX_CONCURRENCY;
  } else {
    concurrency = options.concurrency;
  }

  let running = false;
  let loopPromises: Promise<void>[] = [];
  const wakers = new Set<() => void>();
  let abandoned = false;

  // Claims are serialized fleet-wide by claimJob's advisory lock, so chaining
  // them in-process costs no throughput and keeps N loops from parking N pool
  // connections on the same lock.
  let claimChain: Promise<unknown> = Promise.resolve();
  function claimSerially(): Promise<ClaimedJob | null> {
    const next = claimChain.then(
      () => claimJob(workerId, leaseDurationMs),
      () => claimJob(workerId, leaseDurationMs),
    );
    claimChain = next.catch(() => undefined);
    return next;
  }

  /** Capped exponential backoff with jitter. Jitter prevents a retry convoy. */
  function backoffMs(attempt: number, baseMs: number, capMs: number): number {
    const raw = baseMs * Math.pow(2, attempt) * (0.5 + random());
    return Math.min(raw, capMs);
  }

  /** Resolves after `ms`, or immediately when wakeSleep() is called. */
  function interruptibleSleep(ms: number): Promise<void> {
    if (!running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waker = () => {
        clearTimeout(timer);
        wakers.delete(waker);
        resolve();
      };
      const timer = setTimeout(() => {
        wakers.delete(waker);
        resolve();
      }, ms);
      timer.unref();
      wakers.add(waker);
    });
  }

  function wakeSleep(): void {
    for (const waker of [...wakers]) waker();
  }

  async function processOneJob(job: ClaimedJob): Promise<JobOutcome> {
    logger.info('Claimed job', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      project_id: job.projectId,
      job_type: job.jobType,
    });

    const controller = new AbortController();
    let heartbeatInFlight = false;
    const heartbeatInterval = setInterval(async () => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      try {
        const stillOwned = await heartbeat(
          job.id,
          workerId,
          job.leaseGeneration,
          leaseDurationMs,
        );
        if (!stillOwned) {
          logger.warn('Heartbeat: lease lost, aborting job', { job_id: job.id });
          controller.abort();
        }
      } catch (err: unknown) {
        logger.error('Heartbeat failed, aborting job', {
          job_id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        controller.abort();
      } finally {
        heartbeatInFlight = false;
      }
    }, Math.floor(leaseDurationMs / 3));

    try {
      await processJob(job, controller.signal);
      if (controller.signal.aborted) {
        logger.warn('Processing stopped: lease lost', {
          job_id: job.id,
          lease_generation: job.leaseGeneration,
        });
        return 'aborted';
      }
      if (beforeComplete) await beforeComplete(job);
      const completed = await completeJob(job.id, workerId, job.leaseGeneration);
      if (!completed) {
        logger.warn('Completion rejected: lease lost', {
          job_id: job.id,
          lease_generation: job.leaseGeneration,
        });
        controller.abort();
        return 'aborted';
      }
      logger.info('Completed job', {
        job_id: job.id,
        error_group_id: job.errorGroupId,
        job_type: job.jobType,
      });
      return 'completed';
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'JobRescheduledError') {
        logger.info('Job rescheduled', { job_id: job.id });
        return 'completed';
      }
      const message = err instanceof Error ? err.message : String(err);
      const nonRetryable = err instanceof NonRetryableJobError ? err : null;
      logger.error('Job failed', {
        job_id: job.id,
        error_group_id: job.errorGroupId,
        job_type: job.jobType,
        error: message,
        non_retryable: nonRetryable !== null,
        stop: nonRetryable?.detail.stop,
        cost_usd: nonRetryable?.detail.costUsd,
      });
      try {
        const failed = await failJob(
          job.id,
          workerId,
          job.leaseGeneration,
          message,
          nonRetryable
            ? { exhaust: true, deadLetterClass: nonRetryable.deadLetterClass }
            : undefined,
        );
        if (!failed) {
          logger.warn('Failure update rejected: lease lost', {
            job_id: job.id,
            lease_generation: job.leaseGeneration,
          });
        }
      } catch (failErr: unknown) {
        logger.error('Failed to record job failure', {
          job_id: job.id,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
      return 'failed';
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  async function runLoop(): Promise<void> {
    let consecutiveClaimErrors = 0;
    let consecutiveNonCompletions = 0;
    while (running) {
      let job: ClaimedJob | null;
      try {
        job = await claimSerially();
      } catch (err: unknown) {
        logger.error('Failed to claim job', {
          error: err instanceof Error ? err.message : String(err),
          consecutive_claim_errors: consecutiveClaimErrors + 1,
        });
        const delay = backoffMs(
          consecutiveClaimErrors,
          CLAIM_ERROR_BASE_MS,
          CLAIM_ERROR_CAP_MS,
        );
        consecutiveClaimErrors += 1;
        await interruptibleSleep(delay);
        continue;
      }

      consecutiveClaimErrors = 0;

      if (!job) {
        await interruptibleSleep(intervalMs);
        continue;
      }

      // Metrics callbacks must never break the claim loop.
      try {
        onClaim?.(job);
      } catch {
        // Ignore metrics failures.
      }

      // stop() may have fired while the claim was in flight. Return the job
      // immediately rather than stranding it for the full lease duration.
      if (!running) {
        try {
          await rescheduleJob(job, new Date());
          logger.info('Released job claimed during shutdown', { job_id: job.id });
        } catch (err: unknown) {
          if (err instanceof LeaseLostError) {
            logger.info('Job already reclaimed elsewhere during shutdown', { job_id: job.id });
          } else {
            logger.error('Handback failed; job stays claimed until the reaper takes it', {
              job_id: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return;
      }

      const outcome = await processOneJob(job);
      if (outcome === 'completed') {
        consecutiveNonCompletions = 0;
        continue;
      }

      consecutiveNonCompletions += 1;
      if (consecutiveNonCompletions >= CIRCUIT_BREAKER_THRESHOLD) {
        const delay = backoffMs(
          consecutiveNonCompletions - CIRCUIT_BREAKER_THRESHOLD,
          intervalMs,
          CIRCUIT_BREAKER_CAP_MS,
        );
        logger.warn('Circuit breaker: pausing claims after consecutive non-completions', {
          consecutive_non_completions: consecutiveNonCompletions,
          delay_ms: Math.round(delay),
        });
        await interruptibleSleep(delay);
      }
    }
  }

  return {
    start(): void {
      if (loopPromises.length > 0 || abandoned) {
        logger.warn('Poller already started or abandoned mid-shutdown; ignoring start()', {
          abandoned,
        });
        return;
      }
      running = true;
      logger.info('Poller started', {
        interval_ms: intervalMs,
        lease_duration_ms: leaseDurationMs,
        worker_id: workerId,
        concurrency,
      });
      loopPromises = Array.from({ length: concurrency }, () => runLoop());
    },

    async stop(): Promise<void> {
      running = false;
      wakeSleep();
      if (loopPromises.length > 0) {
        logger.info('Waiting for the poll loop to finish');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), shutdownGraceMs);
          timer.unref();
        });
        const result = await Promise.race([
          Promise.all(loopPromises).then(() => 'clean' as const),
          deadline,
        ]);
        if (timer) clearTimeout(timer);
        if (result === 'timeout') {
          logger.warn('Poll loop did not finish within the shutdown grace period', {
            shutdown_grace_ms: shutdownGraceMs,
          });
          abandoned = true;
          return;
        }
        loopPromises = [];
      }
      logger.info('Poller stopped');
    },
  };
}
