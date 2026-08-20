# Opslane Pipeline Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous write-time grouping with an asynchronous pipeline where identity settles after stack resolution, a cheap mechanical filter and an inquiry gate investigation, and a daily AI pass writes the customer's message from completed work.

**Architecture:** Capture stores observations and decides nothing. A worker resolves stacks to source locations; Go binds fingerprints to a stable issue through an alias table rather than rewriting keys. A mechanical filter answers "enough reach, recently, in scope"; an inquiry with read-only repository access answers "is this a real product problem". Only work passing both is investigated. Postgres stays the queue.

**Tech Stack:** Go 1.24 (chi, pgx) in `packages/ingestion`; Node 22 + TypeScript (vitest) in `packages/worker`; PostgreSQL; Cloudflare R2 for recordings and source maps.

**Spec:** `docs/superpowers/specs/2026-08-15-pipeline-architecture-design.md`, with build order in `docs/superpowers/specs/2026-08-16-pipeline-implementation-plan.md` and decisions in `docs/superpowers/specs/2026-08-16-pipeline-design-record.md`.

## Global Constraints

- **Next migration number is 054.** The highest present is `053_delivery_policy.sql`.
- **Every migration must be reapply-safe.** `run-migrations.sh` re-applies every file on every start. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and `DO $$ ... IF NOT EXISTS ... END $$` guards for constraints.
- **Never edit or delete a frozen fixture under `test-fixtures/wire/`.** New grouping fixtures live elsewhere. The `POST /api/v1/events` request contract is append-only.
- **Do not introduce Redis, BullMQ, or a workflow engine.** Postgres is the queue.
- **Every new table carries `project_id`** and is scoped by it in every query.
- **The version column is `rule_version`** (singular), matching `friction_signals.rule_version`. Not `rules_version`.
- **Nothing may read `sample_event_id`** for identity, evidence selection, or investigation. `db/queries.go:588` rewrites it on every event.
- **Go alone computes fingerprints.** TypeScript writes a structured envelope; Go normalizes, serializes, and hashes.
- **New server-side packages default to `AGPL-3.0-only`.**
- **Go DB tests follow the existing guard**: read `os.Getenv("DATABASE_URL")`, `pgxpool.New`, and `t.Skipf` when unreachable (`digest/build_test.go:23-33`). Before accepting the cutover candidate, confirm **zero** skipped Go tests.
- **Worker tests are vitest**, colocated in `packages/worker/src/__tests__/`, run with `pnpm --filter @opslane/worker test`.

## Deploy boundaries

Tasks 1 through 4 ship to production alone. Tasks 5 through 29 accumulate in one release candidate and are **not deployed individually**: Task 8 stops the request creating issues, and nothing creates them again until Tasks 12 and 14A settle identity and Tasks 18 and 19A admit work. Task 30 performs the cutover. Lettered tasks (12A, 14A, 16A, 19A, 25A, 28A) sit in sequence at their number and carry the same rules as the rest.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/ingestion/db/migrations/054_pipeline_rewrite.sql` | All new tables, inert until used |
| `packages/ingestion/grouping/fingerprint.go` | Asset-hash regex fix (Task 3) |
| `packages/ingestion/identity/` | New Go package: alias lookup, settlement, conflicts |
| `packages/ingestion/identity/settle.go` | `Settle(ctx, observationID)` and its transaction |
| `packages/ingestion/identity/alias.go` | Alias binding and conflict recording |
| `packages/ingestion/identity/canonical.go` | Canonical string from the resolved envelope |
| `packages/ingestion/filter/` | New Go package: the cheap filter |
| `packages/ingestion/filter/evaluate.go` | `Evaluate(ctx, roundID)` and decision append |
| `packages/ingestion/digest/freeze.go` | Daily candidate freeze |
| `packages/ingestion/digest/validate.go` | Validation of AI-written payloads |
| `packages/worker/src/resolve/` | Resolution job and position cache |
| `packages/worker/src/inquiry/` | Inquiry prompt, schema, and job |
| `packages/worker/src/product-context/` | Repository understanding job |
| `packages/worker/src/digest-writer/` | Daily writing job |
| `test-fixtures/grouping/resolved-envelope-v2.json` | Shared Go/TS golden fixture |

---

# Slice 0: repair the current message (deploys alone)

### Task 1: Filter digest cards on occurrence time

**Files:**
- Modify: `packages/ingestion/digest/build.go:64`
- Test: `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: no new symbols; changes the WHERE clause of `receiptItemsFromClause`

The digest currently selects on `digest_readiness.updated_at`, which is bookkeeping, not occurrence time. Two independent bugs follow: stale problems appear, and `worker/src/db.ts:141-147` only bumps `updated_at` when status or reason changed, so a re-investigation landing on the same values freezes a row out of every future window.

- [ ] **Step 1: Write the failing test**

```go
func TestReceiptItemsExcludeStaleProblems(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	// Readiness updated inside the window, but the problem stopped 10 days ago.
	staleID := seedEligibleGroup(t, pool, projectID, seedOpts{
		LastSeen:          time.Now().Add(-10 * 24 * time.Hour),
		ReadinessUpdated:  time.Now().Add(-1 * time.Hour),
	})
	freshID := seedEligibleGroup(t, pool, projectID, seedOpts{
		LastSeen:         time.Now().Add(-2 * time.Hour),
		ReadinessUpdated: time.Now().Add(-1 * time.Hour),
	})

	items, err := ReceiptItems(ctx, pool, projectID,
		time.Now().Add(-24*time.Hour), time.Now())
	if err != nil {
		t.Fatalf("ReceiptItems: %v", err)
	}
	ids := map[string]bool{}
	for _, it := range items {
		ids[it.IncidentID] = true
	}
	if ids[staleID] {
		t.Errorf("stale problem (last_seen 10d ago) must not appear")
	}
	if !ids[freshID] {
		t.Errorf("fresh problem must appear")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -run TestReceiptItemsExcludeStaleProblems -v`
Expected: FAIL, stale problem appears in the item list.

- [ ] **Step 3: Add the liveness predicate**

In `receiptItemsFromClause`, keep the readiness window and add a liveness bound on the group:

```go
AND dr.updated_at >= $2 AND dr.updated_at < $3
AND g.last_seen >= now() - interval '7 days'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -run TestReceiptItemsExcludeStaleProblems -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/digest/build.go packages/ingestion/digest/build_test.go
git commit -m "fix(digest): exclude problems that stopped occurring"
```

---

### Task 2: Render approval states as requests

**Files:**
- Modify: `packages/ingestion/digest/build.go:186-198`
- Test: `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: `receiptState` returns `awaiting_approval` and `pr_draft` distinctly

`receiptState` has a catch-all `default: return "report_ready"` that swallows `awaiting_approval`. That state is real and means "code cause found, fix written, parked for a human" (`shared/src/types.ts:172`).

- [ ] **Step 1: Write the failing test**

```go
func TestReceiptStateSurfacesApproval(t *testing.T) {
	cases := map[string]string{
		"awaiting_approval": "awaiting_approval",
		"pr_draft":          "pr_draft",
		"investigated":      "report_ready",
	}
	for groupStatus, want := range cases {
		if got := receiptState(groupStatus, ""); got != want {
			t.Errorf("receiptState(%q) = %q, want %q", groupStatus, got, want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingestion && go test ./digest -run TestReceiptStateSurfacesApproval -v`
Expected: FAIL, `awaiting_approval` returns `report_ready`.

- [ ] **Step 3: Add the explicit cases before the default**

```go
case "awaiting_approval":
	return "awaiting_approval"
case "pr_draft":
	return "pr_draft"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ingestion && go test ./digest -run TestReceiptStateSurfacesApproval -v`
Expected: PASS

- [ ] **Step 5: Update the card copy**

In `packages/ingestion/narrative/narrative.go:84`, replace the `report_ready` sentence "Investigation report ready." with copy that names the action. For `awaiting_approval`: `"A fix is written and needs your approval."` For `report_ready` where no action exists: `"We could not establish a cause. Details in the issue."`

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/digest/build.go packages/ingestion/digest/build_test.go packages/ingestion/narrative/narrative.go
git commit -m "fix(digest): surface approval requests instead of report_ready"
```

---

### Task 3: Normalize dot-separated content hashes

**Files:**
- Modify: `packages/ingestion/grouping/fingerprint.go:20`
- Test: `packages/ingestion/grouping/fingerprint_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: `reAssetToken` accepts `.` as well as `-` before the hash

`reAssetToken` requires a hyphen before the content hash. AMFJ's Vite bundles are `entry-index.CaWHNXv4.js`, hash after a dot, so normalization never fires and every deploy mints a new identity. Measured on 466 production events, a dot-tolerant regex collapses 71 groups to 63 with zero groups holding more than one distinct message. `looksLikeHash` (eight or more characters, at least one digit) is what keeps `vue.runtime.esm.js` intact.

- [ ] **Step 1: Write the failing test**

```go
func TestFingerprintCollapsesDotSeparatedHashes(t *testing.T) {
	stack1 := "at handler (entry-index.CaWHNXv4.js:17:78242)"
	stack2 := "at handler (entry-index.DXhxKZv7.js:17:78242)"
	a := Fingerprint("javascript", "TypeError", "boom", stack1)
	b := Fingerprint("javascript", "TypeError", "boom", stack2)
	if a != b {
		t.Errorf("dot-separated hashes must collapse: %s != %s", a, b)
	}
}

func TestFingerprintKeepsLibraryNames(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "boom", "at f (vue.runtime.esm.js:1:1)")
	b := Fingerprint("javascript", "TypeError", "boom", "at f (vue.runtime.prod.js:1:1)")
	if a == b {
		t.Errorf("distinct library files must not collapse")
	}
}
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `cd packages/ingestion && go test ./grouping -run 'TestFingerprintCollapsesDotSeparatedHashes|TestFingerprintKeepsLibraryNames' -v`
Expected: first FAILS, second PASSES.

- [ ] **Step 3: Widen the separator**

```go
reAssetToken = regexp.MustCompile(`([A-Za-z0-9_.]+)[-.]([A-Za-z0-9_]+)\.(js|mjs|cjs|css|map)(\?[^\s:'")]*)?(:\d+:\d+)?`)
```

- [ ] **Step 4: Run the full grouping suite**

Run: `cd packages/ingestion && go test ./grouping -v`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/grouping/fingerprint.go packages/ingestion/grouping/fingerprint_test.go
git commit -m "fix(grouping): normalize dot-separated bundle content hashes"
```

---

### Task 4: Deploy Slice 0

**Files:**
- Modify: deploy repository ECS task definition (outside this repository)

**Interfaces:**
- Consumes: Tasks 1 through 3
- Produces: a production digest with working links

`DASHBOARD_URL` is already read at `packages/ingestion/main.go:147` and plumbed through `docker-compose.yml:96`. It is unset in production, so `BuildIncidentURL` returns empty (`notify/url.go:12-15`) and `slackDigestLink` degrades to plain text (`notify/slack_digest.go:371-378`).

- [ ] **Step 1: Set `DASHBOARD_URL` in the production task definition**

Set it to the dashboard origin. This is a deploy-repository change, not a code change.

- [ ] **Step 2: Generate a digest from a production day and click every link**

Run the digest sweep against production and open every link in the payload. Expected: every link resolves; no card describes a problem last seen more than seven days ago; approval requests read as requests.

- [ ] **Step 3: Record the result**

Append the generated digest and the link-check outcome to the cutover evidence file. This is the A3, A5, and A6 evidence.

---

# Slice 1: inert storage and shared contracts

### Task 5: Create the pipeline tables

**Files:**
- Create: `packages/ingestion/db/migrations/054_pipeline_rewrite.sql`
- Test: `packages/ingestion/db/migrations_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: tables `error_capture_buckets`, `error_event_resolutions`, `sourcemap_position_cache`, `error_event_identities`, `canonical_issue_fingerprints`, `issue_episodes`, `issue_decisions`, `issue_inquiry_decisions`, `issue_evidence_anchors`, `issue_publications`, `digest_runs`, `digest_run_items`

- [ ] **Step 1: Write the failing test**

```go
func TestMigration054CreatesPipelineTables(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	want := []string{
		"error_capture_buckets", "error_event_resolutions", "sourcemap_position_cache",
		"error_event_identities", "canonical_issue_fingerprints", "issue_episodes",
		"issue_decisions", "issue_inquiry_decisions", "issue_evidence_anchors",
		"issue_publications", "digest_runs", "digest_run_items",
		"issue_alias_conflicts", "issue_merges", "session_request_failures",
		"session_write_rollups",
	}
	for _, table := range want {
		var exists bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			  WHERE table_schema='public' AND table_name=$1)`, table).Scan(&exists)
		if err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestMigration054IsReapplySafe(t *testing.T) {
	pool := testPool(t)
	sql, err := os.ReadFile("migrations/054_pipeline_rewrite.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(context.Background(), string(sql)); err != nil {
			t.Fatalf("apply %d: %v", i+1, err)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run 'TestMigration054' -v`
Expected: FAIL, tables missing.

- [ ] **Step 3: Write the migration**

Order matters: `issue_episodes` must be created before `error_event_identities`,
which carries a foreign key to it. A forward reference makes the whole file fail to
apply, and because `run-migrations.sh` re-applies every file on every start, that
failure blocks boot rather than showing up later.

```sql
-- 054_pipeline_rewrite.sql , asynchronous identity, filtering, the inquiry stage, publication.
-- Inert until the runtime paths land. IDEMPOTENCY IS MANDATORY.

CREATE TABLE IF NOT EXISTS error_capture_buckets (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_fingerprint  TEXT NOT NULL,
  identity_version INTEGER NOT NULL,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, identity_version, raw_fingerprint)
);

CREATE TABLE IF NOT EXISTS error_event_resolutions (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('resolved','no_map','failed','pending')),
  envelope         JSONB,
  resolver_version INTEGER NOT NULL,
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, event_id)
);

CREATE TABLE IF NOT EXISTS sourcemap_position_cache (
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  debug_id          TEXT NOT NULL,
  map_content_sha   TEXT NOT NULL,
  resolver_version  INTEGER NOT NULL,
  generated_line    INTEGER NOT NULL,
  generated_column  INTEGER NOT NULL,
  original_file     TEXT,
  original_function TEXT,
  original_line     INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, debug_id, map_content_sha, resolver_version,
               generated_line, generated_column)
);

CREATE TABLE IF NOT EXISTS issue_episodes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  sequence           INTEGER NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  UNIQUE (project_id, canonical_issue_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_episode
  ON issue_episodes (canonical_issue_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS error_event_identities (
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id             UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  -- 'settling' is the claim marker: the loop sets it before doing the work so a
  -- second replica cannot pick the same row up. A crash leaves it here, which is
  -- why the reset sweep below exists.
  status               TEXT NOT NULL CHECK (status IN ('pending','settling','settled','conflict')),
  claimed_at           TIMESTAMPTZ,
  canonical_issue_id   UUID REFERENCES error_groups(id) ON DELETE SET NULL,
  raw_fingerprint      TEXT NOT NULL,
  resolved_fingerprint TEXT,
  identity_version     INTEGER NOT NULL,
  -- The work round this observation belongs to. Without it the filter would
  -- count every historical event against every episode of the issue.
  episode_id           UUID REFERENCES issue_episodes(id) ON DELETE SET NULL,
  settled_at           TIMESTAMPTZ,
  PRIMARY KEY (project_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_pending
  ON error_event_identities (project_id, status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS canonical_issue_fingerprints (
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL,
  fingerprint_kind   TEXT NOT NULL CHECK (fingerprint_kind IN ('raw','resolved','friction')),
  canonical_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  identity_version   INTEGER NOT NULL,
  confirmed_by       TEXT NOT NULL CHECK (confirmed_by IN ('exact','model','human')),
  bound_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, identity_version, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_alias_by_issue
  ON canonical_issue_fingerprints (canonical_issue_id);

CREATE TABLE IF NOT EXISTS issue_merges (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  winner_id     UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  loser_id      UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  confirmed_by  TEXT NOT NULL CHECK (confirmed_by IN ('model','human')),
  actor         TEXT,
  aliases_moved INTEGER NOT NULL,
  events_moved  INTEGER NOT NULL,
  merged_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issue_alias_conflicts (
  id             BIGSERIAL PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  left_issue_id  UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  right_issue_id UUID NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open
  ON issue_alias_conflicts (project_id, status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS issue_decisions (
  id           BIGSERIAL PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id   UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  decision     TEXT NOT NULL CHECK (decision IN ('open_inquiry','watch','inactive','out_of_scope')),
  reason       TEXT NOT NULL,
  users_7d     INTEGER NOT NULL,
  anon_7d      INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_latest
  ON issue_decisions (project_id, episode_id, decided_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_inquiry_decisions (
  id             BIGSERIAL PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id     UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  decision       TEXT NOT NULL CHECK (decision IN ('investigate','wait_for_more_evidence','do_not_pursue')),
  reason         TEXT NOT NULL,
  brief          TEXT,
  related_issues UUID[] NOT NULL DEFAULT '{}',
  evaluated_units INTEGER NOT NULL,
  -- What the inquiry actually looked at. The reopen gate compares against this
  -- rather than raw counts, so a changed route map or new failure kind can
  -- reopen even when the unit count did not move.
  evidence_signature TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiry_latest
  ON issue_inquiry_decisions (project_id, episode_id, decided_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS issue_evidence_anchors (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id  UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('threshold','first','recent')),
  event_id    UUID NOT NULL REFERENCES error_events(id) ON DELETE CASCADE,
  frozen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, episode_id, anchor_kind)
);

CREATE TABLE IF NOT EXISTS issue_publications (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id  UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('immediate','post_triage','digest')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, episode_id, channel)
);

CREATE TABLE IF NOT EXISTS digest_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  window_from  TIMESTAMPTZ NOT NULL,
  window_to    TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('frozen','written','validated','delivered','failed')),
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_run_per_window
  ON digest_runs (project_id, window_to);

CREATE TABLE IF NOT EXISTS digest_run_items (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id     UUID NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES issue_episodes(id) ON DELETE CASCADE,
  -- NULL at freeze time: Go records the candidate before any model runs, and
  -- the writing pass fills the outcome in. A non-null CHECK here would make
  -- freezing impossible.
  outcome    TEXT CHECK (outcome IS NULL OR outcome IN ('included','deferred')),
  reason     TEXT,
  PRIMARY KEY (run_id, episode_id)
);

-- Existing table, new column. Jobs are scoped to a work round from here on:
-- the inquiry and investigation both key off the episode, not the issue.
ALTER TABLE error_group_jobs
  ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES issue_episodes(id) ON DELETE CASCADE;

-- One inquiry and one investigation per work round. These are constraints, not
-- indexes: ON CONFLICT needs something to conflict with, and the retry
-- guarantees in later tasks are meaningless without them.
-- Scoped to ACTIVE jobs only. A total index would let one finished inquiry
-- block every future reopen of that episode, and reopening is the whole point
-- of `wait_for_more_evidence`. Every ON CONFLICT against this index must repeat
-- the predicate so Postgres can infer it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_job_per_episode_type
  ON error_group_jobs (project_id, episode_id, job_type)
  WHERE status IN ('pending','claimed');

-- Includes evidence_signature: a reopened inquiry at the same unit count but
-- new evidence must be able to insert. Keying on counts alone would block it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_inquiry_per_evidence
  ON issue_inquiry_decisions (project_id, episode_id, prompt_version, evidence_signature);

-- route_map exists since migration 040 with columns (project_id, pattern, tier,
-- name). Product understanding adds the grounded-claim columns here rather than
-- assuming them.
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS actions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS client_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS server_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0;
-- `tier` and `name` predate this work and are required. Product understanding
-- discovers routes the sweeper never saw, so they need defaults rather than a
-- value invented per insert.
ALTER TABLE route_map ALTER COLUMN tier SET DEFAULT 'standard';
ALTER TABLE route_map ALTER COLUMN name SET DEFAULT '';
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS commit_sha TEXT;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS prompt_version INTEGER;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE route_map ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mechanical';

-- The digest writer job needs to know which frozen run it is writing.
ALTER TABLE error_group_jobs ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES digest_runs(id) ON DELETE CASCADE;

-- Capture no longer creates a group, so a job can exist before any issue does.
-- 001_baseline.sql:113 declares this NOT NULL; every job the new pipeline
-- enqueues would fail on it.
ALTER TABLE error_group_jobs ALTER COLUMN error_group_id DROP NOT NULL;

-- One digest-write job per run. The episode-keyed index cannot cover these:
-- their episode_id is NULL and NULLs never collide, so it would permit
-- unlimited duplicates.
-- Active jobs only, so the scheduler can enqueue a rewrite after a failed run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_write_job_per_run
  ON error_group_jobs (project_id, run_id, job_type)
  WHERE run_id IS NOT NULL AND status IN ('pending','claimed');

-- Investigations key off the work round.
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES issue_episodes(id) ON DELETE SET NULL;
-- The terminal-result contract Task 25 selects on. The investigation writer in
-- Task 24 persists one of these three; without the column the freeze query
-- matches nothing and the digest is always empty.
ALTER TABLE diagnosis_decisions ADD COLUMN IF NOT EXISTS outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('verified_fix','needs_human','unable_to_establish_cause'));

-- Compact session facts (architecture section 1). Detailed rows for failures,
-- aggregate rows for successes. No input values, DOM text, bodies, query
-- strings, or host names. Expiry cascades from the session.
CREATE TABLE IF NOT EXISTS session_request_failures (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id_hash  TEXT NOT NULL,
  page_route       TEXT NOT NULL,
  method           TEXT NOT NULL,
  endpoint_pattern TEXT NOT NULL,
  status           INTEGER NOT NULL,
  action_kind      TEXT CHECK (action_kind IS NULL OR action_kind IN ('click','form_submit')),
  action_selector  TEXT,
  action_link      TEXT NOT NULL CHECK (action_link IN ('direct','none')),
  occurred_at      TIMESTAMPTZ NOT NULL,
  rule_version     INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, request_id_hash, rule_version)
);

CREATE TABLE IF NOT EXISTS session_write_rollups (
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_route       TEXT NOT NULL,
  method           TEXT NOT NULL,
  endpoint_pattern TEXT NOT NULL,
  status_class     INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  rule_version     INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, page_route, method,
               endpoint_pattern, status_class, rule_version)
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run 'TestMigration054' -v`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/054_pipeline_rewrite.sql packages/ingestion/db/migrations_test.go
git commit -m "feat(db): add inert pipeline rewrite tables"
```

---

### Task 6: Freeze the resolved-envelope contract in both languages

**Files:**
- Create: `test-fixtures/grouping/resolved-envelope-v2.json`
- Create: `packages/ingestion/identity/canonical.go`
- Create: `packages/ingestion/identity/canonical_test.go`
- Create: `packages/worker/src/resolve/envelope.ts`
- Create: `packages/worker/src/__tests__/resolve-envelope.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - Go: `identity.CanonicalString(env Envelope) string`, `identity.Hash(env Envelope) string`, `type Envelope struct { Version int; Frames []Frame }`, `type Frame struct { OriginalFile, OriginalFunction string; OriginalLine int; Generated GeneratedPos }`
  - TypeScript: `buildEnvelope(frames: ResolvedFrame[]): EnvelopeV2`

This is the single highest-risk contract in the rewrite. TypeScript resolves frames; Go hashes them. A path separator or anonymous-function marker that drifts between the two silently re-keys every issue, and the symptom presents as mass fragmentation rather than as a bug.

- [ ] **Step 1: Write the fixture**

```json
{
  "version": 2,
  "frames": [
    {"original_file": "src/modules/assets/AssetDetails.vue", "original_function": "deleteAsset",
     "original_line": 142, "generated": {"line": 17, "column": 78242}},
    {"original_file": "node_modules/vue/dist/runtime-core.esm-bundler.js", "original_function": "callWithErrorHandling",
     "original_line": 158, "generated": {"line": 17, "column": 41003}},
    {"original_file": "src/shared/http/client.ts", "original_function": "<anonymous>",
     "original_line": 61, "generated": {"line": 17, "column": 9120}}
  ],
  "expected_canonical": "v2|src/modules/assets/AssetDetails.vue#deleteAsset|node_modules/vue/dist/runtime-core.esm-bundler.js#callWithErrorHandling|src/shared/http/client.ts#L61",
  "expected_hash": "COMPUTE_IN_STEP_4"
}
```

- [ ] **Step 2: Write the failing Go test**

```go
func TestCanonicalStringMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/grouping/resolved-envelope-v2.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx struct {
		Version           int     `json:"version"`
		Frames            []Frame `json:"frames"`
		ExpectedCanonical string  `json:"expected_canonical"`
		ExpectedHash      string  `json:"expected_hash"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	env := Envelope{Version: fx.Version, Frames: fx.Frames}
	if got := CanonicalString(env); got != fx.ExpectedCanonical {
		t.Errorf("CanonicalString =\n  %q\nwant\n  %q", got, fx.ExpectedCanonical)
	}
	if got := Hash(env); got != fx.ExpectedHash {
		t.Errorf("Hash = %q, want %q", got, fx.ExpectedHash)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/ingestion && go test ./identity -run TestCanonicalStringMatchesFixture -v`
Expected: FAIL, package does not exist.

- [ ] **Step 4: Implement the canonical serializer**

```go
package identity

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

const IdentityVersion = 2

// ResolverVersion is the envelope contract version. It must equal
// RESOLVER_VERSION in packages/worker/src/resolve/envelope.ts; the golden
// fixture asserts both sides agree.
const ResolverVersion = 2

const maxIdentityFrames = 5

type GeneratedPos struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type Frame struct {
	OriginalFile     string       `json:"original_file"`
	OriginalFunction string       `json:"original_function"`
	OriginalLine     int          `json:"original_line"`
	Generated        GeneratedPos `json:"generated"`
}

type Envelope struct {
	Version int     `json:"version"`
	Frames  []Frame `json:"frames"`
}

// CanonicalString serializes an envelope into the identity key input.
// An anonymous function falls back to file plus original line, so that two
// unrelated anonymous callbacks in one file do not merge.
func CanonicalString(env Envelope) string {
	frames := env.Frames
	if len(frames) > maxIdentityFrames {
		frames = frames[:maxIdentityFrames]
	}
	parts := make([]string, 0, len(frames)+1)
	parts = append(parts, fmt.Sprintf("v%d", env.Version))
	for _, f := range frames {
		file := strings.ReplaceAll(f.OriginalFile, "\\", "/")
		if f.OriginalFunction == "" || f.OriginalFunction == "<anonymous>" {
			parts = append(parts, fmt.Sprintf("%s#L%d", file, f.OriginalLine))
			continue
		}
		parts = append(parts, fmt.Sprintf("%s#%s", file, f.OriginalFunction))
	}
	return strings.Join(parts, "|")
}

func Hash(env Envelope) string {
	sum := sha256.Sum256([]byte(CanonicalString(env)))
	return fmt.Sprintf("%x", sum[:16])
}
```

Then run the test once, read the actual hash from the failure message, and write it into the fixture's `expected_hash`.

- [ ] **Step 5: Run the Go test to verify it passes**

Run: `cd packages/ingestion && go test ./identity -v`
Expected: PASS

- [ ] **Step 6: Write the failing TypeScript test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildEnvelope } from '../resolve/envelope.js';

describe('resolved envelope v2', () => {
  it('produces exactly the shape Go expects', () => {
    const fixture = JSON.parse(
      readFileSync('../../test-fixtures/grouping/resolved-envelope-v2.json', 'utf-8'),
    );
    const built = buildEnvelope(fixture.frames);
    expect(built.version).toBe(2);
    expect(built.frames).toEqual(fixture.frames);
    // Key ordering is part of the contract: Go decodes by tag, but a reordered
    // or renamed key means the two sides disagree about the same field.
    expect(Object.keys(built.frames[0])).toEqual([
      'original_file', 'original_function', 'original_line', 'generated',
    ]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @opslane/worker test -- resolve-envelope`
Expected: FAIL, module not found.

- [ ] **Step 8: Implement the envelope builder**

```typescript
export const RESOLVER_VERSION = 2;

export interface GeneratedPos { line: number; column: number }
export interface EnvelopeFrame {
  original_file: string;
  original_function: string;
  original_line: number;
  generated: GeneratedPos;
}
export interface EnvelopeV2 { version: 2; frames: EnvelopeFrame[] }

export function buildEnvelope(frames: EnvelopeFrame[]): EnvelopeV2 {
  return {
    version: 2,
    frames: frames.map((f) => ({
      original_file: f.original_file.replace(/\\/g, '/'),
      original_function: f.original_function || '<anonymous>',
      original_line: f.original_line,
      generated: { line: f.generated.line, column: f.generated.column },
    })),
  };
}
```

- [ ] **Step 9: Run both suites**

Run: `pnpm --filter @opslane/worker test -- resolve-envelope && cd packages/ingestion && go test ./identity -v`
Expected: PASS both.

- [ ] **Step 10: Commit**

```bash
git add test-fixtures/grouping/resolved-envelope-v2.json packages/ingestion/identity packages/worker/src/resolve/envelope.ts packages/worker/src/__tests__/resolve-envelope.test.ts
git commit -m "feat(identity): freeze the v2 resolved-envelope contract in Go and TypeScript"
```

---

### Task 7: Document the capture handle in the events contract

**Files:**
- Modify: `docs/contracts/events.md`

**Interfaces:**
- Consumes: nothing
- Produces: documented meaning for `group_id` and `error_group_id` in the response

`group_id` is returned at `handler/error_event.go:301-302` but appears nowhere in the contract document, no frozen wire fixture contains it, the SDK references it only in its own test mocks, and the suppression path at `:230` already returns it empty. It is about to become a provisional handle, so it needs documenting before that is true.

- [ ] **Step 1: Add a response section to the contract**

```markdown
## Response

`POST /api/v1/events` returns:

| Field | Meaning |
| --- | --- |
| `event_id` | Stable identifier for the stored observation. |
| `group_id` | **Provisional capture handle.** It opens the processing item and is not a stable issue identifier. Reads through it resolve or redirect to the canonical issue once identity settles. |
| `error_group_id` | Deprecated alias for `group_id`, retained for compatibility. |

A suppressed event returns an empty `group_id`. Clients must tolerate an empty
value and must not treat either field as a durable issue key.
```

- [ ] **Step 2: Verify no frozen fixture asserts on the field**

Run: `grep -rl "group_id" test-fixtures/wire/ || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add docs/contracts/events.md
git commit -m "docs(contracts): define group_id as a provisional capture handle"
```

---

# Slice 2: capture without judging

### Task 8: Split capture out of InsertErrorEventAndGroup

**Files:**
- Modify: `packages/ingestion/db/queries.go:486` (`InsertErrorEventAndGroup`)
- Create: `packages/ingestion/db/capture.go`
- Test: `packages/ingestion/db/capture_test.go`

**Interfaces:**
- Consumes: `identity.IdentityVersion` from Task 6
- Produces: `func (q *Queries) CaptureError(ctx context.Context, p IngestParams) (*CaptureReceipt, error)` where `type CaptureReceipt struct { EventID, CaptureHandle string }`

Today `InsertErrorEventAndGroup` creates the event, the group, the investigation job, and the `issue.created` outbox row in one transaction. `queries.go:707` enqueues an investigation and publishes on the **first occurrence**, which is why one bug sent nineteen alerts in four days.

- [ ] **Step 1: Write the failing test**

```go
func TestCaptureCreatesNoIssueOrJobOrOutbox(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := &Queries{pool: pool}
	projectID := seedProject(t, pool)

	receipt, err := q.CaptureError(ctx, IngestParams{
		ProjectID: projectID, Title: "TypeError: boom", Platform: "javascript",
		StackRaw: "at f (entry-index.CaWHNXv4.js:1:1)",
	})
	if err != nil {
		t.Fatalf("CaptureError: %v", err)
	}
	if receipt.EventID == "" {
		t.Fatal("expected an event id")
	}

	// Capture DOES enqueue exactly one stack_resolve job. That is the only job
	// it may create; the assertions below prove it creates nothing else.
	var resolveJobs int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND job_type='stack_resolve'`, projectID).Scan(&resolveJobs); err != nil {
		t.Fatalf("resolve jobs: %v", err)
	}
	if resolveJobs != 1 {
		t.Errorf("stack_resolve jobs = %d, want 1", resolveJobs)
	}

	for _, check := range []struct {
		name, query string
	}{
		{"investigation jobs", `SELECT count(*) FROM error_group_jobs
		                          WHERE project_id=$1 AND job_type='investigate'`},
		{"outbox events", `SELECT count(*) FROM outbound_events WHERE project_id=$1`},
		{"stable issues", `SELECT count(*) FROM error_groups WHERE project_id=$1`},
	} {
		var n int
		if err := pool.QueryRow(ctx, check.query, projectID).Scan(&n); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		if n != 0 {
			t.Errorf("capture created %d %s, want 0", n, check.name)
		}
	}

	var pending int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_event_identities WHERE project_id=$1 AND status='pending'`,
		projectID).Scan(&pending); err != nil {
		t.Fatalf("identities: %v", err)
	}
	if pending != 1 {
		t.Errorf("pending identities = %d, want 1", pending)
	}
}

func TestCaptureSharesBucketAcrossConcurrentIdenticalEvents(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := &Queries{pool: pool}
	projectID := seedProject(t, pool)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = q.CaptureError(ctx, IngestParams{
				ProjectID: projectID, Title: "TypeError: boom", Platform: "javascript",
				StackRaw: "at f (entry-index.CaWHNXv4.js:1:1)",
			})
		}()
	}
	wg.Wait()

	var buckets, events int
	pool.QueryRow(ctx, `SELECT count(*) FROM error_capture_buckets WHERE project_id=$1`, projectID).Scan(&buckets)
	pool.QueryRow(ctx, `SELECT count(*) FROM error_events WHERE project_id=$1`, projectID).Scan(&events)
	if buckets != 1 {
		t.Errorf("buckets = %d, want 1", buckets)
	}
	if events != 8 {
		t.Errorf("events = %d, want 8", events)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db -run 'TestCapture' -v`
Expected: FAIL, `CaptureError` undefined.

- [ ] **Step 3: Implement CaptureError**

```go
type CaptureReceipt struct {
	EventID       string
	CaptureHandle string
}

// CaptureError stores one observation and schedules its resolution. It creates
// no stable issue, investigation, or notification: every product decision moves
// downstream of identity settlement.
func (q *Queries) CaptureError(ctx context.Context, p IngestParams) (*CaptureReceipt, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	rawFingerprint := grouping.Fingerprint(p.Platform, p.ErrorType, p.ErrorMessage, p.StackRaw)

	if _, err := tx.Exec(ctx,
		`INSERT INTO error_capture_buckets (project_id, raw_fingerprint, identity_version)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (project_id, identity_version, raw_fingerprint)
		 DO UPDATE SET last_seen = now()`,
		p.ProjectID, rawFingerprint, identity.IdentityVersion,
	); err != nil {
		return nil, fmt.Errorf("upsert bucket: %w", err)
	}

	var eventID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id, environment_id, error_type, error_message, stack_trace_raw,
		    platform, debug_meta, session_id, end_user_id, timestamp, release, commit_sha)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		 RETURNING id`,
		p.ProjectID, p.EnvironmentID, p.ErrorType, p.ErrorMessage, p.StackRaw,
		p.Platform, p.DebugMeta, p.SessionID, p.EndUserID, p.Timestamp, p.Release, p.CommitSHA,
	).Scan(&eventID); err != nil {
		return nil, fmt.Errorf("insert event: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO error_event_identities
		   (project_id, event_id, status, raw_fingerprint, identity_version)
		 VALUES ($1, $2, 'pending', $3, $4)`,
		p.ProjectID, eventID, rawFingerprint, identity.IdentityVersion,
	); err != nil {
		return nil, fmt.Errorf("insert identity: %w", err)
	}

	// The pending resolution row is what the watchdog sweeps. Without it a job
	// that is never claimed leaves no trace and the event waits forever.
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_event_resolutions (project_id, event_id, status, resolver_version)
		 VALUES ($1, $2, 'pending', $3)
		 ON CONFLICT (project_id, event_id) DO NOTHING`,
		p.ProjectID, eventID, identity.ResolverVersion,
	); err != nil {
		return nil, fmt.Errorf("insert pending resolution: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, event_id, job_type, status)
		 VALUES ($1, $2, 'stack_resolve', 'pending')`,
		p.ProjectID, eventID,
	); err != nil {
		return nil, fmt.Errorf("enqueue resolve: %w", err)
	}

	if err := q.pinSession(ctx, tx, p); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return &CaptureReceipt{EventID: eventID, CaptureHandle: rawFingerprint}, nil
}
```

- [ ] **Step 4: Point the handler at CaptureError**

In `handler/error_event.go`, replace the `InsertErrorEventAndGroup` call with `CaptureError`, and return `receipt.CaptureHandle` in both `group_id` and `error_group_id`. The response shape does not change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./db ./handler -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/capture.go packages/ingestion/db/capture_test.go packages/ingestion/db/queries.go packages/ingestion/handler/error_event.go
git commit -m "feat(capture): store observations without creating issues or alerts"
```

---

# Slice 3: resolve stacks before grouping

### Task 9: Add the position cache

**Files:**
- Create: `packages/worker/src/resolve/position-cache.ts`
- Test: `packages/worker/src/__tests__/resolve-position-cache.test.ts`

**Interfaces:**
- Consumes: `RESOLVER_VERSION` from Task 6
- Produces: `lookupPosition(key: PositionKey): Promise<CachedPosition | null>`, `storePosition(key: PositionKey, value: CachedPosition): Promise<void>`, `type PositionKey = { projectId: string; debugId: string; mapContentSha: string; line: number; column: number }`

Since 2026-08-05, 509 production events carrying debug IDs shared 34 source maps, one of which is 2.25 MB. Fetching and parsing per event would repeat that work 509 times.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { lookupPosition, storePosition } from '../resolve/position-cache.js';

describe('position cache', () => {
  const key = {
    projectId: '00000000-0000-0000-0000-000000000001',
    debugId: 'c5cec566-6bbe-7c79-06b9-db1c71e746e5',
    mapContentSha: 'abc123',
    line: 17,
    column: 78242,
  };

  it('returns null before anything is stored', async () => {
    expect(await lookupPosition(key)).toBeNull();
  });

  it('round-trips a stored position', async () => {
    await storePosition(key, {
      originalFile: 'src/AssetDetails.vue',
      originalFunction: 'deleteAsset',
      originalLine: 142,
    });
    expect(await lookupPosition(key)).toEqual({
      originalFile: 'src/AssetDetails.vue',
      originalFunction: 'deleteAsset',
      originalLine: 142,
    });
  });

  it('treats a different resolver version as a different entry', async () => {
    await storePosition(key, {
      originalFile: 'src/Old.vue', originalFunction: 'old', originalLine: 1,
    });
    const other = await lookupPosition({ ...key, column: 99999 });
    expect(other).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @opslane/worker test -- resolve-position-cache`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the cache**

```typescript
import { getPool } from '../db.js';
import { RESOLVER_VERSION } from './envelope.js';

export interface PositionKey {
  projectId: string; debugId: string; mapContentSha: string;
  line: number; column: number;
}
export interface CachedPosition {
  originalFile: string; originalFunction: string; originalLine: number;
}

export async function lookupPosition(k: PositionKey): Promise<CachedPosition | null> {
  const res = await getPool().query(
    `SELECT original_file, original_function, original_line
       FROM sourcemap_position_cache
      WHERE project_id=$1 AND debug_id=$2 AND map_content_sha=$3
        AND resolver_version=$4 AND generated_line=$5 AND generated_column=$6`,
    [k.projectId, k.debugId, k.mapContentSha, RESOLVER_VERSION, k.line, k.column],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    originalFile: row.original_file,
    originalFunction: row.original_function,
    originalLine: row.original_line,
  };
}

export async function storePosition(k: PositionKey, v: CachedPosition): Promise<void> {
  await getPool().query(
    `INSERT INTO sourcemap_position_cache
       (project_id, debug_id, map_content_sha, resolver_version,
        generated_line, generated_column, original_file, original_function, original_line)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [k.projectId, k.debugId, k.mapContentSha, RESOLVER_VERSION,
     k.line, k.column, v.originalFile, v.originalFunction, v.originalLine],
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @opslane/worker test -- resolve-position-cache`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/resolve/position-cache.ts packages/worker/src/__tests__/resolve-position-cache.test.ts
git commit -m "feat(resolve): cache source-map positions per artifact"
```

---

### Task 10: Add the stack_resolve job

**Files:**
- Create: `packages/worker/src/resolve/job.ts`
- Modify: `packages/worker/src/index.ts` (job dispatch)
- Modify: `packages/worker/src/index.ts:538`, `:1185` (remove on-demand resolution)
- Test: `packages/worker/src/__tests__/resolve-job.test.ts`

**Interfaces:**
- Consumes: `lookupPosition`/`storePosition` (Task 9), `buildEnvelope` (Task 6), existing `resolveEventStack` from `resolve-stack.ts:103`
- Produces: `runStackResolve(job: ClaimedJob): Promise<void>`, writing `error_event_resolutions`

- [ ] **Step 1: Write the failing test**

```typescript
describe('stack_resolve job', () => {
  it('writes a resolved envelope and marks the identity ready', async () => {
    const { eventId, projectId } = await seedEventWithDebugId();
    await runStackResolve({ id: 'job-1', projectId, eventId } as ClaimedJob);
    const row = await queryOne(
      `SELECT status, envelope FROM error_event_resolutions WHERE event_id=$1`, [eventId]);
    expect(row.status).toBe('resolved');
    expect(row.envelope.version).toBe(2);
    expect(row.envelope.frames.length).toBeGreaterThan(0);
  });

  it('records no_map when the event carries no debug id', async () => {
    const { eventId, projectId } = await seedEventWithoutDebugId();
    await runStackResolve({ id: 'job-2', projectId, eventId } as ClaimedJob);
    const row = await queryOne(
      `SELECT status FROM error_event_resolutions WHERE event_id=$1`, [eventId]);
    expect(row.status).toBe('no_map');
  });

  it('is idempotent across retries', async () => {
    const { eventId, projectId } = await seedEventWithDebugId();
    await runStackResolve({ id: 'job-3', projectId, eventId } as ClaimedJob);
    await runStackResolve({ id: 'job-3', projectId, eventId } as ClaimedJob);
    const { count } = await queryOne(
      `SELECT count(*)::int AS count FROM error_event_resolutions WHERE event_id=$1`, [eventId]);
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @opslane/worker test -- resolve-job`
Expected: FAIL, `runStackResolve` not exported.

- [ ] **Step 3: Implement the job**

```typescript
export async function runStackResolve(job: ClaimedJob): Promise<void> {
  const event = await loadEvent(job.projectId, job.eventId);
  if (!event.debug_meta?.images?.length) {
    await recordResolution(job.projectId, job.eventId, 'no_map', null);
    return;
  }
  const frames = await resolveFramesWithCache(event);
  if (!frames) {
    await recordResolution(job.projectId, job.eventId, 'no_map', null);
    return;
  }
  await recordResolution(job.projectId, job.eventId, 'resolved', buildEnvelope(frames));
}

async function recordResolution(
  projectId: string, eventId: string,
  status: 'resolved' | 'no_map' | 'failed', envelope: EnvelopeV2 | null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO error_event_resolutions
       (project_id, event_id, status, envelope, resolver_version)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id, event_id) DO UPDATE
       SET status=EXCLUDED.status, envelope=EXCLUDED.envelope,
           resolver_version=EXCLUDED.resolver_version, resolved_at=now()`,
    [projectId, eventId, status, envelope, RESOLVER_VERSION],
  );
}
```

- [ ] **Step 3b: Route the new job types in the worker**

`processJobInner` in `packages/worker/src/index.ts` dispatches on `job_type`. Add the
four new types alongside the existing `investigate`, `fix`, `session_analysis`, and
`route_map` cases:

Add only the case whose handler exists at this task:

```typescript
case 'stack_resolve': return runStackResolve(job);
```

The other three job types get their cases in the tasks that create their handlers:
`issue_inquiry` in Task 21, `product_context` in Task 17, and `digest_write` in
Task 26. Adding them here would import modules that do not exist and break the
worker build at this point in the sequence.

A job type with no case is claimed, never handled, and leases out forever. Task 26,
the last of the four, adds the test asserting that every type the Go side enqueues
has a case, so a fifth type cannot be added without routing it.

`claimJob` (`packages/worker/src/db.ts:562-584`) must also select the two new
columns and put them on `ClaimedJob`:

```typescript
export interface ClaimedJob {
  // ...existing fields
  episodeId?: string;   // set for issue_inquiry and investigate
  runId?: string;       // set for digest_write
}
```

Without them every handler above receives `undefined` and fails at its first query.

- [ ] **Step 4: Remove on-demand resolution from investigate and fix**

Delete the `resolveStackForEvent` calls at `packages/worker/src/index.ts:538` and `:1185`. Those are its only two callers. Investigations now read the persisted envelope.

- [ ] **Step 5: Run the worker suite**

Run: `pnpm --filter @opslane/worker test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/resolve/job.ts packages/worker/src/index.ts packages/worker/src/__tests__/resolve-job.test.ts
git commit -m "feat(resolve): resolve stacks in their own job before grouping"
```

---

### Task 11: Add the raw fallback and the watchdog

**Files:**
- Create: `packages/ingestion/resolve/watchdog.go`
- Test: `packages/ingestion/resolve/watchdog_test.go`

**Interfaces:**
- Consumes: `error_event_resolutions` (Task 5)
- Produces: `func (w *Watchdog) Sweep(ctx context.Context) (settledRaw int, stuck int, err error)`

An event whose map has not arrived must not wait forever. At the daily boundary it settles on its raw fingerprint; a later map upload can wake it sooner. Anything still pending past the boundary is reported.

- [ ] **Step 1: Write the failing test**

```go
func TestWatchdogSettlesStaleUnresolvedEventsOnRaw(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	eventID := seedPendingResolution(t, pool, projectID, time.Now().Add(-30*time.Hour))

	w := &Watchdog{pool: pool, boundary: 24 * time.Hour}
	settled, stuck, err := w.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if settled != 1 {
		t.Errorf("settled = %d, want 1", settled)
	}
	if stuck != 0 {
		t.Errorf("stuck = %d, want 0", stuck)
	}
	var status string
	pool.QueryRow(ctx,
		`SELECT status FROM error_event_resolutions WHERE event_id=$1`, eventID).Scan(&status)
	if status != "no_map" {
		t.Errorf("status = %q, want no_map", status)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./resolve -v`
Expected: FAIL, package does not exist.

- [ ] **Step 3: Implement the watchdog**

```go
package resolve

// Sweep settles events whose source map never arrived. Waiting forever would
// let a bug fragment indefinitely while looking smaller than it is.
func (w *Watchdog) Sweep(ctx context.Context) (int, int, error) {
	tag, err := w.pool.Exec(ctx,
		`UPDATE error_event_resolutions
		    SET status = 'no_map', resolved_at = now()
		  WHERE status = 'pending'
		    AND resolved_at < now() - $1::interval`,
		w.boundary.String())
	if err != nil {
		return 0, 0, fmt.Errorf("settle stale: %w", err)
	}
	var stuck int
	if err := w.pool.QueryRow(ctx,
		`SELECT count(*) FROM error_event_resolutions
		  WHERE status='failed' AND resolved_at < now() - $1::interval`,
		w.boundary.String()).Scan(&stuck); err != nil {
		return 0, 0, fmt.Errorf("count stuck: %w", err)
	}
	if stuck > 0 {
		slog.Warn("resolution jobs stuck", "count", stuck)
	}
	return int(tag.RowsAffected()), stuck, nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./resolve -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/resolve/
git commit -m "feat(resolve): settle on raw identity when a map never arrives"
```

---

# Slice 4: attach observations to stable issues

### Task 12: Bind aliases and settle one observation

**Files:**
- Create: `packages/ingestion/identity/settle.go`
- Create: `packages/ingestion/identity/alias.go`
- Test: `packages/ingestion/identity/settle_test.go`

**Interfaces:**
- Consumes: `CanonicalString`, `Hash`, `IdentityVersion` (Task 6); `error_event_resolutions` (Task 10)
- Produces: `func Settle(ctx context.Context, pool *pgxpool.Pool, projectID, eventID string) (Result, error)` where `type Result struct { CanonicalIssueID string; State string }` and `State` is `settled` or `conflict`

Normal settlement **attaches**; it never moves. This is the decision the whole slice rests on. Rewriting `error_groups.fingerprint` in place collides with `UNIQUE(project_id, fingerprint)` (`001_baseline.sql:95`) exactly when two issues should merge, and because `error_events.error_group_id` has no foreign key (`001_baseline.sql:63`), the events orphaned by the obvious recovery go quiet rather than error, which reads as a successful fix.

- [ ] **Step 1: Write the failing tests**

```go
func TestSettleAttachesTwoFingerprintsToOneIssue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)

	// Two deploys, same source location, different bundle hash.
	a := seedResolvedEvent(t, pool, projectID, "entry-index.AAA11111.js", "src/Assets.vue", "deleteAsset")
	b := seedResolvedEvent(t, pool, projectID, "entry-index.BBB22222.js", "src/Assets.vue", "deleteAsset")

	ra, err := Settle(ctx, pool, projectID, a)
	if err != nil {
		t.Fatalf("settle a: %v", err)
	}
	rb, err := Settle(ctx, pool, projectID, b)
	if err != nil {
		t.Fatalf("settle b: %v", err)
	}
	if ra.CanonicalIssueID != rb.CanonicalIssueID {
		t.Errorf("same source location must settle to one issue: %s != %s",
			ra.CanonicalIssueID, rb.CanonicalIssueID)
	}
	var issues int
	pool.QueryRow(ctx, `SELECT count(*) FROM error_groups WHERE project_id=$1`, projectID).Scan(&issues)
	if issues != 1 {
		t.Errorf("issues = %d, want 1", issues)
	}
}

func TestSettleRecordsConflictWithoutMerging(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)

	// Two established issues, then an event whose raw and resolved aliases
	// point at different ones.
	issueA := seedIssueWithAlias(t, pool, projectID, "raw-1", "raw")
	issueB := seedIssueWithAlias(t, pool, projectID, "res-1", "resolved")
	eventID := seedEventWithFingerprints(t, pool, projectID, "raw-1", "res-1")

	res, err := Settle(ctx, pool, projectID, eventID)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if res.State != "conflict" {
		t.Errorf("state = %q, want conflict", res.State)
	}
	if issueA == issueB {
		t.Fatal("test setup error")
	}
	var aliasCount int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM canonical_issue_fingerprints
		  WHERE project_id=$1 AND canonical_issue_id IN ($2,$3)`,
		projectID, issueA, issueB).Scan(&aliasCount)
	if aliasCount != 2 {
		t.Errorf("conflict must not rebind aliases: got %d, want 2", aliasCount)
	}
}

func TestSettleIsIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	eventID := seedResolvedEvent(t, pool, projectID, "a.js", "src/A.vue", "f")

	first, _ := Settle(ctx, pool, projectID, eventID)
	second, _ := Settle(ctx, pool, projectID, eventID)
	if first.CanonicalIssueID != second.CanonicalIssueID {
		t.Errorf("retry changed the issue: %s -> %s", first.CanonicalIssueID, second.CanonicalIssueID)
	}
	var occurrences int
	pool.QueryRow(ctx,
		`SELECT occurrence_count FROM error_groups WHERE id=$1`, first.CanonicalIssueID).Scan(&occurrences)
	if occurrences != 1 {
		t.Errorf("occurrence_count = %d, want 1 (retry must not double-count)", occurrences)
	}
}

func TestSettleNeverReadsSampleEventID(t *testing.T) {
	// Guard against the oscillation failure: queries.go:588 rewrites
	// sample_event_id on every occurrence, so anything keyed on it computes a
	// different answer depending on when it ran.
	src, err := os.ReadFile("settle.go")
	if err != nil {
		t.Fatalf("read settle.go: %v", err)
	}
	if bytes.Contains(src, []byte("sample_event_id")) {
		t.Error("settle.go must not reference sample_event_id")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: FAIL, `Settle` undefined.

- [ ] **Step 3: Implement settlement**

```go
// Settle binds an observation's fingerprints to a canonical issue. It only ever
// attaches: no fingerprint is rewritten and no event is relocated. A confirmed
// merge is a separate audited operation.
func Settle(ctx context.Context, pool *pgxpool.Pool, projectID, eventID string) (Result, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var rawFP string
	var status string
	var envelope *Envelope
	if err := tx.QueryRow(ctx,
		`SELECT i.raw_fingerprint, i.status, r.envelope
		   FROM error_event_identities i
		   LEFT JOIN error_event_resolutions r
		     ON r.project_id = i.project_id AND r.event_id = i.event_id
		  WHERE i.project_id = $1 AND i.event_id = $2
		  FOR UPDATE OF i`,
		projectID, eventID).Scan(&rawFP, &status, &envelope); err != nil {
		return Result{}, fmt.Errorf("load identity: %w", err)
	}
	if status == "settled" {
		var issueID string
		tx.QueryRow(ctx,
			`SELECT canonical_issue_id FROM error_event_identities
			  WHERE project_id=$1 AND event_id=$2`, projectID, eventID).Scan(&issueID)
		return Result{CanonicalIssueID: issueID, State: "settled"}, tx.Commit(ctx)
	}

	candidates := []alias{{fp: rawFP, kind: "raw"}}
	if envelope != nil {
		candidates = append(candidates, alias{fp: Hash(*envelope), kind: "resolved"})
	}
	// Sorted advisory locks prevent deadlock between concurrent settlers that
	// touch the same pair of fingerprints in opposite order.
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].fp < candidates[j].fp })
	for _, c := range candidates {
		if _, err := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtext($1))`, c.fp); err != nil {
			return Result{}, fmt.Errorf("lock %s: %w", c.fp, err)
		}
	}

	bound, err := lookupAliases(ctx, tx, projectID, candidates)
	if err != nil {
		return Result{}, err
	}
	distinct := distinctIssues(bound)
	if len(distinct) > 1 {
		if err := recordConflict(ctx, tx, projectID, eventID, distinct); err != nil {
			return Result{}, err
		}
		// Mark the row terminal. Leaving it pending would let the loop reclaim
		// it every tick and write a fresh conflict each time.
		if _, err := tx.Exec(ctx,
			`UPDATE error_event_identities SET status='conflict'
			  WHERE project_id=$1 AND event_id=$2`, projectID, eventID); err != nil {
			return Result{}, fmt.Errorf("mark conflict: %w", err)
		}
		return Result{State: "conflict"}, tx.Commit(ctx)
	}

	issueID := ""
	if len(distinct) == 1 {
		issueID = distinct[0]
	} else {
		if issueID, err = createIssue(ctx, tx, projectID, eventID); err != nil {
			return Result{}, err
		}
	}
	for _, c := range candidates {
		if err := bindAlias(ctx, tx, projectID, c, issueID); err != nil {
			return Result{}, err
		}
	}
	if err := attachObservation(ctx, tx, projectID, eventID, issueID); err != nil {
		return Result{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_event_identities
		    SET status='settled', canonical_issue_id=$3, settled_at=now()
		  WHERE project_id=$1 AND event_id=$2`,
		projectID, eventID, issueID); err != nil {
		return Result{}, fmt.Errorf("mark settled: %w", err)
	}
	return Result{CanonicalIssueID: issueID, State: "settled"}, tx.Commit(ctx)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: PASS all four.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/identity/
git commit -m "feat(identity): settle observations by binding aliases, never by moving"
```

---

### Task 12A: Merge two issues on confirmation, audited

**Files:**
- Create: `packages/ingestion/identity/merge.go`
- Test: `packages/ingestion/identity/merge_test.go`

**Interfaces:**
- Consumes: `canonical_issue_fingerprints`, `issue_alias_conflicts` (Task 5)
- Produces: `func ConfirmMerge(ctx context.Context, pool *pgxpool.Pool, projectID, winnerID, loserID, confirmedBy, actor string) error`

Task 12 records conflicts and merges nothing, which is correct for normal
settlement. But conflicts then accumulate in a ledger nothing drains. This is the
separate, audited operation that resolves one: it redirects the losing aliases,
marks the loser merged, and rebuilds the winner's counters from `error_events`.

V1 permits an automatic confirmed merge **only before either issue has started an
investigation or a publication**. After that, a merge would silently rewrite history
a customer has already been shown, so it stays a visible possible duplicate.

- [ ] **Step 1: Write the failing tests**

```go
func TestConfirmMergeRedirectsAliasesAndRebuildsCounters(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, projectID, 3)
	loser  := seedIssueWithEvents(t, pool, projectID, 2)

	if err := ConfirmMerge(ctx, pool, projectID, winner, loser, "human", "abhishek"); err != nil {
		t.Fatalf("ConfirmMerge: %v", err)
	}

	var pointing int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM canonical_issue_fingerprints WHERE canonical_issue_id=$1`,
		winner).Scan(&pointing)
	if pointing < 2 {
		t.Errorf("winner holds %d aliases, want the loser's redirected too", pointing)
	}

	var occ int
	pool.QueryRow(ctx, `SELECT occurrence_count FROM error_groups WHERE id=$1`, winner).Scan(&occ)
	if occ != 5 {
		t.Errorf("occurrence_count = %d, want 5 rebuilt from error_events", occ)
	}

	var status string
	pool.QueryRow(ctx, `SELECT status FROM error_groups WHERE id=$1`, loser).Scan(&status)
	if status != "merged" {
		t.Errorf("loser status = %q, want merged", status)
	}

	var audited int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_merges WHERE winner_id=$1 AND loser_id=$2`,
		winner, loser).Scan(&audited)
	if audited != 1 {
		t.Errorf("merge audit rows = %d, want 1; an unaudited merge is a silent rewrite", audited)
	}

	var openLoserEpisodes int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_episodes WHERE canonical_issue_id=$1 AND closed_at IS NULL`,
		loser).Scan(&openLoserEpisodes)
	if openLoserEpisodes != 0 {
		t.Errorf("loser has %d open episodes, want 0", openLoserEpisodes)
	}
}

func TestConfirmMergeRefusesAfterInvestigationOrPublication(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	for _, blocker := range []string{"investigation", "publication"} {
		winner := seedIssueWithEvents(t, pool, projectID, 2)
		loser  := seedIssueWithEvents(t, pool, projectID, 2)
		seedBlocker(t, pool, projectID, loser, blocker)
		err := ConfirmMerge(ctx, pool, projectID, winner, loser, "model", "inquiry")
		if err == nil {
			t.Errorf("%s should block an automatic merge", blocker)
		}
	}
}

func TestRebuiltCountersMatchAbsoluteReconstruction(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, projectID, 7)
	loser  := seedIssueWithEvents(t, pool, projectID, 4)
	if err := ConfirmMerge(ctx, pool, projectID, winner, loser, "human", "abhishek"); err != nil {
		t.Fatalf("ConfirmMerge: %v", err)
	}
	var incremental, absolute int
	pool.QueryRow(ctx, `SELECT occurrence_count FROM error_groups WHERE id=$1`, winner).Scan(&incremental)
	pool.QueryRow(ctx,
		`SELECT count(*) FROM error_events e
		   JOIN error_event_identities i ON i.event_id = e.id
		  WHERE i.canonical_issue_id = $1`, winner).Scan(&absolute)
	if incremental != absolute {
		t.Errorf("counter drift: stored %d, reconstructed %d", incremental, absolute)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -run 'TestConfirmMerge|TestRebuilt' -v`
Expected: FAIL, `ConfirmMerge` undefined.

- [ ] **Step 3: Implement the merge**

```go
// ConfirmMerge is the only operation that may move an observation between
// issues. Normal settlement attaches and never moves; this exists so a
// confirmed duplicate can be resolved without leaving orphaned events.
func ConfirmMerge(ctx context.Context, pool *pgxpool.Pool, projectID, winnerID, loserID, confirmedBy, actor string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var blocked bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM error_group_jobs j
		    JOIN issue_episodes ep ON ep.id = j.episode_id
		   WHERE ep.canonical_issue_id IN ($1,$2) AND j.job_type = 'investigate')
		 OR EXISTS (
		   SELECT 1 FROM issue_publications p
		    JOIN issue_episodes ep ON ep.id = p.episode_id
		   WHERE ep.canonical_issue_id IN ($1,$2))`,
		winnerID, loserID).Scan(&blocked); err != nil {
		return fmt.Errorf("check blockers: %w", err)
	}
	if blocked && confirmedBy != "human" {
		return fmt.Errorf("merge refused: an issue already investigated or published")
	}

	aliasTag, err := tx.Exec(ctx,
		`UPDATE canonical_issue_fingerprints
		    SET canonical_issue_id = $1, confirmed_by = $3, bound_at = now()
		  WHERE canonical_issue_id = $2 AND project_id = $4`,
		winnerID, loserID, confirmedBy, projectID)
	if err != nil {
		return fmt.Errorf("redirect aliases: %w", err)
	}
	aliasesMoved := int(aliasTag.RowsAffected())

	eventTag, err := tx.Exec(ctx,
		`UPDATE error_event_identities SET canonical_issue_id = $1
		  WHERE canonical_issue_id = $2 AND project_id = $3`,
		winnerID, loserID, projectID)
	if err != nil {
		return fmt.Errorf("move observations: %w", err)
	}
	eventsMoved := int(eventTag.RowsAffected())
	// Absolute reconstruction, not arithmetic on the two counters. Rebuilding
	// from error_events is what keeps the incremental path auditable.
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups g SET
		   occurrence_count = sub.n, first_seen = sub.first, last_seen = sub.last
		  FROM (SELECT count(*) AS n, min(e.created_at) AS first, max(e.created_at) AS last
		          FROM error_events e
		          JOIN error_event_identities i ON i.event_id = e.id
		         WHERE i.canonical_issue_id = $1) sub
		 WHERE g.id = $1`, winnerID); err != nil {
		return fmt.Errorf("rebuild counters: %w", err)
	}
	// The capture handle on the raw event row must follow the observation, or a
	// reader coming through the old handle lands on a merged, silent issue.
	if _, err := tx.Exec(ctx,
		`UPDATE error_events SET error_group_id = $1
		  WHERE error_group_id = $2 AND project_id = $3`,
		winnerID, loserID, projectID); err != nil {
		return fmt.Errorf("move capture handles: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE issue_episodes SET closed_at = now()
		  WHERE canonical_issue_id = $1 AND closed_at IS NULL`, loserID); err != nil {
		return fmt.Errorf("close loser episode: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups SET status = 'merged', merged_at = now() WHERE id = $1`,
		loserID); err != nil {
		return fmt.Errorf("mark loser merged: %w", err)
	}
	// The audit record. Without this row the operation is a silent rewrite of
	// history and nothing can answer "why are these one issue now".
	if _, err := tx.Exec(ctx,
		`INSERT INTO issue_merges
		   (project_id, winner_id, loser_id, confirmed_by, actor, aliases_moved, events_moved)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		projectID, winnerID, loserID, confirmedBy, actor, aliasesMoved, eventsMoved); err != nil {
		return fmt.Errorf("record merge: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE issue_alias_conflicts SET status = 'resolved'
		  WHERE project_id = $3
		    AND left_issue_id IN ($1,$2) AND right_issue_id IN ($1,$2)`,
		winnerID, loserID, projectID); err != nil {
		return fmt.Errorf("close conflict: %w", err)
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/identity/merge.go packages/ingestion/identity/merge_test.go
git commit -m "feat(identity): resolve a confirmed duplicate with an audited merge"
```

---

### Task 13: Run the settler as a multi-replica loop

**Files:**
- Create: `packages/ingestion/identity/loop.go`
- Modify: `packages/ingestion/main.go` (start the loop)
- Test: `packages/ingestion/identity/loop_test.go`

**Interfaces:**
- Consumes: `Settle` (Task 12)
- Produces: `func (l *Loop) Start(ctx context.Context, interval time.Duration)`

- [ ] **Step 1: Write the failing test**

```go
func TestLoopSkipsObservationsWhoseResolutionIsStillPending(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	eventID := seedEventWithPendingResolution(t, pool, projectID)

	if err := (&Loop{pool: pool}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	var status string
	pool.QueryRow(ctx,
		`SELECT status FROM error_event_identities WHERE event_id=$1`, eventID).Scan(&status)
	if status != "pending" {
		t.Errorf("status = %q, want pending; settling before resolution loses the map", status)
	}
}

func TestLoopSettlesEachObservationExactlyOnceUnderConcurrency(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	// Distinct raw fingerprints as well as distinct resolved ones. Seeding all
	// forty with one raw key would bind them through the raw alias and produce
	// a single issue, so the four-issue assertion below would prove nothing.
	for i := 0; i < 40; i++ {
		seedResolvedEvent(t, pool, projectID,
			fmt.Sprintf("bundle-%d.js", i%4), fmt.Sprintf("src/F%d.vue", i%4), "f")
	}

	var wg sync.WaitGroup
	for r := 0; r < 4; r++ { // four replicas
		wg.Add(1)
		go func() { defer wg.Done(); (&Loop{pool: pool}).Tick(ctx) }()
	}
	wg.Wait()

	var pending, settled int
	pool.QueryRow(ctx, `SELECT count(*) FROM error_event_identities WHERE status='pending'`).Scan(&pending)
	pool.QueryRow(ctx, `SELECT count(*) FROM error_event_identities WHERE status='settled'`).Scan(&settled)
	if pending != 0 || settled != 40 {
		t.Errorf("pending=%d settled=%d, want 0 and 40", pending, settled)
	}
	// Four distinct source files must produce exactly four issues.
	var issues int
	pool.QueryRow(ctx, `SELECT count(*) FROM error_groups WHERE project_id=$1`, projectID).Scan(&issues)
	if issues != 4 {
		t.Errorf("issues = %d, want 4", issues)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -run TestLoop -v`
Expected: FAIL, `Loop` undefined.

- [ ] **Step 3: Implement the loop**

```go
// Tick claims a bounded batch of pending identities. FOR UPDATE SKIP LOCKED
// lets every replica make progress without blocking on each other.
func (l *Loop) Tick(ctx context.Context) error {
	// Claim by UPDATE, not by SELECT ... FOR UPDATE. Closing the rows of a
	// SELECT releases its locks before the work runs, so two replicas would
	// process the same batch. Marking the row 'settling' is the claim.
	// Without this join the settler races the resolver and permanently settles a
	// mapped event on its raw fingerprint, which is the exact fragmentation the
	// rewrite exists to remove.
	rows, err := l.pool.Query(ctx,
		`UPDATE error_event_identities i
		    SET status = 'settling', claimed_at = now()
		  WHERE (i.project_id, i.event_id) IN (
		          SELECT i2.project_id, i2.event_id
		            FROM error_event_identities i2
		            JOIN error_event_resolutions r
		              ON r.project_id = i2.project_id AND r.event_id = i2.event_id
		           WHERE i2.status = 'pending'
		             AND r.status IN ('resolved','no_map','failed')
		           ORDER BY i2.event_id
		           LIMIT 100
		           FOR UPDATE OF i2 SKIP LOCKED)
		 RETURNING i.project_id::text, i.event_id::text`)
	if err != nil {
		return fmt.Errorf("claim batch: %w", err)
	}
	type ref struct{ project, event string }
	var batch []ref
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.project, &r.event); err != nil {
			rows.Close()
			return err
		}
		batch = append(batch, r)
	}
	rows.Close()

	for _, r := range batch {
		if _, err := Settle(ctx, l.pool, r.project, r.event); err != nil {
			slog.Error("settle failed", "event_id", r.event, "error", err)
		}
	}
	return nil
}
```

- [ ] **Step 3b: Reset abandoned claims**

A worker that dies mid-settle leaves the row at `settling` forever, and Task 13 only
claims `pending`. Add to the same tick:

```go
// Rows claimed but not finished within the lease are returned to the queue.
// Settlement is idempotent, so re-running one is free.
func (l *Loop) resetAbandoned(ctx context.Context) error {
	_, err := l.pool.Exec(ctx,
		`UPDATE error_event_identities
		    SET status = 'pending', claimed_at = NULL
		  WHERE status = 'settling' AND claimed_at < now() - interval '5 minutes'`)
	return err
}
```

```go
func TestAbandonedClaimsReturnToTheQueue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	eventID := seedStuckSettlingIdentity(t, pool, projectID, time.Now().Add(-10*time.Minute))

	if err := (&Loop{pool: pool}).resetAbandoned(ctx); err != nil {
		t.Fatalf("resetAbandoned: %v", err)
	}
	var status string
	pool.QueryRow(ctx, `SELECT status FROM error_event_identities WHERE event_id=$1`,
		eventID).Scan(&status)
	if status != "pending" {
		t.Errorf("status = %q, want pending; a dead worker must not strand an observation", status)
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/identity/loop.go packages/ingestion/identity/loop_test.go packages/ingestion/main.go
git commit -m "feat(identity): run settlement as a multi-replica claim loop"
```

---

### Task 14: Open and close issue episodes

**Files:**
- Create: `packages/ingestion/identity/episode.go`
- Test: `packages/ingestion/identity/episode_test.go`

**Interfaces:**
- Consumes: `Settle` (Task 12)
- Produces: `func OpenOrGetEpisode(ctx, tx, projectID, issueID string) (string, error)`, `func CloseEpisode(ctx, tx, projectID, episodeID string) error`

An episode is one continuous active period between resolutions. It makes "investigate once", "publish once", and "returned rather than new" enforceable without treating a recurrence as a new issue.

- [ ] **Step 1: Write the failing test**

```go
func TestEpisodeReopensAsReturnedAfterResolution(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	issueID := seedIssue(t, pool, projectID)

	first := mustOpenEpisode(t, pool, projectID, issueID)
	same := mustOpenEpisode(t, pool, projectID, issueID)
	if first != same {
		t.Errorf("an open episode must be reused, got %s then %s", first, same)
	}

	mustCloseEpisode(t, pool, projectID, first)
	second := mustOpenEpisode(t, pool, projectID, issueID)
	if second == first {
		t.Error("a recurrence after resolution must open a new episode")
	}

	var seq int
	pool.QueryRow(ctx, `SELECT sequence FROM issue_episodes WHERE id=$1`, second).Scan(&seq)
	if seq != 2 {
		t.Errorf("sequence = %d, want 2 (this is what renders as returned)", seq)
	}
}

func TestOnlyOneEpisodeOpenPerIssue(t *testing.T) {
	pool := testPool(t)
	projectID := seedProject(t, pool)
	issueID := seedIssue(t, pool, projectID)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = openEpisodeRaw(pool, projectID, issueID) }()
	}
	wg.Wait()
	var open int
	pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_episodes WHERE canonical_issue_id=$1 AND closed_at IS NULL`,
		issueID).Scan(&open)
	if open != 1 {
		t.Errorf("open episodes = %d, want 1", open)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -run TestEpisode -v`
Expected: FAIL

- [ ] **Step 3: Implement episodes**

```go
// OpenOrGetEpisode returns the issue's open episode, creating one if the issue
// has none. The partial unique index idx_one_open_episode makes the race safe.
func OpenOrGetEpisode(ctx context.Context, tx pgx.Tx, projectID, issueID string) (string, error) {
	var id string
	err := tx.QueryRow(ctx,
		`INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
		 SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1
		   FROM issue_episodes WHERE canonical_issue_id = $2
		 ON CONFLICT DO NOTHING
		 RETURNING id::text`,
		projectID, issueID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("open episode: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM issue_episodes
		  WHERE project_id = $1 AND canonical_issue_id = $2 AND closed_at IS NULL`,
		projectID, issueID).Scan(&id); err != nil {
		return "", fmt.Errorf("read open episode: %w", err)
	}
	return id, nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: PASS

- [ ] **Step 4b: Close the round when the issue resolves**

`OpenOrGetEpisode` has no counterpart caller, so without this step a resolved issue
keeps its round open and a later recurrence attaches to the same one, which means
A9 can never pass: nothing ever presents as returned.

**Closure is Go's, and it happens on resolution only.** A verified fix is not a
resolution: its card is the PR the founder still has to review, and Task 25 only
considers episodes with `closed_at IS NULL`, so closing on a verified fix would make
the fix unpublishable. The round closes when the issue actually reaches `resolved`.

TypeScript cannot call this Go function, so nothing bridges runtimes. Instead the
dispatcher sweep in Task 19A closes rounds whose issue has become resolved, which
keeps `issue_episodes` single-writer:

```go
// closeResolvedRounds runs in the same tick as staleEpisodes.
func (d *Dispatcher) closeResolvedRounds(ctx context.Context) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE issue_episodes ep SET closed_at = now()
		   FROM error_groups g
		  WHERE g.id = ep.canonical_issue_id
		    AND ep.closed_at IS NULL
		    AND g.status = 'resolved'`)
	return err
}
```

Add a test:

```go
func TestResolutionClosesTheRoundSoRecurrenceReturns(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	issueID := seedIssue(t, pool, projectID)
	first := mustOpenEpisode(t, pool, projectID, issueID)

	mustResolveIssue(t, pool, projectID, issueID)
	if err := (&Dispatcher{pool: pool}).closeResolvedRounds(ctx); err != nil {
		t.Fatalf("closeResolvedRounds: %v", err)
	}

	var closed bool
	pool.QueryRow(ctx,
		`SELECT closed_at IS NOT NULL FROM issue_episodes WHERE id=$1`, first).Scan(&closed)
	if !closed {
		t.Fatal("resolving the issue must close its round")
	}
	second := mustOpenEpisode(t, pool, projectID, issueID)
	if second == first {
		t.Error("a recurrence after resolution must open a new round")
	}
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/identity/episode.go packages/ingestion/identity/episode_test.go
git commit -m "feat(identity): track work rounds as issue episodes"
```

---

### Task 14A: Wire settlement to the episode and the filter

**Files:**
- Modify: `packages/ingestion/identity/settle.go`
- Modify: `packages/ingestion/identity/loop.go`
- Test: `packages/ingestion/identity/wiring_test.go`

**Interfaces:**
- Consumes: `Settle` (Task 12), `OpenOrGetEpisode` (Task 14)
- Produces: settlement opens the work round and stamps it on the observation

Evaluation is **not** here. An earlier draft called `filter.Evaluate` from this loop,
which made Task 14A depend on Task 18 and therefore unable to compile in sequence.
The filter runs from its own sweep in Task 19A instead.

Tasks 12 and 14 build settlement and episodes; nothing calls the second from the
first. Without this task an engineer can finish every identity task and observe no
episodes, no decisions, and no downstream work. This is the first of three links
that turn the stages into a pipeline.

- [ ] **Step 1: Write the failing test**

```go
func TestSettlementOpensAnEpisodeAndTriggersTheFilter(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	seedResolvedEvent(t, pool, projectID, "a.js", "src/A.vue", "f")
	seedResolvedEvent(t, pool, projectID, "a.js", "src/A.vue", "f")

	if err := (&Loop{pool: pool}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	var episodes int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_episodes WHERE project_id=$1 AND closed_at IS NULL`,
		projectID).Scan(&episodes)
	if episodes != 1 {
		t.Errorf("open episodes = %d, want 1", episodes)
	}

	var stamped int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM error_event_identities
		  WHERE project_id=$1 AND status='settled' AND episode_id IS NOT NULL`,
		projectID).Scan(&stamped)
	if stamped != 2 {
		t.Errorf("observations stamped with an episode = %d, want 2", stamped)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -run TestSettlementOpens -v`
Expected: FAIL, zero episodes.

- [ ] **Step 3: Open the episode inside settlement**

In `Settle`, after `attachObservation` and before marking the observation settled,
call `OpenOrGetEpisode(ctx, tx, projectID, issueID)` and record the episode on the
attached observation. The episode is part of the same transaction, so an issue can
never exist without one.

- [ ] **Step 4: Stamp the episode on the observation**

`Settle` writes `error_event_identities.episode_id` in the same transaction. The
filter counts observations by episode, so an unstamped observation would be counted
against every round the issue has ever had.

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./identity -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/identity/
git commit -m "feat(identity): open a work round on settlement"
```

---

# Slice 5: compact session facts and evidence lookup

### Task 15: Fix the refused-request signal before building on it

**Files:**
- Modify: `packages/worker/src/friction/facts.ts:43`, `:88-91`, `:106-111`
- Test: `packages/worker/src/__tests__/friction-facts.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `WRITE_METHODS` includes `DELETE`; status `0` counts as a failure

The severity signal this design leans on is invisible three ways today. `WRITE_METHODS` omits `DELETE`, so the flagship "customers cannot delete assets" case produces no refused-write signal at all. The SDK emits `status: 0` for transport refusals (`packages/sdk/src/network.ts:124`) and the bucketing counts only `2xx` and `>= 400`, so a connection the server never answered lands nowhere. And `sameOrigin` returns true when a URL will not parse.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('failed write detection', () => {
  it('counts a refused DELETE', () => {
    const facts = extractSessionFacts(sessionWith([
      { method: 'DELETE', url: '/api/assets/1', status: 400, sameOrigin: true },
    ]));
    expect(facts.failedWriteCount).toBe(1);
  });

  it('counts a transport refusal reported as status 0', () => {
    const facts = extractSessionFacts(sessionWith([
      { method: 'POST', url: '/api/assets', status: 0, sameOrigin: true },
    ]));
    expect(facts.failedWriteCount).toBe(1);
  });

  it('does not treat an unparseable URL as same-origin', () => {
    const facts = extractSessionFacts(sessionWith([
      { method: 'POST', url: '::::not-a-url', status: 500, sameOrigin: false },
    ]));
    expect(facts.failedWriteCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify all three fail**

Run: `pnpm --filter @opslane/worker test -- friction-facts`
Expected: FAIL on all three.

- [ ] **Step 3: Fix the three defects**

```typescript
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// status 0 is the SDK's transport-refusal marker (sdk/src/network.ts:124):
// the request never got an answer, which is a failure, not an unknown.
function isFailure(status: number): boolean {
  return status === 0 || status >= 400;
}

function sameOrigin(url: string, pageOrigin: string): boolean {
  // `new URL('::::not-a-url', base)` does NOT throw: it resolves as a relative
  // path and would count as same-origin. Reject anything that is not an
  // absolute same-origin URL or a plain rooted path.
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return parsed.origin === pageOrigin;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @opslane/worker test -- friction-facts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/friction/facts.ts packages/worker/src/__tests__/friction-facts.test.ts
git commit -m "fix(friction): count refused DELETEs and transport refusals as failed writes"
```

---

### Task 16: Build the bounded evidence reader

**Files:**
- Create: `packages/worker/src/evidence/bundle.ts`
- Test: `packages/worker/src/__tests__/evidence-bundle.test.ts`

**Interfaces:**
- Consumes: `error_event_resolutions` (Task 10), `issue_evidence_anchors` (Task 5), session facts (Task 15)
- Produces: `loadEvidence(projectId: string, episodeId: string): Promise<EvidenceBundle>` where
  `EvidenceBundle = { frames, failedRequests, writeRollups, productContext, replayPointers, availability, affectedUnits, relatedCandidates }`

`affectedUnits` and `relatedCandidates` exist because Task 21 reads both: the first
becomes `evaluated_units` on the stored decision, the second is the only set of
issue IDs an inquiry is allowed to cite.

- [ ] **Step 1: Write the failing test**

```typescript
describe('evidence bundle', () => {
  it('reads frozen anchors, never sample_event_id', async () => {
    const { episodeId, projectId, anchorEventId } = await seedEpisodeWithAnchors();
    await moveSampleEventId(projectId); // simulate a later occurrence arriving
    const bundle = await loadEvidence(projectId, episodeId);
    expect(bundle.frames.sourceEventId).toBe(anchorEventId);
  });

  it('degrades to stated availability when the recording expired', async () => {
    const { episodeId, projectId } = await seedEpisodeWithExpiredRecording();
    const bundle = await loadEvidence(projectId, episodeId);
    expect(bundle.availability.recording).toBe('expired');
    expect(bundle.failedRequests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @opslane/worker test -- evidence-bundle`
Expected: FAIL

- [ ] **Step 3: Implement the reader**

```typescript
export async function loadEvidence(
  projectId: string, episodeId: string,
): Promise<EvidenceBundle> {
  const anchors = await getPool().query(
    `SELECT anchor_kind, event_id FROM issue_evidence_anchors
      WHERE project_id=$1 AND episode_id=$2`, [projectId, episodeId]);
  if (anchors.rowCount === 0) {
    throw new Error(`no frozen anchors for episode ${episodeId}`);
  }
  const threshold = anchors.rows.find((r) => r.anchor_kind === 'threshold');
  const frames = await loadResolvedFrames(projectId, threshold.event_id);
  const facts = await loadSessionFacts(projectId, anchors.rows.map((r) => r.event_id));
  return {
    frames: { ...frames, sourceEventId: threshold.event_id },
    failedRequests: facts.failedRequests,
    writeRollups: facts.writeRollups,
    productContext: await loadProductContext(projectId, frames.routes),
    replayPointers: facts.replayPointers,
    availability: {
      recording: facts.recordingExpired ? 'expired' : 'available',
      sourceMap: frames.status,
    },
    affectedUnits: await countAffectedUnits(projectId, episodeId),
    relatedCandidates: await loadRelatedCandidates(projectId, episodeId),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @opslane/worker test -- evidence-bundle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/evidence/ packages/worker/src/__tests__/evidence-bundle.test.ts
git commit -m "feat(evidence): assemble a bounded bundle from frozen anchors"
```

---

### Task 16A: Persist compact session facts

**Files:**
- Create: `packages/worker/src/facts/persist.ts`
- Test: `packages/worker/src/__tests__/facts-persist.test.ts`

**Interfaces:**
- Consumes: `session_request_failures`, `session_write_rollups` (Task 5); the fixed
  predicates from Task 15
- Produces: `replaceSessionFacts(projectId: string, sessionId: string, facts: SessionFacts): Promise<void>`

Task 15 fixes what counts as a failed write; nothing stores the result. The
architecture keeps recordings in object storage and writes only the facts an
investigation needs, so this is the write path that makes the evidence bundle
possible. Decoded recordings in the audited sample ran 1.1 MB to 28 MB while the
facts fit in a handful of rows.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('session fact persistence', () => {
  it('stores one row per failed request and rolls up successes', async () => {
    const { projectId, sessionId } = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({
      failures: [
        { method: 'PUT', endpoint: '/api/assets/:id', status: 400, route: '/assets/:id/edit' },
        { method: 'PUT', endpoint: '/api/assets/:id', status: 400, route: '/assets/:id/edit' },
      ],
      successes: [
        { method: 'POST', endpoint: '/api/assets', statusClass: 2, route: '/assets/new', count: 5 },
      ],
    }));
    const f = await query(`SELECT * FROM session_request_failures WHERE session_id=$1`, [sessionId]);
    const r = await query(`SELECT * FROM session_write_rollups WHERE session_id=$1`, [sessionId]);
    expect(f.rowCount).toBe(2);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].occurrence_count).toBe(5);
  });

  it('replaces the whole fact set when a late chunk arrives', async () => {
    const { projectId, sessionId } = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({ failures: [failure()] }));
    await replaceSessionFacts(projectId, sessionId, factsWith({ failures: [failure(), failure2()] }));
    const f = await query(`SELECT * FROM session_request_failures WHERE session_id=$1`, [sessionId]);
    expect(f.rowCount).toBe(2); // replaced, not appended
  });

  it('stores no request body, query string, or host', async () => {
    const { projectId, sessionId } = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({
      failures: [{ method: 'POST', endpoint: '/api/assets?token=secret',
                   status: 400, route: '/assets/new' }],
    }));
    const f = await query(`SELECT endpoint_pattern FROM session_request_failures WHERE session_id=$1`, [sessionId]);
    expect(f.rows[0].endpoint_pattern).not.toContain('token');
    expect(f.rows[0].endpoint_pattern).not.toContain('?');
  });

  it('expires with the session', async () => {
    const { projectId, sessionId } = await seedSession();
    await replaceSessionFacts(projectId, sessionId, factsWith({ failures: [failure()] }));
    await query(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
    const f = await query(`SELECT * FROM session_request_failures WHERE session_id=$1`, [sessionId]);
    expect(f.rowCount).toBe(0); // ON DELETE CASCADE, no second sweeper
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @opslane/worker test -- facts-persist`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement transactional replacement**

```typescript
/** One session's facts are whole-session truth at a rule version. A late chunk
 *  produces a new truth, so the old set is replaced rather than merged. */
export async function replaceSessionFacts(
  projectId: string, sessionId: string, facts: SessionFacts,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM session_request_failures
        WHERE project_id=$1 AND session_id=$2 AND rule_version=$3`,
      [projectId, sessionId, facts.ruleVersion]);
    await client.query(
      `DELETE FROM session_write_rollups
        WHERE project_id=$1 AND session_id=$2 AND rule_version=$3`,
      [projectId, sessionId, facts.ruleVersion]);
    for (const f of facts.failures) {
      await client.query(
        `INSERT INTO session_request_failures
           (project_id, session_id, request_id_hash, page_route, method,
            endpoint_pattern, status, action_kind, action_selector, action_link,
            occurred_at, rule_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [projectId, sessionId, f.requestIdHash, f.route, f.method,
         stripQuery(f.endpoint), f.status, f.actionKind ?? null,
         f.actionSelector ?? null, f.actionLink, f.occurredAt, facts.ruleVersion]);
    }
    for (const r of facts.successes) {
      await client.query(
        `INSERT INTO session_write_rollups
           (project_id, session_id, page_route, method, endpoint_pattern,
            status_class, occurrence_count, rule_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [projectId, sessionId, r.route, r.method, stripQuery(r.endpoint),
         r.statusClass, r.count, facts.ruleVersion]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Query strings can carry tokens, so the pattern never keeps one. */
function stripQuery(endpoint: string): string {
  return endpoint.split('?')[0]!;
}
```

Call it at the end of the session analysis job, replacing the current totals-only write.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @opslane/worker test -- facts-persist`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/facts/ packages/worker/src/__tests__/facts-persist.test.ts
git commit -m "feat(facts): persist compact session facts with cascading expiry"
```

---

# Slice 6: LLM-built product understanding

### Task 17: Build grounded route and action understanding

**Files:**
- Create: `packages/worker/src/product-context/job.ts`
- Create: `packages/worker/src/product-context/schema.ts`
- Test: `packages/worker/src/__tests__/product-context.test.ts`

**Interfaces:**
- Consumes: existing repository checkout tooling; `route_map` table
- Produces: `runProductContext(job: ClaimedJob): Promise<void>`; `type RouteClaim = { route: string; purpose: string; actions: string[]; clientRefs: string[]; serverRefs: string[]; audience: string; confidence: number }`

Mechanical discovery supplies registered routes, likely page files, and observed requests. The model then reads the code and records what each route is for. Every claim carries its code references, commit, prompt version, model, and confidence. Human rows stay authoritative. Missing understanding means unknown, never unimportant.

- [ ] **Step 1: Write the failing test**

```typescript
describe('product context', () => {
  it('records code references for every claim', async () => {
    const claims = await runProductContextForFixture('assets-repo');
    for (const claim of claims) {
      expect(claim.clientRefs.length + claim.serverRefs.length).toBeGreaterThan(0);
    }
  });

  it('never overwrites a human-authored claim', async () => {
    const { projectId, route } = await seedHumanClaim('/assets/:id/edit', 'Edits an asset');
    await runProductContext({ projectId } as ClaimedJob);
    const stored = await queryOne(
      `SELECT purpose, source FROM route_map WHERE project_id=$1 AND pattern=$2`,
      [projectId, route]);
    expect(stored.source).toBe('human');
    expect(stored.purpose).toBe('Edits an asset');
  });

  it('marks an unmapped route unknown rather than unimportant', async () => {
    const claims = await runProductContextForFixture('sparse-repo');
    const unmapped = claims.find((c) => c.route === '/internal/debug');
    expect(unmapped?.confidence).toBe(0);
    expect(unmapped?.purpose).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @opslane/worker test -- product-context`
Expected: FAIL

- [ ] **Step 3: Implement the job with a strict output schema**

```typescript
export const ROUTE_CLAIM_SCHEMA = {
  type: 'object',
  required: ['route', 'purpose', 'actions', 'client_refs', 'server_refs', 'audience', 'confidence'],
  properties: {
    route: { type: 'string' },
    purpose: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    client_refs: { type: 'array', items: { type: 'string' } },
    server_refs: { type: 'array', items: { type: 'string' } },
    audience: { type: 'string', enum: ['customer', 'admin', 'standard', 'unknown'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const;

export async function runProductContext(job: ClaimedJob): Promise<void> {
  const discovered = await discoverRoutes(job.projectId);
  const claims = await askModelForClaims(discovered, ROUTE_CLAIM_SCHEMA);
  for (const claim of claims) {
    if (!claim.client_refs.length && !claim.server_refs.length) {
      // Stored as unknown with zero confidence, not dropped. "Missing
      // understanding means unknown, never unimportant": a dropped route looks
      // identical to one nobody has looked at, and ranking would treat it as
      // ordinary rather than unexamined.
      claim.purpose = 'unknown';
      claim.confidence = 0;
    }
    await getPool().query(
      `INSERT INTO route_map
         (project_id, pattern, purpose, actions, client_refs, server_refs,
          audience, confidence, commit_sha, prompt_version, model, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'model')
       ON CONFLICT (project_id, pattern) DO UPDATE
         SET purpose=EXCLUDED.purpose, actions=EXCLUDED.actions,
             client_refs=EXCLUDED.client_refs, server_refs=EXCLUDED.server_refs,
             audience=EXCLUDED.audience, confidence=EXCLUDED.confidence,
             commit_sha=EXCLUDED.commit_sha, prompt_version=EXCLUDED.prompt_version,
             model=EXCLUDED.model
         WHERE route_map.source <> 'human'`,
      [job.projectId, claim.route, claim.purpose, claim.actions, claim.client_refs,
       claim.server_refs, claim.audience, claim.confidence, job.commitSha,
       PROMPT_VERSION, MODEL]);
  }
}
```

- [ ] **Step 4: Add the deploy trigger**

`handler/webhook.go:57` rejects every GitHub event that is not `pull_request`, so a deploy cannot trigger this job today. Accept `push` on the default branch and enqueue a `product_context` job. Add the corresponding App event subscription.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @opslane/worker test -- product-context`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/product-context/ packages/worker/src/__tests__/product-context.test.ts packages/ingestion/handler/webhook.go
git commit -m "feat(product-context): build grounded route understanding on deploy"
```

---

# Slice 7A: the cheap filter

### Task 18: Evaluate reach, recency, and scope

**Files:**
- Create: `packages/ingestion/filter/evaluate.go`
- Test: `packages/ingestion/filter/evaluate_test.go`

**Interfaces:**
- Consumes: `issue_episodes` (Task 14)
- Produces: `func Evaluate(ctx context.Context, pool *pgxpool.Pool, projectID, episodeID string) (Decision, error)` where `Decision = { Outcome string; Reason string; Users7d, Anon7d int }` and `Outcome` is one of `open_inquiry`, `watch`, `inactive`, `out_of_scope`

An affected unit is one distinct identified user, or one anonymous session where no identity exists. Occurrence count is not reach: one retry loop generates unlimited events and no additional people. The 30-day replay admits three to seven issues a day and holds 24 to 31 at exactly one unit.

- [ ] **Step 1: Write the failing tests**

```go
func TestFilterOutcomes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)

	cases := []struct {
		name    string
		seed    func(t *testing.T) string // returns episodeID
		want    string
	}{
		{"two identified users admit", func(t *testing.T) string {
			return seedEpisodeWithUsers(t, pool, projectID, 2, 0, time.Now())
		}, "open_inquiry"},
		{"one user plus one anon session admit", func(t *testing.T) string {
			return seedEpisodeWithUsers(t, pool, projectID, 1, 1, time.Now())
		}, "open_inquiry"},
		{"one unit holds", func(t *testing.T) string {
			return seedEpisodeWithUsers(t, pool, projectID, 1, 0, time.Now())
		}, "watch"},
		{"200 occurrences from one user still holds", func(t *testing.T) string {
			return seedEpisodeWithOccurrences(t, pool, projectID, 1, 200, time.Now())
		}, "watch"},
		{"quiet for eight days is inactive", func(t *testing.T) string {
			return seedEpisodeWithUsers(t, pool, projectID, 5, 0, time.Now().Add(-8*24*time.Hour))
		}, "inactive"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, err := Evaluate(ctx, pool, projectID, tc.seed(t))
			if err != nil {
				t.Fatalf("Evaluate: %v", err)
			}
			if d.Outcome != tc.want {
				t.Errorf("outcome = %q, want %q (reason: %s)", d.Outcome, tc.want, d.Reason)
			}
		})
	}
}

func TestFilterAppendsOnlyOnChange(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	ep := seedEpisodeWithUsers(t, pool, projectID, 1, 0, time.Now())

	for i := 0; i < 3; i++ {
		if _, err := Evaluate(ctx, pool, projectID, ep); err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
	}
	var n int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_decisions WHERE episode_id=$1`, ep).Scan(&n)
	if n != 1 {
		t.Errorf("decisions = %d, want 1 (unchanged outcome must not append)", n)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./filter -v`
Expected: FAIL, package does not exist.

- [ ] **Step 3: Implement the filter**

```go
package filter

const RuleVersion = 1
const admitUnits = 2
const livenessWindow = 7 * 24 * time.Hour

// Evaluate answers one factual question: has this happened recently, in scope,
// to enough distinct people to deserve an AI review? It does not decide whether
// the issue is a real defect. That is the inquiry's job.
func Evaluate(ctx context.Context, pool *pgxpool.Pool, projectID, episodeID string) (Decision, error) {
	var users7d, anon7d int
	var lastSeen time.Time
	var inScope bool
	err := pool.QueryRow(ctx,
		`SELECT
		   -- Keyed on i.episode_id, NOT on the issue. A returned episode must
		   -- count its own observations; joining through canonical_issue_id
		   -- would hand it every event the issue ever had.
		   (SELECT count(DISTINCT e.end_user_id) FROM error_events e
		     JOIN error_event_identities i ON i.event_id = e.id
		    WHERE i.episode_id = $1 AND e.end_user_id IS NOT NULL
		      AND e.created_at > now() - interval '7 days'),
		   (SELECT count(DISTINCT e.session_id) FROM error_events e
		     JOIN error_event_identities i ON i.event_id = e.id
		    WHERE i.episode_id = $1 AND e.end_user_id IS NULL
		      AND e.created_at > now() - interval '7 days'),
		   (SELECT max(g.last_seen) FROM error_groups g
		     JOIN issue_episodes ep ON ep.canonical_issue_id = g.id WHERE ep.id = $1),
		   (SELECT COALESCE(bool_or(rm.tier <> 'excluded'), true)
		      FROM route_map rm
		      JOIN error_events e2 ON e2.context->>'url' LIKE '%' || rm.pattern || '%'
		      JOIN error_event_identities i2 ON i2.event_id = e2.id
		     WHERE i2.episode_id = $1)`,
		episodeID).Scan(&users7d, &anon7d, &lastSeen, &inScope)
	if err != nil {
		return Decision{}, fmt.Errorf("count reach: %w", err)
	}

	d := Decision{Users7d: users7d, Anon7d: anon7d}
	switch {
	case !inScope:
		d.Outcome, d.Reason = "out_of_scope", "no observations in the project's action scope"
	case time.Since(lastSeen) > livenessWindow:
		d.Outcome, d.Reason = "inactive", fmt.Sprintf("no occurrence since %s", lastSeen.Format(time.RFC3339))
	case users7d+anon7d >= admitUnits:
		d.Outcome, d.Reason = "open_inquiry", fmt.Sprintf("%d affected units in seven days", users7d+anon7d)
	default:
		d.Outcome, d.Reason = "watch", fmt.Sprintf("%d affected unit in seven days, below %d", users7d+anon7d, admitUnits)
	}
	return d, appendIfChanged(ctx, pool, projectID, episodeID, d)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./filter -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/filter/
git commit -m "feat(filter): admit on two affected units in seven days"
```

---

### Task 19: Replay the filter over 30 days of production

**Files:**
- Create: `packages/ingestion/cmd/filter-replay/main.go`

**Interfaces:**
- Consumes: `Evaluate` (Task 18)
- Produces: a read-only report of daily admit and hold counts

- [ ] **Step 1: Write the replay command**

```go
// filter-replay recomputes the cheap filter for each of the last 30 days from
// error_events, so the rule can be judged before it gates anything.
// Read-only: it opens the session with default_transaction_read_only.
func main() {
	// ... connect, SET default_transaction_read_only = on ...
	for day := 29; day >= 0; day-- {
		at := time.Now().AddDate(0, 0, -day)
		counts := replayDay(ctx, pool, projectID, at)
		fmt.Printf("%s  admit=%d  watch=%d  inactive=%d\n",
			at.Format("2006-01-02"), counts.Admit, counts.Watch, counts.Inactive)
	}
}
```

- [ ] **Step 2: Run it against production**

Run: `DATABASE_URL="$PROD_READONLY_DSN" go run ./cmd/filter-replay --project 5a64d496-0dd0-48a3-aebd-f2ad636e3b44`
Expected: three to seven admitted per recent day, 24 to 31 watched at one unit.

- [ ] **Step 3: Read the held list**

Print the watched issues for the most recent day with their titles and counts. A person reads all of them and confirms none should have been investigated. Record the outcome in the cutover evidence file.

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/cmd/filter-replay/
git commit -m "feat(filter): add a read-only 30-day admission replay"
```

---

### Task 19A: Sweep the filter, freeze evidence, enqueue the inquiry

**Files:**
- Create: `packages/ingestion/filter/dispatch.go`
- Create: `packages/ingestion/identity/anchors.go` (`FreezeAnchors`, first called here)
- Modify: `packages/ingestion/main.go`
- Test: `packages/ingestion/filter/dispatch_test.go`
- Test: `packages/ingestion/identity/anchors_test.go`

`FreezeAnchors` pins three observations for the round: the one that crossed the bar,
the round's first, and a recent distinct one. It reads `error_events` joined through
`error_event_identities` on `episode_id`, and never `sample_event_id`, which
`queries.go:588` rewrites on every occurrence.

**Interfaces:**
- Consumes: `filter.Evaluate` (Task 18), `FreezeAnchors` (Task 24), `error_group_jobs.episode_id` (Task 5)
- Produces: `func (d *Dispatcher) Tick(ctx context.Context) (evaluated, enqueued int, err error)`

Second of three links, and it does three things in order: evaluate every open episode
that has new evidence or a stale rule version, freeze the evidence anchors for any
episode the filter admits, then enqueue one inquiry job for it.

**Anchors freeze here, not at acceptance.** The inquiry reads the evidence bundle to
make its decision, and the bundle is built from frozen anchors. Freezing after the
inquiry decides would make the inquiry depend on evidence that does not exist yet.
The architecture puts the freeze in the admission transaction for exactly this
reason.

- [ ] **Step 1: Write the failing test**

```go
func TestDispatcherFreezesAnchorsBeforeEnqueueingTheInquiry(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	ep := seedEpisodeWithEvents(t, pool, projectID, 3)

	if _, _, err := (&Dispatcher{pool: pool}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	var anchors int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_evidence_anchors WHERE episode_id=$1`, ep).Scan(&anchors)
	if anchors < 2 {
		t.Fatalf("anchors = %d; the inquiry cannot build an evidence bundle without them", anchors)
	}
	if got := countJobs(t, pool, ep, "issue_inquiry"); got != 1 {
		t.Errorf("inquiry jobs = %d, want 1", got)
	}
}

func TestDispatcherEnqueuesOneInquiryPerAdmittedEpisode(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	admitted := seedDecision(t, pool, projectID, "open_inquiry")
	watched := seedDecision(t, pool, projectID, "watch")

	if _, _, err := (&Dispatcher{pool: pool}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if got := countJobs(t, pool, admitted, "issue_inquiry"); got != 1 {
		t.Errorf("admitted episode has %d inquiry jobs, want 1", got)
	}
	if got := countJobs(t, pool, watched, "issue_inquiry"); got != 0 {
		t.Errorf("watched episode has %d inquiry jobs, want 0", got)
	}
}

func TestDispatcherDoesNotReEnqueueWhileOneIsPending(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	ep := seedDecision(t, pool, projectID, "open_inquiry")
	for i := 0; i < 3; i++ {
		if _, _, err := (&Dispatcher{pool: pool}).Tick(ctx); err != nil {
			t.Fatalf("Tick: %v", err)
		}
	}
	if got := countJobs(t, pool, ep, "issue_inquiry"); got != 1 {
		t.Errorf("inquiry jobs = %d, want 1", got)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./filter -run TestDispatcher -v`
Expected: FAIL, `Dispatcher` undefined.

- [ ] **Step 3: Implement the dispatcher**

```go
// Tick evaluates open episodes, then admits the ones that clear the bar. The
// evaluation runs here rather than inside settlement so a slow filter never
// holds an identity lock, and appendIfChanged makes a repeat evaluation free.
func (d *Dispatcher) Tick(ctx context.Context) (int, int, error) {
	// Close rounds whose issue resolved, so a later recurrence opens a new one
	// and presents as returned rather than joining the old round.
	if err := d.closeResolvedRounds(ctx); err != nil {
		return 0, 0, err
	}

	episodes, err := d.staleEpisodes(ctx)
	if err != nil {
		return 0, 0, err
	}
	evaluated := 0
	for _, e := range episodes {
		if _, err := Evaluate(ctx, d.pool, e.projectID, e.episodeID); err != nil {
			slog.Error("evaluate failed", "episode_id", e.episodeID, "error", err)
			continue
		}
		evaluated++
	}

	admitted, err := d.admittedWithoutJob(ctx)
	if err != nil {
		return evaluated, 0, err
	}
	enqueued := 0
	for _, a := range admitted {
		if err := d.admitOne(ctx, a.projectID, a.episodeID); err != nil {
			slog.Error("admit failed", "episode_id", a.episodeID, "error", err)
			continue
		}
		enqueued++
	}
	return evaluated, enqueued, nil
}

// admitOne freezes the evidence the inquiry will read and enqueues it, in one
// transaction. uq_one_active_job_per_episode_type makes a concurrent replica a no-op.
func (d *Dispatcher) admitOne(ctx context.Context, projectID, episodeID string) error {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := identity.FreezeAnchors(ctx, tx, projectID, episodeID); err != nil { // identity is imported
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, episode_id, job_type, status)
		 VALUES ($1, $2, 'issue_inquiry', 'pending')
		 ON CONFLICT (project_id, episode_id, job_type)
		   WHERE status IN ('pending','claimed') DO NOTHING`,
		projectID, episodeID); err != nil {
		return fmt.Errorf("enqueue inquiry: %w", err)
	}
	return tx.Commit(ctx)
}
```

`staleEpisodes` selects open episodes on three conditions, and the third is easy to
forget: an observation newer than the latest decision, a decision at an older
`rule_version`, **or** a latest decision older than the liveness window. Without the
third, an issue that simply stops occurring is never re-evaluated and never becomes
`inactive`, because nothing new arrives to trigger a look. That is what makes a
quiet issue go `inactive` and a rule change re-evaluate, both of which the
architecture requires and neither of which happens on its own.

Start it in `main.go` beside the identity loop and the acceptor, on the same
advisory-lock pattern the priority sweeper uses (`priority/sweeper.go:22`, `:362`),
with a fresh lock key so the two sweepers do not block each other.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./filter -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/filter/ packages/ingestion/identity/anchors.go packages/ingestion/identity/anchors_test.go packages/ingestion/main.go
git commit -m "feat(filter): dispatch an inquiry when an episode clears the bar"
```

---

# Slice 7B: retire the old readiness path

### Task 20: Remove every runtime writer and reader of digest_readiness

**Files:**
- Modify: `packages/worker/src/db.ts:130-150` (`upsertDigestReadiness`), `:1277-1281` (direct UPDATE)
- Modify: `packages/ingestion/db/queries.go:779-784` (ingest-transaction write)
- Modify: `packages/ingestion/digest/build.go` (readiness join)
- Test: `packages/ingestion/db/readiness_retired_test.go`

**Interfaces:**
- Consumes: `issue_decisions`, `issue_inquiry_decisions` (Tasks 5, 18, 21)
- Produces: no runtime reference to `digest_readiness`

The table has six writers across two runtimes, including one that bypasses its own helper and one inside the Go ingest transaction. That distribution is why "we considered this and held it back" has never been expressible.

- [ ] **Step 1: Write the failing guard test**

```go
func TestNoRuntimeReferenceToDigestReadiness(t *testing.T) {
	roots := []string{"../", "../../worker/src"}
	var offenders []string
	for _, root := range roots {
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if strings.Contains(path, "/migrations/") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			if ext := filepath.Ext(path); ext != ".go" && ext != ".ts" {
				return nil
			}
			body, _ := os.ReadFile(path)
			if bytes.Contains(body, []byte("digest_readiness")) {
				offenders = append(offenders, path)
			}
			return nil
		})
	}
	if len(offenders) > 0 {
		t.Errorf("digest_readiness still referenced at runtime:\n  %s",
			strings.Join(offenders, "\n  "))
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ingestion && go test ./db -run TestNoRuntimeReference -v`
Expected: FAIL, listing all six writers plus the digest reader.

- [ ] **Step 3: Replace each reference**

Delete `upsertDigestReadiness` and its four call sites. Delete the direct UPDATE at `db.ts:1277`. Delete the Go write in the requeue path at `queries.go:779`. Change `digest/build.go` to join `issue_decisions` and `issue_inquiry_decisions` for eligibility instead of `digest_readiness`.

- [ ] **Step 4: Run the guard and both suites**

Run: `cd packages/ingestion && go test ./... && cd ../.. && pnpm --filter @opslane/worker test`
Expected: PASS. The table remains in the schema, inert, until a later cleanup migration drops it.

- [ ] **Step 5: Commit**

```bash
git add -A packages/ingestion packages/worker
git commit -m "refactor(readiness): replace digest_readiness with explicit decisions"
```

---

# Slice 8: inquiries

### Task 21: Add the inquiry job with a strict decision schema

**Files:**
- Create: `packages/worker/src/inquiry/schema.ts`
- Create: `packages/worker/src/inquiry/job.ts`
- Test: `packages/worker/src/__tests__/inquiry-job.test.ts`

**Interfaces:**
- Consumes: `loadEvidence` (Task 16), `route_map` claims (Task 17), `issue_decisions` (Task 18)
- Produces: `runInquiry(job: ClaimedJob): Promise<InquiryDecision>` where `InquiryDecision = { decision: 'investigate' | 'wait_for_more_evidence' | 'do_not_pursue'; reason: string; brief?: string; relatedIssues: string[] }`

The inquiry answers what counts cannot: is this a genuine product problem, was the user blocked, is this third-party noise, is there enough evidence to spend a full investigation. It gets read-only repository tools and no write or PR tools. Every candidate gets a decision; silence is a failure. Uncertainty favours investigation, because a silent false negative costs more than a wasted investigation.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('issue_inquiry', () => {
  it('records an investigate decision and creates its job atomically', async () => {
    const ep = await seedQualifiedEpisode();
    stubModel({ decision: 'investigate', reason: 'real failed write', brief: 'check delete path' });
    await runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob);
    const d = await queryOne(
      `SELECT decision, evidence_signature FROM issue_inquiry_decisions WHERE episode_id=$1`, [ep.id]);
    expect(d.decision).toBe('investigate');
    expect(d.evidence_signature).toBeTruthy();
    const { count } = await queryOne(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE job_type='investigate' AND episode_id=$1`, [ep.id]);
    expect(count).toBe(1);
  });

  it('creates no job for do_not_pursue but stores the decision', async () => {
    const ep = await seedQualifiedEpisode();
    stubModel({ decision: 'do_not_pursue', reason: 'browser extension noise' });
    await runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob);
    const jobs = await queryOne(
      `SELECT count(*)::int AS count FROM error_group_jobs
        WHERE job_type='investigate' AND episode_id=$1`, [ep.id]);
    expect(jobs.count).toBe(0);
    const decision = await queryOne(
      `SELECT decision, reason FROM issue_inquiry_decisions WHERE episode_id=$1`, [ep.id]);
    expect(decision.decision).toBe('do_not_pursue');
    expect(decision.reason).toBe('browser extension noise');
  });

  it('fails the job on silent or invalid model output', async () => {
    const ep = await seedQualifiedEpisode();
    stubModel({ reason: 'no decision field' });
    await expect(runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob))
      .rejects.toThrow(/decision/);
  });

  it('stores one decision across retries', async () => {
    const ep = await seedQualifiedEpisode();
    stubModel({ decision: 'investigate', reason: 'r', brief: 'b' });
    await runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob);
    await runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob);
    const d = await queryOne(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions WHERE episode_id=$1`, [ep.id]);
    expect(d.count).toBe(1); // uq_one_inquiry_per_evidence
  });

  it('cites only issue IDs it was given', async () => {
    const ep = await seedQualifiedEpisode();
    stubModel({ decision: 'investigate', reason: 'r', related_issues: ['not-a-supplied-id'] });
    await expect(runInquiry({ projectId: ep.projectId, episodeId: ep.id } as ClaimedJob))
      .rejects.toThrow(/unknown issue/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @opslane/worker test -- inquiry-job`
Expected: FAIL

- [ ] **Step 3: Implement the schema and job**

```typescript
export const INQUIRY_PROMPT_VERSION = 1;

export const INQUIRY_DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['investigate', 'wait_for_more_evidence', 'do_not_pursue'] },
    reason: { type: 'string', minLength: 1 },
    brief: { type: 'string' },
    related_issues: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export async function runInquiry(job: ClaimedJob): Promise<InquiryDecision> {
  const evidence = await loadEvidence(job.projectId, job.episodeId);
  const suppliedIds = new Set(evidence.relatedCandidates.map((c) => c.issueId));

  const raw = await askModel({
    schema: INQUIRY_DECISION_SCHEMA,
    tools: readOnlyRepositoryTools(), // no write, no PR
    input: evidence,
  });
  if (!raw?.decision) {
    throw new Error('inquiry returned no decision; silence is a failure');
  }
  for (const id of raw.related_issues ?? []) {
    if (!suppliedIds.has(id)) {
      throw new Error(`inquiry cited unknown issue ${id}`);
    }
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO issue_inquiry_decisions
         (project_id, episode_id, decision, reason, brief, related_issues,
          evaluated_units, evidence_signature, model, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id, episode_id, prompt_version, evidence_signature)
       DO NOTHING`,
      [job.projectId, job.episodeId, raw.decision, raw.reason, raw.brief ?? null,
       raw.related_issues ?? [], evidence.affectedUnits,
       evidenceSignature(evidence), MODEL, INQUIRY_PROMPT_VERSION]);
    // The same lease-fenced transaction creates the investigation job when the
    // effective stored decision is `investigate`. See the dedicated Slice 8
    // inquiry-to-investigation handoff plan for the complete idempotent insert.
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return raw as InquiryDecision;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @opslane/worker test -- inquiry-job`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/inquiry/ packages/worker/src/__tests__/inquiry-job.test.ts
git commit -m "feat(inquiry): gate investigation on a bounded AI review"
```

---

### Task 22: Bound reopen the inquirying with an evidence growth gate

**Files:**
- Modify: `packages/worker/src/inquiry/job.ts`
- Test: `packages/worker/src/__tests__/inquiry-reopen.test.ts`

**Interfaces:**
- Consumes: `issue_inquiry_decisions.evaluated_units` (Task 5)
- Produces: `INQUIRY_REGROWTH = 1.5`; `shouldReopenInquiry(units: number, lastEvaluated: number): boolean`

Waiting work re-runs when evidence changes, and counts change on every occurrence, so an episode parked in `wait_for_more_evidence` would reopen the inquiry continuously at model cost. This codebase already solved the same problem once: `packages/worker/src/friction/promotion.ts:29` sets `RE_ADJUDICATION_GROWTH = 1.5`, enforced at `:192`, with the comment "Re-judge only when evidence has grown by half again since the last verdict. Without this, a bucket over threshold is re-judged on every session." Tracking cost is not bounding it.

- [ ] **Step 1: Write the failing test**

```typescript
describe('reopen the inquiry gate', () => {
  it('does not reopen the inquiry on a single extra unit', () => {
    // ceil(2 * 1.5) = 3, so two units growing to two stays below the bar.
    expect(shouldReopenInquiry(2, 2)).toBe(false);
  });

  it('reopens the inquiry when evidence grows by half again', () => {
    // 3 >= ceil(2 * 1.5) = 3. The boundary reopens.
    expect(shouldReopenInquiry(3, 2)).toBe(true);
    expect(shouldReopenInquiry(4, 2)).toBe(true);
  });

  it('always reopens the inquiry on a prompt version change', async () => {
    // The stored prompt_version is the module constant, so simulate the bump by
    // seeding a decision at an older version and running the sweep.
    const ep = await seedWaitingEpisode({ units: 2, promptVersion: INQUIRY_PROMPT_VERSION - 1 });
    await runInquirySweep(ep.projectId);
    const { count } = await queryOne(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions WHERE episode_id=$1`, [ep.id]);
    expect(count).toBe(2);
  });

  it('does not reopen the inquiry a waiting episode whose counts barely moved', async () => {
    const ep = await seedWaitingEpisode({ units: 4, promptVersion: 1 });
    await addUnits(ep.id, 1); // 5 units, below ceil(4 * 1.5) = 6
    await runInquirySweep(ep.projectId);
    const { count } = await queryOne(
      `SELECT count(*)::int AS count FROM issue_inquiry_decisions WHERE episode_id=$1`, [ep.id]);
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @opslane/worker test -- inquiry-reopen`
Expected: FAIL, `shouldReopenInquiry` not exported.

- [ ] **Step 3: Implement the gate**

```typescript
/** Mirrors friction/promotion.ts:29. Without this, an episode over the bar is
 *  re-judged on every occurrence. */
export const INQUIRY_REGROWTH = 1.5;

export function shouldReopenInquiry(units: number, lastEvaluated: number): boolean {
  if (lastEvaluated <= 0) return true;
  return units >= Math.ceil(lastEvaluated * INQUIRY_REGROWTH);
}
```

Apply it in the sweep that requeues `wait_for_more_evidence` episodes: reopen the inquiry when `shouldReopenInquiry(currentUnits, lastDecision.evaluated_units)` is true, or when the prompt version changed, or on an explicit human request. A `do_not_pursue` episode reopens the inquiry only on material new evidence, a prompt-version change, or a human request.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @opslane/worker test -- inquiry-reopen`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/inquiry/job.ts packages/worker/src/__tests__/inquiry-reopen.test.ts
git commit -m "feat(inquiry): bound reopen the inquirying with an evidence growth gate"
```

---

### Task 23: Evaluate the inquiry against a fixed production set

**Files:**
- Create: `packages/worker/src/inquiry/__fixtures__/production-set.json`
- Create: `packages/worker/scripts/inquiry-eval.ts`

**Interfaces:**
- Consumes: `runInquiry` (Task 21)
- Produces: an evaluation report; no runtime behaviour

- [ ] **Step 1: Assemble the fixed set**

Six named cases from production, each with its evidence bundle captured to JSON: the asset-deletion cluster (seven fragments, 28 occurrences, nine identified users); the four Assets dead-click digest cards; stale release assets (577 occurrences, 42 identified users); browser-extension noise; one-user errors; and investigations that previously ended `needs_more_context`.

- [ ] **Step 2: Run the evaluation**

Run: `pnpm --filter @opslane/worker exec tsx scripts/inquiry-eval.ts`
Expected: a table of decision, reason, tokens, cost, and latency per case.

- [ ] **Step 3: Read every rejection**

A person reads every `do_not_pursue` and every `wait_for_more_evidence`. Expected: the asset-deletion cluster and stale release assets are investigated; browser-extension noise is rejected with a specific reason; the dead-click cards are either investigated as one component defect or rejected with a reason that names the recovered behaviour.

- [ ] **Step 4: Record acceptance by issue type**

Write the results to the cutover evidence file: acceptance rate by type, reversals, any false negative found by reading, tokens, cost, and latency.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/inquiry/__fixtures__/ packages/worker/scripts/inquiry-eval.ts
git commit -m "test(inquiry): add a fixed production evaluation set"
```

---

# Slice 9: hand accepted work to the investigator

### Task 24: Turn an accepted inquiry into an investigation

> **Superseded before implementation.** Do not add the Go acceptor described
> below. The narrower Slice 8 specification and
> `2026-08-19-inquiry-investigate-job-handoff.md` make
> `persistInquiryDecision` the sole owner of the decision-to-job transition.
> It stores the effective inquiry decision and creates or verifies the
> investigation job in one lease-fenced transaction. The remaining Task 24
> text is retained only as design history.

**Files:**
- Create: `packages/ingestion/inquiry/accept.go`
- Test: `packages/ingestion/inquiry/accept_test.go`

`FreezeAnchors` already exists: Task 19A creates it, because Task 19A is where it is
first called.

**Interfaces:**
- Consumes: `issue_inquiry_decisions` (Task 21), `issue_evidence_anchors` (Task 5)
- Produces: `func (a *Acceptor) Tick(ctx context.Context) (accepted int, err error)`

**Why this is Go and not TypeScript.** The inquiry job runs in the worker and calls
the model, but creating the investigation job is a database write next to the
counters Go already owns. Anchors were frozen earlier, at admission (Task 19A), so
the inquiry could read them; this task reuses them rather than freezing again. A TypeScript transaction cannot call a
Go function, and duplicating the anchor SQL in both runtimes would give
`issue_evidence_anchors` and `error_group_jobs` two writers each, which the
architecture forbids. So the runtimes hand off through Postgres, exactly like
capture hands off to resolution: TypeScript writes only its decision, and this Go
loop turns an `investigate` decision into frozen anchors and one investigation job,
atomically.

- [ ] **Step 1: Write the failing tests**

```go
func TestAcceptorFreezesAnchorsAndCreatesOneInvestigation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	ep := seedEpisodeWithEvents(t, pool, projectID, 4)
	// Admission froze these in Task 19A. The acceptor asserts they exist rather
	// than creating them, so the test must reproduce that handoff.
	seedFrozenAnchors(t, pool, projectID, ep)
	seedInquiryDecision(t, pool, projectID, ep, "investigate")

	a := &Acceptor{pool: pool}
	n, err := a.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if n != 1 {
		t.Fatalf("accepted = %d, want 1", n)
	}

	var anchors int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_evidence_anchors WHERE episode_id=$1`, ep).Scan(&anchors)
	if anchors < 2 {
		t.Errorf("anchors = %d, want at least threshold and first", anchors)
	}

	// And an episode reaching acceptance WITHOUT anchors must fail loudly.
	bare := seedEpisodeWithEvents(t, pool, projectID, 2)
	seedInquiryDecision(t, pool, projectID, bare, "investigate")
	if _, err := a.Tick(ctx); err == nil {
		var jobs int
		pool.QueryRow(ctx,
			`SELECT count(*) FROM error_group_jobs
			  WHERE episode_id=$1 AND job_type='investigate'`, bare).Scan(&jobs)
		if jobs != 0 {
			t.Error("an episode with no frozen anchors must not reach investigation")
		}
	}
	for _, kind := range []string{"threshold", "first"} {
		var exists bool
		pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM issue_evidence_anchors
			   WHERE episode_id=$1 AND anchor_kind=$2)`, ep, kind).Scan(&exists)
		if !exists {
			t.Errorf("missing %s anchor", kind)
		}
	}

	var jobs int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		  WHERE episode_id=$1 AND job_type='investigate'`, ep).Scan(&jobs)
	if jobs != 1 {
		t.Errorf("investigation jobs = %d, want 1", jobs)
	}
}

func TestAcceptorIgnoresNonInvestigateDecisions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	for _, outcome := range []string{"wait_for_more_evidence", "do_not_pursue"} {
		ep := seedEpisodeWithEvents(t, pool, projectID, 4)
		seedInquiryDecision(t, pool, projectID, ep, outcome)
		if _, err := (&Acceptor{pool: pool}).Tick(ctx); err != nil {
			t.Fatalf("Tick: %v", err)
		}
		var jobs int
		pool.QueryRow(ctx,
			`SELECT count(*) FROM error_group_jobs
			  WHERE episode_id=$1 AND job_type='investigate'`, ep).Scan(&jobs)
		if jobs != 0 {
			t.Errorf("%s created %d investigations, want 0", outcome, jobs)
		}
	}
}

func TestAcceptorIsIdempotentAcrossReplicas(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	ep := seedEpisodeWithEvents(t, pool, projectID, 4)
	seedInquiryDecision(t, pool, projectID, ep, "investigate")

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = (&Acceptor{pool: pool}).Tick(ctx) }()
	}
	wg.Wait()

	var jobs, anchors int
	pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		  WHERE episode_id=$1 AND job_type='investigate'`, ep).Scan(&jobs)
	pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_evidence_anchors WHERE episode_id=$1`, ep).Scan(&anchors)
	if jobs != 1 {
		t.Errorf("investigation jobs = %d, want 1 (uq_one_active_job_per_episode_type)", jobs)
	}
	if anchors > 3 {
		t.Errorf("anchors = %d, want at most 3", anchors)
	}
}

func TestAcceptorNeverReadsSampleEventID(t *testing.T) {
	for _, f := range []string{"accept.go", "../identity/anchors.go"} {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("cannot read %s: %v (a missing file must fail, not pass)", f, err)
		}
		if bytes.Contains(src, []byte("sample_event_id")) {
			t.Errorf("%s must not reference sample_event_id", f)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./inquiry -v`
Expected: FAIL, package does not exist.

- [ ] **Step 3: Implement the acceptor**

```go
package inquiry

// Tick turns accepted inquiries into investigations. It claims decisions whose
// episode has no investigation job yet, so a crash between claim and commit
// simply leaves the row for the next tick.
func (a *Acceptor) Tick(ctx context.Context) (int, error) {
	// DISTINCT ON picks the LATEST decision per episode. Selecting any
	// historical 'investigate' would resurrect a decision a later inquiry
	// reversed. The uniqueness index, not the lock, is what makes concurrent
	// replicas safe here.
	rows, err := a.pool.Query(ctx,
		`SELECT project_id, episode_id FROM (
		   SELECT DISTINCT ON (d.episode_id)
		          d.project_id::text AS project_id, d.episode_id::text AS episode_id,
		          d.decision
		     FROM issue_inquiry_decisions d
		    ORDER BY d.episode_id, d.decided_at DESC, d.id DESC) latest
		  WHERE latest.decision = 'investigate'
		    AND NOT EXISTS (
		          SELECT 1 FROM error_group_jobs j
		           WHERE j.episode_id = latest.episode_id::uuid
		             AND j.job_type = 'investigate')
		  LIMIT 50`)
	if err != nil {
		return 0, fmt.Errorf("claim accepted inquiries: %w", err)
	}
	type ref struct{ project, episode string }
	var batch []ref
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.project, &r.episode); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()

	accepted := 0
	for _, r := range batch {
		if err := a.acceptOne(ctx, r.project, r.episode); err != nil {
			slog.Error("accept inquiry failed", "episode_id", r.episode, "error", err)
			continue
		}
		accepted++
	}
	return accepted, nil
}

func (a *Acceptor) acceptOne(ctx context.Context, projectID, episodeID string) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Anchors already exist from admission. Assert rather than create: an
	// episode reaching acceptance without them means the dispatcher failed, and
	// investigating on unfrozen evidence is the bug this whole path prevents.
	var anchors int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM issue_evidence_anchors WHERE episode_id=$1`,
		episodeID).Scan(&anchors); err != nil {
		return fmt.Errorf("count anchors: %w", err)
	}
	if anchors == 0 {
		return fmt.Errorf("episode %s accepted with no frozen anchors", episodeID)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs (project_id, episode_id, job_type, status)
		 VALUES ($1, $2, 'investigate', 'pending')
		 ON CONFLICT (project_id, episode_id, job_type)
		   WHERE status IN ('pending','claimed') DO NOTHING`,
		projectID, episodeID); err != nil {
		return fmt.Errorf("enqueue investigation: %w", err)
	}
	return tx.Commit(ctx)
}
```

`FreezeAnchors` lives in `packages/ingestion/identity/anchors.go` and is called by
the dispatcher in Task 19A. It pins the observation that crossed the bar, the
episode's first observation, and a recent distinct one, reading `error_events`
joined through `error_event_identities`, never `sample_event_id`.

- [ ] **Step 3b: Start the acceptor**

Add `go acceptor.Start(ctx, 1*time.Minute)` in `packages/ingestion/main.go` beside
the identity loop and the filter dispatcher, guarded by its own advisory-lock key on
the `priority/sweeper.go:22` pattern. A loop nobody starts is the defect this whole
slice exists to remove; the boot log line proves it runs.

- [ ] **Step 4: Point the investigator at frozen evidence and persist its outcome**

Change the investigate job in `packages/worker/src/index.ts` to call
`loadEvidence(projectId, episodeId)` from Task 16 instead of reading the group's
sample event, and stamp `episode_id` on the row it writes.

It must also persist `diagnosis_decisions.outcome` as exactly one of `verified_fix`,
`needs_human`, or `unable_to_establish_cause`. Task 25's freeze selects on that
column, so an investigation that finishes without writing it produces a digest that
is permanently empty, and the failure looks like "no problems today" rather than
like a bug.

```typescript
await client.query(
  `UPDATE diagnosis_decisions SET outcome=$2, summary=$3, pr_url=$4
    WHERE id=$1`,
  [decisionId, terminalOutcome, summary, prUrl ?? null]);
```

Add a test asserting every terminal path writes one of the three values, and that
none writes the customer phrase "Investigation report ready".

- [ ] **Step 5: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./inquiry -v && pnpm --filter @opslane/worker test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/inquiry/ packages/worker/src/index.ts
git commit -m "feat(inquiry): turn accepted inquiries into anchored investigations"
```

---

# Slice 10: author and deliver the daily message

### Task 25: Freeze the candidate set in Go

**Files:**
- Create: `packages/ingestion/digest/freeze.go`
- Test: `packages/ingestion/digest/freeze_test.go`

**Interfaces:**
- Consumes: `issue_publications`, `digest_runs` (Task 5)
- Produces: `func FreezeCandidates(ctx, pool, projectID string, at time.Time) (runID string, candidates []Candidate, err error)`

The AI cannot revive a stale issue or invent a candidate, because it never chooses the candidate set. Go does, and freezes it before the model sees anything.

- [ ] **Step 1: Write the failing tests**

```go
func TestFreezeAllowsANewlyReadyActionOnAQuietProblem(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	// Problem last seen nine days ago, but a fix became ready an hour ago.
	quietWithAction := seedTerminalEpisode(t, pool, projectID, time.Now().Add(-9*24*time.Hour), false)
	seedReadyAction(t, pool, projectID, quietWithAction, "verified_fix", time.Now().Add(-1*time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, projectID, time.Now())
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	found := false
	for _, c := range candidates {
		if c.EpisodeID == quietWithAction {
			found = true
		}
	}
	if !found {
		t.Error("a newly ready fix must be publishable even when the problem went quiet")
	}
}

func TestFreezeExcludesStaleAndAlreadyPublished(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)

	fresh := seedTerminalEpisode(t, pool, projectID, time.Now().Add(-2*time.Hour), false)
	stale := seedTerminalEpisode(t, pool, projectID, time.Now().Add(-9*24*time.Hour), false)
	already := seedTerminalEpisode(t, pool, projectID, time.Now().Add(-2*time.Hour), true)

	_, candidates, err := FreezeCandidates(ctx, pool, projectID, time.Now())
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	got := map[string]bool{}
	for _, c := range candidates {
		got[c.EpisodeID] = true
	}
	if !got[fresh] {
		t.Error("a fresh terminal result must be a candidate")
	}
	if got[stale] {
		t.Error("a problem last seen nine days ago must not be a candidate")
	}
	if got[already] {
		t.Error("an episode with a digest receipt must not repeat")
	}
}

func TestFreezeIsIdempotentPerWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	at := time.Now()
	first, _, _ := FreezeCandidates(ctx, pool, projectID, at)
	second, _, _ := FreezeCandidates(ctx, pool, projectID, at)
	if first != second {
		t.Errorf("two freezes in one window must reuse the run: %s != %s", first, second)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -run TestFreeze -v`
Expected: FAIL

- [ ] **Step 3: Implement the freeze**

```go
// FreezeCandidates selects the day's publishable work and records it before any
// model runs. idx_one_run_per_window makes a concurrent sweeper reuse the run.
func FreezeCandidates(ctx context.Context, pool *pgxpool.Pool, projectID string, at time.Time) (string, []Candidate, error) {
	// The frozen candidate carries everything the writer is allowed to use.
	// Anything absent here is something the model would have to invent.
	rows, err := pool.Query(ctx,
		`SELECT ep.id::text, ep.sequence, g.id::text, g.title,
		        d.outcome, d.summary, d.pr_url,
		        (SELECT count(DISTINCT eau.end_user_id) FROM error_group_affected_users eau
		          WHERE eau.error_group_id = g.id) AS affected_users,
		        (SELECT array_agg(DISTINCT eu.account_name) FROM error_group_affected_users eau2
		           JOIN end_users eu ON eu.id = eau2.end_user_id
		          WHERE eau2.error_group_id = g.id AND eu.account_name IS NOT NULL) AS accounts,
		        g.last_seen, rm.purpose
		   FROM issue_episodes ep
		   JOIN error_groups g ON g.id = ep.canonical_issue_id
		   LEFT JOIN route_map rm ON rm.project_id = ep.project_id
		                         AND g.page_url_normalized LIKE '%' || rm.pattern || '%'
		   -- Latest decision per episode, not every decision ever written. A
		   -- reversed inquiry or a superseded diagnosis must not resurrect.
		   JOIN LATERAL (
		     SELECT dd.outcome, dd.decided_at, dd.summary, dd.pr_url FROM diagnosis_decisions dd
		      WHERE dd.episode_id = ep.id
		      ORDER BY dd.decided_at DESC, dd.id DESC LIMIT 1) d ON true
		   JOIN LATERAL (
		     SELECT idq.decision FROM issue_inquiry_decisions idq
		      WHERE idq.episode_id = ep.id
		      ORDER BY idq.decided_at DESC, idq.id DESC LIMIT 1) s ON true
		  WHERE ep.project_id = $1
		    AND s.decision = 'investigate'
		    AND d.outcome IN ('verified_fix','needs_human')
		    AND ep.closed_at IS NULL
		    -- Liveness, with the architecture's exception: a newly ready PR or
		    -- approval request may appear even when the problem itself has gone
		    -- quiet. Its card describes the action as current, not the problem.
		    AND (g.last_seen >= $2 - interval '7 days'
		         OR EXISTS (SELECT 1 FROM diagnosis_decisions dd
		                     WHERE dd.episode_id = ep.id
		                       AND dd.outcome IN ('verified_fix','needs_human')
		                       AND dd.decided_at >= (SELECT COALESCE(max(window_to), 'epoch')
		                                               FROM digest_runs
		                                              WHERE project_id = $1 AND status = 'delivered')))
		    -- Newly usable since the last delivered run, OR deferred by it and
		    -- still unpublished. Without the second arm a deferred card is
		    -- silently dropped forever: its diagnosis is now older than the
		    -- window even though nobody has ever seen it.
		    AND (d.decided_at >= (SELECT COALESCE(max(window_to), 'epoch')
		                            FROM digest_runs
		                           WHERE project_id = $1 AND status = 'delivered')
		         OR EXISTS (SELECT 1 FROM digest_run_items dri
		                     WHERE dri.episode_id = ep.id AND dri.outcome = 'deferred'))
		    AND NOT EXISTS (SELECT 1 FROM issue_publications p
		                     WHERE p.episode_id = ep.id AND p.channel = 'digest')
		  ORDER BY g.last_seen DESC`,
		projectID, at)
	// ... scan into []Candidate, insert digest_runs with status 'frozen',
	//     insert digest_run_items, return the run id ...
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/digest/freeze.go packages/ingestion/digest/freeze_test.go
git commit -m "feat(digest): freeze the candidate set before any model runs"
```

---

### Task 25A: Schedule the daily run

**Files:**
- Create: `packages/ingestion/digest/scheduler.go`
- Modify: `packages/ingestion/main.go`
- Test: `packages/ingestion/digest/scheduler_test.go`

**Interfaces:**
- Consumes: `FreezeCandidates` (Task 25), the writer job (Task 26), `ValidateAndPublish` (Task 27)
- Produces: `func (s *Scheduler) Tick(ctx context.Context) error`

Third and last orchestration link. Tasks 25 through 27 build freeze, write, and
publish, and nothing runs them on a schedule or moves a run between the stages.
The run is the state machine: `frozen` becomes `written` becomes `validated`
becomes `delivered`, and a failure at any point leaves the window unadvanced so the
next tick retries the same frozen set.

- [ ] **Step 1: Write the failing tests**

```go
func TestSchedulerFreezesOncePerDailyBoundary(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProjectWithBoundary(t, pool, "09:00", "America/Los_Angeles")
	seedTerminalEpisode(t, pool, projectID, time.Now().Add(-2*time.Hour), false)

	s := &Scheduler{pool: pool, now: func() time.Time { return boundaryTime(t, "09:01") }}
	for i := 0; i < 3; i++ {
		if err := s.Tick(ctx); err != nil {
			t.Fatalf("Tick %d: %v", i, err)
		}
	}
	var runs int
	pool.QueryRow(ctx, `SELECT count(*) FROM digest_runs WHERE project_id=$1`, projectID).Scan(&runs)
	if runs != 1 {
		t.Errorf("runs = %d, want 1 (idx_one_run_per_window)", runs)
	}
}

func TestSchedulerAdvancesTheRunThroughItsStates(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProjectWithBoundary(t, pool, "09:00", "UTC")
	seedTerminalEpisode(t, pool, projectID, time.Now().Add(-2*time.Hour), false)
	s := &Scheduler{pool: pool, now: func() time.Time { return boundaryTime(t, "09:01") }}

	stubWriterReturnsValidPayload(t)
	if err := s.Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	var status string
	pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE project_id=$1`, projectID).Scan(&status)
	if status != "delivered" {
		t.Errorf("status = %q, want delivered", status)
	}
}

func TestAFailedRunRetriesTheSameFrozenSet(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProjectWithBoundary(t, pool, "09:00", "UTC")
	ep := seedTerminalEpisode(t, pool, projectID, time.Now().Add(-2*time.Hour), false)
	s := &Scheduler{pool: pool, now: func() time.Time { return boundaryTime(t, "09:01") }}

	stubWriterReturnsInventedLink(t)
	_ = s.Tick(ctx)
	var runID, status string
	pool.QueryRow(ctx, `SELECT id::text, status FROM digest_runs WHERE project_id=$1`, projectID).Scan(&runID, &status)
	if status != "failed" {
		t.Fatalf("status = %q, want failed", status)
	}

	// A later episode must not join the retried run: the set was frozen.
	seedTerminalEpisode(t, pool, projectID, time.Now(), false)
	stubWriterReturnsValidPayload(t)
	if err := s.Tick(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	var items int
	pool.QueryRow(ctx, `SELECT count(*) FROM digest_run_items WHERE run_id=$1`, runID).Scan(&items)
	if items != 1 {
		t.Errorf("frozen items = %d, want 1; the retry must not re-freeze", items)
	}
	_ = ep
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -run TestScheduler -v`
Expected: FAIL, `Scheduler` undefined.

- [ ] **Step 3: Implement the scheduler**

```go
// Tick advances at most one run per project. Freezing is idempotent per window,
// so a crash anywhere in the chain resumes from the last durable status rather
// than rebuilding the candidate set.
func (s *Scheduler) Tick(ctx context.Context) error {
	projects, err := s.projectsPastBoundary(ctx)
	if err != nil {
		return err
	}
	for _, projectID := range projects {
		// Normalised to the project's boundary, not the wall clock. The unique
		// index is on (project_id, window_to); passing s.now() every five
		// minutes would mint a new run each tick.
		windowTo := boundaryFor(projectID, s.now())
		runID, _, err := FreezeCandidates(ctx, s.pool, projectID, windowTo)
		if err != nil {
			slog.Error("freeze failed", "project_id", projectID, "error", err)
			continue
		}
		status, err := s.runStatus(ctx, runID)
		if err != nil {
			continue
		}
		switch status {
		case "frozen", "failed":
			if err := s.enqueueWrite(ctx, projectID, runID); err != nil {
				slog.Error("enqueue write failed", "run_id", runID, "error", err)
			}
		case "written":
			if err := ValidateAndPublish(ctx, s.pool, runID); err != nil {
				slog.Error("publish failed", "run_id", runID, "error", err)
			}
		}
	}
	return nil
}
```

Start it in `main.go` on the advisory-lock pattern from `priority/sweeper.go:22`,
with its own key, ticking every five minutes. The boundary check makes a tick
outside the window a cheap no-op, which is the same shape as the existing digest
sweep.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/digest/scheduler.go packages/ingestion/digest/scheduler_test.go packages/ingestion/main.go
git commit -m "feat(digest): schedule and advance the daily run"
```

---

### Task 26: Write the cards with the model

**Files:**
- Create: `packages/worker/src/digest-writer/job.ts`
- Create: `packages/worker/src/digest-writer/schema.ts`
- Test: `packages/worker/src/__tests__/digest-writer.test.ts`

**Interfaces:**
- Consumes: frozen candidates (Task 25)
- Produces: `writeDigest(runId: string): Promise<DigestPayload>` where every input candidate appears in `included` or `deferred`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('digest writer', () => {
  it('accounts for every candidate', async () => {
    const run = await seedFrozenRun(5);
    const payload = await writeDigest(run.id);
    const seen = new Set([
      ...payload.included.map((c) => c.episodeId),
      ...payload.deferred.map((d) => d.episodeId),
    ]);
    expect(seen.size).toBe(5);
  });

  it('rejects a card citing an episode that was not frozen', async () => {
    const run = await seedFrozenRun(2);
    stubModel({ included: [{ episodeId: 'not-frozen', copy: 'x', action: 'y' }], deferred: [] });
    await expect(writeDigest(run.id)).rejects.toThrow(/unknown episode/);
  });

  it('rejects a card whose count does not match stored observations', async () => {
    const run = await seedFrozenRun(1, { users: 9 });
    stubModel({ included: [{ episodeId: run.episodes[0], copy: '40 customers affected', action: 'Review the fix PR', claimedUsers: 40 }], deferred: [] });
    await expect(writeDigest(run.id)).rejects.toThrow(/unsupported count/);
  });

  it('advances the run to written and records every outcome', async () => {
    const run = await seedFrozenRun(3);
    await writeDigest(run.id);
    const r = await queryOne(`SELECT status, payload FROM digest_runs WHERE id=$1`, [run.id]);
    expect(r.status).toBe('written');
    expect(r.payload).toBeTruthy();
    const { pending } = await queryOne(
      `SELECT count(*)::int AS pending FROM digest_run_items
        WHERE run_id=$1 AND outcome IS NULL`, [run.id]);
    expect(pending).toBe(0);
  });

  it('labels a second episode as returned', async () => {
    const run = await seedFrozenRunWithReturnedEpisode();
    const payload = await writeDigest(run.id);
    expect(payload.included[0].label).toBe('returned');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @opslane/worker test -- digest-writer`
Expected: FAIL

- [ ] **Step 3: Implement the writer**

```typescript
export const DIGEST_PROMPT_VERSION = 1;

export async function writeDigest(runId: string): Promise<DigestPayload> {
  const { candidates, projectId } = await loadFrozenRun(runId);
  const allowed = new Set(candidates.map((c) => c.episodeId));

  const raw = await askModel({ schema: DIGEST_PAYLOAD_SCHEMA, input: candidates });

  // The model may translate facts into product language. It may not change
  // counts, account names, PR URLs, issue URLs, or investigation state.
  for (const card of raw.included) {
    if (!allowed.has(card.episodeId)) {
      throw new Error(`unknown episode ${card.episodeId}`);
    }
    const truth = candidates.find((c) => c.episodeId === card.episodeId)!;
    if (card.claimedUsers != null && card.claimedUsers !== truth.affectedUsers) {
      throw new Error(
        `unsupported count for ${card.episodeId}: claimed ${card.claimedUsers}, stored ${truth.affectedUsers}`);
    }
    card.label = truth.episodeSequence > 1 ? 'returned' : 'new';
  }
  const accounted = new Set([
    ...raw.included.map((c) => c.episodeId),
    ...raw.deferred.map((d) => d.episodeId),
  ]);
  for (const c of candidates) {
    if (!accounted.has(c.episodeId)) {
      throw new Error(`candidate ${c.episodeId} was neither included nor deferred`);
    }
  }

  // Persist and advance. Returning the payload without storing it would leave
  // the run stuck at `frozen`, and the scheduler would re-enqueue the write
  // every tick forever.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE digest_runs SET payload=$2, status='written' WHERE id=$1 AND status IN ('frozen','failed')`,
      [runId, raw]);
    for (const card of raw.included) {
      await client.query(
        `UPDATE digest_run_items SET outcome='included', reason=NULL
          WHERE run_id=$1 AND episode_id=$2`, [runId, card.episodeId]);
    }
    for (const d of raw.deferred) {
      await client.query(
        `UPDATE digest_run_items SET outcome='deferred', reason=$3
          WHERE run_id=$1 AND episode_id=$2`, [runId, d.episodeId, d.reason]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return raw;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @opslane/worker test -- digest-writer`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/digest-writer/ packages/worker/src/__tests__/digest-writer.test.ts
git commit -m "feat(digest): author cards with the model over a frozen candidate set"
```

---

### Task 27: Validate and deliver once

**Files:**
- Create: `packages/ingestion/digest/validate.go`
- Test: `packages/ingestion/digest/validate_test.go`

**Interfaces:**
- Consumes: `writeDigest` output (Task 26)
- Produces: `func ValidateAndPublish(ctx, pool, runID string) error`

- [ ] **Step 1: Write the failing tests**

```go
func TestValidateRejectsInventedLinks(t *testing.T) {
	pool := testPool(t)
	runID := seedWrittenRun(t, pool, withCard(card{PRURL: "https://github.com/other/repo/pull/1"}))
	err := ValidateAndPublish(context.Background(), pool, runID)
	if err == nil || !strings.Contains(err.Error(), "link") {
		t.Errorf("expected a link rejection, got %v", err)
	}
}

func TestPublishIsIdempotentAcrossConcurrentSweepers(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID := seedWrittenRun(t, pool, withCard(validCard()))

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = ValidateAndPublish(ctx, pool, runID) }()
	}
	wg.Wait()

	var outbox, receipts int
	pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events WHERE payload->>'run_id'=$1`, runID).Scan(&outbox)
	pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications WHERE channel='digest'`).Scan(&receipts)
	if outbox != 1 {
		t.Errorf("outbox events = %d, want 1", outbox)
	}
	if receipts != 1 {
		t.Errorf("publication receipts = %d, want 1", receipts)
	}
}

func TestFailedRunDoesNotAdvanceTheWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID := seedWrittenRun(t, pool, withCard(card{PRURL: "https://evil.example/pull/1"}))
	_ = ValidateAndPublish(ctx, pool, runID)

	var status string
	pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status)
	if status != "failed" {
		t.Errorf("status = %q, want failed", status)
	}
	var receipts int
	pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications WHERE channel='digest'`).Scan(&receipts)
	if receipts != 0 {
		t.Errorf("a failed run must write no receipts, got %d", receipts)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -run 'TestValidate|TestPublish|TestFailedRun' -v`
Expected: FAIL

- [ ] **Step 3: Implement validation and the publish transaction**

Validation rejects unknown episode IDs, stale candidates, links whose host or repository does not match the project's own, counts unsupported by stored observations, duplicate actions, and malformed output. One transaction then writes the run status, chosen items, deferred reasons, rendered payload, publication receipts, outbox event, and deliveries. A failure leaves the window unadvanced so the next sweep retries the same frozen run.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./digest -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/digest/validate.go packages/ingestion/digest/validate_test.go
git commit -m "feat(digest): validate AI output and publish exactly once"
```

---

### Task 28: Read a week of generated messages

**Files:**
- Create: `packages/ingestion/cmd/digest-eval/main.go`

**Interfaces:**
- Consumes: Tasks 25 through 27
- Produces: seven rendered digests for human reading

This is the A1 and A9 evidence and cannot be automated.

- [ ] **Step 1: Generate seven daily messages from production snapshots**

Run: `DATABASE_URL="$PROD_READONLY_DSN" go run ./cmd/digest-eval --project 5a64d496-0dd0-48a3-aebd-f2ad636e3b44 --days 7`

- [ ] **Step 2: The founder reads all seven**

For every card, they name the action without opening the dashboard. Any "so what?" fails the evaluation and sends the copy or the bar back for change.

- [ ] **Step 3: Confirm the returned label reads correctly**

Find at least one episode with sequence greater than one and confirm the card presents it as returned rather than new. This is A9's rendering proof, which the recurrence integration test does not cover.

- [ ] **Step 4: Record the outcome**

Append the seven messages and the founder's per-card actions to the cutover evidence file.

---

### Task 28A: Show pipeline state in the inbox

**Files:**
- Modify: `packages/ingestion/handler/read_api.go`
- Modify: `packages/dashboard/src/` (issue list and detail)
- Test: `packages/ingestion/handler/inbox_test.go`

**Interfaces:**
- Consumes: `issue_decisions` (Task 18), `issue_inquiry_decisions` (Task 21),
  `issue_episodes` (Task 14)
- Produces: `GET /api/v1/issues` returns a `state` and a `reason` per issue

Section 7 of the architecture had no task. Without it the digest becomes selective
while nothing preserves completeness, which is the trade the whole design rests on:
the message is short **because** the inbox is complete.

The two held-back lists are different and must render separately. `Watching` means
the problem has not reached enough people to look into. `Reviewed, not pursuing`
means Opslane looked and declined. A founder auditing the system cares far more
about the second, and burying it inside thirty low-count issues hides it.

- [ ] **Step 1: Write the failing tests**

```go
func TestInboxSeparatesWatchedFromDeclined(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	projectID := seedProject(t, pool)
	watched  := seedEpisodeWithDecision(t, pool, projectID, "watch", "1 affected unit in seven days")
	declined := seedEpisodeWithInquiry(t, pool, projectID, "do_not_pursue", "browser extension noise")

	issues := listIssues(t, ctx, pool, projectID)
	byID := map[string]issueView{}
	for _, i := range issues {
		byID[i.EpisodeID] = i
	}
	if got := byID[watched].State; got != "watching" {
		t.Errorf("watched state = %q, want watching", got)
	}
	if got := byID[declined].State; got != "reviewed_not_pursuing" {
		t.Errorf("declined state = %q, want reviewed_not_pursuing", got)
	}
	if byID[declined].Reason != "browser extension noise" {
		t.Errorf("declined issue must carry the inquiry reason, got %q", byID[declined].Reason)
	}
}

func TestEveryLiveIssueHasAStateAndReason(t *testing.T) {
	pool := testPool(t)
	projectID := seedProject(t, pool)
	seedAssortedEpisodes(t, pool, projectID, 20)
	for _, i := range listIssues(t, context.Background(), pool, projectID) {
		if i.State == "" {
			t.Errorf("issue %s has no state", i.EpisodeID)
		}
		if i.Reason == "" {
			t.Errorf("issue %s has no reason; silence is the defect this replaces", i.EpisodeID)
		}
	}
}

func TestInboxShowsCapturesThatHaveNoRoundYet(t *testing.T) {
	pool := testPool(t)
	projectID := seedProject(t, pool)
	// A captured observation whose identity has not settled has no episode.
	// Listing only episodes would hide it, and "Processing" would never appear.
	seedPendingIdentity(t, pool, projectID)

	issues := listIssues(t, context.Background(), pool, projectID)
	if len(issues) != 1 {
		t.Fatalf("issues = %d, want 1", len(issues))
	}
	if issues[0].State != "processing" {
		t.Errorf("state = %q, want processing", issues[0].State)
	}
}

func TestInboxHidesNoLiveIssue(t *testing.T) {
	pool := testPool(t)
	projectID := seedProject(t, pool)
	seedAssortedEpisodes(t, pool, projectID, 20)
	var live int
	pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_episodes WHERE project_id=$1 AND closed_at IS NULL`,
		projectID).Scan(&live)
	if got := len(listIssues(t, context.Background(), pool, projectID)); got != live {
		t.Errorf("inbox shows %d of %d live issues", got, live)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler -run 'TestInbox|TestEveryLive' -v`
Expected: FAIL

- [ ] **Step 3: Derive the state from the latest decisions**

```go
// inboxState maps pipeline records onto the customer vocabulary. Storage names
// never reach the response.
func inboxState(identity, filterDecision, inquiryDecision, diagnosisOutcome, groupStatus string) (state, reason string) {
	switch {
	case identity == "pending":
		return "processing", "working out which problem this belongs to"
	case groupStatus == "resolved":
		return "resolved", "closed"
	case inquiryDecision == "do_not_pursue":
		return "reviewed_not_pursuing", "" // caller fills the stored reason
	case inquiryDecision == "wait_for_more_evidence":
		return "waiting_for_evidence", ""
	case inquiryDecision == "investigate" && diagnosisOutcome == "verified_fix":
		return "fix_ready", "a change is verified and waiting for your review"
	case inquiryDecision == "investigate" && diagnosisOutcome == "needs_human":
		return "needs_you", "" // caller fills the stored reason
	case inquiryDecision == "investigate" && diagnosisOutcome == "unable_to_establish_cause":
		return "reviewed_not_pursuing", "we could not establish a cause"
	case inquiryDecision == "investigate":
		return "investigating", "tracing the cause"
	case filterDecision == "open_inquiry":
		return "reviewing_evidence", "deciding whether this is worth investigating"
	case filterDecision == "inactive":
		return "inactive", "stopped occurring before it advanced"
	default:
		return "watching", "" // caller fills the stored reason
	}
}
```

The list query unions open episodes with pending identities that have no episode
yet, so a just-captured observation appears as `processing` rather than vanishing
until settlement. The endpoint returns `state`, `reason`, the cited evidence
references, the decision time, and links to the observations and available recordings. The dashboard
renders `watching` and `reviewed_not_pursuing` as two lists, with a control on the
second to request another look.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/ packages/dashboard/src/
git commit -m "feat(inbox): show what Opslane is watching and why it did not advance"
```

---

# Slice 11: cut over production

### Task 29: Generate and read the cutover report

**Files:**
- Create: `packages/ingestion/cmd/cutover-report/main.go`

**Interfaces:**
- Consumes: `Settle` (Task 12), `Evaluate` (Task 18)
- Produces: a read-only report of proposed identity changes, the held list, and inquiry candidates

- [ ] **Step 1: Write the read-only report**

The command opens its session with `SET default_transaction_read_only = on`, replays identity over 30 days, and prints every proposed many-to-one identity change with the titles and messages of the issues being combined.

- [ ] **Step 2: Run it against production**

Run: `DATABASE_URL="$PROD_READONLY_DSN" go run ./cmd/cutover-report --project 5a64d496-0dd0-48a3-aebd-f2ad636e3b44`

- [ ] **Step 3: Read every many-to-one change by hand**

A wrong merge is indistinguishable from a successful fix: if three of four merged fragments stop after a fix and one does not, occurrences fall and it reads as success. Only confirmed clusters enter the alias backfill. Uncertain clusters stay split.

- [ ] **Step 4: Read the held and rejected lists again**

Under the final action-scope query, confirm nothing in the held list should have been investigated and nothing in the inquiry's rejections was a false negative.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/cmd/cutover-report/
git commit -m "feat(cutover): add the read-only pre-cutover report"
```

---

### Task 30: Execute the maintenance window

**Files:**
- Create: `packages/ingestion/db/migrations/055_cutover_backfill.sql`
- Create: `scripts/cutover-smoke.sh`

**Interfaces:**
- Consumes: every prior task
- Produces: production running the new pipeline

- [ ] **Step 1: Write the backfill**

Adopt existing visible `error_groups` rows as canonical issues, open an active episode for each, bind confirmed aliases from the report, link recent observations, and seed digest publication receipts so old issues do not announce themselves again as new. Uncertain clusters stay split.

- [ ] **Step 2: Write the smoke script**

`scripts/cutover-smoke.sh` must assert, in order: an event is accepted and returns a capture handle; its resolution row reaches a terminal status; its identity settles to a canonical issue; the filter writes a decision; a qualified episode reaches an inquiry decision; an accepted episode creates exactly one investigation; a digest run freezes, validates, and delivers. This script is the only gate before the rollback window closes.

- [ ] **Step 3: Run the full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: PASS with `DATABASE_URL` and storage configured, and **zero** skipped Go database or storage tests. Remove stale `dist/` output first, since it survives between runs and a local build otherwise proves nothing about a clean checkout.

- [ ] **Step 4: Execute the window**

1. Let active jobs finish.
2. Stop ingestion and the worker.
3. Snapshot Postgres.
4. Apply migrations 054 and 055.
5. Deploy both runtimes.
6. Run `scripts/cutover-smoke.sh`.
7. Resume traffic.

The browser SDK buffers up to 100 events and retries with backoff capped at 30 seconds, extended to roughly 45 by jitter, with a best-effort unload flush limited to 60 KiB. A short outage is mostly survivable, not lossless: overflow, prolonged failure, or navigation can still drop events.

- [ ] **Step 5: Know the rollback boundary**

Before traffic resumes, restore the snapshot and the old images. After new canonical data arrives, recovery is a forward fix, because old binaries cannot read the new sources of truth safely.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/migrations/055_cutover_backfill.sql scripts/cutover-smoke.sh
git commit -m "feat(cutover): add the backfill and the live smoke gate"
```

---

## Self-review

**Spec coverage.** Every architecture section maps to at least one task.

| Architecture section | Tasks |
| --- | --- |
| 1. Store observations | 8 |
| 1. Stack resolution | 9, 10, 11 |
| 1. Session facts | 15, 16A |
| 1. Product understanding | 17 |
| 2. One problem, one issue | 12, 12A, 13, 14 |
| 3. Cheap filter | 18, 19 |
| 4. Inquiry | 21, 22, 23 |
| 5. Investigation | 24 |
| 6. Daily message | 25, 25A, 26, 27, 28 |
| 7. Inbox | 28A |
| Stored state and ownership | 5, 20 |
| Asynchrony and orchestration | 14A, 19A, 24, 25A |
| Verification | 19, 23, 28, 29 |
| Direct cutover | 29, 30 |

Acceptance criteria: A1 (28), A2 (3, 12, 12A, 25), A3 (1, 25), A4 (26), A5 (2, 26),
A6 (4, 30), A7 (18, 20, 21, 28A), A8 (27), A9 (14, 26, 28).

**The pipeline is wired end to end.** Three tasks exist only to connect stages,
because an earlier draft built every stage and no track between them. Task 14A makes
settlement open a work round and evaluate it. Task 19A turns an admitted decision
into an inquiry job. Task 24 turns an accepted inquiry into frozen anchors and an
investigation. Task 25A schedules the daily run and advances it through its states.
Task 30's smoke asserts that whole chain, so it now has an implementation behind it.

**Cross-runtime handoffs go through Postgres, never through a shared transaction.**
Go captures, settles, filters, dispatches, accepts, and publishes. TypeScript
resolves stacks, runs the inquiry, investigates, and writes the digest. Each new
state has exactly one writer. Where the two runtimes must cooperate, one writes a
row and the other's loop claims it.

**Known gaps carried forward.** Two open questions from the design record are not
closed by any task. The reopen gate in Task 22 compares an evidence signature whose
exact composition is left to the implementer beyond "counts, route map version, and
failure kinds"; a wrong choice makes inquiries either too chatty or too sticky, and
the Task 23 evaluation is what would catch it. And Task 30's live smoke has its
assertions listed but no written script; it is the last gate before the rollback
window closes and deserves review before the window is scheduled.

**Placeholder scan.** No task contains TBD, "handle edge cases", or a step without
its content. Task 25's `FreezeCandidates` and Task 27's validation carry a described
tail rather than full code; both are scan-and-insert bodies whose queries and
rejection lists are stated in full.

**Type consistency.** `Envelope`, `Frame`, and `GeneratedPos` (Task 6) are used
unchanged in Tasks 10 and 12. `Decision` (Task 18) and `InquiryDecision` (Task 21)
are distinct types over distinct tables. `episode_id` is the join key from Task 14
onward, added to `error_group_jobs` by the migration in Task 5 before Tasks 19A, 21,
and 24 write it. Every `ON CONFLICT` in the plan names a constraint the migration
creates.
