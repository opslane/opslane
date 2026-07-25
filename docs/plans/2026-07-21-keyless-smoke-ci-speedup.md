# Keyless Smoke CI Speed-Up Implementation Plan

> **Superseded for replay chunks:** the presigned POST and commit flow was replaced by the single-call ingestion upload in `2026-07-24-replay-chunk-upload-r2.md`. This document remains a historical implementation record.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cut the `Keyless smoke E2E` CI job from ~13 minutes to under 5, without losing a single test or weakening a security invariant.

**Architecture:** One test file, `test-e2e/friction-incidents.test.ts`, is 582.8s of the 583.3s vitest run. It performs 13 serial waits for the Go chunk scrubber, each ~44.8s. That latency is two independent delays: a 30s row-eligibility grace in SQL and a 15s scrub tick. The grace is load-bearing security (it outlives a replayable presigned upload policy) and stays exactly as it is. We shorten the tick to 1s in CI only, and let the friction tests backdate their own synthetic chunks so they stop waiting out a window that exists to protect hostile callers.

**Tech Stack:** Go 1.24 (ingestion, pgx), Node 22 + Vitest (test-e2e), Docker Compose, GitHub Actions.

---

## Background: why the grace is untouchable

`packages/ingestion/handler/session.go:21-26`:

```go
const (
	...
	// Scrubbing waits this out because POST policies are replayable until expiry.
	chunkUploadPolicyTTL = 30 * time.Second
)
```

`CommitChunk` sets `uploaded_at` only after `StatObject` proves the object exists (`handler/session.go:325-331`) — but the presigned POST policy issued at `handler/session.go:281` stays valid for its full 30s TTL. A client can overwrite the same object key after commit. Scrubbing inside that window could stamp `scrubbed_at` on a row whose bytes were then replaced with raw, unredacted content.

So: **do not make the 30s grace configurable, and do not shorten it anywhere, including CI.** An earlier revision of this plan proposed exactly that and was rejected in review. If you find yourself adding `SCRUB_GRACE_SECONDS`, stop — you are re-introducing the rejected design.

The 15s tick has no such invariant attached. It is pure scheduling.

---

## Task 1: Extract a pure `resolveInterval` in the scrubber

**Files:**
- Modify: `packages/ingestion/scrubber/scrubber.go:34-40`
- Create: `packages/ingestion/scrubber/interval_test.go`

Modeled on `packages/ingestion/retention/retention.go:34-46`, which has the identical shape. A pure function is testable without live Postgres/MinIO; `RunOnce` is not, because it checks `s.Q`/`s.MinIO` before doing anything else.

**Step 1: Write the failing test**

Create `packages/ingestion/scrubber/interval_test.go`. Note `package scrubber` (internal), matching `scrubber_internal_test.go` — `resolveInterval` is unexported. Do not put this in `scrubber_test.go`, which is `package scrubber_test`.

```go
package scrubber

import (
	"testing"
	"time"
)

// The tick interval is the caller's to choose. It is deliberately NOT bounded
// by the 30s eligibility grace in ClaimUnscrubbedChunks: that grace outlives
// the replayable presigned POST policy (handler.chunkUploadPolicyTTL) and is a
// floor on when a chunk becomes claimable, not a floor on how often we look.
func TestResolveInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"caller's value is honored", 5 * time.Second, 5 * time.Second},
		{"main.go's production argument", 15 * time.Second, 15 * time.Second},
		{"a one-second CI interval is honored", time.Second, time.Second},
		{"an interval above the grace is not clamped", time.Minute, time.Minute},
		{"zero falls back to the default", 0, defaultInterval},
		{"negative falls back to the default", -time.Second, defaultInterval},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveInterval(tt.in); got != tt.want {
				t.Fatalf("resolveInterval(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// defaultInterval must stay reachable, so a future refactor cannot make the
// zero path dead code the way retention's clamp once did.
func TestResolveInterval_DefaultIsReachable(t *testing.T) {
	if got := resolveInterval(0); got != 15*time.Second {
		t.Fatalf("resolveInterval(0) = %v, want 15s", got)
	}
}
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./scrubber/ -run TestResolveInterval -v
```

Expected: FAIL — `undefined: resolveInterval`.

**Step 3: Write the minimal implementation**

In `packages/ingestion/scrubber/scrubber.go`, add above `Start`:

```go
// resolveInterval picks the tick interval for Start. Only a non-positive
// interval is overridden. The 30s eligibility grace in ClaimUnscrubbedChunks is
// a separate and deliberately non-configurable floor: it outlives the
// replayable presigned POST policy (handler.chunkUploadPolicyTTL), so it must
// not be bound to, or shortened alongside, the tick rate.
func resolveInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultInterval
	}
	return interval
}
```

Then replace the inline branch at the top of `Start`:

```go
func (s *Scrubber) Start(ctx context.Context, interval time.Duration) {
	interval = resolveInterval(interval)
	if s.MaxInflateBytes <= 0 {
		s.MaxInflateBytes = defaultMaxInflate
	}
```

(The `if interval <= 0 { interval = defaultInterval }` lines go away; the `MaxInflateBytes` guard stays.)

**Step 4: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./scrubber/ -run TestResolveInterval -v
```

Expected: PASS, 8 subtests.

**Step 5: Commit**

```bash
git add packages/ingestion/scrubber/scrubber.go packages/ingestion/scrubber/interval_test.go
git commit -m "refactor(ingestion): extract resolveInterval in the chunk scrubber"
```

---

## Task 2: Read `SCRUB_INTERVAL_SECONDS` in main.go

**Files:**
- Modify: `packages/ingestion/main.go:193-198`

Follow the `RETENTION_SWEEP_INTERVAL_SECONDS` idiom that already lives ~10 lines below in the same block. Do not invent a different parsing style.

**Step 1: Make the change**

Replace:

```go
	if minioClient != nil {
		s := &scrubber.Scrubber{Q: queries, MinIO: minioClient}
		go s.Start(context.Background(), 15*time.Second)
		slog.Info("chunk scrubber started")
```

with:

```go
	if minioClient != nil {
		s := &scrubber.Scrubber{Q: queries, MinIO: minioClient}
		// Only the tick rate is tunable. The 30s eligibility grace in
		// ClaimUnscrubbedChunks stays fixed: it outlives chunkUploadPolicyTTL,
		// so shortening it would let a replayed upload swap raw bytes under an
		// already-scrubbed row.
		scrubInterval := 15 * time.Second
		if v := os.Getenv("SCRUB_INTERVAL_SECONDS"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				scrubInterval = time.Duration(parsed) * time.Second
			}
		}
		go s.Start(context.Background(), scrubInterval)
		slog.Info("chunk scrubber started", "interval", scrubInterval.String())
```

`os`, `strconv`, and `time` are all already imported in this file.

**Step 2: Verify it builds and the package still tests green**

```bash
cd packages/ingestion && go build ./... && go vet ./... && go test ./scrubber/ ./retention/
```

Expected: no output from build/vet, PASS from both test packages.

**Step 3: Commit**

```bash
git add packages/ingestion/main.go
git commit -m "feat(ingestion): make the chunk scrub tick configurable via SCRUB_INTERVAL_SECONDS"
```

---

## Task 3: Plumb the variable through Compose and the CI lane

**Files:**
- Modify: `docker-compose.yml` (ingestion service `environment:`)
- Modify: `.github/workflows/ci.yml` ("Boot the stack without an LLM key" step)

**Step 1: Add the passthrough to Compose**

In the `ingestion` service's `environment:` map, next to the other passthroughs (e.g. after `INTERNAL_READ_TOKEN`):

```yaml
      # Test lanes shorten the scrub tick. The 30s eligibility grace is NOT
      # tunable and is not shortened here; see handler.chunkUploadPolicyTTL.
      SCRUB_INTERVAL_SECONDS: ${SCRUB_INTERVAL_SECONDS:-}
```

Empty default means unset, which means 15s. Local `docker compose up` is unaffected.

**Step 2: Set it in the keyless lane**

In `.github/workflows/ci.yml`, the "Boot the stack without an LLM key" step already has an `env:` block containing `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS`. Add:

```yaml
          # The friction suites wait on the chunk scrubber 13 times. A 1s tick
          # removes up to 15s from each wait. The 30s eligibility grace is
          # deliberately left at its production value; the tests fast-forward
          # their own fixtures instead (see makeChunksScrubbable).
          SCRUB_INTERVAL_SECONDS: "1"
```

**Step 3: Validate the Compose file**

```bash
docker compose config --quiet
```

Expected: no output, exit 0.

```bash
SCRUB_INTERVAL_SECONDS=1 docker compose config | grep -A1 SCRUB_INTERVAL
```

Expected: shows `SCRUB_INTERVAL_SECONDS: "1"` under the ingestion service.

**Step 4: Commit**

```bash
git add docker-compose.yml .github/workflows/ci.yml
git commit -m "ci: run the keyless lane with a 1s chunk scrub tick"
```

---

## Task 4: Let the friction tests fast-forward their own chunks

**Files:**
- Modify: `test-e2e/helpers.ts` (add helper near `waitForScrubbedChunks`, line ~633)
- Modify: `test-e2e/friction-incidents.test.ts:136-141`
- Modify: `test-e2e/friction-smoke.test.ts:91-92`

This is the larger half of the win: it removes the 30s grace from each of the 13 waits without changing what the grace means for anyone else.

**Step 1: Add the helper to `test-e2e/helpers.ts`**

Place it immediately before `waitForScrubbedChunks` so the two read together:

```ts
/**
 * Makes a test's own freshly-committed chunks eligible for the scrubber now.
 *
 * Production makes a chunk wait 30s (db/sessions.go ClaimUnscrubbedChunks)
 * because the presigned POST policy stays replayable for the whole of
 * handler.chunkUploadPolicyTTL. A replay inside that window could swap raw
 * bytes under a row the scrubber has already stamped, so the grace outlives the
 * policy on purpose. A test that owns the client and never replays has no such
 * exposure, so it fast-forwards its own fixtures rather than waiting out a
 * window that exists to defend against hostile callers.
 *
 * Scoped to one session id, so it can never touch a concurrently running
 * suite's rows. Shifts uploaded_at relatively, so ordering within a batch (the
 * claim query's ORDER BY uploaded_at) is preserved.
 *
 * Waits for the chunk to be committed first: callers that upload through a real
 * browser SDK (friction-smoke) have no synchronous commit to await.
 */
export async function makeChunksScrubbable(
  sessionId: string,
  timeoutMs = 60_000
): Promise<void> {
  const db = getPool();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await db.query(
      `UPDATE session_chunks
          SET uploaded_at = uploaded_at - interval '1 hour'
        WHERE session_id = $1
          AND uploaded_at IS NOT NULL
          AND uploaded_at > now() - interval '1 minute'`,
      [sessionId]
    );
    if ((res.rowCount ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`no committed chunk for ${sessionId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
```

The `uploaded_at > now() - interval '1 minute'` guard makes the statement idempotent: a chunk already shifted an hour back will not be shifted again if the helper is called twice for the same session.

**Step 2: Call it in `friction-incidents.test.ts`**

In `driveRageSession` (line ~136), between the upload and the wait:

```ts
  await uploadChunk(apiKey, sessionId, 0, rageChunk(Date.now() - 5_000, opts.selector));
  await makeChunksScrubbable(sessionId);
  await waitForScrubbedChunks(sessionId, 1);
```

Add `makeChunksScrubbable` to the existing import block from `./helpers.js` (the one that already pulls in `waitForScrubbedChunks`).

**Step 3: Call it in `friction-smoke.test.ts`**

At line ~91:

```ts
        const sessionId = await pollSessionForProject(tenant.projectId);
        await makeChunksScrubbable(sessionId);
        await pollScrubbedChunk(sessionId, 120_000);
```

Add `makeChunksScrubbable` to the import list from `./helpers.js`. Here the helper's internal poll is doing real work: the chunk arrives from the browser SDK, so it may not be committed yet when `pollSessionForProject` returns.

**Step 4: Update the now-stale comment on `pollScrubbedChunk`**

`test-e2e/helpers.ts:394-395` currently says:

```ts
/** Polls until at least one chunk for the session is scrubbed (analyzable).
 * Scrubber cadence: eligible 30s after upload, swept every 15s — expect ~45-60s. */
```

Replace the second line:

```ts
/** Polls until at least one chunk for the session is scrubbed (analyzable).
 * Scrubber cadence: eligible 30s after upload, swept every SCRUB_INTERVAL_SECONDS
 * (15s by default, 1s in CI). Call makeChunksScrubbable first to skip the grace. */
```

**Step 5: Typecheck**

```bash
pnpm --filter @opslane/test-e2e exec tsc --noEmit
```

Expected: no errors. (If test-e2e has no `tsc` script wired, run `pnpm -r build` and confirm it stays green — the e2e package is type-checked as part of the workspace.)

**Step 6: Commit**

```bash
git add test-e2e/helpers.ts test-e2e/friction-incidents.test.ts test-e2e/friction-smoke.test.ts
git commit -m "test(e2e): fast-forward friction fixtures past the scrub eligibility grace"
```

---

## Task 5: Pin the friction-incidents suite in the CI gate

**Files:**
- Modify: `.github/workflows/ci.yml` (`E2E_REQUIRED_PATTERNS`, ~line 394)

Review caught a real gap: `E2E_MIN_TESTS: "75"` is a floor, not an equality (`scripts/check-e2e-results.mjs:57` uses `total < minTests`), and no required pattern names the friction-incidents suite. The change that makes this suite fast is exactly the change that could later make it silently disappear.

**Step 1: Confirm the exact test names**

Do not transcribe from source. The names contain an em-dash and `±`, and the gate builds each name as `[...ancestorTitles, title].join(' > ')`. Take them from a real run's reporter output:

```
friction incidents — synthetic live-service gate > four users stay invisible; the fifth promotes exactly one friction incident
friction incidents — synthetic live-service gate > environments never combine: staging needs its own five users
friction incidents — synthetic live-service gate > a signal inside ±30s of a same-session error folds instead of promoting
friction incidents — synthetic live-service gate > an error outside the ±30s window does not fold
friction incidents — synthetic live-service gate > the stepper fixture produces no signal and no incident
```

After the local run in Task 6, re-derive them from the JSON to be certain:

```bash
node -e 'const r=require("/tmp/e2e.json");r.testResults.flatMap(t=>t.assertionResults).map(a=>[...a.ancestorTitles,a.title].join(" > ")).filter(n=>n.startsWith("friction incidents")).forEach(n=>console.log(n))'
```

**Step 2: Add the patterns**

Append to the `E2E_REQUIRED_PATTERNS` block scalar, with a comment matching the style of the neighbouring entries:

```yaml
            # The friction-incidents suite is the lane's only proof that the
            # 5-user promotion threshold, environment isolation, and the ±30s
            # error-fold window hold end to end. It is also the suite this lane's
            # scrub fast-forward makes cheap, so pin every case by name: a future
            # edit must not be able to drop one while E2E_MIN_TESTS still passes.
            ^friction incidents — synthetic live-service gate > four users stay invisible
            ^friction incidents — synthetic live-service gate > environments never combine
            ^friction incidents — synthetic live-service gate > a signal inside ±30s
            ^friction incidents — synthetic live-service gate > an error outside the ±30s window
            ^friction incidents — synthetic live-service gate > the stepper fixture produces no signal
```

These are JavaScript `RegExp` sources. None of the retained substrings contain regex metacharacters, so no escaping is needed. Keep them shorter than the full titles, as the existing entries do.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: pin the friction-incidents cases in the keyless E2E gate"
```

---

## Task 6: Verify locally against a disposable stack

Never claim this is done from reading the diff. Measure it.

**Warning — do not use the shared database.** Port 5434 is shared across worktree sessions, and other sessions' data lives there. Bring up an isolated project and tear it down with `-v`.

**Step 1: Capture the baseline (optional but recommended)**

If you want a before/after number on this machine, stash the Task 4 changes and time one run first. Otherwise use the CI baseline: `friction-incidents` = 582.8s.

**Step 2: Boot a disposable stack with the CI settings**

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/keyless-smoke-ci
export COMPOSE_PROJECT_NAME=keyless-verify
export SCRUB_INTERVAL_SECONDS=1
docker compose up -d postgres minio minio-setup
docker compose run --rm migrate
docker compose up -d --build --wait ingestion worker
```

**Step 3: Confirm the interval actually took effect**

```bash
docker compose logs ingestion | grep "chunk scrubber started"
```

Expected: `interval=1s`. If it says `15s`, the Compose passthrough (Task 3) did not land — fix that before timing anything.

**Step 4: Time the friction suites**

```bash
export DATABASE_URL=postgres://opslane:opslane_dev@localhost:5434/opslane
export INGESTION_URL=http://localhost:8082
export E2E_WORKER_NO_KEY=1
export MINIO_ENDPOINT=http://localhost:9012
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
time pnpm --filter @opslane/test-e2e exec vitest run friction
```

Expected: both friction files PASS. `friction-incidents.test.ts` around 30s, down from 582.8s. If it is still minutes, the backdate is not taking effect — check that `makeChunksScrubbable` runs before the wait and that its `rowCount` is non-zero.

**Step 5: Run the whole e2e suite with the gate**

`helpers.ts` is shared, so a targeted run is not sufficient evidence.

```bash
export OPSLANE_PYTHON=python3
pnpm --filter @opslane/test-e2e exec vitest run \
  --reporter=default --reporter=json --outputFile=/tmp/e2e.json
node -e 'console.log(require("/tmp/e2e.json").numTotalTests)'
```

Expected: `75`. If the number moved, `E2E_MIN_TESTS` needs re-deriving and something changed test collection — investigate before proceeding.

Then run the gate exactly as CI does, with the new patterns from Task 5 exported:

```bash
E2E_ALLOWED_SKIP_PATTERN='^(pr_created pipeline \(full flow\)|dashboard approved-fixture screenshot capture)' \
E2E_MIN_TESTS=75 \
E2E_REQUIRED_PATTERNS="$(...the full block from ci.yml...)" \
node scripts/check-e2e-results.mjs /tmp/e2e.json
```

Expected: `E2E OK: ...`. Some browser/python suites may skip locally in a way CI does not; if the gate objects to those specifically, note it and rely on CI for that leg — but the friction patterns must match.

**Step 6: Confirm the production default is untouched**

```bash
docker compose down -v
unset SCRUB_INTERVAL_SECONDS
docker compose up -d --build --wait ingestion
docker compose logs ingestion | grep "chunk scrubber started"
```

Expected: `interval=15s`.

**Step 7: Tear down**

```bash
docker compose down -v
```

**Step 8: Full repo gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

---

## Task 7: Push and measure the real job

**Step 1: Push the branch**

The agent cannot push in this repo (a hook blocks it). Ask the user to run:

```
! git push -u origin abhishekray07/keyless-smoke-ci
```

Then open the PR with `gh pr create` from the repo root.

**Step 2: Wait for `Keyless smoke E2E` and read the real timing**

```bash
gh run list --branch abhishekray07/keyless-smoke-ci --workflow=ci.yml --limit 1 --json databaseId
gh api repos/:owner/:repo/actions/runs/<id>/jobs \
  --jq '.jobs[] | select(.name|test("Keyless")) | {name, started_at, completed_at, steps: [.steps[] | {n:.name, s:.started_at, c:.completed_at}]}'
```

Note: a `docs: sync` bot commit can land on the PR branch and cancel in-flight CI. Judge only the newest head.

**Definition of done — all three, measured, not inferred:**

1. `Keyless smoke E2E` wall-clock is **under 5 minutes**.
2. The `Run E2E contracts with hard assertions` step passes.
3. The `Enforce zero unexpected skips` step passes with `E2E_MIN_TESTS: 75` unchanged and the five new friction patterns matched.

If (1) holds but (2) or (3) fails, the job is fast and wrong — that is a failure, not a partial success.

**Expected numbers:** ~184–209s of fixed setup and boot overhead plus a ~35s vitest run ≈ **3m40s–4m05s**.

---

## Out of scope

Docker layer caching for the ~75s image build inside the boot step. The arithmetic above clears 5 minutes without it, and the obvious sketch (add `setup-buildx`) does not actually work: Compose needs the cache wired through `build.cache_from`/`cache_to` or Bake. If the boot step is attacked later, it deserves its own change with its own measurement.
