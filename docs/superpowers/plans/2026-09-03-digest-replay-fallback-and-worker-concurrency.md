# Digest Replay Fallback and Worker Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A digest card links a replay whenever the incident's bounded watchable lookup can find a covered recording anywhere in its history (the same guarantee the incident page gives today), and a single worker process can work several jobs at once so session analysis stops running hours behind the sessions.

**Architecture:** Two independent fixes. (1) The digest's replay lookup currently refuses recordings from before the incident's current waiting spell (`actionable_since`); one shared helper gains a fallback that retries without the floor when the floored lookup finds nothing, applied to both digest surfaces in one commit. (2) The worker's poll loop is strictly serial — one job at a time across every job type — so a morning burst of `session_analysis` jobs backs up for hours; `createPoller` gains a `concurrency` option (default 1, so nothing changes until an operator opts in) that runs N claim loops against the same advisory-lock-serialized claim path.

**Tech Stack:** Go (ingestion digest package, pgx), TypeScript (worker poller, vitest).

**Spec:** The Background section below. It is the prod diagnosis of 2026-09-03 (incident id redacted; no separate spec document exists).

## Background (the spec)

Prod, 2026-09-03: the delivered digest's first card had no Watch replay button. Diagnosis:

- The digest offers a replay only from the incident's **current waiting spell** — the freeze passes `actionable_since` as a floor into `WatchableSessionForGroupOn` (`packages/ingestion/digest/freeze.go:167`; the receipts lane does the same at `packages/ingestion/digest/validate.go:923-927`).
- The incident became actionable at 06:29 UTC; the digest froze at 09:01. The one in-spell session's recording was scrubbed and coverage-complete by 07:58, but its `friction_signals` row was only written at **09:36**: session analysis ran ~1.5-2h behind the sessions.
- **The incident had dozens of accepted, covered signals from previous days already in the database at freeze time** (verified live: 36 of its 50 unfloored candidates passed the coverage span probe). Only the floored, in-spell pool was empty. An unfloored fallback at 09:01 would therefore have produced a button. The fallback fixes the observed failure; the concurrency half shrinks the analysis lag that made the spell pool empty in the first place. Neither depends on the other.
- The analysis lag is structural: `runLoop` in `packages/worker/src/poller.ts:187` claims and processes exactly one job at a time across all job types. `SESSION_ANALYSIS_MAX_CONCURRENT` (fleet-wide claim-side cap, default 2, `packages/worker/src/db.ts:544-552`) is not the binding constraint at one replica; the serial loop is.

Decisions (user, 2026-09-03): do **both**. An in-spell recording is still preferred; the fallback only fires when the floored lookup finds nothing.

What the fallback deliberately does NOT guarantee: `WatchableSessionForGroupOn` bounds its candidate pool (50 friction signals / a bounded per-session set for errors) **before** the coverage probes run, so an incident whose earliest 50 signals are all uncovered can still miss a covered later recording. That is today's behavior on every surface (incident page included) and stays out of scope; the digest simply stops being *stricter* than the page.

## Global Constraints

- Default behavior is unchanged everywhere: `concurrency` defaults to 1; the replay fallback fires only when the floored lookup returns no session and the floor is non-zero.
- An in-spell recording always wins over a pre-spell one; the fallback must never replace a floored hit.
- Both replay surfaces change in ONE commit through one shared helper (`watchableSessionAnySpell`), so the two surfaces cannot drift even at a bisect point.
- Unfloored lookups are an already-shipped pattern (`replayURLFor`, `packages/ingestion/digest/build.go:397`) AND index-bounded: migration `046_impact_query_index.sql` ships `idx_friction_signals_incident_occurred` on `(incident_id, occurred_at)` partial on exactly the friction query's predicates (`accepted`, not retracted, not superseded), and `idx_error_events_group_timestamp` for the error path — the unfloored `ORDER BY occurred_at ASC LIMIT 50` is an ordered index walk, not a history sort. **Measured, not just argued:** `EXPLAIN (ANALYZE, BUFFERS)` of this exact unfloored query ran against prod on 2026-09-03 for the incident that motivated this plan (101 accepted signals at query time) shows `Bitmap Index Scan on idx_friction_signals_incident_occurred`, 4.9ms total execution — see `docs/superpowers/evidence/2026-09-03-watchable-query-explain.txt`. The fallback adds one extra such query per candidate, only on a miss, on lanes capped at `DigestV4CardCap` (9) cards and the bounded receipts list.
- `SESSION_ANALYSIS_MAX_CONCURRENT` (and the narrative/frames caps) are enforced inside `claimJob`, whose admission is serialized fleet-wide by a transaction-scoped advisory lock precisely so simultaneous claimers cannot overshoot a cap (`packages/worker/src/db.ts:573-582`, with a measured ~250 claims/sec ceiling). N in-process loops are just N claimers; do not touch that mechanism.
- Preserve terminal-status and lease contracts (root `AGENTS.md` guardrail); `stop()` still returns within `shutdownGraceMs`. The circuit breaker only sleeps a loop; nothing but `stop()` assigns `running = false` (`poller.ts:280`), and that stays true.
- The worker's pg pool uses the driver default of 10 connections (`db.ts:32-38`, no `max` set) — confirmed against prod's real config (`~/deploy/scripts/bootstrap-app-role.sh:185` builds a plain `postgres://user@host:port/db` with no pool-size query param, and terraform/SSM carry no override), not just the code default. `claimJob` HOLDS a checked-out client while it waits on the fleet-wide advisory lock (`db.ts:593` onward). N unserialized claim loops could therefore park up to N connections on one lock and starve heartbeats. Claims are already serialized fleet-wide by that lock, so serializing them **in-process** costs zero throughput: the poller runs all claims through one promise-chain mutex, and at most ONE pool connection per process is ever parked on claiming.
- `WORKER_CONCURRENCY` (new env) is clamped to integers 1-16. Any invalid raw value (`0`, negatives, fractions, non-numeric) falls back to 1 and any oversize value clamps to 16 — both with a warning log naming the rejected raw value, following the existing config-warning pattern in `index.ts`.
- No new dependencies. Worker and ingestion stay AGPL-3.0-only.
- Verification: focused package checks per task, then Task 5's full repo gate AND the live pipeline smoke the root `AGENTS.md` requires for pipeline changes.

---

### Task 1: The replay fallback, both surfaces, one commit

**Files:**
- Modify: `packages/ingestion/digest/digest.go` (add helper next to `replayURLFor`, ~line 64)
- Modify: `packages/ingestion/digest/freeze.go:167` (call the helper)
- Modify: `packages/ingestion/digest/validate.go:915-928` (call the helper; rewrite the floor comment)
- Test: `packages/ingestion/digest/freeze_test.go`, `packages/ingestion/digest/validate_actionable_test.go`

**Interfaces:**
- Consumes: `ingestiondb.WatchableSessionForGroupOn(ctx, q, groupID, projectID, since)` (`packages/ingestion/db/sessions_read.go:529`) — `since == time.Time{}` means unfloored.
- Produces: `watchableSessionAnySpell(ctx context.Context, q ingestiondb.RowQuerier, groupID, projectID string, floor time.Time) (sessionID string, anchorMs int64, ok bool, err error)`.

- [ ] **Step 1: Write the failing freeze tests**

Append to `freeze_test.go` (helpers `seedDigestFixture`, `seedActionableGroup`, `seedFreezeReplay`, `quietBackgroundActionable`, `cleanupActionableDiagnoses` already exist in this package). Note both tests assert the exact seeded session id, not just non-emptiness:

```go
// A young spell has no covered recording yet, but the incident's history does.
// The freeze must fall back to the older recording instead of shipping a card
// with no replay: older evidence of the same behavior beats none.
func TestFreezeFallsBackToAPreSpellRecording(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, episodeID := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-3*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	preSpell := "prespell-" + uuid.NewString()
	// The only covered recording is anchored two hours ago...
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, preSpell, now.Add(-2*time.Hour))
	// ...and the current spell started one hour ago, after that recording.
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	wantAnchor := now.Add(-2 * time.Hour).UnixMilli()
	if candidates[0].ReplaySessionID != preSpell || candidates[0].ReplayAnchorMs != wantAnchor {
		t.Fatalf("replay = %q@%d, want the pre-spell session %q@%d",
			candidates[0].ReplaySessionID, candidates[0].ReplayAnchorMs, preSpell, wantAnchor)
	}
}

// When the current spell has its own covered recording, the fallback must not
// replace it with an older one.
func TestFreezePrefersTheInSpellRecording(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, episodeID := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-3*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	inSpell := "inspell-" + uuid.NewString()
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, "prespell-"+uuid.NewString(), now.Add(-2*time.Hour))
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, inSpell, now.Add(-30*time.Minute))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].ReplaySessionID != inSpell {
		t.Fatalf("replay = %q, want the in-spell session %q", candidates[0].ReplaySessionID, inSpell)
	}
}
```

- [ ] **Step 1b: Write the failing FRICTION-path freeze test**

Production failed through `friction_signals`, which selects a different SQL query than the error path (`sessions_read.go:538-541`), so one fallback test must travel it. Add this helper and test to `freeze_test.go`:

```go
// seedFrictionReplay is seedFreezeReplay's friction twin: an accepted, live
// friction signal whose session has a covered, scrubbed recording.
func seedFrictionReplay(t *testing.T, pool *pgxpool.Pool, projectID, environmentID, groupID, sessionID string, anchor time.Time) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO sessions
		(id,project_id,environment_id,started_at,last_chunk_at)
		VALUES ($1,$2,$3,$4,$4)`, sessionID, projectID, environmentID, anchor.Add(-time.Minute)); err != nil {
		t.Fatalf("seed friction replay session: %v", err)
	}
	first, last := anchor.Add(-20*time.Second).UnixMilli(), anchor.Add(20*time.Second).UnixMilli()
	if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
		(session_id,seq,project_id,object_key,has_full_snapshot,scrubbed_at,first_event_ms,last_event_ms)
		VALUES ($1,0,$2,$3,true,now(),$4,$5)`, sessionID, projectID, "digest/"+sessionID, first, last); err != nil {
		t.Fatalf("seed friction replay chunk: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO friction_signals
		(project_id,environment_id,incident_id,session_id,signal_type,fingerprint,occurred_at,adjudication_status,rule_version)
		VALUES ($1,$2,$3,$4,'dead_click','fp-'||$4,$5,'accepted',7)`,
		projectID, environmentID, groupID, sessionID, anchor); err != nil {
		t.Fatalf("seed friction replay signal: %v", err)
	}
}

// The production failure was a friction incident: the friction watchable
// query (not the error one) must take the same fallback.
func TestFreezeFallsBackToAPreSpellFrictionRecording(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "friction", "needs_human", now.Add(-3*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	preSpell := "prespell-friction-" + uuid.NewString()
	seedFrictionReplay(t, pool, f.ProjectID, f.EnvID, groupID, preSpell, now.Add(-2*time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].ReplaySessionID != preSpell {
		t.Fatalf("friction replay = %q, want the pre-spell session %q", candidates[0].ReplaySessionID, preSpell)
	}
}
```

(If `friction_signals` has additional NOT NULL columns in the current schema, fill them with fixture literals the same way `seedOnCardGroup` does in `oncard_test.go`; the point of the helper is an `accepted`, live signal joined to a covered session. If the `error_groups` friction seed needs `signal_type`, reuse `seedOnCardGroup`'s pattern.)

- [ ] **Step 2: Write the failing receipts test**

Append to `validate_actionable_test.go` (helpers `publishEmptyWrittenRun`, `renderedEvent` already exist there):

```go
// The receipts lane mirrors the card lane: a spell too young to have its own
// covered recording still links the incident's older one.
func TestActionableReceiptFallsBackToAPreSpellRecording(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	groupID, episodeID := seedActionableGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval", now.Add(-3*time.Hour))
	quietBackgroundActionable(t, pool, fixture.ProjectID, groupID)
	sessionID := "prespell-receipt-" + uuid.NewString()
	seedFreezeReplay(t, pool, fixture.ProjectID, fixture.EnvID, episodeID, sessionID, now.Add(-2*time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DASHBOARD_URL", "https://app.example.com")

	runID := publishEmptyWrittenRun(t, pool, fixture.ProjectID, now)
	payload := renderedEvent(t, pool, runID)
	if len(payload.Digest.ReceiptItems) != 1 {
		t.Fatalf("receipts = %+v, want one", payload.Digest.ReceiptItems)
	}
	if !strings.Contains(payload.Digest.ReceiptItems[0].SessionURL, sessionID) {
		t.Fatalf("receipt session url = %q, want the pre-spell session %s",
			payload.Digest.ReceiptItems[0].SessionURL, sessionID)
	}
}
```

- [ ] **Step 3: Run all three to verify the two fallback tests fail**

Run (with the disposable-stack env from the root `AGENTS.md` exported):
`cd packages/ingestion && go test ./digest -run 'FallsBackToAPreSpell|PrefersTheInSpell' -count=1`

Expected: both `FallsBack` tests FAIL on the missing replay; `PrefersTheInSpell` PASSES (it pins today's floored preference so the fallback cannot regress it).

- [ ] **Step 4: Add the helper and switch both call sites**

In `packages/ingestion/digest/digest.go`, after `replayURLFor`:

```go
// watchableSessionAnySpell prefers a covered recording from the current
// waiting spell, then falls back to the incident's whole history. A spell that
// started this morning often has no analyzed-and-scrubbed session yet; an
// older recording of the same behavior is better evidence than no button.
// Both underlying queries bound their candidate pool before the coverage
// probes run (sessions_read.go), and the unfloored form already runs per
// digest build on the insights lane (build.go), so the fallback costs one
// extra bounded query, only on a miss.
func watchableSessionAnySpell(ctx context.Context, q ingestiondb.RowQuerier, groupID, projectID string, floor time.Time) (string, int64, bool, error) {
	sessionID, anchorMs, ok, err := ingestiondb.WatchableSessionForGroupOn(ctx, q, groupID, projectID, floor)
	if err != nil || ok || floor.IsZero() {
		return sessionID, anchorMs, ok, err
	}
	return ingestiondb.WatchableSessionForGroupOn(ctx, q, groupID, projectID, time.Time{})
}
```

(`digest.go` already imports the `ingestiondb` alias, `context`, and `time`; add whichever is missing.)

In `packages/ingestion/digest/freeze.go:167`, replace the direct call (the savepoint wrapping stays exactly as-is; the helper's second query runs inside the same savepoint):

```go
			if id, anchor, ok, lookupErr := watchableSessionAnySpell(ctx, tx, candidate.IssueID, projectID, replayFloor); lookupErr != nil {
```

In `packages/ingestion/digest/validate.go` (~lines 918-928), replace the floor comment and the call:

```go
			// Prefer a recording from the current spell; fall back to the
			// incident's history when the spell is too young to have one
			// (see watchableSessionAnySpell for why that is bounded).
			replayFloor := time.Time{}
			if candidate.ActionableSince != nil {
				replayFloor = *candidate.ActionableSince
			}
			sessionID, anchorMs, ok, lookupErr := watchableSessionAnySpell(ctx, tx, candidate.GroupID, run.ProjectID, replayFloor)
```

- [ ] **Step 5: Run the digest and handler suites**

Run: `go test ./digest ./handler -count=1`
Expected: PASS, including all three new tests. `TestFreezeCapturesOccurrenceAndReplayFacts` and `TestValidateRepeatsActionableItemUntilHumanActs` must not change behavior (their recordings are in-spell).

- [ ] **Step 6: Commit (one commit, both surfaces)**

```bash
git add packages/ingestion/digest/digest.go packages/ingestion/digest/freeze.go packages/ingestion/digest/validate.go packages/ingestion/digest/freeze_test.go packages/ingestion/digest/validate_actionable_test.go
git commit -m "feat(digest): fall back to a pre-spell recording on both replay surfaces"
```

### Task 2: Concurrency-safe poller internals

This prepares the serial poller for N loops without changing behavior at concurrency 1. Two closure-level hazards go away: the single `wake` slot (`poller.ts:75-93` — a second sleeper overwrites the first, so `stop()` would strand earlier sleepers for their full timer, up to the 60s claim-error cap, past the 25s grace) and the shared backoff counters (`poller.ts:65-66` — one loop's claim errors would trip another loop's circuit breaker).

**Files:**
- Modify: `packages/worker/src/poller.ts:65-100`
- Test: none new in this task — the refactor is pinned by Task 3's multi-loop tests, and the existing `poller.test.ts` suite must stay green. (A single-loop test for these internals passes both before and after the change and would prove nothing; codex review round 1, finding 9.)

**Interfaces:**
- Produces: unchanged public API; Task 3 builds on these internals.

- [ ] **Step 1: Refactor the sleep bookkeeping**

Replace the single `wake` slot with a set of wakers:

```ts
  const wakers = new Set<() => void>();

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
```

- [ ] **Step 2: Make the backoff counters per-loop**

Delete the closure-level `consecutiveClaimErrors` and `consecutiveNonCompletions` (`poller.ts:65-66`) and declare them as locals at the top of `runLoop`:

```ts
  async function runLoop(): Promise<void> {
    let consecutiveClaimErrors = 0;
    let consecutiveNonCompletions = 0;
    while (running) {
```

(Every use of both counters is already inside `runLoop`; the compiler will catch any miss.)

- [ ] **Step 3: Run the poller suite to prove no behavior change**

Run: `cd packages/worker && npx vitest run src/__tests__/poller.test.ts`
Expected: PASS unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/poller.ts
git commit -m "refactor(worker): make the poller's sleep and backoff state per-loop"
```

### Task 3: Concurrency option, clamp, env wiring, and the in-process safety audit

**Files:**
- Modify: `packages/worker/src/poller.ts` (option, N loops, stop over all loops)
- Modify: `packages/worker/src/index.ts:1796-1804` (env, pass through)
- Modify: `docker-compose.yml` worker `environment` block (~line 156, next to `POLL_INTERVAL_MS`)
- Test: `packages/worker/src/__tests__/poller.test.ts`

**Interfaces:**
- Consumes: Task 2's per-loop internals.
- Produces: `PollerOptions.concurrency?: number` (default 1, clamped to integers 1-16); `WORKER_CONCURRENCY` env read in `index.ts` and forwarded by Compose.

- [ ] **Step 1: The in-process safety audit (do this before writing code)**

The option lets every job type run concurrently in one process, so confirm each shared resource is safe and record the answers as a comment on `PollerOptions.concurrency`:

1. `grep -n "^let \|^const .* = \[\]\|^const .* = new Map\|^let .*: " packages/worker/src/*.ts` — list module-level mutable state reachable from `processJob`. Known-safe examples: `index.ts` metrics counters (`claimsLastMinute`) are increment-only; the memoized `pool`/clients are created once and used concurrently by design.
2. The pg pool holds connections per query, not per job, with the driver-default `max: 10` (`db.ts:32-38`); 16 loops cannot deadlock it but can queue on it — that is why the clamp is 16.
3. Expensive lanes stay bounded at claim time by the advisory-lock-serialized caps (`session_analysis`, `narrative`, `frames` — `db.ts:586-591`); the interactive lanes (investigate/fix) have no cap, so `WORKER_CONCURRENCY` is also the operator's bound on concurrent model-heavy investigations. Say exactly that in the option's doc comment.
4. Anything found unsafe gets fixed or documented as a lane cap before this task's commit; if a genuinely unsafe shared resource turns up that cannot be fixed inside this task, stop and surface it rather than shipping the option.

- [ ] **Step 2: Write the failing tests**

Append to `poller.test.ts` inside the `describe('poller', ...)` block (the file already mocks `../db.js`, uses fake timers, and defines `makeJob`):

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/poller.test.ts`
Expected: the concurrency tests FAIL (TypeScript rejects the unknown option, or peak stays 1); `stays serial by default` PASSES.

- [ ] **Step 4: Implement the option**

In `poller.ts`, add to `PollerOptions` (wording carries the Step 1 audit conclusions):

```ts
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
```

Resolve it in `createPoller`, warning on every rejected raw value:

```ts
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
```

Serialize claims in-process so N loops park at most one pool connection on the fleet-wide advisory lock (`claimJob` holds a checked-out client while waiting on it, and the pool max is the driver-default 10):

```ts
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
```

and `runLoop` calls `claimSerially()` where it called `claimJob(workerId, leaseDurationMs)` directly.

Replace the single `loopPromise` with `let loopPromises: Promise<void>[] = []`. In `start()`:

```ts
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
```

In `stop()`, the guard becomes `if (loopPromises.length > 0)` and the race waits on all loops:

```ts
        const result = await Promise.race([
          Promise.all(loopPromises).then(() => 'clean' as const),
          deadline,
        ]);
```

In `index.ts`, next to the other env reads at the `createPoller` call (~line 1796), pass the RAW parsed value through so `createPoller`'s single validation path sees (and warns about) exactly what the operator typed:

```ts
const rawWorkerConcurrency = process.env['WORKER_CONCURRENCY'];
const WORKER_CONCURRENCY =
  rawWorkerConcurrency === undefined || rawWorkerConcurrency === ''
    ? undefined
    : Number(rawWorkerConcurrency);
```

and pass `concurrency: WORKER_CONCURRENCY,` in the options object. Do not sanitize here: an invalid value must reach `createPoller` so its warning names the rejected input (all validation and warnings live in one place, covered once by the unit tests).

In `docker-compose.yml`, add to the worker `environment` block next to `POLL_INTERVAL_MS`:

```yaml
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-1}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/poller.test.ts`
Expected: PASS, all of them.

- [ ] **Step 6: Run the worker suite and compose validation**

Run: `pnpm --filter @opslane/worker build && npx vitest run` (with `DATABASE_URL` on a disposable stack) and `docker compose config --quiet` from the repo root.
Expected: PASS; the integration poller suite exercises single-loop behavior and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/poller.ts packages/worker/src/index.ts packages/worker/src/__tests__/poller.test.ts docker-compose.yml
git commit -m "feat(worker): run N concurrent claim loops behind WORKER_CONCURRENCY"
```

### Task 4: Operator documentation

`docs/reference/environment-variables.md` is the drift-checked source (`check-docs-drift.mjs` counts documented env vars against the code); `.env.example` is what a new operator actually copies. Neither currently mentions `SESSION_ANALYSIS_MAX_CONCURRENT` in `.env.example` even though it already ships in code, and the reference doc's existing row for it is now WRONG once this plan lands (it says raising it "has no effect at fleet size 1," which was true only because the worker was serial).

**Files:**
- Modify: `docs/reference/environment-variables.md:111` (fix the stale `SESSION_ANALYSIS_MAX_CONCURRENT` row; add `WORKER_CONCURRENCY`)
- Modify: `.env.example` (worker section, next to `ANTHROPIC_API_KEY`)
- Modify: `packages/worker/AGENTS.md` (the SESSION_ANALYSIS_MAX_CONCURRENT note)

**Interfaces:** none; prose only.

- [ ] **Step 1: Fix the stale row and add the new one in the reference doc**

Replace the `SESSION_ANALYSIS_MAX_CONCURRENT` row (`environment-variables.md:111`) — the "no effect at fleet size 1" claim becomes false once Task 3 ships:

```markdown
| `SESSION_ANALYSIS_MAX_CONCURRENT` | no (2) | Fleet-wide cap on `session_analysis` jobs running at the same time; `0` prevents workers from starting analysis jobs. Raising it only helps if a worker also runs enough concurrent loops to use the extra room — see `WORKER_CONCURRENCY` |
```

Add a new row directly after it:

```markdown
| `WORKER_CONCURRENCY` | no (1) | How many jobs one worker process runs at once (any job type, mixed). Accepted range 1-16; invalid or out-of-range values log a warning and fall back to 1, or clamp to 16. The simultaneous-analysis ceiling is `min(SESSION_ANALYSIS_MAX_CONCURRENT, replicas × WORKER_CONCURRENCY)`; the uncapped investigate/fix lanes are bounded only by this value times the replica count |
```

- [ ] **Step 2: Add both vars to `.env.example`**

Add to the "Full error-to-PR pipeline (worker)" section (`.env.example:12-26`), after the GitHub credentials block:

```
# How many jobs one worker process runs at once (any type, mixed). 1 keeps
# the worker serial. Session analysis is separately capped fleet-wide by
# SESSION_ANALYSIS_MAX_CONCURRENT below; raising one without the other may
# not speed up analysis. See docs/reference/environment-variables.md.
WORKER_CONCURRENCY=1
SESSION_ANALYSIS_MAX_CONCURRENT=2
```

- [ ] **Step 3: Update the worker AGENTS.md cap note**

Amend the existing `SESSION_ANALYSIS_MAX_CONCURRENT` bullet, removing the now-false "no throughput at fleet size 1" claim:

```markdown
- `SESSION_ANALYSIS_MAX_CONCURRENT` is a **fleet-wide** cap on concurrently claimed
  `session_analysis` jobs, not a per-process one, and it defaults to 2. A worker
  process runs `WORKER_CONCURRENCY` claim loops (default 1, max 16); the ceiling on
  simultaneously running analysis jobs is
  `min(SESSION_ANALYSIS_MAX_CONCURRENT, replicas × WORKER_CONCURRENCY)`, and every
  job type shares the loops. It also counts zombie leases for up to
  `LEASE_DURATION_MS`, so at the default two crashed workers can block the whole
  fleet's analysis lane for five minutes.
```

- [ ] **Step 4: Run the docs checks**

Run: `pnpm docs:map:test && node scripts/check-docs-drift.mjs && node scripts/check-docs-voice.mjs`
Expected: PASS (`check-docs-drift` counts documented env vars against the code; both new/changed vars must be indexed and consistent between `.env.example` and the reference doc).

- [ ] **Step 5: Commit**

```bash
git add docs/reference/environment-variables.md .env.example packages/worker/AGENTS.md
git commit -m "docs: document WORKER_CONCURRENCY and correct the stale fleet-size-1 claim"
```

### Task 5: Full gate and the live pipeline smoke

**Files:** none modified; verification only.

- [ ] **Step 1: Full repository gate**

From the repo root, with the disposable-stack env exported and a clean DB:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: green, zero Go skips (per the root `AGENTS.md`, verify the skip count, and note the known host-environment sdk `debug-id-browser` failure is exempt).

- [ ] **Step 2: Live pipeline smoke with concurrency actually exercised**

The root `AGENTS.md` requires a live smoke for pipeline changes, and one event through one loop proves nothing about concurrency. Boot the compose stack on free ports with `WORKER_CONCURRENCY=4` exported, apply migrations, seed `scripts/seed-e2e.sql`, then:

1. Send at least four events to `$INGESTION_URL/api/v1/events` back-to-back (use `test-fixtures/vue-app`) so four jobs are simultaneously claimable, and assert **overlapping claims** in the worker logs: at least two `Job claimed`-style entries whose processing windows overlap, and a startup line showing `concurrency: 4`.
2. Let at least one job run past a heartbeat interval and confirm its lease heartbeats appear while a sibling job runs.
3. While at least two jobs are still in flight, run `docker compose stop worker` and confirm the graceful path: in-flight jobs complete or are handed back inside the grace period, and nothing mutates after shutdown (no post-stop log writes, no leases left to the reaper unless deliberately timed out).
4. Confirm every seeded job reaches its expected terminal state after restarting the worker.

- [ ] **Step 3: Report**

No commit; record the smoke evidence (job ids, terminal states, overlapping-claim log excerpts) in the PR description, alongside the prod `EXPLAIN` evidence already captured in `docs/superpowers/evidence/2026-09-03-watchable-query-explain.txt` (see Global Constraints).

## Deploy note

After merge, set both `WORKER_CONCURRENCY=4` and `SESSION_ANALYSIS_MAX_CONCURRENT=4` on the worker task (terraform on the deploy machine) or the analysis backlog behavior does not change; the code default deliberately preserves today's serial worker. Raising `WORKER_CONCURRENCY` alone without raising the analysis cap would still throttle analysis at 2 concurrent jobs (the cap is fleet-wide, not per-process), leaving the other 2 of the 4 loops to serve investigate/fix instead — raising both together is the decision (grilled 2026-09-03) so the concurrency headroom actually goes to shrinking the analysis lag this plan exists to fix.

## Codex review round 1 — disposition

Findings 7, 9, 10, 11, 12, 13 accepted (env plumbing into Compose, Tasks folded so multi-loop tests carry the refactor, exact-id asserts, the 1-16 clamp, the min() capacity formula, one commit for both replay surfaces). Finding 6 accepted as Task 3 Step 1's audit. Finding 8 accepted as Task 5. Finding 5 accepted as the Background's explicit non-guarantee and the softened Goal. Finding 1 refuted on the facts: the prod incident had dozens of covered pre-spell signals in the database at freeze time (verified live), so the unfloored fallback does fix the observed failure; the fixture mirrors that state. Finding 2 refuted: `claimJob` serializes admission with a transaction-scoped advisory lock for exactly this race (`db.ts:573-582`). Finding 3 refuted: only `stop()` assigns `running = false` (`poller.ts:280`); the breaker sleeps its own loop. Finding 4 answered by shipped precedent: the unfloored lookup already runs per digest build on the insights lane (`build.go:406`) with LIMIT-bounded pools.

## Codex review round 2 — disposition

Codex confirmed round 1's refutations of findings 2 and 3 against the code and accepted the shipped-precedent half of 4. Round 2 dispositions: **1 (query cost)** resolved with a live measurement, not just index evidence: `EXPLAIN (ANALYZE, BUFFERS)` of the exact unfloored query was run against prod during plan review (2026-09-03) for the incident that motivated this plan, confirming a `Bitmap Index Scan on idx_friction_signals_incident_occurred` at 4.9ms total — see `docs/superpowers/evidence/2026-09-03-watchable-query-explain.txt`. This measurement predates Task 1's implementation, so the risk is closed before any code lands rather than spot-checked after. **2 (pool exhaustion by parked claimers)** accepted — correct catch that `claimJob` holds a client while waiting on the advisory lock; fixed with the in-process claim mutex in Task 3 (free, since claims are already serialized fleet-wide). **3 (friction path untested)** accepted — Task 1 Step 1b adds `seedFrictionReplay` and a friction fallback test. **4 (smoke too weak)** accepted — Task 5 Step 2 now demands overlapping claims, a mid-flight heartbeat, and shutdown with jobs in flight. **5 (lost warning for invalid values)** accepted — validation and warnings collapsed into `createPoller`; `index.ts` passes the raw value; unit tests cover 0, negative, fractional, NaN. **6 (backoff refactor unpinned)** accepted — the claim-rate-ratio test with the injected `random` seam pins per-loop counters. **7 (capacity formula overstated)** accepted — both docs now call the expression a ceiling on simultaneous analysis occupancy and the "raise both together or neither matters" sentence is gone.

## Grill session, 2026-09-03 — decisions and a discovered gap

- Confirmed: claims serialize in-process (Task 3) trading nothing for the connection-starvation fix, since claiming is cheap relative to a job's real work.
- The query-cost risk (round 2 finding 1) was closed with a live prod `EXPLAIN (ANALYZE, BUFFERS)` run during this grill, not deferred to Task 5 — see the updated Global Constraints and the evidence file. Task 5's redundant spot-check step was removed.
- Shipping as one PR (not split by fix), despite the two halves being independently deployable.
- `WORKER_CONCURRENCY=4` AND `SESSION_ANALYSIS_MAX_CONCURRENT=4` at deploy: raising concurrency alone would still throttle analysis at the old cap of 2, wasting half the new headroom on lanes that weren't the point of this plan.
- The 16-loop clamp was re-verified against prod's actual `DATABASE_URL` construction (no pool-size override anywhere in the deploy path), not just the code default.
- Discovered gap, fixed in Task 4: `docs/reference/environment-variables.md` (the drift-checked source) had a now-stale claim that raising `SESSION_ANALYSIS_MAX_CONCURRENT` "has no effect at fleet size 1" — true only while the worker was serial, false once this plan ships. Neither var was in `.env.example`. Task 4 now targets the real reference doc and `.env.example` instead of `self-host.md`.

## Self-review

- Spec coverage: fallback on both replay surfaces (Task 1), concurrency-safe internals and the option (Tasks 2-3), operator docs (Task 4), full gate + live smoke (Task 5). The freeze schedule stays out of scope.
- Placeholder scan: none.
- Type consistency: `watchableSessionAnySpell` signature identical at both call sites; `concurrency` / `WORKER_CONCURRENCY` / clamp bounds identical across Tasks 3-4.
