# Worker drain loop and retry backoff: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 720 jobs/hour per-worker ceiling by replacing the worker's `setInterval` poller with a drain loop, and replace the three implicit guarantees the 5-second tick was silently providing.

**Architecture:** `packages/worker/src/poller.ts` stops using `setInterval` and becomes a single awaited `while (running)` loop that claims, processes, and immediately claims again, sleeping only when the queue is empty or a claim throws. Because the removed tick was also the system's only retry spacing, `failJob` and `requeueStaleJobs` in `packages/worker/src/db.ts` gain an `available_at` exponential backoff, and the loop gains a consecutive-failure circuit breaker. Shutdown moves from awaiting one job promise to awaiting the loop promise, with a handback for a job claimed during shutdown.

**Tech Stack:** Node 22, TypeScript (ESM, strict), Vitest, `pg` against Postgres. No new dependencies.

**Spec:** `docs/plans/2026-08-04-worker-drain-loop-design.md`. Read it before starting; this plan implements the M1 and M2 milestones from it.

## Global constraints

- **No single commit may contain the drain loop without both of its safety mechanisms.** "One PR" is not sufficient protection: it prevents merge separation, not a cherry-pick or a deploy from an intermediate commit. So the loop, the claim-error backoff, and the circuit breaker are **one atomic commit** (Task 3), and the database retry backoff lands *before* it (Task 1). Do not split Task 3 into separate commits and do not reorder it ahead of Task 1.
- Every commit must build and pass tests on its own.
- Lease ownership, fencing generations (`lease_generation`), and terminal-status transitions must not change. Retry *timing* changes; retry *semantics* do not. Any test that currently asserts fencing behavior must pass unmodified.
- ESM + strict TypeScript. Use `unknown` plus narrowing, never `any`. Tests colocated in `__tests__`.
- No Redis, BullMQ, or any new queue. Postgres only.
- `pnpm --filter @opslane/worker build` and `pnpm --filter @opslane/worker test` must pass at every commit.
- **Read the skip count, not the pass count.** `src/__tests__/db.test.ts` gates on `DATABASE_URL` only. `src/__tests__/poller.integration.test.ts` gates on `DATABASE_URL` **and** `OPSLANE_RELIABILITY_DB_TESTS=1`. A green run with either unset proves nothing.
- Backoff constants, used identically in both database paths: **base 30 seconds, cap 900 seconds**. Claim-error backoff: base 1s, cap 60s. Circuit breaker: base `POLL_INTERVAL_MS`, cap 300s. Threshold K = 3.

## File structure

| File | Change | Responsibility after the change |
|---|---|---|
| `packages/worker/src/poller.ts` | Modify | Owns claim cadence: the drain loop, the interruptible sleep, claim-error backoff, the circuit breaker, and the shutdown contract |
| `packages/worker/src/db.ts` | Modify | `failJob` and `requeueStaleJobs` gain `available_at` backoff; the stale advisory-lock comment is corrected |
| `packages/worker/src/index.ts` | Modify | `POLL_INTERVAL_MS` NaN guard; `/health` gains queue-age and claim-rate fields |
| `packages/worker/src/__tests__/poller.test.ts` | Modify | Unit coverage for cadence, backoff, breaker, shutdown. Mocked db, fake timers |
| `packages/worker/src/__tests__/db.test.ts` | Modify | Backoff SQL assertions. Real Postgres, `DATABASE_URL` gate |
| `packages/worker/src/__tests__/poller.integration.test.ts` | Modify | Real backlog drain, no stranded claims. Real Postgres, double gate |
| `packages/worker/AGENTS.md` | Modify | Records the fleet-cap coupling for the deploy workstream |
| `docs/reference/environment-variables.md` | Modify | Documents the changed meaning of `POLL_INTERVAL_MS`, the new `SHUTDOWN_GRACE_MS`, and the fleet-cap coupling. Backoff bases, caps, and the breaker threshold are deliberately compile-time constants, not env knobs: they are correctness parameters, and an operator retuning them mid-incident is more likely to cause the retry storm than to avoid it |

---

### Task 0: Run the M0 measurement gate (no code)

The design makes M0 blocking. It is not a code task, but skipping it is how this
work ends up sized against a statistic the design itself calls untrustworthy.

**Files:** none. Production database, read-only.

**Interfaces:**
- Consumes: nothing.
- Produces: the p95/p99 `session_analysis` duration, which decides whether D-1
  (in-process concurrency) reopens, and the `dead_letter` count, which decides
  whether issue #260's arrival numbers can still be quoted.

- [ ] **Step 1: Run the four queries in the design doc's M0 section**

`docs/plans/2026-08-04-worker-drain-loop-design.md`, section "M0: measure before
building". Run them read-only against production.

- [ ] **Step 2: Record the results in the issue**

Paste the four results into issue #260 as a comment so the numbers have a home
outside a chat log.

- [ ] **Step 3: Decide two things before writing code**

- If p95/p99 shows a heavy tail, **stop and reopen D-1**: serial draining is no
  longer obviously sufficient and in-process concurrency returns as a real option.
  This plan assumes the tail is short.
- If `dead_letter` is a large fraction of `session_analysis`, the queue is already
  shedding load, and the ~1,350/hour arrival figure needs re-deriving before
  anyone quotes it again, including in this plan's own justification.

`ANTHROPIC_API_KEY` was confirmed set in production on 2026-08-04, so adjudication
runs and the "backlog produces nothing" scenario is already closed. Query 1 is a
spend-sizing input now, not a gate: this change multiplies model spend by the same
factor it multiplies throughput.

---

### Task 1: `available_at` backoff in `failJob` and `requeueStaleJobs`

Lands first so no commit contains the drain loop without retry spacing.

**Files:**
- Modify: `packages/worker/src/db.ts:295-345` (`failJob`), `packages/worker/src/db.ts:357-402` (`requeueStaleJobs`)
- Test: `packages/worker/src/__tests__/db.test.ts` (gated on `DATABASE_URL` only, so it runs in the normal gate)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RETRY_BACKOFF_BASE_SECONDS = 30` and `RETRY_BACKOFF_CAP_SECONDS = 900`, both exported from `db.ts`. This task's own tests and Task 7's integration tests use them to compute expected retry windows rather than hardcoding 30 in three places.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/db.test.ts`, inside the existing `describeDb` block that contains `'should retry (reset to pending) when under max_attempts'`:

```ts
it('schedules a retry in the future instead of immediately', async () => {
  const { jobId } = await seedClaimedJob();   // reuse the helper the neighboring failJob tests use
  const before = Date.now();
  await failJob(jobId, WORKER_ID, '1', 'transient boom');

  const { rows } = await pool.query<{ status: string; available_at: Date; attempts: number }>(
    `SELECT status, available_at, attempts FROM error_group_jobs WHERE id = $1`, [jobId]);
  expect(rows[0]!.status).toBe('pending');
  expect(rows[0]!.attempts).toBe(1);
  // First retry uses the pre-increment attempts value (0), so base * 2^0 = 30s,
  // then jitter in [0.5, 1.5). Lower bound 15s, upper bound 45s.
  const delayMs = rows[0]!.available_at.getTime() - before;
  expect(delayMs).toBeGreaterThan(14_000);
  expect(delayMs).toBeLessThan(46_000);
});

it('does not let a backed-off job be claimed before its window elapses', async () => {
  const { jobId } = await seedClaimedJob();
  await failJob(jobId, WORKER_ID, '1', 'transient boom');
  const claimed = await claimJob('other-worker', 30_000);
  expect(claimed?.id).not.toBe(jobId);
});

it('leaves available_at alone when the job dead-letters', async () => {
  const { jobId } = await seedClaimedJob({ attempts: 2, maxAttempts: 3 });
  const { rows: pre } = await pool.query<{ available_at: Date }>(
    `SELECT available_at FROM error_group_jobs WHERE id = $1`, [jobId]);
  await failJob(jobId, WORKER_ID, '1', 'final boom');
  const { rows: post } = await pool.query<{ status: string; available_at: Date }>(
    `SELECT status, available_at FROM error_group_jobs WHERE id = $1`, [jobId]);
  expect(post[0]!.status).toBe('dead_letter');
  expect(post[0]!.available_at.getTime()).toBe(pre[0]!.available_at.getTime());
});

it('spaces reaper requeues the same way failJob does', async () => {
  const { jobId } = await seedClaimedJob({ leaseExpired: true });
  const before = Date.now();
  await requeueStaleJobs();
  const { rows } = await pool.query<{ status: string; available_at: Date }>(
    `SELECT status, available_at FROM error_group_jobs WHERE id = $1`, [jobId]);
  expect(rows[0]!.status).toBe('pending');
  expect(rows[0]!.available_at.getTime()).toBeGreaterThan(before + 14_000);
});
```

If `seedClaimedJob` does not already exist with an options argument, extend the seeding helper the surrounding `failJob` tests use so it accepts `{ attempts?, maxAttempts?, leaseExpired? }`, defaulting to `{ attempts: 0, maxAttempts: 3, leaseExpired: false }`. When `leaseExpired` is true it must insert with `lease_expires_at = now() - interval '1 minute'`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/worker
DATABASE_URL="$DATABASE_URL" pnpm vitest run src/__tests__/db.test.ts -t 'schedules a retry'
```

Expected: FAIL. `available_at` is unchanged by `failJob` today, so the computed `delayMs` is negative or near zero.

- [ ] **Step 3: Add the backoff to `failJob`**

In `src/db.ts`, above `failJob`, add the shared constants:

```ts
/** Retry backoff floor and ceiling, shared by failJob and the reaper.
 *  The tick used to be the only retry spacing; these replace it. */
export const RETRY_BACKOFF_BASE_SECONDS = 30;
export const RETRY_BACKOFF_CAP_SECONDS = 900;
```

In the `failJob` UPDATE (`db.ts:309-336`), add one clause to the SET list, immediately before `updated_at = now()`:

```sql
           available_at = CASE
             WHEN attempts + 1 >= max_attempts THEN available_at
             ELSE now() + make_interval(secs => LEAST(
                    $5::double precision * power(2, attempts) * (0.5 + random()),
                    $6::double precision))
           END,
```

and extend the bind array from `[jobId, workerId, leaseGeneration, error]` to:

```ts
      [jobId, workerId, leaseGeneration, error,
       RETRY_BACKOFF_BASE_SECONDS, RETRY_BACKOFF_CAP_SECONDS]
```

Two things that are easy to get wrong here:

1. Inside a single Postgres `UPDATE ... SET`, every right-hand expression reads the row as it was **before** the statement. `attempts` is therefore the count of failures *before* this one, which is what the exponent wants: the first retry gets `30 * 2^0`. The status decision in the same statement wants the count *after*, which is why it says `attempts + 1`. Both are correct as written. Do not "fix" one to match the other.
2. The jitter multiplier is **inside** `LEAST`, not outside. Outside, a 0.5-1.5 multiplier would let the delay reach 1.5x the cap, and the cap would not be a cap.

- [ ] **Step 4: Add the same backoff to `requeueStaleJobs`**

`requeueStaleJobs` (`db.ts:357-402`) currently calls `client.query` with no bind array. Add the identical clause before `updated_at = now()` in its UPDATE:

```sql
           available_at = CASE
             WHEN attempts + 1 >= max_attempts THEN available_at
             ELSE now() + make_interval(secs => LEAST(
                    $1::double precision * power(2, attempts) * (0.5 + random()),
                    $2::double precision))
           END,
```

and give the query a bind array as its second argument:

```ts
      [RETRY_BACKOFF_BASE_SECONDS, RETRY_BACKOFF_CAP_SECONDS]
```

Without this, a failed job backs off but a lease-expired job retries instantly, and a job that OOM-kills the worker re-claims every `REAPER_INTERVAL_MS` forever with no growing delay.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/worker
DATABASE_URL="$DATABASE_URL" pnpm vitest run src/__tests__/db.test.ts
```

Expected: PASS, including the pre-existing `'should retry (reset to pending) when under max_attempts'` and `'should dead-letter when at max_attempts'`. Confirm the run reports **0 skipped**.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/src/__tests__/db.test.ts
git commit -m "fix(worker): space job retries with exponential backoff

failJob and requeueStaleJobs reset status to pending without ever writing
available_at, so the 5s poll interval was the only thing separating retry
attempts. Add jittered exponential backoff to both before the poller stops
using that interval."
```

---

### Task 2: Guard `POLL_INTERVAL_MS` against NaN

Small, and a precondition for Task 3: under a drain loop, `sleep(NaN)` is a no-op and the error path becomes unthrottled.

**Files:**
- Modify: `packages/worker/src/index.ts:73-76`

**Interfaces:**
- Consumes: nothing.
- Produces: `POLL_INTERVAL_MS` is guaranteed a positive integer. Task 3 relies on this.

- [ ] **Step 1: Apply the guard already used in this file**

`index.ts:88-99` already guards `RESOLVE_AGE_DAYS` with a comment explaining why misconfiguration is dangerous. Follow that established pattern rather than inventing a new one. Replace `index.ts:73-76`:

```ts
const POLL_INTERVAL_MS = parseInt(
  process.env['POLL_INTERVAL_MS'] ?? '5000',
  10
);
```

with:

```ts
const POLL_INTERVAL_MS_DEFAULT = 5000;
const POLL_INTERVAL_MS_RAW = parseInt(
  process.env['POLL_INTERVAL_MS'] ?? String(POLL_INTERVAL_MS_DEFAULT),
  10
);
// Guard against NaN/non-positive misconfiguration. Under the drain loop this is
// the only pacing left on the empty-queue and claim-error paths: setTimeout
// coerces NaN to 0, so a typo here would spin claims against Postgres.
const POLL_INTERVAL_MS_MIN = 50;
const POLL_INTERVAL_MS_MAX = 300_000;
const POLL_INTERVAL_MS =
  Number.isInteger(POLL_INTERVAL_MS_RAW) &&
  POLL_INTERVAL_MS_RAW >= POLL_INTERVAL_MS_MIN &&
  POLL_INTERVAL_MS_RAW <= POLL_INTERVAL_MS_MAX
    ? POLL_INTERVAL_MS_RAW
    : POLL_INTERVAL_MS_DEFAULT;
```

`Number.isInteger` alone is not enough, for three reasons worth stating so nobody
"simplifies" this later. `parseInt('1.5', 10)` yields `1`, a legal positive integer
that would make the empty-queue path poll a thousand times a second. Values beyond
Node's timer range are also positive integers, and `setTimeout` clamps them back to
roughly 1ms, recreating the same hot loop from the opposite direction. And
`parseInt('5000oops', 10)` yields `5000`, which is lenient but harmless. The floor
and ceiling catch the two dangerous cases; the leniency of the third does not matter.

- [ ] **Step 2: Verify the build passes**

```bash
pnpm --filter @opslane/worker build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/index.ts
git commit -m "fix(worker): fall back to the default when POLL_INTERVAL_MS is not a positive integer"
```

---

### Task 3: Replace `setInterval` with the drain loop

**Tasks 3, 4, and 5 are one commit.** Work through all three, then commit once at the end
of Task 5. Tasks 3 and 4 deliberately have no commit step. A commit containing the drain
loop without the claim-error backoff hot-spins against a failing database; one without the
circuit breaker walks the whole backlog into abandoned-claimed state during an outage. "One
PR" does not prevent someone cherry-picking or deploying an intermediate commit, so the
protection has to be that the intermediate commit never exists.

This task establishes the loop and the shutdown contract.

**Audit note, already performed:** every existing test in `poller.test.ts` that returns a
job uses `mockResolvedValueOnce` (lines 62, 112, 146, 178, 208, 237); the only two
persistent mocks (lines 262, 291) resolve `null`, which the loop handles by sleeping. So no
existing test becomes an unbounded drain under this change, and all nine pass unmodified.
Re-check this if you add a persistent `mockResolvedValue(makeJob())` anywhere.

**Files:**
- Modify: `packages/worker/src/poller.ts` (whole file)
- Test: `packages/worker/src/__tests__/poller.test.ts`

**Interfaces:**
- Consumes: `POLL_INTERVAL_MS` is a positive integer (Task 2).
- Produces:
  - `PollerOptions` gains one optional field: `random?: () => number` (defaults to `Math.random`), the injection seam Tasks 4 and 5 use for deterministic jitter assertions.
  - Module-private `interruptibleSleep(ms: number): Promise<void>` and `wakeSleep(): void`.
  - Module-private `processOneJob(job: ClaimedJob): Promise<'completed' | 'failed' | 'aborted'>` — the existing IIFE body, returning its outcome. Task 5 consumes the return value.
  - `Poller.start()` and `Poller.stop()` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/poller.test.ts` inside the existing `describe('poller', ...)`:

```ts
it('drains consecutive jobs without waiting for the poll interval', async () => {
  mockClaimJob
    .mockResolvedValueOnce(makeJob({ id: 'job-1' }))
    .mockResolvedValueOnce(makeJob({ id: 'job-2' }))
    .mockResolvedValueOnce(makeJob({ id: 'job-3' }))
    .mockResolvedValue(null);
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({ intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);   // microtasks only, zero simulated time

  expect(processJob).toHaveBeenCalledTimes(3);
  expect(mockCompleteJob).toHaveBeenCalledWith('job-1', 'test-worker', '1');
  expect(mockCompleteJob).toHaveBeenCalledWith('job-3', 'test-worker', '1');

  await poller.stop();
});

it('sleeps a full interval after an empty claim', async () => {
  mockClaimJob.mockResolvedValueOnce(null).mockResolvedValueOnce(makeJob());
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({ intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(processJob).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(5000);
  expect(processJob).toHaveBeenCalledTimes(1);

  await poller.stop();
});

it('stop() resolves during an idle sleep without advancing the clock', async () => {
  mockClaimJob.mockResolvedValue(null);
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({ intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);

  await poller.stop();               // must not hang; no timer advance follows
  const callsAfterStop = mockClaimJob.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mockClaimJob.mock.calls.length).toBe(callsAfterStop);
});

it('hands back a job claimed during shutdown without consuming an attempt', async () => {
  const job = makeJob();
  let releaseClaim: (j: ClaimedJob) => void = () => {};
  mockClaimJob.mockImplementationOnce(() => new Promise<ClaimedJob>((res) => { releaseClaim = res; }));
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({ intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);

  const stopping = poller.stop();    // stop() while the claim is still in flight
  releaseClaim(job);
  await stopping;

  expect(processJob).not.toHaveBeenCalled();
  expect(mockRescheduleJob).toHaveBeenCalledWith(job, expect.any(Date));
  expect(mockFailJob).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Extend the db mock**

`poller.test.ts:5-11` mocks `../db.js` without `rescheduleJob` or `LeaseLostError`. Without this step every test in the file throws `rescheduleJob is not a function`. Replace the mock factory with:

```ts
vi.mock('../db.js', () => ({
  JobRescheduledError: class JobRescheduledError extends Error {},
  LeaseLostError: class LeaseLostError extends Error {},
  claimJob: vi.fn(),
  heartbeat: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  rescheduleJob: vi.fn(),
}));
```

and add to the import and mock bindings below it:

```ts
const { claimJob, heartbeat, completeJob, failJob, rescheduleJob } = await import('../db.js');
const mockRescheduleJob = vi.mocked(rescheduleJob);
```

Add `mockRescheduleJob.mockResolvedValue(undefined);` to the existing `beforeEach`.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts
```

Expected: the four new tests FAIL. `drains consecutive jobs` sees `processJob` called once, because `tick()` claims one job per firing.

- [ ] **Step 4: Rewrite the poller**

Replace the body of `createPoller` in `src/poller.ts`. Delete `pollTimer` and `activeJobPromise`; they are dead once the loop awaits its own work.

```ts
export interface PollerOptions {
  intervalMs: number;
  leaseDurationMs: number;
  workerId: string;
  processJob: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  beforeComplete?: (job: ClaimedJob) => Promise<void>;
  /** Injection seam for deterministic jitter in tests. Returns [0, 1). */
  random?: () => number;
  /** Bounded wait for the loop to finish on stop(). Must be below the platform's
   *  container termination grace period. Defaults to 25s. */
  shutdownGraceMs?: number;
}

type JobOutcome = 'completed' | 'failed' | 'aborted';

export function createPoller(options: PollerOptions): Poller {
  const { intervalMs, leaseDurationMs, workerId, processJob, beforeComplete } = options;
  const shutdownGraceMs = options.shutdownGraceMs ?? 25_000;

  let running = false;
  let loopPromise: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  /** Set when stop() gave up waiting. The loop may still be in flight. */
  let abandoned = false;

  /** Resolves after `ms`, or immediately when wakeSleep() is called. Never rejects.
   *  Returns immediately if we are already stopping, which closes the lost-wake
   *  race described below. */
  function interruptibleSleep(ms: number): Promise<void> {
    if (!running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  }

  function wakeSleep(): void {
    wake?.();
  }

  async function runLoop(): Promise<void> {
    while (running) {
      let job: ClaimedJob | null;
      try {
        job = await claimJob(workerId, leaseDurationMs);
      } catch (err: unknown) {
        logger.error('Failed to claim job', {
          error: err instanceof Error ? err.message : String(err),
        });
        await interruptibleSleep(intervalMs);
        continue;
      }

      if (!job) {
        await interruptibleSleep(intervalMs);
        continue;
      }

      // stop() may have been called while the claim was in flight. Hand the job
      // straight back rather than stranding it for the full lease duration.
      if (!running) {
        try {
          await rescheduleJob(job, new Date());
          logger.info('Released job claimed during shutdown', { job_id: job.id });
        } catch (err: unknown) {
          // rescheduleJob throws LeaseLostError when no row matches, which here
          // means someone else already owns the job: benign, nothing to release.
          // Any other error means the handback genuinely failed and the job stays
          // claimed until the reaper takes it, which DOES consume an attempt.
          // These are logged at different levels on purpose; do not collapse them.
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

      await processOneJob(job);
    }
  }

  async function processOneJob(job: ClaimedJob): Promise<JobOutcome> {
    logger.info('Claimed job', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      project_id: job.projectId,
    });

    const controller = new AbortController();
    let heartbeatInFlight = false;

    const heartbeatInterval = setInterval(async () => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      try {
        const stillOwned = await heartbeat(job.id, workerId, job.leaseGeneration, leaseDurationMs);
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
      logger.info('Completed job', { job_id: job.id, error_group_id: job.errorGroupId });
      return 'completed';
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'JobRescheduledError') {
        logger.info('Job rescheduled', { job_id: job.id });
        return 'completed';
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Job failed', {
        job_id: job.id,
        error_group_id: job.errorGroupId,
        error: message,
      });
      try {
        const failed = await failJob(job.id, workerId, job.leaseGeneration, message);
        if (!failed) {
          logger.warn('Failure update rejected: lease lost', {
            job_id: job.id,
            lease_generation: job.leaseGeneration,
          });
        }
      } catch (failErr: unknown) {
        // A failed state transition is not another handler failure. Do not
        // attempt a second transition; the reaper owns recovery from here.
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

  return {
    start(): void {
      // Two concurrent loops would share the single `wake` slot, so one sleep
      // could clear the other's callback, and stop() would await only the most
      // recently stored loop.
      if (loopPromise || abandoned) {
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
      });
      loopPromise = runLoop();
    },

    async stop(): Promise<void> {
      running = false;
      wakeSleep();
      if (loopPromise) {
        logger.info('Waiting for the poll loop to finish');
        // Bounded wait. An in-flight fix job can run for minutes and claimJob
        // can hang on a wedged connection; without a deadline the process sits
        // past the platform's termination grace period and gets SIGKILLed
        // mid-job, which is the outcome the handback exists to avoid. On
        // expiry we leave the job to the reaper rather than issuing an
        // unfenced terminal write from a dying process.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), shutdownGraceMs);
        });
        const result = await Promise.race([loopPromise.then(() => 'clean' as const), deadline]);
        if (timer) clearTimeout(timer);
        if (result === 'timeout') {
          logger.warn('Poll loop did not finish within the shutdown grace period', {
            shutdown_grace_ms: shutdownGraceMs,
          });
          // Deliberately do NOT clear loopPromise here. The loop is still running
          // and may still touch the pool; clearing it would let a later start()
          // create a second loop sharing the single `wake` slot, and would signal
          // to callers that the poller is fully quiesced when it is not. The
          // start() guard keys on loopPromise, so a timed-out poller refuses to
          // restart in-process, which is the safe direction.
          abandoned = true;
          return;
        }
        loopPromise = null;
      }
      logger.info('Poller stopped');
    },
  };
}
```

Add `rescheduleJob` to the import at `poller.ts:2`:

```ts
import { claimJob, heartbeat, completeJob, failJob, rescheduleJob, LeaseLostError } from './db.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts
```

Expected: PASS, all tests, including the nine that existed before. `'should poll on recurring interval'` (`poller.test.ts:261`) is the regression anchor for the empty-claim path and must pass **unmodified**. If it now hangs, `stop()` is not resolving the pending sleep.

- [ ] **Step 6: Commit**

Then wire the grace period at the call site in `src/index.ts:1000-1005`, keeping it
below the platform's container termination grace period:

```ts
// Validated like POLL_INTERVAL_MS: an unvalidated NaN here becomes a 0ms deadline,
// so every deploy would abandon its in-flight job instead of waiting for it.
const SHUTDOWN_GRACE_MS_DEFAULT = 25_000;
const SHUTDOWN_GRACE_MS_RAW = parseInt(
  process.env['SHUTDOWN_GRACE_MS'] ?? String(SHUTDOWN_GRACE_MS_DEFAULT), 10);
const SHUTDOWN_GRACE_MS =
  Number.isInteger(SHUTDOWN_GRACE_MS_RAW) &&
  SHUTDOWN_GRACE_MS_RAW >= 1_000 && SHUTDOWN_GRACE_MS_RAW <= 120_000
    ? SHUTDOWN_GRACE_MS_RAW
    : SHUTDOWN_GRACE_MS_DEFAULT;

const poller = createPoller({
  intervalMs: POLL_INTERVAL_MS,
  leaseDurationMs: LEASE_DURATION_MS,
  workerId: WORKER_ID,
  processJob,
  shutdownGraceMs: SHUTDOWN_GRACE_MS,
});
```

**Open question carried from the design doc:** the platform's actual termination
grace period is unverified. 25s is a safe default for a 30s ECS default, but
confirm the real value before deploying and adjust.

**Do not commit yet.** Continue straight to Task 4; the commit happens at the end of Task 5.

---

### Task 4: Jittered backoff on the claim-error path

Without this, a database outage makes the loop spin as fast as Postgres can reject connections.

**Files:**
- Modify: `packages/worker/src/poller.ts`
- Test: `packages/worker/src/__tests__/poller.test.ts`

**Interfaces:**
- Consumes: `interruptibleSleep`, `PollerOptions.random` (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

```ts
it('backs off instead of hot-spinning when claimJob rejects', async () => {
  mockClaimJob.mockRejectedValue(new Error('ECONNREFUSED'));
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({
    intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob,
    random: () => 0.5,           // jitter factor becomes exactly 1.0
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(mockClaimJob).toHaveBeenCalledTimes(1);   // no spin

  await vi.advanceTimersByTimeAsync(1000);         // base 1s, attempt 0
  expect(mockClaimJob).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(2000);         // 2s, attempt 1
  expect(mockClaimJob).toHaveBeenCalledTimes(3);

  await poller.stop();
});

it('resets claim-error backoff after a successful claim', async () => {
  mockClaimJob
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValueOnce(makeJob())
    .mockRejectedValue(new Error('ECONNREFUSED'));
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({
    intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob,
    random: () => 0.5,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);   // first backoff
  await vi.advanceTimersByTimeAsync(2000);   // second backoff, then a job claims and runs
  const callsBeforeReset = mockClaimJob.mock.calls.length;

  // After the success the counter is back to 0, so the next error waits 1s, not 4s.
  await vi.advanceTimersByTimeAsync(1000);
  expect(mockClaimJob.mock.calls.length).toBeGreaterThan(callsBeforeReset);

  await poller.stop();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts -t 'hot-spinning'
```

Expected: FAIL. The loop currently sleeps `intervalMs` on a claim error, so the second call needs 5000ms, not 1000ms.

- [ ] **Step 3: Implement the backoff**

Add near the top of `createPoller`, after the destructure:

```ts
  const random = options.random ?? Math.random;
  const CLAIM_ERROR_BASE_MS = 1_000;
  const CLAIM_ERROR_CAP_MS = 60_000;
  let consecutiveClaimErrors = 0;

  /** Capped exponential backoff with jitter. Jitter is required, not cosmetic:
   *  a fixed delay re-synchronizes the whole fleet into a retry convoy during
   *  a database outage. */
  function backoffMs(attempt: number, baseMs: number, capMs: number): number {
    const raw = baseMs * Math.pow(2, attempt) * (0.5 + random());
    return Math.min(raw, capMs);
  }
```

In `runLoop`, replace the claim-error `catch` body's sleep and add the reset:

```ts
      } catch (err: unknown) {
        logger.error('Failed to claim job', {
          error: err instanceof Error ? err.message : String(err),
          consecutive_claim_errors: consecutiveClaimErrors + 1,
        });
        const delay = backoffMs(consecutiveClaimErrors, CLAIM_ERROR_BASE_MS, CLAIM_ERROR_CAP_MS);
        consecutiveClaimErrors += 1;
        await interruptibleSleep(delay);
        continue;
      }

      consecutiveClaimErrors = 0;
```

Place `consecutiveClaimErrors = 0;` immediately after the `catch` block, so it runs on every successful claim call including one that returns `null`.

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts
```

Expected: PASS, all tests.

**Do not commit yet.** Continue straight to Task 5.

---

### Task 5: Consecutive-failure circuit breaker

The design's C2, and the piece with no counterpart in today's code. When the heartbeat aborts, the job is deliberately left `claimed` with no terminal write, so a systemic failure produces a fast silent loop with no processing time pacing it.

**Files:**
- Modify: `packages/worker/src/poller.ts`
- Test: `packages/worker/src/__tests__/poller.test.ts`

**Interfaces:**
- Consumes: `processOneJob`'s `JobOutcome` return value and `backoffMs` (Tasks 3 and 4).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

```ts
it('pauses after three consecutive non-completions', async () => {
  mockClaimJob.mockResolvedValue(makeJob());
  // Drive the abort through the terminal write, NOT the heartbeat. The heartbeat
  // is a setInterval at leaseDurationMs/3; under advanceTimersByTimeAsync(0) it
  // never fires, so a heartbeat-driven test would silently assert nothing.
  mockCompleteJob.mockResolvedValue(false);   // completion rejected: lease lost
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({
    intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob,
    random: () => 0.5,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);

  // Exactly three jobs get through, then the breaker holds the loop in a sleep.
  expect(processJob).toHaveBeenCalledTimes(3);
  const callsAtTrip = mockClaimJob.mock.calls.length;

  await vi.advanceTimersByTimeAsync(0);
  expect(mockClaimJob.mock.calls.length).toBe(callsAtTrip);   // still paused

  await vi.advanceTimersByTimeAsync(5000);                    // breaker base is intervalMs
  expect(processJob).toHaveBeenCalledTimes(4);

  await poller.stop();
});

it('resets the breaker after one successful completion', async () => {
  mockClaimJob.mockResolvedValue(makeJob());
  mockCompleteJob
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)     // success resets the counter
    .mockResolvedValue(false);
  const processJob = vi.fn<(j: ClaimedJob, s: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

  const poller = createPoller({
    intervalMs: 5000, leaseDurationMs: 30_000, workerId: 'test-worker', processJob,
    random: () => 0.5,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);

  // Without the reset the breaker would trip on job 3. With it, the count goes
  // 1, 2, reset, 1, 2, 3 -> five jobs run before the first pause.
  expect(processJob).toHaveBeenCalledTimes(6);

  await poller.stop();
});

Note on why these drive the abort through `completeJob` returning `false` rather than through the heartbeat: the heartbeat is a `setInterval` at `leaseDurationMs / 3`, and a fake-timer probe confirms it does **not** fire under `advanceTimersByTimeAsync(0)`. A heartbeat-driven version of this test passes while asserting nothing. Aborts, not failures, are the realistic runaway once Task 1's backoff exists, because a failed job is no longer instantly re-claimable.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts -t 'three consecutive'
```

Expected: FAIL. Nothing pauses the loop today, so `claimJob` keeps being called with no timer advance.

- [ ] **Step 3: Implement the breaker**

Add alongside the Task 4 constants:

```ts
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_CAP_MS = 300_000;
  let consecutiveNonCompletions = 0;
```

Replace `await processOneJob(job);` at the end of the loop body with:

```ts
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
```

Rationale for counting aborts and failures together: from the loop's position an abort storm and a fail storm are indistinguishable, and pausing on either is safe. Without this, a down MinIO walks the whole backlog into abandoned-claimed state, the reaper then increments `attempts` on all of it, and the dead-letter path writes customer-visible "Unchecked friction" incidents that a code revert does not remove.

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

This is the commit for Tasks 3, 4, and 5 together. Verify the whole unit suite passes
first, then:

```bash
cd packages/worker && pnpm vitest run src/__tests__/poller.test.ts
```

```bash
git add packages/worker/src/poller.ts packages/worker/src/index.ts packages/worker/src/__tests__/poller.test.ts
git commit -m "perf(worker): drain the queue instead of claiming one job per tick

tick() claimed at most one job per 5s firing and skipped entirely while a job was
active, capping one worker at 720 jobs/hour regardless of job cost. Replace
setInterval with a single awaited loop that sleeps only on an empty claim or a
claim error, and move shutdown from awaiting one job to awaiting the loop.

The 5s tick was also the only thing pacing retries and bounding failure blast
radius, so the claim-error backoff and the consecutive-non-completion circuit
breaker land in the same commit rather than as follow-ups: a build containing the
loop without them hot-spins against a failing database and walks the backlog into
abandoned-claimed state during an outage."
```

---

### Task 6: Queue-age and claim-rate on `/health`

The design pulls this into M1 rather than M2: shipping an irreversible change before the instrument that detects its failure is backwards. `/health` currently returns 200 while claims are fully stalled.

**Files:**
- Modify: `packages/worker/src/index.ts:113-115` (counters), `packages/worker/src/index.ts:975-995` (handler), `packages/worker/src/db.ts` (one new query)
- Test: `packages/worker/src/__tests__/db.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getQueueDepth(): Promise<Array<{ jobType: string; eligible: number; backedOff: number; oldestEligibleSeconds: number | null }>>` exported from `db.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('reports eligible and backed-off depth separately per job type', async () => {
  await seedPendingJob({ jobType: 'session_analysis', availableAt: new Date(Date.now() - 60_000) });
  await seedPendingJob({ jobType: 'session_analysis', availableAt: new Date(Date.now() + 600_000) });

  const depth = await getQueueDepth();
  const row = depth.find((d) => d.jobType === 'session_analysis');
  expect(row?.eligible).toBe(1);
  expect(row?.backedOff).toBe(1);
  expect(row?.oldestEligibleSeconds).toBeGreaterThanOrEqual(59);
});
```

Add a `seedPendingJob({ jobType, availableAt })` helper next to the existing seeding helpers in `db.test.ts` if one does not exist; it inserts a row with `status='pending'` and the given `available_at`.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/worker
DATABASE_URL="$DATABASE_URL" pnpm vitest run src/__tests__/db.test.ts -t 'eligible and backed-off'
```

Expected: FAIL with `getQueueDepth is not a function`.

- [ ] **Step 3: Implement the query**

Add to `src/db.ts`:

```ts
export interface QueueDepthRow {
  jobType: string;
  eligible: number;
  backedOff: number;
  oldestEligibleSeconds: number | null;
}

/** Queue shape by job type. Backed-off rows stay 'pending', so eligible and
 *  scheduled are counted separately: a queue that looks deep may be entirely
 *  waiting on retry windows. Sampled on a timer, never per claim. */
export async function getQueueDepth(): Promise<QueueDepthRow[]> {
  const { rows } = await getPool().query<{
    job_type: string;
    eligible: string;
    backed_off: string;
    oldest_eligible_seconds: string | null;
  }>(
    `SELECT job_type,
            count(*) FILTER (WHERE available_at <= now())::text AS eligible,
            count(*) FILTER (WHERE available_at >  now())::text AS backed_off,
            EXTRACT(EPOCH FROM (now() - min(created_at)
              FILTER (WHERE available_at <= now())))::text AS oldest_eligible_seconds
       FROM error_group_jobs
      WHERE status = 'pending'
      GROUP BY job_type`
  );
  return rows.map((r) => ({
    jobType: r.job_type,
    eligible: Number(r.eligible),
    backedOff: Number(r.backed_off),
    oldestEligibleSeconds:
      r.oldest_eligible_seconds === null ? null : Math.round(Number(r.oldest_eligible_seconds)),
  }));
}
```

- [ ] **Step 4: Sample it on a timer and expose it**

In `src/index.ts`, next to the existing counters at `:113-115`:

```ts
let claimsLastMinute = 0;
let claimRatePerMinute = 0;
let queueDepth: QueueDepthRow[] = [];
```

In `main()`, next to the other timers (near the reaper at `:1009`):

```ts
  // Sampled on a timer, never per claim: the aggregate scans the pending set
  // and the drain loop claims far too often to pay for it each time.
  const queueSampleTimer = setInterval(() => {
    claimRatePerMinute = claimsLastMinute;
    claimsLastMinute = 0;
    getQueueDepth()
      .then((depth) => { queueDepth = depth; })
      .catch((err: unknown) => {
        logger.error('Queue depth sample failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, 60_000);
```

Track the in-flight sample so shutdown cannot close the pool underneath it:

```ts
let queueSampleInFlight: Promise<void> = Promise.resolve();
```

and assign it inside the timer body (`queueSampleInFlight = getQueueDepth().then(...)`).

In `shutdown()`, add `clearInterval(queueSampleTimer);` alongside the other `clearInterval`
calls at `:1073-1075`, and `await queueSampleInFlight;` **before** `await closePool();`.
`clearInterval` stops future samples but does nothing about a query already running, and
`closePool()` under a live query throws on shutdown.

Count claims at the **claim boundary inside the poller**, not at handler entry and not
beside the existing `jobsProcessed++` / `jobsFailed++` sites. Those sites measure handler
outcomes: they miss a claim that is handed back at shutdown, loses its lease, or hangs,
which is exactly the stalled-worker case this metric exists to reveal.

Add an optional callback to `PollerOptions` in `src/poller.ts`:

```ts
  /** Fired once per successful claim, before processing. Metrics only. */
  onClaim?: (job: ClaimedJob) => void;
```

destructure it (`const { ..., onClaim } = options;`) and call it in `runLoop` immediately
after a non-null claim and **before** the `if (!running)` handback branch, so the counter
means "claims that succeeded" rather than "claims that led to work". A handed-back claim
still proves the claim path is alive, which is exactly what the stall check reads:

```ts
      if (job) {
        // Metrics must never break the loop.
        try { onClaim?.(job); } catch { /* ignore */ }
      }

      if (!running) {
        // ... handback, unchanged
      }
```

Then in `src/index.ts`, pass it at the `createPoller` call site:

```ts
  onClaim: () => { claimsLastMinute++; },
```

Extend the `/health` JSON body at `:983-990`:

```ts
        worker_id: WORKER_ID,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        jobs_processed: jobsProcessed,
        jobs_failed: jobsFailed,
        last_job_at: lastJobAt,
        claims_per_minute: claimRatePerMinute,
        queue_depth: queueDepth,
        status: isStalled() ? 'stalled' : 'ok',
```

with, next to the counters:

```ts
/** Work is eligible, nothing was claimed for a full sample window, and nothing is
 *  being worked on. All three conditions are required: a single multi-minute fix
 *  job legitimately produces zero claims across several windows while the queue
 *  still holds eligible work, and flagging that as a stall would fire on healthy
 *  operation and train everyone to ignore the field. */
function isStalled(): boolean {
  const eligible = queueDepth.reduce((n, d) => n + d.eligible, 0);
  return eligible > 0 && claimRatePerMinute === 0 && jobsInFlight === 0;
}
```

`jobsInFlight` is tracked in the one place every job passes through, the exported
`processJob` at `index.ts:154`:

```ts
let jobsInFlight = 0;

export async function processJob(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  jobsInFlight++;
  try {
    await withJobTrace(job.id, job.errorGroupId ?? job.sourceId ?? 'unknown', job.projectId,
      () => processJobInner(job, signal));
  } finally {
    jobsInFlight--;
  }
}
```

**Deliberately still HTTP 200.** Returning non-200 would make ECS or the load balancer kill
the task, and the two cases this flag covers most often are a database outage and a
circuit-breaker pause, where killing and rescheduling the worker makes things worse. The
field is for alerting; the status code stays a liveness signal.

Import `getQueueDepth` and the `QueueDepthRow` type from `./db.js` at the top of `index.ts`.

- [ ] **Step 5: Run the tests and build**

```bash
cd packages/worker
pnpm --filter @opslane/worker build
DATABASE_URL="$DATABASE_URL" pnpm vitest run src/__tests__/db.test.ts
```

Expected: PASS, 0 skipped.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/poller.ts packages/worker/src/db.ts packages/worker/src/index.ts packages/worker/src/__tests__/db.test.ts
git commit -m "feat(worker): report queue age and claim rate on /health

The endpoint returned 200 while claims were fully stalled, which is how the
720/hour ceiling went unnoticed for eight hours."
```

---

### Task 7: Real-Postgres integration coverage

Proves the operational claims that mocked, fake-timer unit tests cannot.

**Files:**
- Modify: `packages/worker/src/__tests__/poller.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Add to the existing `describeDb` block:

```ts
**Before writing these, fix a fixture leak in the existing helper.** `seedInvestigateJob`
(`poller.integration.test.ts:34-50`) creates a fresh org *and* project on every call and
overwrites the module-level `orgId` / `projectId`, while `afterEach` (`:88-96`) deletes only
the last pair. Calling it ten times leaves nine orphaned org/project trees behind. Add a
helper that seeds N jobs under **one** project:

```ts
async function seedJobsInOneProject(count: number): Promise<string[]> {
  const { groupId, jobId } = await seedInvestigateJob();   // creates org + project once
  const ids: string[] = [jobId];                           // include the first job
  for (let i = 0; i < count - 1; i += 1) {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO error_group_jobs (error_group_id, project_id, status, job_type, attempts, max_attempts)
       VALUES ($1, $2, 'pending', 'investigate', 0, 3) RETURNING id`, [groupId, projectId]);
    ids.push(job.rows[0]!.id);
  }
  return ids;
}
```

```ts
it('drains a seeded backlog without waiting a poll interval per job', async () => {
  const jobIds = await seedJobsInOneProject(10);

  const poller = createPoller({
    intervalMs: 5000, leaseDurationMs: 30_000,
    workerId: 'drain-it', processJob: makeProcessJob(),
  });
  const started = Date.now();
  poller.start();
  await waitFor(async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM error_group_jobs
        WHERE id = ANY($1) AND status = 'completed'`, [jobIds]);
    return Number(rows[0]!.n) === 10;
  }, 10_000);
  const elapsed = Date.now() - started;
  await poller.stop();

  // Serial ticks would need at least 9 * 5000ms between the ten jobs.
  expect(elapsed).toBeLessThan(5000);
});

it('leaves no claimed job behind after stop() resolves', async () => {
  await seedInvestigateJob();
  const poller = createPoller({
    intervalMs: 50, leaseDurationMs: 30_000,
    workerId: 'shutdown-it', processJob: makeProcessJob(),
  });
  poller.start();
  await poller.stop();

  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM error_group_jobs
      WHERE worker_id = 'shutdown-it' AND status = 'claimed'`);
  expect(Number(rows[0]!.n)).toBe(0);
});

it('does not re-claim a failed job before its backoff window elapses', async () => {
  const { jobId } = await seedInvestigateJob();
  const poller = createPoller({
    intervalMs: 50, leaseDurationMs: 30_000, workerId: 'backoff-it',
    processJob: async () => { throw new Error('boom'); },
  });
  poller.start();
  // Wait for attempts to reach 1, NOT for status === 'pending': the job is seeded
  // pending, so a status-only wait can succeed before the poller claims anything
  // and the test would pass without exercising a retry at all.
  await waitFor(async () => {
    const { rows } = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM error_group_jobs WHERE id = $1`, [jobId]);
    return rows[0]!.attempts === 1;
  }, 5000);
  // Then give the loop a full second to misbehave: without backoff it would burn
  // all three attempts and dead-letter almost immediately.
  await sleep(1000);
  await poller.stop();

  const { rows } = await pool.query<{ attempts: number; status: string }>(
    `SELECT attempts, status FROM error_group_jobs WHERE id = $1`, [jobId]);
  expect(rows[0]!.attempts).toBe(1);
  expect(rows[0]!.status).toBe('pending');
});
```

- [ ] **Step 2: Run them**

```bash
cd packages/worker
OPSLANE_RELIABILITY_DB_TESTS=1 DATABASE_URL="$DATABASE_URL" \
  pnpm vitest run src/__tests__/poller.integration.test.ts
```

Expected: PASS, **0 skipped**. If the run reports `skipped`, one of the two gate variables is unset and the run proved nothing.

The third test is the direct regression test for the retry storm and **fails on `main`**: without Task 1, `attempts` reaches 3 within the first second.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/__tests__/poller.integration.test.ts
git commit -m "test(worker): cover backlog drain, shutdown handback, and retry spacing against real Postgres"
```

---

### Task 8: Documentation and the stale comment

Three places drift from the code without this, and one of them actively misleads.

**Files:**
- Modify: `packages/worker/src/db.ts:110-113`, `packages/worker/AGENTS.md`, `docs/reference/environment-variables.md:74,77`, `docker-compose.yml:140`

**Interfaces:** none.

- [ ] **Step 1: Correct the advisory-lock comment**

`db.ts:110-113` currently justifies the global advisory lock with a premise this change invalidates:

> Claims are millisecond-scale single-row updates against multi-second poll intervals, so the serialization is not a throughput concern.

Replace that sentence with:

```
 * Admission is serialized fleet-wide, so claim latency bounds total claim
 * throughput. Measured at 4.05ms with 4k rows pending (the ORDER BY CASE
 * matches no index, so every claim sorts the whole eligible set), giving a
 * ceiling near 250 claims/sec that degrades linearly with backlog depth. A
 * drain-looping worker claims at roughly 1/job-duration, so the margin is
 * wide at current fleet size. Re-measure with EXPLAIN (ANALYZE, BUFFERS)
 * before scaling the fleet or letting the pending set grow much larger.
```

- [ ] **Step 2: Record the fleet-cap coupling for the deploy workstream**

Append to the "Contracts" section of `packages/worker/AGENTS.md`:

```markdown
- `SESSION_ANALYSIS_MAX_CONCURRENT` is a **fleet-wide** cap on concurrently claimed
  `session_analysis` jobs, not a per-process one, and it defaults to 2. A serial worker
  holds at most one analysis lease, so raising it buys no throughput at fleet size 1 and
  horizontal scaling stops paying off past two workers until it is raised. It also counts
  zombie leases for up to `LEASE_DURATION_MS`, so at the default two crashed workers can
  block the whole fleet's analysis lane for five minutes.
- `POLL_INTERVAL_MS` is the empty-queue wait, not a claim cadence: the poller drains
  continuously while work exists. It no longer throttles throughput under load.
```

- [ ] **Step 3: Update the environment variable reference**

In `docs/reference/environment-variables.md`, change the `POLL_INTERVAL_MS` row (line 74) so the description reads `How long the worker waits when the queue is empty (it drains continuously while work exists)`, and extend the `SESSION_ANALYSIS_MAX_CONCURRENT` row (line 77) with `; raising it has no effect at fleet size 1`.

- [ ] **Step 4: Raise the fleet cap in the Compose default**

The design requires the cap to be raised in the same deploy, and it is currently a
default of 2 in `db.ts:87` with no Compose override. Add an explicit value to the
worker service in `docker-compose.yml` next to `POLL_INTERVAL_MS` (line 140):

```yaml
      SESSION_ANALYSIS_MAX_CONCURRENT: "8"
```

**8 is a placeholder that must be replaced with a value derived from Task 0.** Size it as
the smaller of two bounds, not from the 0.7s blended mean:

```
cap_throughput = ceil(target_jobs_per_hour * p95_seconds / 3600)
cap_quota      = floor(anthropic_requests_per_minute
                       / (model_calls_per_job * 60 / p95_seconds))
cap            = max(2, min(cap_throughput, cap_quota))
```

`model_calls_per_job` comes from `promotion.ts:65-198`, which issues one call per
fold-eligible signal plus a bucket call at threshold. If the quota bound is the binding
one, raising the cap converts a queue backlog into provider 429s, which the retry backoff
from Task 1 will then space out rather than eliminate. Do not commit this step until Task 0's numbers exist. Note that
this changes nothing at fleet size 1, where a serial worker holds at most one analysis
lease; it matters when the deploy repo scales out, and it stops two crashed workers from
blocking the whole fleet's analysis lane for a full `LEASE_DURATION_MS`.

- [ ] **Step 5: Verify the full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: all green. Per the root `AGENTS.md`, confirm the Go suite reports **zero skips**; it prints `ok` while roughly 30 storage tests never run if the MinIO environment is incomplete.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/db.ts packages/worker/AGENTS.md docs/reference/environment-variables.md docker-compose.yml
git commit -m "docs(worker): correct the advisory-lock rationale and record the fleet-cap coupling"
```

---

## What you need before starting

Execution stalls without these, so confirm them up front rather than discovering them at Task 0 or Task 7:

- Read access to the production database for Task 0, and permission to comment on issue #260.
- A migrated Postgres for `DATABASE_URL`, plus `OPSLANE_RELIABILITY_DB_TESTS=1`, or Tasks 1, 6, and 7 silently skip and prove nothing.
- MinIO credentials and the free-port triple from the root `AGENTS.md` for the live smoke, exported as a unit with their derived URLs.
- The platform's real container termination grace period, which sets `SHUTDOWN_GRACE_MS`. 25s assumes a 30s default and is unverified.
- The `superpowers` skills referenced in the header are optional. If they are not installed, execute the tasks in order and ignore the banner.

## Before opening the PR

- [ ] Run the live pipeline smoke from the root `AGENTS.md`: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion and worker, post an event to `$INGESTION_URL/api/v1/events`, and confirm the job reaches its expected terminal state. From a worktree, export the free-port triple **and** the derived URLs together, or Go DB tests fall back to `localhost:5434` and skip.
- [ ] Edit issue #260 to remove the claim that this fixes "a single multi-minute investigate/fix job blocks all session analysis." A serial drain loop still runs one job at a time. Leaving it in the acceptance criteria guarantees the issue is reopened.
- [ ] Confirm with the deploy workstream that `SESSION_ANALYSIS_MAX_CONCURRENT` is raised in the same deploy, and that the raised value was chosen from M0's p95/p99 and the Anthropic request/token quota rather than from the 0.7s blended mean.
- [ ] Deploy to one worker and hold before rolling the fleet. If it misbehaves, **revert the Task 3-5 commit only** and leave Task 1 in place: the database retry backoff is harmless without the loop, and reverting it during a rollback would re-expose the retry storm at exactly the moment the system is already unhealthy. This is why the two are separate commits and why Task 1 goes first.

## Out of scope

Carried from the design doc so nobody adds them mid-implementation:

- In-process concurrency (D-1, reopens only if M0's percentiles show a heavy tail)
- Per-project fairness or spend budgets in `claimJob`
- `LISTEN/NOTIFY` for idle-queue latency
- The `sessions.go` late-chunk re-enqueue debounce
- Fleet sizing and autoscaling
