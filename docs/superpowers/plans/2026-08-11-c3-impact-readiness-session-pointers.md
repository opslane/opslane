# C3: Impact, Readiness Backfill, and Session Pointers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every open incident carries a mechanically computed impact stamp (`blocked/degraded/invisible` from session recordings, both lanes), a watchable session pointer that actually plays (stitched ±15s coverage, friction retraction fallback), and a `digest_readiness` row (the backfill retires C1's absent-row policy) — and the friction fix rung stops reading confidence, discharging C2's frozen-rung debt.

**Architecture:** The existing priority sweeper gains a transactional impact pass: one temp-table rollup over both lanes' sessions (error events for `kind='error'`, accepted friction signals for `kind='friction'`), a single stamp UPDATE, and a stale-clear guarded on non-NULL so unknown groups are never rewritten. `SessionPointerForGroup` gains a friction branch (representative signal, earliest-accepted fallback); a new coverage-gated `WatchableSessionForGroup` feeds the digest's replay links with a `?t=` anchor the dashboard already understands. Migration 046 adds the `(error_group_id, "timestamp")` index the rollup needs; migration 047 is the one-shot readiness backfill. The worker's friction auto-fix rung swaps its confidence conjunct for a live signal-session impact bar recorded as `policy_eligible`/`policy_basis`.

**Tech Stack:** Go 1.24 (ingestion: sweeper, queries, digest, migrations, plain `testing`), Postgres (plain SQL migrations under `packages/ingestion/db/migrations/`), TypeScript + Vitest (worker: friction impact bar).

**Parent:** `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C3. Authority: `docs/design/2026-08-10-unified-actionable-program.md` (decisions 2, 3). Carried-forward detail: `docs/superpowers/plans/2026-08-10-actionable-receipts-v1.md` Tasks B1/B2 (revised SQL, coverage definition), amended below where exploration of the working tree contradicted them (see "Deviations from carried-forward text").

## Dependencies on C0, C1, C2 (hard prerequisites)

Consumed, never edited:

- **C0 / migration 044** (`044_actionable_receipts_contracts.sql:38-44`): the four impact columns already exist on `error_groups` — `impact_class TEXT CHECK (impact_class IN ('blocked','degraded','invisible'))`, `impact_visits BIGINT`, `impact_visits_recovered BIGINT`, `impact_computed_at TIMESTAMPTZ` — **C3 adds no impact columns**, only the query index (Task 1). `digest_readiness` (`:80-90`: `incident_id` PK, `project_id`, `status IN ('eligible','ineligible','pending')`, `reason`, `updated_at`, composite FK → `error_groups` ON DELETE CASCADE).
- **C1**: the interim digest gate (`digest/build.go:108-111` and 4 siblings — `NOT EXISTS (… dr.status IN ('ineligible','pending'))`; absent rows render as today) — Task 8's backfill is exactly the retirement of that absent-row clause the C1 comment promises; the incident DTO readiness gate (`read_api.go`: `ineligible`/`pending` null the cause) and honest-state dashboard card; the requeue transition (`queries.go:731-739`, UPDATE-only `('pending','reinvestigating')`); readiness reasons `'validated_cause'`, `'reinvestigating'`, `'quarantined_degenerate'`; migration 045's one-shot guard shape and `applied_data_migrations` (`028_project_api_keys.sql:28-31`: columns `name`, `applied_at`).
- **C2** (`docs/superpowers/plans/2026-08-11-c2-worker-verification-judge-policy.md`; merged before Task 9 and before CP3's AC3.7 fix-outcome leg — Tasks 1–8 need only C1): `DecisionRow.policyEligible/policyBasis` and their persistence in `insertDiagnosisDecision` (C2 Task 2); the `ImpactBar` type and error-lane `getGroupImpactBar` (C2 Task 2 — Task 9 reuses the type and thresholds verbatim); the frozen friction rung with its debt comment (`index.ts`, C2 Task 3: `// C3 replaces this confidence check with the signal-session impact bar…`); fix-outcome readiness reasons `'fix_pr_opened'`, `'fix_attempt_failed_with_diff'`, `'fix_attempt_failed_no_diff'` (C2 Task 13 — AC3.7's middle leg witnesses them, C3 does not write them).
- Line numbers in this plan are anchors into the working tree, verified 2026-08-11. Where a symbol has moved, locate it by name (`grep -n`); the named function is the contract, not the line.

## Global Constraints

- Postgres queue only; wire contract append-only (`test-fixtures/wire/` untouched); lease and terminal-status contracts preserved; human-trigger bypass untouched.
- **No judgment-based impact labels** (design decision 2, overturning nothing softer): `impact_class` is computed from session recordings or it is NULL. Unknown is **all four columns NULL** — one representation for never-computed and computed-found-nothing. The "recording impact unavailable" sentence is C4/C5 rendering scope; C3 stores NULLs and renders nothing new.
- Named contracts, frozen here: `impactWindowDays = 30` (deliberately wider than the priority 7d/24h windows; it is not "the retention window"), `impactRecoveryMs = 60_000` (last recorded activity ≥ 60s after the session's last crash/signal counts as recovered), `watchWindowMs = 15_000` (stitched-span coverage each side of the anchor), `watchCandidateEvents = 50` (newest events examined per group for a watchable pointer).
- **Sweeper contract preserved:** single-flight via session advisory lock `0x7072696F7269`; `RunOnce` returns `(0, nil)` on contention (pinned by `sweeper_test.go:253`); the impact pass runs on the same held connection but inside **its own transaction** (temp table + two statements — the rest of `RunOnce` stays autocommit-per-statement, unchanged).
- Every read of `session_chunks` gates on `scrubbed_at IS NOT NULL` (the fail-closed rule in `002_sessions.sql:40-46`), and impact/coverage arithmetic additionally requires non-NULL `first_event_ms`/`last_event_ms` — NULL-bounded chunks are excluded everywhere (unknown evidence is not proof of death).
- Client-clock consistency: crash times use `error_events."timestamp"` and signal times use `friction_signals.occurred_at` because they are compared against `session_chunks.first_event_ms/last_event_ms`, which are client-clock epoch ms (`003_chunk_event_times.sql`). The dashboard's `?t=` query param is an **absolute epoch-ms event timestamp** (`SessionDetail.vue:13-15`), the same clock domain — pointers emit it directly.
- Migrations are idempotent under unconditional replay (`scripts/run-migrations.sh` replays every file every boot, per-statement autocommit); one-shot data migrations guard via `applied_data_migrations` (045's Shape A). 046/047 widen no constraint or enum, so `scripts/check-migration-reapply.sh` needs no new seed rows (stated so the reviewer doesn't hunt).
- **Readiness single-writer discipline holds:** steady-state writers remain exactly C1/C2's (`upsertDigestReadiness` in the worker, the Go requeue UPDATE). C3 adds only the one-shot migration 047. New frozen backfill reason strings: `'backfill_receipt_state'`, `'backfill_validated_cause'`, `'backfill_unverified'`. **C4 must key its gate on `status` alone** (eligible-only), never on eligible-side reason strings — recorded here because 047 makes eligible reasons heterogeneous.
- **Customer-visible deploy note (deliberate, program-intended):** the moment 047 runs, open legacy incidents classified `pending` fall out of the digest (C1's interim gate already excludes `pending`) and their incident pages show the honest not-verified state (C1's DTO gate). That is the point — the absent-row policy dies, unverified legacy prose stops rendering, and receipt/validated legacy keeps rendering via the eligible carve-outs. The rollout runbook (Task 10) records the per-class counts from a prod copy before the release.
- Go tests may not skip beyond the `check-go-skips.mjs` allowlist; new DB-gated tests follow each package's existing gating (`priority`: skip only when `DATABASE_URL` unset, fatal on unreachable; `db`: skip on unreachable, `defaultTestDSN` fallback).
- Copy rule inherited: C3 writes no customer copy. Impact class strings are stored enum values, not sentences.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ingestion/db/migrations/046_impact_query_index.sql` (create) | Partial index `(error_group_id, "timestamp") WHERE session_id IS NOT NULL` on `error_events`, CONCURRENTLY with 044's invalid-index drop guard |
| `packages/ingestion/db/migrations/047_readiness_backfill.sql` (create) | One-shot classification of every open, absent-row incident into `digest_readiness` |
| `packages/ingestion/priority/sweeper.go` (modify) | `stampImpact` pass: temp-table rollup (both lanes), stamp UPDATE, guarded stale-clear; named constants |
| `packages/ingestion/priority/impact_test.go` (create) | DB-gated impact tests: AC3.1–AC3.4 shapes incl. xmin stability |
| `packages/ingestion/priority/impact_explain_test.go` (create) | AC3.8: 100k-event seed, `EXPLAIN (ANALYZE, BUFFERS)`, examined-row ratio assertion |
| `packages/ingestion/db/sessions_read.go` (modify) | `SessionPointerForGroup` friction branch; new `WatchableSessionForGroup` |
| `packages/ingestion/db/sessions_read_test.go` (extend) | Pointer + coverage tests: AC3.5/AC3.6 query halves |
| `packages/ingestion/db/migration_046_test.go`, `migration_047_test.go` (create) | Index presence; backfill classification, marker, idempotence |
| `packages/ingestion/digest/digest.go` (modify) | `sessionURLAt(sessionID, anchorMs)` emitting `/sessions/{id}?t={ms}` |
| `packages/ingestion/digest/build.go` (modify) | Replay links from `WatchableSessionForGroup` (issues + insights) |
| `packages/ingestion/digest/build_test.go` (extend) | Chunk-seeded replay-link matrix |
| `packages/worker/src/db.ts` (modify) | `getFrictionGroupImpactBar` (signal-session arithmetic, `ImpactBar` reused) |
| `packages/worker/src/index.ts` (modify) | Friction rung: impact bar replaces the frozen confidence conjunct; policy stamp on friction `code_fix` decisions |
| `packages/worker/src/__tests__/index.test.ts` (extend) | AC3.9 routing tests |
| `packages/worker/src/__tests__/db.test.ts` (extend) | Friction bar boundary tests |

**PR train** (each PR = consecutive tasks, merged in order): PR1 = Tasks 1–4 (impact) · PR2 = Tasks 5–7 (pointers + digest links) · PR3 = Task 8 (readiness backfill — deployed after PR1/PR2 so the flip lands with impact stamps and working pointers live) · PR4 = Task 9 (friction routing; requires C2 merged) · CP3 = Task 10.

## Deviations from carried-forward text (each deliberate, source-verified)

1. **Open-group predicate:** receipts B1 wrote `archived_at IS NULL AND status NOT IN ('resolved','merged')`. The sweeper's own five existing queries use `status NOT IN ('resolved','merged','archived')` (`sweeper.go:40,61,97,147,175`) — `'archived'` is an enum status and `archived_at` accompanies it. The impact pass uses the in-file spelling; mixing predicates inside one file is the bug factory.
2. **One migration became two:** B1's "no backfill — next sweep fills" holds for impact (046 carries only the index); the readiness backfill (program W3.B, not in the receipts plan) is 047, its own PR, because it is the customer-visible flip.
3. **`?t=` confirmed, semantics pinned:** B2 said "extend with `?t={offsetMs}` only after confirming the dashboard router accepts it." Confirmed: `SessionDetail.vue:13-15` parses `t` as an absolute epoch-ms timestamp (not an offset) and threads it to `useSessionPlayback({ seekAtMs })`; `IncidentDetail.vue:385-393` already emits `t: Date.parse(error_at)`. Pointers emit absolute ms; no dashboard work needed.
4. **Digest insights switch selection rules:** today `buildInsights` links the newest signal's session (`(array_agg(fs.session_id ORDER BY fs.occurred_at DESC))[1]`, `build.go:101`) with no coverage check, and `buildTopNewIssues` reads `representative_session_id`, which is written only for friction — error issues get no link. Both sections now route through `WatchableSessionForGroup`: links that exist can play; links that can't play don't exist. Existing digest tests are updated (they currently seed no `session_chunks`, so their expected links change — asserted explicitly in Task 7).
5. **Bounded candidate scan:** B2's coverage rule is kept verbatim, but the error-branch search examines only the newest `watchCandidateEvents = 50` session-bearing events per group, so a coverage-less group costs a bounded probe, not a full-history walk.
6. **The TS mirror stays error-lane:** `getSessionPointerForGroup` (`worker/src/db.ts:1594`) mirrors the Go pointer 1:1 today. Its consumers are error-lane replay evidence only; Task 5 changes the Go function and leaves the mirror untouched, updating its comment to say the friction branch is Go-only and why. (Verify the consumer claim by grep before relying on it; if a friction path consumes it, extend the mirror identically instead.)

---

### Task 1: Migration 046 — the index the rollup stands on

`error_events` has no index serving "this group's events in a client-time window": `idx_error_events_group_created` (039) is on `created_at`, and the rollup must bound on `"timestamp"` (client clock, to compare against chunk event ms). Without this, examined rows ∝ all events of open groups and AC3.8 is unpassable.

**Files:**
- Create: `packages/ingestion/db/migrations/046_impact_query_index.sql`
- Test: `packages/ingestion/db/migration_046_test.go` (create)

**Interfaces:**
- Produces: `idx_error_events_group_timestamp ON error_events (error_group_id, "timestamp") WHERE session_id IS NOT NULL` — consumed by Task 2's rollup and asserted by Task 4's planner test.

- [ ] **Step 1: Write the failing test** (pattern: `migrations_test.go` harness + the `pg_indexes` probe from `sessions_index_test.go:139`):

```go
func TestMigration046ImpactQueryIndex(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	var def string
	err := pool.QueryRow(context.Background(),
		`SELECT indexdef FROM pg_indexes WHERE tablename = 'error_events' AND indexname = 'idx_error_events_group_timestamp'`,
	).Scan(&def)
	if err != nil {
		t.Fatalf("index missing: %v", err)
	}
	if !strings.Contains(def, `(error_group_id, "timestamp")`) {
		t.Fatalf("indexdef %q: columns missing or misordered — want (error_group_id, \"timestamp\")", def)
	}
	if !strings.Contains(def, "session_id IS NOT NULL") {
		t.Fatalf("indexdef %q missing the partial predicate", def)
	}
	// Second index, same probe: idx_friction_signals_incident_occurred on
	// friction_signals with (incident_id, occurred_at) in order and all four
	// partial-predicate conjuncts (incident_id, superseded_by, retracted_at,
	// adjudication_status = 'accepted').
}
```

- [ ] **Step 2: Run → FAIL** (index absent). `DATABASE_URL=… go test ./db/ -run TestMigration046`
- [ ] **Step 3: Write the migration.** Copy 044's two-part shape exactly: a `DO $$` guard that drops the index only if it exists **and is invalid** (`pg_index.indisvalid = false` — an interrupted `CONCURRENTLY` build leaves an invalid index that `IF NOT EXISTS` would happily keep forever), then the concurrent create:

```sql
-- 046_impact_query_index.sql
-- C3/W3.1: the impact rollup bounds error_events per group on client "timestamp"
-- (chunk event ms are client-clock; created_at cannot serve the predicate).
-- IDEMPOTENCY IS MANDATORY: scripts/run-migrations.sh replays every file on
-- every boot, per-statement autocommit (which is what makes CONCURRENTLY legal here).
DO $$
DECLARE idx regclass;
BEGIN
  SELECT c.oid INTO idx
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
  WHERE c.relname = 'idx_error_events_group_timestamp' AND NOT i.indisvalid;
  IF idx IS NOT NULL THEN
    EXECUTE 'DROP INDEX ' || idx;
  END IF;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_error_events_group_timestamp
  ON error_events (error_group_id, "timestamp")
  WHERE session_id IS NOT NULL;

-- The friction arm and the friction impact bar filter accepted-active signals by
-- occurred_at; 039's reach index is ordered by created_at, so a long-lived incident
-- with a large aged-but-still-active accepted set would be re-examined every sweep.
-- Same guard shape applies (add the invalid-index drop for this name to the DO block).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_friction_signals_incident_occurred
  ON friction_signals (incident_id, occurred_at)
  WHERE incident_id IS NOT NULL AND superseded_by IS NULL
    AND retracted_at IS NULL AND adjudication_status = 'accepted';
```

- [ ] **Step 4: Run → PASS**, and run the umbrella suite (`go test ./db/ -run TestMigrations_`) — the glob-driven apply/idempotency/roll-forward tests pick 046 up automatically; `TestMigrations_RollForwardFromPreviousSchema` now rolls 046 forward by construction (expected; note it in the PR).
- [ ] **Step 5: Commit.** `feat(db): index error_events by group and client timestamp for the impact rollup (C3/W3.1)`

### Task 2: The impact pass — error lane, transactional, stamp + guarded clear

**Files:**
- Modify: `packages/ingestion/priority/sweeper.go` (constants near `:13`; new SQL consts after `scoreFrictionGroupsSQL`; `stampImpact` method; one call in `RunOnce` after the scoring statements, before `enqueueRouteMapJobsSQL`)
- Test: `packages/ingestion/priority/impact_test.go` (create; helpers `testPool`/`mustExec`/`seedTenant`/`seedGroup` from `testutil_test.go`)

**Interfaces:**
- Consumes: the 044 impact columns; Task 1's index; `session_chunks` bounds.
- Produces (consumed by Task 3, C4's cards, C5's badges/PR body):
  - Constants: `const impactWindowDays = 30`, `const impactRecoveryMs = 60_000`.
  - `func (s *Sweeper) stampImpact(ctx context.Context, conn *pgxpool.Conn) error` — one transaction on the already-held advisory-locked connection: `CREATE TEMPORARY TABLE impact_rollup ON COMMIT DROP AS <rollup>`, then the stamp UPDATE, then the guarded clear. `RunOnce` calls it and propagates errors exactly like its existing statements; `updated` (the scoring row count) is **not** changed — impact counts are `slog.Debug`ged, keeping every existing `RunOnce` assertion byte-stable.
  - Semantics (B1 revised, frozen): a **visit** = a distinct session among the group's in-window occurrences that has usable chunk evidence (some scrubbed chunk with non-NULL bounds). **Recovered** = that session's `max(last_event_ms) >= last_hit_ms + 60000`. `blocked` = recovered 0; `degraded` = 0 < recovered < visits; `invisible` = recovered = visits. Groups with no rollup row: previously stamped → cleared to all-NULL once; never stamped → untouched (no WAL churn, AC3.4).

The rollup (error lane in this task; Task 3 adds the friction arm to the same temp table — the UNION ALL seam is built now):

```sql
CREATE TEMPORARY TABLE impact_rollup ON COMMIT DROP AS
WITH open_groups AS (
  SELECT id, project_id, kind FROM error_groups
  WHERE status NOT IN ('resolved','merged','archived')
), err_sess AS (
  SELECT g.id AS group_id, e.project_id, e.session_id,
         (max(extract(epoch FROM e."timestamp")) * 1000)::bigint AS last_hit_ms
  FROM open_groups g
  JOIN error_events e ON e.error_group_id = g.id AND e.project_id = g.project_id
  WHERE g.kind = 'error' AND e.session_id IS NOT NULL
    AND e."timestamp" > now() - interval '30 days'
  GROUP BY 1, 2, 3
), sess AS (
  SELECT * FROM err_sess
  -- Task 3 appends: UNION ALL SELECT * FROM fric_sess
), chunks AS (
  SELECT c.project_id, c.session_id, max(c.last_event_ms) AS last_activity_ms
  FROM session_chunks c
  WHERE c.scrubbed_at IS NOT NULL
    AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL
    AND (c.project_id, c.session_id) IN (SELECT DISTINCT project_id, session_id FROM sess)
  GROUP BY 1, 2
)
SELECT sess.group_id,
       count(*)::bigint AS visits,
       (count(*) FILTER (WHERE ch.last_activity_ms >= sess.last_hit_ms + 60000))::bigint AS recovered
FROM sess
JOIN chunks ch ON ch.project_id = sess.project_id AND ch.session_id = sess.session_id
GROUP BY 1;
```

The stamp and the clear (same transaction; the temp table is why this is a transaction at all — a CTE cannot span statements):

```sql
UPDATE error_groups g SET
  impact_visits = r.visits,
  impact_visits_recovered = r.recovered,
  impact_class = CASE WHEN r.recovered = 0 THEN 'blocked'
                      WHEN r.recovered < r.visits THEN 'degraded'
                      ELSE 'invisible' END,
  impact_computed_at = now()
FROM impact_rollup r
WHERE g.id = r.group_id
  AND g.status NOT IN ('resolved','merged','archived');

UPDATE error_groups g SET
  impact_class = NULL, impact_visits = NULL,
  impact_visits_recovered = NULL, impact_computed_at = NULL
WHERE g.status NOT IN ('resolved','merged','archived')
  AND (g.impact_class IS NOT NULL OR g.impact_visits IS NOT NULL
       OR g.impact_visits_recovered IS NOT NULL OR g.impact_computed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM impact_rollup r WHERE r.group_id = g.id);
```

(The stamp re-checks open status inside the UPDATE — a group resolved between the rollup materialization and the stamp must not be written. The clear guards on **any** of the four columns being non-NULL, not just `impact_class`: only these two statements write the columns and both write all four, but the all-NULL "unknown" representation is a contract, so the guard enforces it rather than assuming it.)

(The interval literal is built from `impactWindowDays` and the `60000` from `impactRecoveryMs` via `fmt.Sprintf` at package init, the way `maxURLsPerGroup` parameterizes the tally SQL — one source for each number.)

- [ ] **Step 1: Write the failing tests** in `impact_test.go`. Local seed helpers (sessions and chunks; `seedTenant`'s cleanup deletes `sessions`, and `session_chunks` cascades from it):

```go
func seedSession(t *testing.T, pool *pgxpool.Pool, projectID, envID, id string, user *string) { /* INSERT INTO sessions (id, project_id, environment_id, end_user_id, started_at, status) VALUES (..., now(), 'recording') — 002's CHECK admits only recording/closed/analyzing/analyzed/analysis_failed/deleting; copy the column list build_test.go:103-108 uses */ }
func seedChunk(t *testing.T, pool *pgxpool.Pool, projectID, sessionID string, seq int, firstMs, lastMs *int64, fullSnap bool) { /* INSERT INTO session_chunks (..., scrubbed_at) VALUES (..., now()) */ }
func seedEvent(t *testing.T, pool *pgxpool.Pool, projectID, envID, groupID, sessionID string, at time.Time) { /* INSERT INTO error_events (project_id, environment_id, error_group_id, session_id, "timestamp", error_type, error_message, stack_trace_raw) */ }
```

Tests (all one `TestImpactPass` with subtests, one `RunOnce` per subtest arrangement):

```go
// AC3.1a: crash-loop-only group → blocked, 2 visits, 0 recovered.
//   Two sessions; each: crash at T, chunk bounds [T-60s .. T+5s] (activity dies within 60s).
// AC3.1b: loop-plus-recovery group → degraded, visits 2, recovered 1.
//   Session A as above; session B: crash at T, chunk last_event_ms = T+17min.
// invisible: single session whose activity continues past T+60s on its only crash → invisible 1/1.
// AC3.3: group whose only session has NULL-bounded chunks (first_event_ms/last_event_ms NULL)
//   → all four impact columns NULL after the sweep.
// half-NULL bounds: a chunk with first_event_ms NULL but last_event_ms set (and vice versa)
//   is NOT usable evidence — a group whose only session has only such chunks stays all-NULL
//   (the both-bounds filter in the chunks CTE, not just the both-NULL case).
// window: a group whose only events are 31 days old → no stamp (columns NULL).
// AC3.4: stamp a group (in-window seed), then age it out (UPDATE error_events SET "timestamp" =
//   now() - interval '31 days'), sweep → all four NULL; then prove write-stability.
// closed groups: a resolved group with in-window sessions → never stamped.
```

The row-version-stability witness AC3.4 names **cannot** ride `RunOnce`: the scoring pass rewrites `priority_scored_at = now()` on every open group every sweep (`sweeper.go:100/:150`), so the group row's `xmin` changes on every full pass regardless of the impact clear. The assertion therefore drives `stampImpact` directly (in-package test, method visible), twice, after the aging step:

```go
conn, _ := pool.Acquire(ctx)
defer conn.Release()
if err := sw.stampImpact(ctx, conn); err != nil { t.Fatal(err) } // the clear happens here
var xminBefore, xminAfter string
// Read through the SAME acquired conn — a second pool checkout can deadlock a
// small test pool while conn is held.
conn.QueryRow(ctx, `SELECT xmin::text FROM error_groups WHERE id = $1`, groupID).Scan(&xminBefore)
if err := sw.stampImpact(ctx, conn); err != nil { t.Fatal(err) } // second pass: nothing to write
conn.QueryRow(ctx, `SELECT xmin::text FROM error_groups WHERE id = $1`, groupID).Scan(&xminAfter)
if xminBefore != xminAfter { t.Fatalf("second impact pass rewrote an unknown-impact row: %s → %s", xminBefore, xminAfter) }
```

(`xmin` scans through pgx as `::text`; the clear-once semantics are proven at the statement that owns them, and one earlier `RunOnce`-driven subtest still proves the pass runs inside the full sweep.)
- [ ] **Step 2: Run → FAIL** (`DATABASE_URL=… go test ./priority/ -run TestImpactPass` — columns stay NULL, no pass exists).
- [ ] **Step 3: Implement** `stampImpact` + constants + the `RunOnce` call. Keep the existing `RunOnce` error style (wrap with `fmt.Errorf("impact: %w", err)`).
- [ ] **Step 4: Run → PASS**, plus the whole package: `go test ./priority/` — the five existing sweeper tests must pass unmodified (single-flight, tallies, scoring untouched).
- [ ] **Step 5: Commit.** `feat(ingestion): impact stamped from session recordings in the priority sweeper (C3/W3.1)`

### Task 3: The friction arm of the same rollup

**Files:**
- Modify: `packages/ingestion/priority/sweeper.go` (the `sess` CTE seam from Task 2)
- Test: extend `packages/ingestion/priority/impact_test.go`

**Interfaces:**
- Produces: friction incidents stamped by the **same arithmetic** over their signals' sessions (program §C3). The friction arm, appended into `sess` via `UNION ALL`:

```sql
fric_sess AS (
  SELECT g.id AS group_id, fs.project_id, fs.session_id,
         (max(extract(epoch FROM fs.occurred_at)) * 1000)::bigint AS last_hit_ms
  FROM open_groups g
  JOIN friction_signals fs ON fs.incident_id = g.id AND fs.project_id = g.project_id
  WHERE g.kind = 'friction'
    AND fs.adjudication_status = 'accepted'
    AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
    AND fs.occurred_at > now() - interval '30 days'
  GROUP BY 1, 2, 3
)
```

  Signal filters match the sweeper's own friction-reach discipline (`scoreFrictionGroupsSQL`): accepted, active (not retracted, not superseded). The `g.kind = 'friction'` guard matters: fold-attached signals point `incident_id` at **error** groups, whose impact must come from their crashes, not from folded friction signals. Index support: `idx_friction_signals_incident_reach` (039) — partial on exactly these filters; its second column is `created_at`, not `occurred_at`, which is acceptable because the incident's accepted-active signal set is small (asserted cheap in Task 4's plan review, not indexed further).

- [ ] **Step 1: Failing tests** (extend `TestImpactPass`):

```go
// AC3.2: friction incident, two accepted dead_click signals in two sessions.
//   Session A: signal occurred_at T, chunks end T+5s  → not recovered (5s < 60s).
//   Session B: signal occurred_at T, chunks end T+10min → recovered.
//   → impact_class 'degraded', impact_visits 2, impact_visits_recovered 1.
// retracted/superseded/pending signals contribute nothing: same shape but session B's signal
//   retracted → visits 1, recovered 0, class 'blocked'.
// fold guard: an accepted signal whose incident_id is a kind='error' group adds no friction
//   visit to that group (its impact comes from err_sess only) — seed a crash session too and
//   assert visits counts only the crash session.
// (Window semantics differ by purpose, deliberately: the ROLLUP windows on occurred_at —
//  client clock, because it is compared against chunk event ms — while the Task 9 policy
//  bar windows on created_at; see Task 9's rationale.)
```

Signal seeding: copy the `insertSignal` closure shape from `sweeper_test.go:126-138` (columns: `session_id, project_id, environment_id, end_user_id, rule_version, signal_type, fingerprint, page_url_normalized, occurred_at, adjudication_status, retracted_at, superseded_by, incident_id`).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** (add the CTE + UNION ALL). **Step 4: Run → PASS** including Task 2's subtests unchanged.
- [ ] **Step 5: Commit.** `feat(ingestion): friction incidents stamped by the same recordings arithmetic (C3/W3.1, AC3.2)`

### Task 4: AC3.8 — the planner proof at 100k events

**Files:**
- Modify: `packages/ingestion/priority/sweeper.go` (export `ImpactRollupSelectSQL` — the SELECT body without the `CREATE TEMPORARY TABLE` wrapper, an exported package `var` built once by `fmt.Sprintf` from the named constants — a `const` cannot carry Sprintf output; production concatenates the `CREATE TEMPORARY TABLE` wrapper onto this exact var, one source of truth)
- Create: `packages/ingestion/db/impact_explain_test.go` — **`package db_test`**, pinned: every existing test file in that directory (`migrations_test.go`, `testhelper_test.go`, `sessions_index_test.go`) declares `package db_test`, so `disposableDB`/`migrationFiles`/`applyMigration`/`testPool` are same-package helpers, directly callable; `db_test` importing `priority` creates no cycle (`priority` imports only pgx, verified by grep). The test lives here and not in `priority` because the production rollup scans every tenant's open groups — on the shared dev database, unrelated rows make an examined-rows ratio nondeterministic; a disposable DB gives controlled statistics.

**Interfaces:**
- Consumes: Task 1's two indexes, `priority.ImpactRollupSelectSQL`, the `migrations_test.go` harness.

- [ ] **Step 1: Write the failing test.** In a disposable DB with all migrations applied: seed via `generate_series` (the `sessions_index_test.go:67` pattern), then `ANALYZE error_events; ANALYZE friction_signals; ANALYZE session_chunks`. Shape: one tenant, two error groups and one friction incident — an **open** error group with 20,000 in-window session-bearing events; 80,000 events that must not be examined (40,000 on the same open group but older than 31 days; 40,000 in-window on a **resolved** group); the friction incident with 500 accepted-active in-window signals and **20,000 aged (32+ days) but still accepted-active** signals plus 500 retracted ones. The aged-active set is what makes the friction assertion falsifiable: those rows sit inside `idx_friction_signals_incident_reach`'s partial predicate (039 orders it by `created_at`), so a plan using the old index — or a seq scan over the 20,500-row table — examines them all and blows the cap; only Task 1's `(incident_id, occurred_at)` index passes. Also seed **bounded scrubbed chunks** for a subset of the in-window sessions so the rollup's chunk join produces output — an empty branch reports zero examined rows while the plan text still name-drops indexes, so the test first runs the SELECT itself and asserts ≥1 rollup row, then EXPLAINs. Sessions can repeat (e.g. 200 distinct sessions round-robin) — the ratio under test is examined rows. Then:

```go
planJSON := explainAnalyze(t, pool, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+priority.ImpactRollupSelectSQL)
// Walk the JSON plan. For every node whose "Relation Name" is the target table, EXAMINED =
// ("Actual Rows" + "Rows Removed by Filter" + "Rows Removed by Index Recheck") * "Actual Loops".
// "Actual Rows" alone counts EMITTED rows — a seq scan that filters 80k rows down to 20k
// would pass a naive sum; the removed-rows terms are what make the metric mean "examined".
examinedEvents := sumExamined(planJSON, "error_events")
if examinedEvents > int(float64(20_000)*1.5) {
	t.Fatalf("rollup examined %d error_events rows for 20000 in-window (ratio %.2f > 1.5)", examinedEvents, float64(examinedEvents)/20_000)
}
examinedSignals := sumExamined(planJSON, "friction_signals")
if examinedSignals > int(float64(500)*3.0) {
	t.Fatalf("friction arm examined %d signal rows for 500 in-window accepted-active (ratio > 3.0; the 20k aged-active set leaked in)", examinedSignals)
}
for _, idx := range []string{"idx_error_events_group_timestamp", "idx_friction_signals_incident_occurred"} {
	if !strings.Contains(planJSON, idx) {
		t.Fatalf("rollup does not use %s; plan:\n%s", idx, planJSON)
	}
}
t.Logf("AC3.8 plan (paste into the PR):\n%s", planJSON) // BUFFERS numbers recorded here
```

  `explainAnalyze` mirrors `explainWithoutSeqScan` (`sessions_index_test.go:31`) minus the seqscan toggle — ANALYZE with real settings is the point; the examined-rows ratio and the index-name assertions together are the gate. `sumExamined` is real parsing code with its own unit test over canned plan-JSON fixtures (Seq Scan with `Rows Removed by Filter`, Index Scan, Bitmap Index + Bitmap Heap pair — counted once, not twice — and a nested-loop inner scan with `Actual Loops` > 1; absent metrics read as zero); an unverified walker would make the whole gate decorative.
- [ ] **Step 2: Run → observe.** If it fails, the index or the rollup's join order is wrong — fix the query, not the threshold.
- [ ] **Step 3: Run** `go test ./db/ -run TestImpactRollupExamined -v` (the `-v` matters: `t.Logf` output on a passing test is hidden without it, and the logged plan is the PR artifact) plus the whole `priority` and `db` packages → PASS.
- [ ] **Step 4: Commit.** `test(ingestion): impact rollup examined-rows ratio pinned at 100k events (C3, AC3.8)`

### Task 5: `SessionPointerForGroup` grows the friction branch

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go` (`SessionPointerForGroup` at `:331`)
- Test: extend `packages/ingestion/db/sessions_read_test.go` (helpers `addReadSignal` `:42`, `addReadError` `:63` already exist)

**Interfaces:**
- Consumes: `error_groups.kind`, `representative_signal_id` (written at promotion, `promotion-db.ts:765-782`), friction signal liveness/verdict columns.
- Produces: same signature — `SessionPointerForGroup(ctx, errorGroupID, projectID) (sessionID string, errorAt time.Time, ok bool, err error)` — now kind-branched. The incident read API (`read_api.go:349-351`) and the dashboard player consume it unchanged: a friction incident's page gains `session_pointer` and therefore the windowed player and the "Open full session →" link with `t = Date.parse(error_at)` — zero dashboard edits (AC3.5's surface is already built).
- Semantics: first `SELECT kind FROM error_groups WHERE id = $1 AND project_id = $2` (absent group → `ok=false`). `kind='error'`: the existing query, untouched. `kind='friction'`:

```sql
SELECT fs.session_id, fs.occurred_at
  FROM friction_signals fs
  JOIN sessions s ON s.id = fs.session_id AND s.project_id = fs.project_id
  JOIN error_groups g ON g.id = $1
 WHERE fs.incident_id = $1 AND fs.project_id = $2
   AND fs.adjudication_status = 'accepted'
   AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
   AND s.status <> 'deleting'
 ORDER BY (fs.id = g.representative_signal_id) DESC, fs.occurred_at ASC, fs.id ASC
 LIMIT 1
```

  One query, both B2 rules: the representative signal wins while it is accepted and live; a retracted/superseded/rejected representative simply fails the WHERE and the earliest accepted signal (`occurred_at ASC, id ASC`) is the fallback. No accepted signals → `ok=false` (the page keeps today's "no replay" state). No coverage gate here — the pointer is identity+offset, and the player owns graceful degradation (poll/partial/unavailable states), exactly as the error branch behaves today.

- [ ] **Step 1: Failing tests** in `sessions_read_test.go`:

```go
// friction pointer: incident with representative signal R (accepted, occurred_at T2) and an
//   earlier accepted sibling (T1) → pointer = R's session at T2 (representative wins over earliest).
// AC3.5 fallback: retract R (retracted_at = now()) → pointer = sibling's session at T1.
// superseded representative → same fallback.
// all signals rejected/retracted → ok == false.
// deleting session excluded: representative's session status='deleting' → fallback signal's session.
// error-kind regression: existing error-branch test still passes byte-identical (newest event).
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS** (`go test ./db/ -run SessionPointer` plus the package). Also grep the TS mirror's consumers (`grep -rn "getSessionPointerForGroup" packages/worker/src`) and record in the PR that they are error-lane only (or extend the mirror if that grep says otherwise — Deviation 6).
- [ ] **Step 5: Commit.** `feat(ingestion): friction incidents get a session pointer — representative signal with retraction fallback (C3/W3.2, AC3.5)`

### Task 6: `WatchableSessionForGroup` — coverage-gated pointer for links that must play

**Files:**
- Modify: `packages/ingestion/db/sessions_read.go` (new function below `SessionPointerForGroup`)
- Test: extend `packages/ingestion/db/sessions_read_test.go`

**Interfaces:**
- Produces (consumed by Task 7 and by C4's `ReceiptItem.SessionURL` producer later):

```go
// WatchableSessionForGroup returns a session pointer that is proven playable at
// its anchor: the session's scrubbed, bounded chunks must STITCH across the full
// ±15s window around the anchor (min(first_event_ms) <= anchor-15s AND
// max(last_event_ms) >= anchor+15s — a 1ms chunk at the anchor is not coverage;
// intra-span gaps are accepted in v1), and some full-snapshot chunk must start
// at-or-before the window start. anchorMs is client-clock epoch ms — the same
// value the dashboard's ?t= expects.
func (q *Queries) WatchableSessionForGroup(ctx context.Context, errorGroupID, projectID string) (sessionID string, anchorMs int64, ok bool, err error)
```

- Semantics: kind-branched like Task 5. Error branch — newest covered event among the newest `watchCandidateEvents = 50` session-bearing events (ties by newest `created_at DESC, id DESC`, matching the existing pointer's ordering):

```sql
SELECT cand.session_id, cand.anchor_ms FROM (
  SELECT e.session_id, (extract(epoch FROM e."timestamp") * 1000)::bigint AS anchor_ms,
         e.created_at, e.id
    FROM error_events e
    JOIN sessions s ON s.id = e.session_id AND s.project_id = e.project_id
   WHERE e.error_group_id = $1 AND e.project_id = $2
     AND e.session_id IS NOT NULL AND s.status <> 'deleting'
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT 50
) cand
WHERE EXISTS (
  SELECT 1 FROM session_chunks c
   WHERE c.session_id = cand.session_id AND c.project_id = $2
     AND c.scrubbed_at IS NOT NULL
     AND c.first_event_ms IS NOT NULL AND c.last_event_ms IS NOT NULL
  HAVING min(c.first_event_ms) <= cand.anchor_ms - 15000
     AND max(c.last_event_ms) >= cand.anchor_ms + 15000
)
AND EXISTS (
  SELECT 1 FROM session_chunks c2
   WHERE c2.session_id = cand.session_id AND c2.project_id = $2
     AND c2.scrubbed_at IS NOT NULL AND c2.has_full_snapshot
     AND c2.first_event_ms IS NOT NULL AND c2.last_event_ms IS NOT NULL
     AND c2.first_event_ms <= cand.anchor_ms - 15000
)
ORDER BY cand.created_at DESC, cand.id DESC
LIMIT 1
```

  Friction branch: Task 5's friction query (representative-first ordering) with the same two `EXISTS` predicates over `fs.session_id` at anchor `(extract(epoch FROM fs.occurred_at) * 1000)::bigint`. The `15000`s and the `LIMIT 50` are emitted from `watchWindowMs`/`watchCandidateEvents` via `fmt.Sprintf` the same way Task 2 parameterizes its constants — the frozen values have one source each. Terminology note: "stitched-span" here means the **bounding span** of the session's usable chunks covers the window; intra-span gaps are accepted in v1 and documented (carried forward from receipts B2 verbatim — the program's AC3.6 uses the same term with the same documented limit).

- [ ] **Step 1: Failing tests:**

```go
// AC3.6 positive: session with three chunks [T-20s..T-8s], [T-8s..T+2s], [T+2s..T+16s],
//   full snapshot on the first → covered (stitched span [T-20s, T+16s] ⊇ [T-15s, T+15s])
//   → pointer returned, anchorMs == T in epoch ms.
// AC3.6 negative: session whose only chunk is [T..T+1ms] → ok == false.
// overlap-but-not-coverage: single chunk [T-1s..T+1s] → ok == false (the old overlap
//   predicate would have passed this; the stitched-span rule is the difference under test).
// playability: three covering chunks but has_full_snapshot only on a chunk starting at
//   T-10s (> window start T-15s) → ok == false.
// NULL-bounded chunks are invisible: coverage chunks + one NULL-bounds chunk → still covered
//   (NULL rows neither help nor veto).
// newest-covered wins: event E1 (old, covered session) and E2 (new, uncovered session)
//   → E1's session returned (the newest COVERED candidate, not nothing).
// friction: representative signal's session uncovered, earlier accepted sibling covered
//   → sibling returned at its occurred_at anchor.
// unscrubbed chunks don't count: coverage chunks with scrubbed_at NULL → ok == false.
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS** (package suite; zero skips with DB up).
- [ ] **Step 5: Commit.** `feat(ingestion): watchable session pointers — stitched coverage and snapshot playability (C3/W3.2, AC3.6)`

### Task 7: Digest replay links that play, with the `?t=` anchor

**Files:**
- Modify: `packages/ingestion/digest/digest.go` (add `sessionURLAt` beside `sessionURL` at `:42-48`)
- Modify: `packages/ingestion/digest/build.go` (`buildTopNewIssues` `:200`, `buildInsights` `:96`)
- Test: extend `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: `WatchableSessionForGroup` (Task 6). The digest `Sweeper` holds only a pool — construct the queries wrapper the way `main.go` builds it for the handler (locate with `grep -n "db.New\|Queries{" packages/ingestion/main.go` and mirror; if the constructor takes the pool, build it once in `digest.New` and store it on the Sweeper).
- Produces:

```go
func (s *Sweeper) sessionURLAt(sessionID string, anchorMs int64) *string {
	if sessionID == "" || s.dashboardURL == "" {
		return nil
	}
	u := s.dashboardURL + "/sessions/" + url.PathEscape(sessionID) + "?t=" + strconv.FormatInt(anchorMs, 10)
	return &u
}
```

- Wiring: `buildTopNewIssues` drops its `COALESCE(g.representative_session_id,'')` selection (it never fired for error groups anyway — the column is friction-only); `buildInsights` drops the `(array_agg(fs.session_id ORDER BY fs.occurred_at DESC))[1]` pick. Both collect their scanned rows first, and **only after `rows.Close()`** loop the collected group ids calling `WatchableSessionForGroup(ctx, groupID, projectID)` per item (≤ `listCap = 3` per section — bounded; issuing nested queries while the cursor is open is the pool-exhaustion pattern these builders' own comments warn about), setting `ReplayURL = s.sessionURLAt(sessionID, anchorMs)` when `ok`, `nil` otherwise. The group id must be in each section's scan — `buildTopNewIssues` already selects `g.id`; add it to `buildInsights`' select if absent (read the query first). `DigestIssue`/`DigestInsight` shapes are unchanged (`ReplayURL *string` already exists) — **no payload schema change, no wire change**; v1 formatter behavior (`slackDigestLink(*ReplayURL, "Watch replay")`) is untouched.
- Behavior change, stated: an insight whose newest signal's session cannot play no longer gets a dead link — it gets no link (and the C1-era test expectation `ReplayURL == …/sessions/SessIn2` changes accordingly). A link that exists now proves coverage.

- [ ] **Step 1: Failing tests** in `build_test.go`:

```go
// Extend seedDigestFixture (or a sibling seeder) to add session_chunks:
//   SessIn2 (the newest-signal session): one 1ms chunk at its signal time → NOT watchable.
//   SessIn1 (older accepted signal): three stitched chunks covering ±15s + full snapshot → watchable.
// TestBuildDigestReplayLinksRequireCoverage:
//   buildInsights → insight.ReplayURL == "https://dash.example/sessions/"+SessIn1+"?t="+<SessIn1 signal ms>
//   (the covered fallback, not the uncovered newest — the old expectation is deleted, not kept).
// error issue: seed the fp-new group's event with a covered session → issue.ReplayURL carries ?t=<event ms>;
//   remove the chunks → ReplayURL nil.
// TestDigestExcerptAndSessionURLHelpers extended: sessionURLAt("a/b", 123) == ".../sessions/a%2Fb?t=123";
//   sessionURLAt("", 5) == nil.
```

  Existing digest tests that asserted the old newest-signal link (`TestBuildDigestSections:195`) are **updated in this task** — enumerate every changed expectation in the PR description (they are the visible spec of Deviation 4).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS**: `go test ./digest/` and the ingestion build; confirm `git diff -- test-fixtures/wire/` is empty.
- [ ] **Step 5: Commit.** `feat(digest): replay links prove coverage and land at the moment of impact (C3/W3.2)`

### Task 8: Migration 047 — the readiness backfill (W3.B)

**Files:**
- Create: `packages/ingestion/db/migrations/047_readiness_backfill.sql`
- Test: `packages/ingestion/db/migration_047_test.go` (create; harness from `migrations_test.go` + the 045 test's shape)

**Interfaces:**
- Consumes: `digest_readiness`, `applied_data_migrations`, `diagnosis_decisions` (camelCase `diagnosis` JSONB keys per the C0 case rule — `evidence` is a camelCase-side key).
- Produces: every **open** incident enters the projection; C1's absent-row clause becomes vestigial (C4 deletes it when flipping to eligible-only). Classification, mechanical and frozen:
  - `receipt_state` := `status IN ('pr_created','pr_draft')` (both are `error_group_status` enum values — `pr_draft` added by `015_draft_prs.sql:4`) OR (`status = 'needs_human'` AND (a non-empty `candidate_diff` OR **usable** verification evidence)) — an attempt artifact exists; the receipt is the artifact, not the prose. "Usable evidence" is a defined predicate, not `IS NOT NULL` (which would count JSON `null`, `{}`, or empty text): a `checks` array with ≥1 element whose `name` is a non-empty string (`EvidenceRecord.checks` is the persisted executed-check list, `shared/src/types.ts:232` — `[null]` or `[{}]` elements fail the name check).
  - `validated_cause` := the group's **latest** decision row has `outcome IN ('code_fix','not_actionable')` and the frozen C1 validity shape, checked structurally: ≥1 evidence element, **every** element carrying non-empty `path`/`detail`/`symptomLink`, and — for `code_fix` — a non-empty `agentTaskBrief` that fails the anchored filler regex (`^\s*(placeholder|tbd|to be determined)\M`, 045's spelling). Expectation, recorded: C1 writes decisions and readiness **in one transaction**, so this arm should match ≈0 rows — it exists for crash-window stragglers, and the runbook records its actual match count so a surprise is visible. (Deliberate limit, mirroring C1's recorded rationale: the migration checks structure, not re-verified citations against a checkout — mechanical re-verification is a checkpoint activity, not a boot-time data migration.)
  - Everything else open → `('pending', 'backfill_unverified')` — the honest-state flip for the unverified legacy book (see the Global Constraints deploy note).
  - Closed incidents (`resolved`/`merged`/`archived`) stay absent-row, per the program's "every existing open incident." Recorded for C4: C1's interim gate covers all five digest sections including `PRsMerged`, but it only *excludes* `ineligible`/`pending` rows — closed groups keep rendering there because they are absent-row, and this backfill keeps them absent. C4's eligible-only flip must therefore either scope the merged section out of the flip or backfill closed receipts itself — its decision, recorded here so it isn't discovered as a surprise.
  - The headline invariant, asserted in the test and the runbook: after 047, **zero open incidents lack a readiness row** — per-arm counts can look plausible while rows are omitted; the anti-join is the proof.

```sql
-- 047_readiness_backfill.sql
-- C3/W3.B: classify every open incident into digest_readiness, retiring C1's
-- absent-row policy before C4 flips the digest to eligible-only.
-- One-shot via applied_data_migrations: pipeline-written rows must never be
-- overwritten by a boot replay. IDEMPOTENCY IS MANDATORY.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '047_readiness_backfill') THEN
    INSERT INTO digest_readiness (incident_id, project_id, status, reason)
    SELECT g.id, g.project_id,
           CASE WHEN c.receipt_state OR c.validated_cause THEN 'eligible' ELSE 'pending' END,
           CASE WHEN c.receipt_state THEN 'backfill_receipt_state'
                WHEN c.validated_cause THEN 'backfill_validated_cause'
                ELSE 'backfill_unverified' END
      FROM error_groups g
      CROSS JOIN LATERAL (
        SELECT
          (g.status IN ('pr_created','pr_draft')
           OR (g.status = 'needs_human'
               AND (NULLIF(btrim(g.candidate_diff), '') IS NOT NULL
                    OR (CASE WHEN jsonb_typeof(g.verification_evidence->'checks') = 'array'
                             THEN EXISTS (
                               SELECT 1 FROM jsonb_array_elements(g.verification_evidence->'checks') chk
                                WHERE btrim(coalesce(chk->>'name','')) <> ''
                             )
                             ELSE false END)))) AS receipt_state,
          EXISTS (
            SELECT 1
              FROM (SELECT d.outcome, d.diagnosis
                      FROM diagnosis_decisions d
                     WHERE d.error_group_id = g.id AND d.project_id = g.project_id
                     ORDER BY d.decided_at DESC, d.id DESC
                     LIMIT 1) latest
             WHERE latest.outcome IN ('code_fix','not_actionable')
               AND (CASE WHEN jsonb_typeof(latest.diagnosis->'evidence') = 'array'
                         THEN jsonb_array_length(latest.diagnosis->'evidence') >= 1
                          AND NOT EXISTS (
                            SELECT 1 FROM jsonb_array_elements(latest.diagnosis->'evidence') e
                             WHERE btrim(coalesce(e->>'path',''))        = ''
                                OR btrim(coalesce(e->>'detail',''))      = ''
                                OR btrim(coalesce(e->>'symptomLink','')) = ''
                          )
                         ELSE false END)
               AND (latest.outcome <> 'code_fix'
                    OR (NULLIF(btrim(latest.diagnosis->>'agentTaskBrief'), '') IS NOT NULL
                        AND latest.diagnosis->>'agentTaskBrief' !~* '^\s*(placeholder|tbd|to be determined)\M'))
          ) AS validated_cause
      ) c
     WHERE g.status NOT IN ('resolved','merged','archived')
       AND NOT EXISTS (SELECT 1 FROM digest_readiness dr WHERE dr.incident_id = g.id)
    ON CONFLICT (incident_id) DO NOTHING;
    INSERT INTO applied_data_migrations (name) VALUES ('047_readiness_backfill');
  END IF;
END
$$;
```

  (`ON CONFLICT DO NOTHING` is belt-and-braces under the `NOT EXISTS` — a worker writing a row mid-migration must win. Verify the `diagnosis_decisions` sort column is `decided_at` by reading the table DDL before implementing; if it differs, follow the DDL — the "latest decision" semantic is the contract.)

- [ ] **Step 1: Write the failing test** (`migration_047_test.go`, disposable DB, apply through 046 first): seed one project and one group per matrix row below (rows that name a sibling seed two), then apply 047 and assert each row:

| seed | expected row |
| --- | --- |
| `status='pr_draft'` | `('eligible','backfill_receipt_state')` |
| `status='pr_created'` | `('eligible','backfill_receipt_state')` |
| `status='needs_human'`, `candidate_diff='diff --git …'` | `('eligible','backfill_receipt_state')` |
| `status='needs_human'`, no diff, no evidence | `('pending','backfill_unverified')` |
| `status='needs_human'`, `verification_evidence='{}'` (empty object) | `('pending','backfill_unverified')` |
| `status='needs_human'`, `verification_evidence='null'::jsonb` | `('pending','backfill_unverified')` — and the migration does not throw |
| `status='needs_human'`, `verification_evidence='{"checks":[{"name":"suite"}]}'` | `('eligible','backfill_receipt_state')` |
| `status='needs_human'`, `verification_evidence='{"checks":[null]}'` and a sibling with `'{"checks":[{}]}'` | `('pending','backfill_unverified')` (elements without a non-empty name are not usable evidence) |
| `status='investigated'`, latest decision `code_fix`, sound evidence but `agentTaskBrief` absent (and a sibling with `agentTaskBrief='tbd'`) | `('pending','backfill_unverified')` (the frozen validity shape requires a non-filler brief for code_fix) |
| `status='investigated'`, latest decision `code_fix` with `diagnosis: {"evidence":[{"path":"a.ts","detail":"d","symptomLink":"s"}]}` | `('eligible','backfill_validated_cause')` |
| `status='investigated'`, latest decision `code_fix`, no `evidence` key (legacy) | `('pending','backfill_unverified')` |
| `status='investigated'`, latest decision `code_fix`, `diagnosis: {"evidence":"corrupt"}` (scalar) | `('pending','backfill_unverified')` — no throw (the CASE guards `jsonb_array_length`) |
| `status='investigated'`, latest decision `code_fix`, `evidence: [{"path":"a.ts","detail":"","symptomLink":"s"}]` | `('pending','backfill_unverified')` (empty citation field fails the shape check) |
| `status='resolved'` | **no row** |
| `status='new'`, pre-existing readiness row `('ineligible','quarantined_degenerate')` | row **unchanged** |

  Plus the headline invariant: `SELECT count(*) FROM error_groups g WHERE g.status NOT IN ('resolved','merged','archived') AND NOT EXISTS (SELECT 1 FROM digest_readiness dr WHERE dr.incident_id = g.id)` → **0** after apply.
  Then: apply 047 again → zero new rows and the quarantined row still untouched (marker respected); flip one backfilled row to `('eligible','validated_cause')` and apply again → still `validated_cause` (one-shot proven against pipeline overwrites). Decision-row seeding must satisfy 034's trigger discipline — copy the INSERT shape `migration_045_test.go` or `error_group_ingestion_test.go` uses for decision rows (read first).
- [ ] **Step 2: Run → FAIL** (047 absent). **Step 3: Write the migration. Step 4: Run → PASS**, plus `go test ./db/ -run TestMigration` (the umbrella idempotency/roll-forward suites absorb 047).
- [ ] **Step 5: Commit.** `feat(db): readiness backfill classifies the legacy book — absent-row policy retired (C3/W3.B)`

### Task 9: Friction fix routing reads the impact bar, not confidence

Discharges C2 Task 3's frozen rung (`// C3 replaces this confidence check with the signal-session impact bar…`). Program authority: decision 3 (any usable `code_fix` on an issue meeting the impact bar gets an attempt) and the global constraint (confidence out of routing). The friction autonomy opt-in (`friction_autonomy = 'auto_fix'`) is a customer setting, not a self-grade — it stays. **Honesty note for the reviewer:** bucket promotion already requires ≥5 identified users (`PROMOTION_THRESHOLD_USERS`), so promoted friction incidents virtually always pass the ≥1-identified bar — the change's value is uniformity and the recorded `policy_basis`, plus correctness for edge incidents whose users aged past the 7-day window; it is not a wide behavior swing. AC3.9 is plan-added (CP3 in the program plan predates C2's freeze decision).

**Files:**
- Modify: `packages/worker/src/db.ts` — new `getFrictionGroupImpactBar` beside the error-lane `getGroupImpactBar` (C2 Task 2)
- Modify: `packages/worker/src/index.ts` — the friction verdict branch (locate the C2 freeze comment; the rung is the `verdict.confidence === 'high' && autonomyAllowsFix` conjunction)
- Test: extend `packages/worker/src/__tests__/db.test.ts` (DB-gated) and `packages/worker/src/__tests__/index.test.ts` (mock seams `vi.mock('../db.js')`)

**Interfaces:**
- Produces:

```ts
/** Live impact bar over the incident's accepted, active friction-signal sessions.
 *  Same thresholds and ImpactBar type as the error lane (C2 Task 2). The 7-day
 *  window uses server-observed created_at, matching the sweeper's friction-reach
 *  discipline (sweeper.go frictionReach) — an authorization input should not ride
 *  the client clock (003's comment scopes client event times to playback
 *  arithmetic; the impact ROLLUP uses occurred_at because it compares against
 *  chunk event ms, which is exactly that playback domain). */
export async function getFrictionGroupImpactBar(errorGroupId: string, projectId: string): Promise<ImpactBar> {
  const res = await pool.query(
    `SELECT
       (SELECT count(DISTINCT fs.end_user_id) FROM friction_signals fs
         WHERE fs.incident_id = $1 AND fs.project_id = $2
           AND fs.end_user_id IS NOT NULL
           AND fs.adjudication_status = 'accepted'
           AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
           AND fs.created_at > now() - interval '7 days') AS identified_users,
       (SELECT count(*) FROM (
          SELECT fs.session_id FROM friction_signals fs
           WHERE fs.incident_id = $1 AND fs.project_id = $2
             AND fs.adjudication_status = 'accepted'
             AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
             AND fs.created_at > now() - interval '7 days'
           GROUP BY fs.session_id
           HAVING bool_and(fs.end_user_id IS NULL)
        ) anon) AS recent_anon_sessions`,
    [errorGroupId, projectId],
  );
  const identifiedUsers = Number(res.rows[0].identified_users);
  const recentAnonSessions = Number(res.rows[0].recent_anon_sessions);
  return { identifiedUsers, recentAnonSessions, eligible: impactBarEligible(identifiedUsers, recentAnonSessions) };
}
```

  **One threshold source:** the eligibility expression is a shared pure helper, not restated. If C2 landed it inline in `getGroupImpactBar`, this task extracts `export function impactBarEligible(identifiedUsers: number, recentAnonSessions: number): boolean { return identifiedUsers >= 1 || recentAnonSessions >= 3; }` and points **both** bar functions at it (pure refactor; C2's error-lane bar tests must pass unmodified — that is the proof the thresholds didn't drift). The values are the design's (decision 3: "≥1 identified user or ≥3 recent anonymous sessions"); CP2's AC2.1 seeding of 2 users is a comfortably-above-bar fixture, not a different threshold.
  Note `friction_signals.session_id` is `NOT NULL` by schema (`004_friction.sql:37`), so the anon subquery needs no NULL-session guard — unlike the error lane, where `error_events.session_id` is nullable.

- Routing: in the friction verdict branch, for `codeCause` verdicts compute the bar once; the auto-fix rung becomes `bar.eligible && autonomyAllowsFix` (the `verdict.confidence === 'high'` conjunct and the freeze comment die); below-bar or non-auto-fix parks at `'awaiting_approval'` exactly as today. The friction `code_fix` decision row gains `policyEligible: bar.eligible, policyBasis: { v: 1, identified_users: bar.identifiedUsers, recent_anon_sessions: bar.recentAnonSessions }` (C2's `DecisionRow` fields; non-`code_fix` friction decisions keep NULLs, mirroring the error lane). `verdict.confidence` still flows to storage. The human approval path and C1's report-only guard are untouched.

- [ ] **Step 1: Failing tests.** `db.test.ts` (DB-gated): bar boundaries over seeded signals — 1 identified user → eligible; 0 identified + 3 anon sessions → eligible; 0 + 2 → not; a session with one identified and one anonymous signal is not anonymous (`bool_and`); retracted/pending signals don't count; signals with `created_at` older than 7 days don't count even when `occurred_at` is recent (the server-clock window pinned). `index.test.ts` (AC3.9):

```ts
it('AC3.9: identical friction codeCause verdicts with different confidence route identically', async () => {
  for (const confidence of ['high', 'low'] as const) {
    vi.mocked(investigateFriction).mockResolvedValueOnce(frictionVerdict({ codeCause: true, confidence }));
    vi.mocked(db.getFrictionGroupImpactBar).mockResolvedValueOnce({ identifiedUsers: 5, recentAnonSessions: 0, eligible: true });
    await processFrictionInvestigateJob(makeJob({ jobType: 'friction_investigate' }), signal());
  }
  expect(vi.mocked(db.updateGroupAndCreateFixJob)).toHaveBeenCalledTimes(2); // both attempted
  for (const call of vi.mocked(db.updateGroupAndCreateFixJob).mock.calls) {
    expect(call[2].decision).toMatchObject({          // the TRUE side is stamped too, exactly
      policyEligible: true,
      policyBasis: { v: 1, identified_users: 5, recent_anon_sessions: 0 },
    });
  }
});
it('AC3.9: below-bar friction codeCause parks awaiting_approval with policy_eligible=false and basis', async () => {
  vi.mocked(db.getFrictionGroupImpactBar).mockResolvedValueOnce({ identifiedUsers: 0, recentAnonSessions: 1, eligible: false });
  // → no fix job; updateGroupInvestigation called with 'awaiting_approval' and decision
  //   { policyEligible: false, policyBasis: { v: 1, identified_users: 0, recent_anon_sessions: 1 } }
});
it('autonomy still gates: eligible bar but friction_autonomy ask_first → awaiting_approval, no fix job', ...);
it('report-only friction jobs still never create a fix job even above the bar', ...);
```

  The C2 Task 3 pin ("friction auto_fix rung is byte-for-byte unchanged") asserted the *old* semantics — it is **replaced** by AC3.9's pair in this task, not kept alongside (its purpose was to freeze the rung until C3; C3 is here).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement. Step 4: Run → PASS** (full worker suite, with and without `DATABASE_URL`).
- [ ] **Step 5: Commit.** `feat(worker): friction fix routing reads the signal-session impact bar, confidence retired (C3, AC3.9)`

### Task 10: CP3 verification run

No new production code. Prove the checkpoint criteria (program §CP3) plus plan-added AC3.9, then the repository gate. Use the worktree port block from root `AGENTS.md` if the default ports are taken; export the full env block as a unit.

- [ ] **Step 1: Full gate.** `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` with `DATABASE_URL` exported (read skip counts); `(cd packages/ingestion && go build ./... && go test ./...)` → **zero skips**; `docker compose config --quiet`.
- [ ] **Step 2: AC3.1–AC3.4, AC3.6 drivable.** These run as the DB-gated tests from Tasks 2/3/6 driving the real sweeper and queries (seed → `RunOnce` → assert columns). Re-run them against the live stack's database once (`go test ./priority/ ./db/` with the stack's `DATABASE_URL`) and record outputs.
- [ ] **Step 3: AC3.5 drivable — playback, not just a URL.** On the dev stack: seed a friction incident with two accepted signals via the `bucket-promotion` seed shapes (or drive `test-e2e/friction-incidents.test.ts`'s `analyzeSessionInProcess` path), **with real scrubbed chunks for the fallback signal's session** (the e2e chunk builders `rageChunk`/`stepperChunk` produce playable rrweb data — the criterion says "player loads", and a correct URL over an unplayable session would pass a URL-only check while failing the criterion). Stamp one signal as representative, retract it with SQL, load the incident page → the player reaches its ready state on the fallback signal's session at the signal's offset (not the "no replay" fallback text), and "Open full session →" carries `?t=` equal to the fallback signal's `occurred_at` in epoch ms. Screenshot + SQL output recorded.
- [ ] **Step 4: AC3.6 drivable (digest half).** Seed the three-stitched-chunks session and the 1ms-chunk session from Task 7's fixture; build a digest (`Sweeper.Build`) → the covered session's item carries `?t=`; the 1ms one carries no replay link.
- [ ] **Step 5: AC3.7 drivable — transitions written by pipeline and migration, never seeded.** (a) Drive a valid investigation through the real pipeline (the C1 `anthropic-stub.mjs` scripted-verdict rig at `test-e2e/support/`) → readiness `('eligible','validated_cause')` written by the worker. (b) Drive a fix attempt to a terminal outcome (C2's CP2 rig — requires C2 merged) → readiness carries the receipt reason (`fix_pr_opened` or `fix_attempt_failed_*`). (c) Apply 047 on a database seeded with the legacy book from Task 8's table → rows land per the classification matrix. All three asserted with read-only SQL, outputs recorded.
- [ ] **Step 6: AC3.8 [gate].** Task 4's test output (ratio + BUFFERS plan) pasted into the PR; reviewer sign-off on the index review recorded there.
- [ ] **Step 7: Backfill prod runbook (pre-release).** Against a prod copy via `~/deploy/scripts/prod-sql.sh`: run 047's SELECT (without the INSERT) grouped by the CASE arms → record per-class counts and the eligible IDs in the PR. Sanity: `eligible` counts should roughly match open `pr_created`/`pr_draft`/diff-bearing `needs_human` groups; a surprise (e.g. thousands eligible) stops the release. The predicate stays content-driven rather than count-asserted in the migration itself — a group arriving between rehearsal and boot *should* be classified (C1's recorded rationale for 045 applies verbatim) — but two operational gates are hard:
  1. **Impact-first gate:** before the 047 release, confirm the **deployed** sweeper completed a pass against prod — `SELECT max(impact_computed_at) FROM error_groups` is later than the recorded PR1 deploy timestamp (a bare `count(*) > 0` would accept a stale or manual stamp), corroborated by the sweeper's pass log line.
  2. **Post-apply invariant:** the headline anti-join (open incidents with no readiness row) must return 0.
  Recovery path, recorded here so the one-shot marker is not a trap. Preferred: **correct misclassified rows in place** (`UPDATE digest_readiness SET status = …, reason = … WHERE incident_id = ANY(…)`) — targeted, no surface flapping. Last resort, one transaction so no partial state is ever visible: `BEGIN; DELETE FROM digest_readiness WHERE reason IN ('backfill_receipt_state','backfill_validated_cause','backfill_unverified'); DELETE FROM applied_data_migrations WHERE name = '047_readiness_backfill'; COMMIT;` — removes only migration-written rows (pipeline rows carry other reasons) and re-arms the migration. Stated plainly: the full rollback restores the pre-047 surface, **including** legacy prose rendering via the absent-row policy — that is what "roll back" means here, and it is why in-place correction is preferred.
  After deploy: re-run the counts live, confirm the digest build excludes `pending` legacy, and spot-check one `pending` incident page for the honest state.
- [ ] **Step 8:** Run `/opslane-verify:verify` with the CP3 drivable criteria (AC3.1–AC3.7) as the pre-drafted half, per the program's verification method.

## CP3 criteria → task map

| AC | Covered by |
|---|---|
| AC3.1 (schippers shapes → blocked/degraded) | Task 2; Task 10 Step 2 |
| AC3.2 (friction incident degraded 2/1) | Task 3; Task 10 Step 2 |
| AC3.3 (NULL-bounded chunks → all NULL) | Task 2; Task 10 Step 2 |
| AC3.4 (age-out clears once, row version stable) | Task 2 (xmin test); Task 10 Step 2 |
| AC3.5 (retracted representative → fallback plays at offset) | Task 5 (query), C1 surfaces (player); Task 10 Step 3 |
| AC3.6 (three stitched chunks → pointer; 1ms chunk → none) | Tasks 6–7; Task 10 Step 4 |
| AC3.7 (pipeline-written transitions + backfill rules) | C1/C2 writers witnessed + Task 8; Task 10 Step 5 |
| AC3.8 [gate] (examined-rows ratio, buffers in PR) | Tasks 1, 4; Task 10 Step 6 |
| AC3.9 (plan-added: friction bar routing, confidence inert) | Task 9 |

## Execution notes

- Tasks 1–8 depend only on C1 being merged; Task 9 and Task 10 Step 5(b) require C2. If C2's merge slips, PR1–PR3 proceed and PR4 waits — the frozen rung stays frozen, which is exactly its contract.
- The impact pass and the backfill are independent; the deploy order that matters is PR3 (backfill) after PR1/PR2 are live, so the digest that legacy incidents vanish from is the same digest whose remaining links play and whose eligible incidents carry impact stamps.
- Deliberate non-goals: no impact fields on the incident DTO or PR body (C5 owns rendering); no `ReceiptItems`/`SessionURL` production (C4 owns the payload); no eligible-only digest flip (C4); no re-evaluation of parked below-bar incidents when later signals cross the bar (the error lane's documented v1 limitation applies to friction identically); no session-facts backfill coupling (#314 stays off every critical path).
- The `priority` package's DB-gating differs from `db`'s (skip only on unset `DATABASE_URL`, fatal on unreachable) — new tests follow their host package's convention, and `check-go-skips.mjs` counts stay green.

## Revision log

**v2 after Codex round 1 (26 findings: 13 P1, 12 P2, 1 P3; Codex's sandbox could not read repo files — bwrap bootstrap failure, same as C1 round 1 — so findings are plan-internal; source-dependent ones were verified by direct grep before folding).** Accepted: both-bounds chunk filter in the rollup (`first_event_ms IS NOT NULL` added; half-NULL test case added); stamp UPDATE re-checks open status; stale-clear guards on any of the four impact columns; composite `(project_id, session_id)` chunk predicate; xmin witness moved off `RunOnce` onto direct `stampImpact` calls (the scoring pass rewrites `priority_scored_at` every sweep — source-confirmed at `sweeper.go:100/:150` — so the original test design could never pass); AC3.8 examined-rows metric redefined as `Actual Rows + Rows Removed by Filter/Recheck` × loops with an index-name assertion (Actual Rows alone counts emitted rows); explain test moved to the db package on a disposable DB (the rollup is cross-tenant; the shared dev DB makes ratios nondeterministic) with the rollup SQL exported as `priority.ImpactRollupSelectSQL`; friction-arm examined ratio added to the same test; `-v` on the test command so the logged plan artifact is visible; playability EXISTS gains `last_event_ms IS NOT NULL`; `watchCandidateEvents` bound into the SQL via Sprintf; 046 invalid-index guard schema-qualified; 046 test asserts column order; 047 `jsonb_array_length` wrapped in CASE (Postgres does not guarantee AND short-circuit; scalar/`null` evidence must not throw — test rows added); `verification_evidence IS NOT NULL` replaced with a usable-evidence predicate (≥1 recorded check); `validated_cause` strengthened to structural citation-shape checking (non-empty path/detail/symptomLink per element); headline invariant added (zero open incidents without a readiness row, in test and runbook); AC3.5 runbook requires actual playback via seeded playable chunks, not URL correctness; sweep-completed gate before the 047 release; documented rollback SQL for the backfill (reason-scoped DELETE + marker re-arm); `PRsMerged` rationale corrected (C1 gates all five sections; closed groups render because absent-row, and stay absent — C4's flip must scope accordingly); "stitched-span" glossed as bounding-span with the documented v1 gap acceptance. Rejected, with rationale: (R1#7) `friction_signals.session_id` is `NOT NULL` by schema (`004_friction.sql:37`) — no NULL-session guard needed in the friction bar; (R1#8's threshold claim) the ≥1/≥3 values are design decision 3's, and CP2's 2-user seed is an above-bar fixture, not a different bar — the shared-helper half of the finding was accepted; (R1#19) `applied_data_migrations` is created in `028_project_api_keys.sql:28` (source-confirmed by grep; C1's "since 038" described the guard-shape example, not the table's home); (R1#23) wiring the digest links is carried-forward receipts-B2 scope ("per-issue watchable session selection" modifies `digest/build.go`) and AC3.6's drivable witness needs a consumer — C4 owns the receipt payload, not the v1 sections' link column.

**v3 after Codex round 2 (18 findings: 10 P1, 7 P2, 1 P3; load-bearing sources inlined into the prompt this round — Codex confirmed both source-dependent round-1 rejections).** Accepted (source-confirmed by direct grep before folding): session seed status `'recording'` (002's CHECK rejects `'active'`); explain test pinned to `package db_test` (every db test file already declares it, so `disposableDB`/`migrationFiles` are same-package helpers; `priority` imports no db package — no cycle); friction policy bar windows on server-observed `created_at` (the sweeper's friction-reach discipline; 003 scopes client event times to playback arithmetic — the rollup keeps `occurred_at` because chunk event ms are that domain, divergence recorded in both tasks); `validated_cause` requires the full frozen validity shape (non-filler `agentTaskBrief` for `code_fix`) with the recorded expectation that the arm matches ≈0 rows (C1 writes decision+readiness transactionally) and the runbook records its actual count; usable-evidence predicate requires ≥1 check element with a non-empty `name` (`[null]`/`[{}]` fail); friction planner assertion made falsifiable (20k aged-but-active accepted signals seeded; a seq scan or the 039 `created_at` index blows the cap) with a new 046 index `idx_friction_signals_incident_occurred` on `(incident_id, occurred_at)` under the accepted-active partial predicate; planner fixture seeds bounded chunks and asserts the SELECT returns ≥1 rollup row before EXPLAINing (empty-branch zero-examined false pass); `sumExamined` walker gets unit fixtures (seq/index/bitmap-pair-counted-once/loops, absent metrics = 0); rollback reframed — in-place correction preferred, full rollback transactional and plainly labeled as restoring the pre-047 surface including legacy prose; impact-first gate sharpened to `max(impact_computed_at)` after the recorded PR1 deploy time plus the pass log; xmin reads through the held `conn` (pool deadlock); digest watchable lookups explicitly after `rows.Close()` (the builders' own pool-exhaustion warning); `ImpactRollupSelectSQL` specified as an exported `var` built by Sprintf (a `const` cannot carry it); AC3.9 asserts the true-side `policyEligible`/`policyBasis` stamp, not just call counts; fixture-count wording fixed (one group per matrix row). Rejected, with rationale: (R2#2) `pr_draft` **is** an `error_group_status` enum value — added by `015_draft_prs.sql:4` (`ALTER TYPE … ADD VALUE`), outside the migrations Codex was shown; the 047 predicate stands.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 13 P1 / 12 P2 / 1 P3; R2: 10 P1 / 7 P2 / 1 P3; 39 accepted (5 partial), 5 rejected with recorded rationale |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | — |

**CODEX:** Two consult-mode iterations (session `019fee8c`, resumed from the program's C0–C2 reviews). Round 1 (sandboxed from source; plan-internal): chunk-bounds asymmetry, EXPLAIN Actual-Rows semantics, shared-DB plan nondeterminism, the jsonb short-circuit throw in 047, weak evidence/citation predicates, the xmin witness broken by the scoring pass, the missing headline invariant, URL-only AC3.5, and deploy-order gaps. Round 2 (load-bearing sources inlined; both source-dependent round-1 rejections confirmed): the illegal session-status seed, test-package mechanics, client-clock authorization windows, falsifiability of the friction planner assertion plus the missing `(incident_id, occurred_at)` index, `[null]`-element evidence, rollback surface-flap honesty, and the pool-deadlock xmin read. All P1/P2s folded into v2/v3 except five rejected with recorded rationale (NOT-NULL friction session ids; design-decision thresholds; the `applied_data_migrations` home; digest-link wiring as carried-forward B2 scope; `pr_draft`'s enum membership via 015).

**VERDICT:** CODEX CLEARED after two iterations — eng review not yet run (recommended before execution, matching the program plan's own review posture).

NO UNRESOLVED DECISIONS
