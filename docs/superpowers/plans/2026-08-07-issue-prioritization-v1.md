# Issue Prioritization v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank error and friction issues by real user impact (`priority = impact × context × cap`), stored server-side and used as the dashboard feed order.

**Architecture:** Two independently shippable increments. Increment A (Tasks 1–7): a Go ticker in ingestion recomputes `priority_score` every 30 minutes from existing rollups, with URL normalization as the privacy boundary; the read API orders by `COALESCE(priority_score,0)`. Increment B (Tasks 8–12): a `route_map` table populated by a worker LLM job that classifies observed URL patterns against the connected repo; the score SQL gains a weight join. The score job must work with no route map (all weights ×1) — that is a spec constraint, not an accident.

**Tech Stack:** Go 1.24 + pgx (ingestion), Postgres, Node 22 + TypeScript (worker), Anthropic API via existing worker harness, Vue 3 (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-07-issue-prioritization-design.md` — the authority on formula, semantics, and copy.

## Global Constraints

- Formula: `priority = impact × context × cap`; `impact = reach_7d + 2 × reach_24h`; `reach_w = distinct identified users in window + distinct sessions in window having no identified user`. This is a "24-hour recency boost", never called "trend".
- Cap ×0.1 only when `reason_code` ∈ {`unfixable_third_party`, `unfixable_no_app_frames`, `unfixable_infra`, `unfixable_test_error`, `triage_unfixable`}; no reason code → no cap.
- Context weights fixed: customer ×3, admin ×0.5, everything else ×1. Unmapped/no repo → ×1.
- Scores are project-wide; per-environment scores are out of scope.
- Time windows use `created_at` (server arrival), never client `timestamp` (back-datable — see `009_regression_lifecycle.sql:9-11` precedent).
- Migrations are replayed on every boot (`scripts/run-migrations.sh:11-15`): every statement must be idempotent (`IF NOT EXISTS` etc.); CI enforces via `scripts/check-migration-reapply.sh`.
- URL templating (`:id`, `:token`) runs before storage and before any model call — it is the privacy boundary.
- All ordering uses `COALESCE(priority_score, 0)` so unscored groups join the zero cohort.
- No new dependencies. No queue other than the existing Postgres job queue. Wire contract untouched.
- Verification per package `AGENTS.md`; DB-gated Go tests must run with `DATABASE_URL` exported (skips are failures for this feature's tests).

---

## Increment A — priority score (shippable alone)

### Task 1: Migration 038 — score columns and window indexes

**Files:**
- Create: `packages/ingestion/db/migrations/038_priority_score.sql`

**Interfaces:**
- Produces: columns `error_groups.priority_score REAL`, `error_groups.priority_scored_at TIMESTAMPTZ`, `error_groups.priority_inputs JSONB`; indexes `idx_error_events_group_created`, `idx_friction_signals_incident_time`.

- [ ] **Step 1: Write the migration**

```sql
-- 038_priority_score.sql
-- Priority score v1 (spec: docs/superpowers/specs/2026-08-07-issue-prioritization-design.md).
-- Score is project-wide, recomputed by the priority sweeper; NULL means "never scored".
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_score REAL;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_scored_at TIMESTAMPTZ;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS priority_inputs JSONB;

-- Reach windows scan events per group by server arrival time.
CREATE INDEX IF NOT EXISTS idx_error_events_group_created
  ON error_events (error_group_id, created_at);

-- Friction reach keys on the promoted incident, live rows only.
CREATE INDEX IF NOT EXISTS idx_friction_signals_incident_time
  ON friction_signals (incident_id, occurred_at)
  WHERE incident_id IS NOT NULL AND superseded_by IS NULL AND retracted_at IS NULL;
```

- [ ] **Step 2: Verify idempotent replay locally**

Run (from repo root, Compose Postgres up, `DATABASE_URL` exported):
```bash
./scripts/run-migrations.sh && ./scripts/run-migrations.sh
```
Expected: both passes succeed (second pass proves idempotency).

- [ ] **Step 3: Commit**

```bash
git add packages/ingestion/db/migrations/038_priority_score.sql
git commit -m "feat(ingestion): add priority score columns and window indexes"
```

### Task 2: URL normalization (pure Go, the privacy boundary)

**Files:**
- Create: `packages/ingestion/priority/urlnorm.go`
- Test: `packages/ingestion/priority/urlnorm_test.go`

**Interfaces:**
- Produces: `func NormalizePageURL(raw string) string` — returns a normalized, templated path (`/assets/:id`, `forge:issue-context`, `/sign/:token`), or `""` for empty input. Pure function, no DB.

- [ ] **Step 1: Write the failing tests**

```go
package priority

import "testing"

func TestNormalizePageURL(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"plain path", "https://app.example.com/assets", "/assets"},
		{"host collapsed", "https://api.example.com/licenses", "/licenses"},
		{"raw ip collapsed", "https://54.186.188.118/alerts", "/alerts"},
		{"numeric id", "https://app.example.com/assets/2985977", "/assets/:id"},
		{"uuid id", "https://a.example.com/x/6428e085-905a-40e4-9c67-d0b9772ceec6", "/x/:id"},
		{"hashbang fragment", "https://app.example.com/#!/reports", "/reports"},
		{"hashbang with id", "https://app.example.com/#!/assets/42", "/assets/:id"},
		{"forge module", "https://59n3u0--x.cdn.prod.atlassian-dev.net/301a/bd1e/2906/global-page/_ctx_H4sIAAAA/", "forge:global-page"},
		{"forge issue context", "https://x.cdn.prod.atlassian-dev.net/a/b/c/issue-context/_ctx_abc/", "forge:issue-context"},
		{"jwt segment", "https://app.example.com/c/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ", "/c/:token"},
		{"long opaque segment", "https://app.example.com/sign/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "/sign/:token"},
		{"short words kept", "https://app.example.com/settings/field-sync", "/settings/field-sync"},
		{"query already stripped by sdk, strip anyway", "https://app.example.com/assets?x=1", "/assets"},
		{"root", "https://app.example.com/", "/"},
		{"non-url garbage", "not a url", "/not-parseable"},
	}
	for _, c := range cases {
		if got := NormalizePageURL(c.in); got != c.want {
			t.Errorf("%s: NormalizePageURL(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./priority/`
Expected: FAIL — `undefined: NormalizePageURL`.

- [ ] **Step 3: Implement**

```go
// Package priority computes issue priority scores.
package priority

import (
	"net/url"
	"regexp"
	"strings"
)

// Forge Custom UI resources; a CDN URL's path contains the module key.
var forgeModules = []string{"global-page", "project-page", "issue-context", "portal-panel", "booking-panel"}

var (
	numericSeg = regexp.MustCompile(`^\d+$`)
	uuidSeg    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	jwtSeg     = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]+\.`)
	opaqueSeg  = regexp.MustCompile(`^[A-Za-z0-9+/_=-]{16,}$`)
	wordish    = regexp.MustCompile(`[a-zA-Z]`)
)

// NormalizePageURL maps a raw observed URL to a normalized, templated path.
// It is the privacy boundary: opaque path segments become :token BEFORE the
// value is stored or shown to any model. The SDK's scrubUrl keeps path
// segments, so this must not be skipped.
func NormalizePageURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "/not-parseable"
	}
	if strings.HasSuffix(u.Hostname(), "atlassian-dev.net") {
		for _, m := range forgeModules {
			if strings.Contains(u.Path, "/"+m+"/") || strings.HasSuffix(u.Path, "/"+m) {
				return "forge:" + m
			}
		}
		return "forge:unknown"
	}
	path := u.EscapedPath()
	// Atlassian Connect keeps the SPA route in a #! fragment.
	if strings.HasPrefix(u.Fragment, "!") {
		path = strings.TrimPrefix(u.Fragment, "!")
	}
	segs := strings.Split(strings.Trim(path, "/"), "/")
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		switch {
		case s == "":
			continue
		case numericSeg.MatchString(s) || uuidSeg.MatchString(s):
			out = append(out, ":id")
		case jwtSeg.MatchString(s),
			opaqueSeg.MatchString(s) && !strings.Contains(s, "-") && len(s) >= 16,
			opaqueSeg.MatchString(s) && !wordish.MatchString(s):
			out = append(out, ":token")
		default:
			out = append(out, s)
		}
	}
	return "/" + strings.Join(out, "/")
}
```

Note: the `opaqueSeg` branch intentionally errs toward templating; `/settings/field-sync` survives because hyphenated word-bearing segments are kept. Adjust the heuristics until Step 1's table passes — the table is the contract, extend it if you find a counterexample, never weaken existing rows.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/ingestion && go test ./priority/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/priority/
git commit -m "feat(ingestion): URL normalization with :id/:token templating"
```

### Task 3: Priority sweeper — reach windows, score write

**Files:**
- Create: `packages/ingestion/priority/sweeper.go`
- Test: `packages/ingestion/priority/sweeper_test.go` (DB-gated, follows `packages/ingestion/db` test conventions)

**Interfaces:**
- Consumes: `db.Queries` pool access (same shape as `retention.Sweeper`, `packages/ingestion/retention/retention.go:47`); `NormalizePageURL` from Task 2.
- Produces: `type Sweeper struct { Pool *pgxpool.Pool }` with `func (s *Sweeper) Start(ctx context.Context, interval time.Duration)` and `func (s *Sweeper) RunOnce(ctx context.Context) (int, error)` (returns groups scored). Task 6 wires `Start`; Task 8 modifies the SQL here.

- [ ] **Step 1: Write the failing DB test**

Follow the existing DB-test setup in `packages/ingestion/db` (TestMain, `DATABASE_URL` env). Seed minimal rows with raw SQL in the test; use fixed UUIDs.

```go
package priority

// requires DATABASE_URL; uses the shared test harness pattern from packages/ingestion/db
func TestRunOnceScoresErrorGroups(t *testing.T) {
	pool := testPool(t) // helper mirroring db package's test setup; t.Skip only when DATABASE_URL unset
	seed := func(sql string, args ...any) { t.Helper(); mustExec(t, pool, sql, args...) }

	// project + environment + group A: 2 identified users in 7d (1 in 24h) + 1 anonymous-only session
	// group B: 1 anonymous session, capped reason code
	// group C (friction): 3 live friction signals, 2 distinct users, 1 anonymous session
	// (INSERT statements for projects, environments, error_groups, end_users,
	//  error_group_affected_users, error_events, sessions, friction_signals —
	//  copy column lists from 001_baseline.sql / 004_friction.sql.)

	s := &Sweeper{Pool: pool}
	n, err := s.RunOnce(context.Background())
	if err != nil { t.Fatal(err) }
	if n < 3 { t.Fatalf("scored %d groups, want >= 3", n) }

	var scoreA, scoreB, scoreC float64
	var inputsA []byte
	row(t, pool, `SELECT priority_score, priority_inputs FROM error_groups WHERE id=$1`, groupA).Scan(&scoreA, &inputsA)
	row(t, pool, `SELECT priority_score FROM error_groups WHERE id=$1`, groupB).Scan(&scoreB)
	row(t, pool, `SELECT priority_score FROM error_groups WHERE id=$1`, groupC).Scan(&scoreC)

	// A: reach_7d = 2 users + 1 anon session = 3; reach_24h = 1; impact = 3 + 2*1 = 5; weight 1; no cap => 5
	if scoreA != 5 { t.Errorf("A = %v, want 5", scoreA) }
	// B: reach_7d = 1; impact 1; cap 0.1 => 0.1
	if scoreB != 0.1 { t.Errorf("B = %v, want 0.1", scoreB) }
	// C (friction): reach_7d = 2 users + 1 anon session = 3, none in 24h => 3
	if scoreC != 3 { t.Errorf("C = %v, want 3", scoreC) }

	// Monotonicity: identifying a previously-anonymous session must not lower A.
	seed(`UPDATE error_events SET end_user_id=$1 WHERE error_group_id=$2 AND end_user_id IS NULL`, userX, groupA)
	seed(`INSERT INTO error_group_affected_users (error_group_id, end_user_id, first_seen, last_seen)
	      VALUES ($1,$2,now(),now()) ON CONFLICT DO NOTHING`, groupA, userX)
	if _, err := s.RunOnce(context.Background()); err != nil { t.Fatal(err) }
	var after float64
	row(t, pool, `SELECT priority_score FROM error_groups WHERE id=$1`, groupA).Scan(&after)
	if after < scoreA { t.Errorf("identify lowered score: %v -> %v", scoreA, after) }

	// scored_at set; inputs have the fixed shape
	var keys []string
	row(t, pool, `SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(
	  (SELECT priority_inputs FROM error_groups WHERE id=$1)) k`, groupA).Scan(&keys)
	want := []string{"anon_sessions_24h","anon_sessions_7d","cap_applied","impact","reason_code",
	  "route_pattern","route_tier","route_weight","users_24h","users_7d"}
	if !slices.Equal(keys, want) { t.Errorf("inputs keys = %v", keys) }
}
```

Also add `TestRunOnceStampsTopURL`: seed group A with 3 events at `https://app.x.com/assets/1` and 1 at `https://app.x.com/other`, run once, assert `page_url_normalized = '/assets/:id'`; assert a friction group's pre-existing `page_url_normalized` is NOT overwritten.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./priority/ -run TestRunOnce`
Expected: FAIL — `undefined: Sweeper`.

- [ ] **Step 3: Implement the sweeper**

```go
package priority

const cappedReasonCodes = `('unfixable_third_party','unfixable_no_app_frames','unfixable_infra','unfixable_test_error','triage_unfixable')`

// scoreErrorGroupsSQL scores kind='error' groups. Task 8 adds the route_map
// join; until then route_weight is literally 1 and route_tier/pattern come
// from the stamped page_url_normalized with no classification.
const scoreErrorGroupsSQL = `
WITH windows AS (
  SELECT eg.id,
    (SELECT count(*) FROM error_group_affected_users u
      WHERE u.error_group_id = eg.id AND u.last_seen > now() - interval '7 days')  AS users_7d,
    (SELECT count(*) FROM error_group_affected_users u
      WHERE u.error_group_id = eg.id AND u.last_seen > now() - interval '24 hours') AS users_24h,
    (SELECT count(*) FROM (
        SELECT ee.session_id FROM error_events ee
        WHERE ee.error_group_id = eg.id AND ee.session_id IS NOT NULL
          AND ee.created_at > now() - interval '7 days'
        GROUP BY ee.session_id HAVING bool_and(ee.end_user_id IS NULL)) anon) AS anon_7d,
    (SELECT count(*) FROM (
        SELECT ee.session_id FROM error_events ee
        WHERE ee.error_group_id = eg.id AND ee.session_id IS NOT NULL
          AND ee.created_at > now() - interval '24 hours'
        GROUP BY ee.session_id HAVING bool_and(ee.end_user_id IS NULL)) anon) AS anon_24h,
    eg.reason_code, eg.page_url_normalized
  FROM error_groups eg
  WHERE eg.kind = 'error' AND eg.status NOT IN ('resolved','merged','archived')
)
UPDATE error_groups eg SET
  priority_score = sub.score,
  priority_scored_at = now(),
  priority_inputs = sub.inputs
FROM (
  SELECT id,
    ((users_7d + anon_7d) + 2 * (users_24h + anon_24h))
      * 1.0
      * (CASE WHEN reason_code IN ` + cappedReasonCodes + ` THEN 0.1 ELSE 1 END) AS score,
    jsonb_build_object(
      'users_7d', users_7d, 'anon_sessions_7d', anon_7d,
      'users_24h', users_24h, 'anon_sessions_24h', anon_24h,
      'impact', (users_7d + anon_7d) + 2 * (users_24h + anon_24h),
      'route_pattern', page_url_normalized, 'route_tier', NULL, 'route_weight', 1,
      'cap_applied', reason_code IN ` + cappedReasonCodes + `,
      'reason_code', reason_code
    ) AS inputs
  FROM windows
) sub
WHERE eg.id = sub.id`
```

Friction variant (`scoreFrictionGroupsSQL`): same shape, `kind='friction'`, windows from `friction_signals` keyed on `incident_id` with the live predicate and `occurred_at`:

```sql
(SELECT count(DISTINCT fs.end_user_id) FROM friction_signals fs
  WHERE fs.incident_id = eg.id AND fs.end_user_id IS NOT NULL
    AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL
    AND fs.occurred_at > now() - interval '7 days') AS users_7d,
-- anon: sessions whose live signals for this incident all lack end_user_id
(SELECT count(*) FROM (
    SELECT fs.session_id FROM friction_signals fs
    WHERE fs.incident_id = eg.id AND fs.superseded_by IS NULL AND fs.retracted_at IS NULL
      AND fs.occurred_at > now() - interval '7 days'
    GROUP BY fs.session_id HAVING bool_and(fs.end_user_id IS NULL)) anon) AS anon_7d,
```

URL stamping (errors only, friction untouched) runs before scoring in the same `RunOnce`:

```go
// stampTopURLs: for each open error group, most-events-in-7d URL, ties by latest event.
const pickTopURLsSQL = `
SELECT DISTINCT ON (ee.error_group_id) ee.error_group_id, ee.context->>'url'
FROM error_events ee
JOIN error_groups eg ON eg.id = ee.error_group_id
WHERE eg.kind = 'error' AND eg.status NOT IN ('resolved','merged','archived')
  AND ee.created_at > now() - interval '7 days' AND ee.context->>'url' IS NOT NULL
GROUP BY ee.error_group_id, ee.context->>'url'
ORDER BY ee.error_group_id, count(*) DESC, max(ee.created_at) DESC`
```

Go side: scan pairs, `NormalizePageURL` each, batch-update `page_url_normalized` (`UPDATE error_groups SET page_url_normalized=$2 WHERE id=$1`). `RunOnce` = stamp → score errors → score friction, returning total rows affected. `Start` copies `retention.Sweeper.Start` (`retention.go:47`): ticker + `ctx.Done()`, `slog` on each pass.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/ingestion && DATABASE_URL=$DATABASE_URL go test ./priority/ -run 'TestRunOnce' -v`
Expected: PASS, zero skips.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/priority/
git commit -m "feat(ingestion): priority sweeper computes reach-based scores"
```

### Task 4: Read API — expose and order by priority

**Files:**
- Modify: `packages/ingestion/db/queries.go:377-408` (struct), `:822-832` and `:895-919` (both list branches), `:925-936` (scan)
- Modify: `packages/ingestion/handler/read_api.go:22-51` (incidentJSON) and the mapping inside `ListIncidents` (read_api.go:214)
- Test: `packages/ingestion/db/queries_priority_test.go` (DB-gated)

**Interfaces:**
- Consumes: columns from Task 1.
- Produces: `ErrorGroup.PriorityScore *float64`, `ErrorGroup.PriorityInputs []byte`, `ErrorGroup.PriorityScoredAt *time.Time`; JSON fields `priority_score`, `priority_inputs`, `priority_scored_at` on the incidents list/detail payloads. Feed order: `ORDER BY COALESCE(eg.priority_score,0) DESC, eg.last_seen DESC, eg.id DESC` (both branches).

- [ ] **Step 1: Write the failing test**

```go
func TestListErrorGroupsOrdersByPriority(t *testing.T) {
	// Seed three groups in one project:
	//  - "older-high": priority_score=10, last_seen = now()-2h
	//  - "newer-zero": priority_score=NULL, last_seen = now()
	//  - "mid":        priority_score=0.5,  last_seen = now()-1h
	// Expect order: older-high, mid, newer-zero (COALESCE(NULL,0) ties with 0-cohort, last_seen breaks it).
	got, err := q.ListErrorGroups(ctx, projectID, nil)
	// assert got[0].Title=="older-high", got[1].Title=="mid", got[2].Title=="newer-zero"
	// assert got[0].PriorityScore != nil && *got[0].PriorityScore == 10
	// assert got[0].PriorityInputs is valid JSON when set
}
```

Add the same ordering assertion through the environment-filtered branch (seed `error_group_environments` rows, pass `&ErrorGroupFilters{EnvironmentID: &envID}`).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./db/ -run TestListErrorGroupsOrdersByPriority`
Expected: FAIL (compile error on `PriorityScore` field, then ordering mismatch).

- [ ] **Step 3: Implement**

- Add to `ErrorGroup` struct: `PriorityScore *float64`, `PriorityInputs []byte`, `PriorityScoredAt *time.Time`.
- Add `eg.priority_score, eg.priority_inputs, eg.priority_scored_at` to both SELECT lists and the env-branch `candidates` arms; extend `rows.Scan` accordingly.
- Change both `ORDER BY` clauses to `ORDER BY COALESCE(<alias>.priority_score, 0) DESC, <alias>.last_seen DESC, <alias>.id DESC`.
- `incidentJSON`: add

```go
PriorityScore    *float64        `json:"priority_score,omitempty"`
PriorityInputs   json.RawMessage `json:"priority_inputs,omitempty"`
PriorityScoredAt *time.Time      `json:"priority_scored_at,omitempty"`
```

and populate in the incident mapping used by `ListIncidents` and `GetIncident`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/ingestion && go test ./db/ ./handler/ && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/ packages/ingestion/handler/
git commit -m "feat(ingestion): incidents feed orders by priority, exposes score + inputs"
```

### Task 5: Types and dashboard — priority as default sort, honest labels

**Files:**
- Modify: `shared/src/types.ts` (incident type used by the read API mirror), `packages/dashboard/src/types/api.ts:132-166`
- Modify: `packages/dashboard/src/views/IssuesList.vue:38-60`
- Create: `packages/dashboard/src/components/incidents/PriorityReason.vue`
- Test: `packages/dashboard/src/views/__tests__/IssuesList.priority.test.ts`, `packages/dashboard/src/components/incidents/__tests__/PriorityReason.test.ts`

**Interfaces:**
- Consumes: `priority_score?: number`, `priority_inputs?: PriorityInputs`, `priority_scored_at?: string` from Task 4.
- Produces: `interface PriorityInputs { users_7d: number; anon_sessions_7d: number; users_24h: number; anon_sessions_24h: number; impact: number; route_pattern: string | null; route_tier: string | null; route_weight: number; cap_applied: boolean; reason_code: string | null }`; component `PriorityReason` with props `{ incident: Incident; environmentFiltered: boolean }`.

- [ ] **Step 1: Write the failing tests**

`PriorityReason.test.ts` (Vitest + @vue/test-utils, colocated per repo convention):

```ts
it('renders known users and anonymous sessions', () => {
  const w = mount(PriorityReason, { props: { incident: incidentWith({
    priority_inputs: { users_7d: 14, anon_sessions_7d: 6, users_24h: 2, anon_sessions_24h: 0,
      impact: 24, route_pattern: '/checkout', route_tier: null, route_weight: 1,
      cap_applied: false, reason_code: null } }), environmentFiltered: false } });
  expect(w.text()).toContain('14 known users + 6 anonymous sessions this week');
});
it('labels project-wide reach under an environment filter', () => {
  // environmentFiltered: true => text contains 'project-wide'
});
it('shows the identify hint when reach is anonymous-only', () => {
  // users_7d: 0, anon_sessions_7d: 9 => text contains 'no user identification'
});
it('shows remediation for capped incidents', () => {
  // cap_applied: true + incident.reason.remediation set => remediation text rendered
});
```

`IssuesList.priority.test.ts`:

```ts
it('defaults to priority order and falls back to zero for unscored rows', () => {
  // three incidents: score 10 / undefined / 0.5 -> rendered order 10, 0.5, undefined-by-last_seen
});
it('labels non-priority sorts as loaded-only', () => {
  // switching sort to last_seen shows caption 'Sorting the loaded issues only'
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opslane/dashboard test`
Expected: FAIL — missing component/sort key.

- [ ] **Step 3: Implement**

- `shared/src/types.ts` + `dashboard/src/types/api.ts`: add the three fields + `PriorityInputs` (append-only; optional fields).
- `IssuesList.vue`: `type SortKey = 'priority' | 'last_seen' | 'occurrences' | 'users' | 'status' | 'age'`; comparator `priority: (a, b) => (a.priority_score ?? 0) - (b.priority_score ?? 0)`; default key `'priority'` (replace `'users'` at :50). Under the table controls, when `sortKey !== 'priority'`, render `<p class="text-xs …">Sorting the loaded issues only — the server feed is ordered by priority.</p>`.
- `PriorityReason.vue`: pure presentational; copy rules (exact strings, from spec):
  - reach: `"{users_7d} known users + {anon_sessions_7d} anonymous sessions this week"`, omitting a zero side (`"14 known users this week"`, `"9 anonymous sessions this week"`); append `" · {users_24h + anon_sessions_24h} today"` when positive.
  - `environmentFiltered` → append `" · project-wide"`.
  - anonymous-only (`users_7d === 0 && anon_sessions_7d > 0`) → line `"No user identification on this page — counting sessions."`
  - `cap_applied` → line `"The agent can't fix this class (ranked down)."` plus `incident.reason?.remediation` when present.
  Sanitize nothing into HTML — text interpolation only (error/model text is untrusted per dashboard AGENTS.md).
- Render `PriorityReason` per row in `IssuesList.vue`; `environmentFiltered` = current environment filter is set.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/shared build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts packages/dashboard/
git commit -m "feat(dashboard): priority feed order with plain-language reason line"
```

### Task 6: Wire the sweeper into main and smoke it live

**Files:**
- Modify: `packages/ingestion/main.go` (next to the token-cleanup goroutine at main.go:182 — unconditional, NOT inside the `minioClient != nil` block at :205)

**Interfaces:**
- Consumes: `priority.Sweeper` from Task 3.
- Produces: running ticker; env override `PRIORITY_SCORE_INTERVAL_SECONDS` (default 1800).

- [ ] **Step 1: Wire the ticker**

```go
// After main.go:201 (token cleanup goroutine):
prioritySweeper := &priority.Sweeper{Pool: pool}
priorityInterval := 30 * time.Minute
if v := os.Getenv("PRIORITY_SCORE_INTERVAL_SECONDS"); v != "" {
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		priorityInterval = time.Duration(secs) * time.Second
	}
}
go prioritySweeper.Start(context.Background(), priorityInterval)
```

(Match the exact pool/queries variable names in main.go; follow `RETENTION_SWEEP_INTERVAL_SECONDS` handling at main.go:228-233 for the env pattern. Document the variable in `docs/reference/environment-variables.md`.)

- [ ] **Step 2: Build and unit-test everything so far**

Run: `cd packages/ingestion && go build ./... && go test ./...`
Expected: PASS, and confirm **zero skips** in `./priority` and `./db` (AGENTS.md: a storage misconfiguration reports ok while tests never run).

- [ ] **Step 3: Live pipeline smoke (per AGENTS.md worktree port discipline)**

```bash
# export the port/URL block from AGENTS.md first (pick a free triple)
docker compose config --quiet
# rebuild ingestion, apply migrations, seed
(cd packages/ingestion && go build ./...)
./scripts/run-migrations.sh && psql "$DATABASE_URL" -f scripts/seed-e2e.sql
# start stack, send an event from test-fixtures/vue-app, then force a pass:
PRIORITY_SCORE_INTERVAL_SECONDS=5 # via compose env for ingestion
curl -s "$INGESTION_URL/api/v1/projects/<seeded-project>/incidents" -H "Authorization: Bearer <seeded session>" \
  | jq '.[0] | {title, priority_score, priority_inputs}'
```
Expected: the seeded event's group carries `priority_score > 0`, `priority_inputs` with all ten keys, and the list is priority-ordered.

- [ ] **Step 4: Commit**

```bash
git add packages/ingestion/main.go docs/reference/environment-variables.md
git commit -m "feat(ingestion): run priority sweeper every 30 minutes"
```

### Task 7: Increment A gate

- [ ] **Step 1: Full repository gate** (AGENTS.md):

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```
Expected: green, with `DATABASE_URL` exported and skip counts read (zero skips in priority/db feature tests).

- [ ] **Step 2: Commit any stragglers; this is the Increment A ship point.** Everything after this line is Increment B and may be cut without touching A.

---

## Increment B — route map (own increment, own migration)

### Task 8: Migration 039 + weight join in the score SQL

**Files:**
- Create: `packages/ingestion/db/migrations/039_route_map.sql`
- Modify: `packages/ingestion/priority/sweeper.go` (the `* 1.0` weight literal and the `route_tier`/`route_weight` fields in `scoreErrorGroupsSQL` / `scoreFrictionGroupsSQL`)
- Test: extend `packages/ingestion/priority/sweeper_test.go`

**Interfaces:**
- Produces: table `route_map(project_id UUID, pattern TEXT, name TEXT, purpose TEXT, tier TEXT CHECK (tier IN ('customer','standard','admin')), source TEXT NOT NULL DEFAULT 'llm', created_at, updated_at, PRIMARY KEY (project_id, pattern))`; score SQL resolves weight `customer→3, admin→0.5, standard→1, no row→1`.

- [ ] **Step 1: Migration**

```sql
-- 039_route_map.sql
CREATE TABLE IF NOT EXISTS route_map (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL,           -- normalized templated path, e.g. /sign/:token, forge:portal-panel
  name       TEXT NOT NULL,           -- human name, e.g. 'JSM portal panel'
  purpose    TEXT NOT NULL DEFAULT '',
  tier       TEXT NOT NULL CHECK (tier IN ('customer','standard','admin')),
  source     TEXT NOT NULL DEFAULT 'llm',  -- 'llm' | 'human'; human edits win, job never overwrites 'human'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, pattern)
);
```

- [ ] **Step 2: Failing test** — extend the Task 3 test: insert `route_map` row `(project, '/portal', 'Portal', 'customer')`, seed a group stamped `/portal` with reach 2; assert score `6` and `priority_inputs.route_tier == 'customer'`, `route_weight == 3`; assert a group with no row keeps weight 1.

Run: `go test ./priority/ -run TestRunOnce` — Expected: FAIL (weight still 1).

- [ ] **Step 3: Implement** — in both score SQLs replace the literal:

```sql
  * COALESCE(rm.weight, 1)
...
LEFT JOIN LATERAL (
  SELECT CASE rm.tier WHEN 'customer' THEN 3.0 WHEN 'admin' THEN 0.5 ELSE 1.0 END AS weight,
         rm.tier, rm.name
  FROM route_map rm
  WHERE rm.project_id = eg.project_id AND rm.pattern = eg.page_url_normalized
) rm ON true
```

and populate `route_tier`/`route_weight`/`route_name` in `priority_inputs` from the join. (Exact-match on pattern is v1: stamped paths are already templated by the same normalizer that produced the patterns, so no glob matching is needed.)

- [ ] **Step 4: Run** `./scripts/run-migrations.sh && ./scripts/run-migrations.sh && go test ./priority/` — Expected: PASS twice-applied + tests green.

- [ ] **Step 5: Commit** — `git commit -m "feat(ingestion): route_map table weights priority context"`

### Task 9: Enqueue route-map jobs from the sweeper

**Files:**
- Modify: `shared/src/types.ts:359` (`JobType` union: add `'route_map'`)
- Modify: `packages/ingestion/priority/sweeper.go` (`RunOnce` final phase)
- Test: extend `packages/ingestion/priority/sweeper_test.go`

**Interfaces:**
- Consumes: `error_group_jobs` table (`job_type` has no CHECK constraint — `001_baseline.sql:371` — so no migration needed).
- Produces: pending `error_group_jobs` rows with `job_type='route_map'`, `project_id` set, `error_group_id` NULL. Worker (Task 10) claims them; new kind falls into the existing default claim lane (`packages/worker/src/db.ts:273-283` CASE lands non-special kinds in lane 2 — acceptable, no change there).

- [ ] **Step 1: Failing test** — seed a project with `github_repo='o/r'` and one stamped, unmapped pattern; `RunOnce`; assert exactly one pending `route_map` job; `RunOnce` again; assert still exactly one (dedupe). Seed a second project with no `github_repo`; assert no job.

- [ ] **Step 2: Implement** — after scoring, one statement (dedupe pattern copied from `packages/ingestion/db/sessions.go:380`):

```sql
INSERT INTO error_group_jobs (project_id, job_type)
SELECT p.id, 'route_map' FROM projects p
WHERE p.github_repo IS NOT NULL
  AND EXISTS (SELECT 1 FROM error_groups eg
              WHERE eg.project_id = p.id AND eg.page_url_normalized IS NOT NULL
                AND eg.status NOT IN ('resolved','merged','archived')
                AND NOT EXISTS (SELECT 1 FROM route_map rm
                                WHERE rm.project_id = p.id AND rm.pattern = eg.page_url_normalized))
  AND NOT EXISTS (SELECT 1 FROM error_group_jobs j
                  WHERE j.project_id = p.id AND j.job_type = 'route_map'
                    AND j.status IN ('pending','claimed'))
```

This is the whole trigger story: no repo-connect hook needed — the next tick after a repo is connected (or after new URLs appear) enqueues classification, which also covers repos connected before this feature shipped.

- [ ] **Step 3: Run** `go test ./priority/` + `pnpm --filter @opslane/shared build` — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(ingestion): enqueue route_map jobs for unmapped observed patterns"`

### Task 10: Worker route-map job

**Files:**
- Create: `packages/worker/src/route-map.ts`
- Modify: `packages/worker/src/index.ts` (dispatch branch next to `:329` `ci_watch`)
- Modify: `packages/worker/src/db.ts` (two small queries, exported for route-map.ts)
- Test: `packages/worker/src/__tests__/route-map.test.ts`

**Interfaces:**
- Consumes: `cloneRepo` (`packages/worker/src/repo-clone.ts:185`, returns `{ repoDir, defaultBranch, cleanup }`); `runReadOnlyAgent` (`packages/worker/src/readonly-agent.ts`, as used by `investigate.ts:222`); pool from `db.ts`.
- Produces:

```ts
export interface RouteMapRow { pattern: string; name: string; purpose: string; tier: 'customer' | 'standard' | 'admin' }
export function buildRouteMapPrompt(patterns: string[]): string
export function parseRouteMapResponse(text: string, patterns: string[]): RouteMapRow[]  // throws on invalid tier/unknown pattern
export async function processRouteMapJob(job: ClaimedJob, deps: { clone?: typeof cloneRepo }): Promise<void>
```

- [ ] **Step 1: Failing tests** (pure functions first — no network, no DB):

```ts
describe('parseRouteMapResponse', () => {
  const patterns = ['/assets/:id', 'forge:portal-panel'];
  it('accepts a valid JSON array and preserves pattern identity', () => {
    const rows = parseRouteMapResponse(JSON.stringify([
      { pattern: '/assets/:id', name: 'Asset details', purpose: 'View one asset', tier: 'standard' },
      { pattern: 'forge:portal-panel', name: 'JSM portal panel', purpose: 'Customers attach assets to tickets', tier: 'customer' },
    ]), patterns);
    expect(rows).toHaveLength(2);
  });
  it('rejects unknown tiers', () => { /* tier: 'revenue' -> throws */ });
  it('rejects rows for patterns that were not asked about', () => { /* hallucinated pattern -> throws */ });
  it('tolerates missing rows (partial classification is fine)', () => { /* 1 of 2 -> length 1 */ });
  it('strips markdown fences around the JSON', () => { /* ```json ... ``` -> parsed */ });
});
describe('buildRouteMapPrompt', () => {
  it('embeds every pattern and the three-tier contract', () => {
    const p = buildRouteMapPrompt(['/a', '/b']);
    expect(p).toContain('/a'); expect(p).toContain('"customer"'); expect(p).toContain('"admin"');
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @opslane/worker test -- route-map` — Expected: FAIL.

- [ ] **Step 3: Implement.** Prompt (versioned `export const ROUTE_MAP_PROMPT_VERSION = 1` alongside, mirroring `ADJUDICATION_PROMPT_VERSION` in `friction/adjudicator.ts`):

```
You are classifying the pages of a web application by WHO uses them.
The repository is checked out at your working directory. For each URL pattern
below, find the code that serves it (router config, page/component files,
manifest or app-descriptor declarations for embedded surfaces) and answer.

Tiers (audience, a code fact — never guess from the path alone):
- "customer": reachable by people outside the operating team — unauthenticated
  or token-link routes, customer-portal or embed modules, public pages.
- "admin": admin/settings/config surfaces (requiresAdmin guards, /settings, /admin).
- "standard": everything else behind normal login.

URL patterns observed in production errors (classify ONLY these; ':id' and
':token' are placeholders; 'forge:<module>' means an Atlassian Forge module):
{patterns, one per line}

Return ONLY a JSON array, one object per pattern you could ground in code:
[{"pattern": "...", "name": "<short human name>", "purpose": "<one line>", "tier": "customer|standard|admin"}]
Skip patterns you cannot find code for. No prose.
```

`processRouteMapJob`: load project (`github_repo`, org) → collect distinct `page_url_normalized` for open groups with no `route_map` row (SQL in db.ts) → if empty, complete job → `cloneRepo` → `runReadOnlyAgent` with the prompt (budget: `maxTurns: 20`, `budgetUsd: 0.5`, same model default as `investigate.ts`) → `parseRouteMapResponse` → upsert rows:

```sql
INSERT INTO route_map (project_id, pattern, name, purpose, tier)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (project_id, pattern) DO UPDATE
SET name=EXCLUDED.name, purpose=EXCLUDED.purpose, tier=EXCLUDED.tier, updated_at=now()
WHERE route_map.source <> 'human'
```

→ mark job done; `cleanup()` in `finally`. Failure handling mirrors other kinds: parse/clone errors mark the job failed with the message; no retries beyond the queue's existing lease behavior. Dispatch in `index.ts` `processJob`: `if (job.jobType === 'route_map') { await processRouteMapJob(job, {}); return; }`.

- [ ] **Step 4: Run** `pnpm --filter @opslane/worker test && pnpm --filter @opslane/worker build` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): route_map job classifies observed URL patterns from the repo"`

### Task 11: Dashboard route chip

**Files:**
- Modify: `packages/dashboard/src/components/incidents/PriorityReason.vue` (+ its test)

**Interfaces:**
- Consumes: `priority_inputs.route_name` (add to `PriorityInputs` type: `route_name: string | null` — also added server-side in Task 8's inputs JSON).

- [ ] **Step 1: Failing test** — `route_name: 'JSM portal panel', route_tier: 'customer'` renders `JSM portal panel · your customers see this page`; `route_tier: 'admin'` renders `· internal config page`; null tier renders the bare `route_pattern` with no reason suffix.
- [ ] **Step 2: Implement** — tier→reason strings exactly: customer `"your customers see this page"`, admin `"internal config page"`, standard `""` (name only).
- [ ] **Step 3: Run** `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build` — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(dashboard): show route name and audience reason on issues"`

### Task 12: Runbook, fixture contract, final gate

**Files:**
- Create: `docs/runbooks/archive-legacy-suppressed-groups.md`
- Test: `packages/worker/src/__tests__/route-map.fixture.test.ts`

- [ ] **Step 1: Fixture contract test** — run `buildRouteMapPrompt` + `parseRouteMapResponse` against `test-fixtures/vue-app`: hand-write the expected classification for the fixture's actual router routes as the assertion table (exact rows, not "sane"); feed a canned LLM response fixture through the parser and assert every tier ∈ enum, every pattern matches a fixture route, names non-empty. (The live-LLM variant is run manually during the smoke, not in CI.)
- [ ] **Step 2: Runbook** (operational, dry-run first — NOT executed as part of this plan):

```markdown
# Archive legacy suppressed-class error groups
Prereq: verify new events cannot resurrect an archived group (grouping path).
1. Dry run (read-only): SELECT id, title, occurrence_count FROM error_groups
   WHERE kind='error' AND status NOT IN ('resolved','merged','archived')
   AND (title ILIKE 'Error: ResizeObserver loop%' OR title = 'Script error.');
2. Review the list with a human. 3. Archive via the existing archive endpoint
   (never raw UPDATE on prod). 4. Confirm archived groups vanish from the feed.
```

- [ ] **Step 3: Full repository gate + live smoke** — repeat Task 6 Step 3 with a route_map row present; expected: the seeded incident's reason line shows the route name, and `priority_inputs.route_weight` reflects the tier. Then the full AGENTS.md gate (build, tests with `DATABASE_URL`, zero skips, compose config).
- [ ] **Step 4: Commit** — `git commit -m "docs: archive runbook; test: route-map fixture contract"`

---

## Self-review notes

- Spec coverage: formula/monotonicity (T3), naming (copy in T5), project-wide + env labeling (T5), friction scoring (T3), feed order + loaded-only labels (T4/T5), scored_at + typed inputs + COALESCE (T1/T3/T4), URL stamping definition + privacy templating (T2/T3), separability (increment boundary, weight literal → join in T8), route-map observed-URLs + human-edits-win (T8/T10), enqueue-without-hook (T9), measurable fixture contract (T12), runbook (T12), identify hint (T5).
- Deliberately absent (spec defers): heavily-used boost, spike detection, per-environment scores, server-side sort parameter, route-map manual-rerun UI (unmapped-pattern detection re-enqueues automatically).
