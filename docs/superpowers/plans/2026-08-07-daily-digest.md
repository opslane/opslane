# Daily Digest v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily, customer-perspective digest per project — computed by an ingestion-side sweep, published through the existing notification outbox, rendered to Slack — per `docs/superpowers/specs/2026-08-07-daily-digest-design.md` (rev 4).

**Architecture:** One deep Go module `packages/ingestion/digest/` exposing `RunOnce(ctx, now)` (sweep tick) and `Build(ctx, projectID, now)` (one project's payload). Due-ness is derived from data every tick; idempotency comes from `outbound_events UNIQUE (project_id, dedup_key)`. The envelope becomes a tagged union (`issue` XOR `digest` body). Delivery reuses the existing dispatcher; only `FormatSlack` grows a digest branch. Sweep ships disabled (`DIGEST_SWEEP_ENABLED`) for two-phase rollout.

**Tech Stack:** Go 1.24 (chi, pgx), Postgres, Vue 3 dashboard, Vitest.

## Global Constraints

- Migrations are append-only and **re-applied on every boot** — every statement must be idempotent. Next free number: `038`.
- Go DB-gated tests skip without `DATABASE_URL`; export it before treating green as proof (`AGENTS.md` root).
- No LLM calls anywhere in the digest path. No new dependencies.
- Ingestion package license: AGPL-3.0-only (default for server-side code).
- Preserve the outbox/delivery lease contracts; do not touch dispatcher claiming logic.
- ESM + strict TypeScript in the dashboard; Vitest tests colocated (`__tests__` / `*.test.ts`).
- Verification per package: `(cd packages/ingestion && go build ./... && go test ./...)`; dashboard: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`.
- Worktree stacks: export the port/URL block from root `AGENTS.md` as a unit before any live verification.

## File Structure

```
packages/ingestion/db/migrations/038_daily_digest.sql        (new: checks, default, backfill, digest_timezone)
packages/ingestion/notify/event.go                           (tagged union + digest payload types + Validate)
packages/ingestion/notify/event_test.go                      (new: envelope marshal/validate tests)
packages/ingestion/notify/slack.go                           (switch on EventType; unknown type errors)
packages/ingestion/notify/slack_digest.go                    (new: digest Block Kit renderer)
packages/ingestion/notify/slack_digest_test.go               (new: golden + budget tests)
packages/ingestion/db/notifications.go                       (publishIssueCreated pointer fix; UpdateNotificationDestination event_types)
packages/ingestion/handler/notifications.go                  (known types, create default, PATCH event_types, test-send event_type)
packages/ingestion/handler/read_api.go                       (digest_timezone PATCH + project JSON)
packages/ingestion/digest/digest.go                          (new: Sweeper, New, Start, RunOnce, due-ness)
packages/ingestion/digest/build.go                           (new: Build + aggregation queries + excerpt helper)
packages/ingestion/digest/digest_test.go                     (new: DB-gated due-ness/RunOnce tests)
packages/ingestion/digest/build_test.go                      (new: DB-gated Build tests + fixture seeder)
packages/ingestion/main.go                                   (wire sweeper + env flag + DigestBuilder dep)
docker-compose.yml                                           (DIGEST_SWEEP_ENABLED env passthrough, default off)
packages/dashboard/src/api.ts                                (updateNotificationDestination event_types; project digest_timezone)
packages/dashboard/src/types/api.ts                          (types)
packages/dashboard/src/components/IntegrationsSettings.vue   (event-type toggles)
packages/dashboard/src/views/Settings.vue                    (digest timezone field)
```

---

### Task 1: Migration 038 — event checks, subscription default, backfill, digest_timezone

**Files:**
- Create: `packages/ingestion/db/migrations/038_daily_digest.sql`

**Interfaces:**
- Produces: `notification_destinations.event_types` accepts `digest.daily` (default + backfilled); `outbound_events.event_type` accepts `digest.daily`; `projects.digest_timezone TEXT NOT NULL DEFAULT 'UTC'`.

- [ ] **Step 1: Confirm the two constraint names before writing DDL**

```bash
PGPASSWORD=opslane_dev psql "$DATABASE_URL" -c "
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid::regclass::text IN ('notification_destinations','outbound_events')
  AND contype='c';"
```

Expected: a check on `notification_destinations.event_types` (likely `notification_destinations_event_types_check`) and one on `outbound_events.event_type` (likely `outbound_events_event_type_check`). Use the actual names below.

- [ ] **Step 2: Write the migration**

```sql
-- Daily digest v1 (docs/superpowers/specs/2026-08-07-daily-digest-design.md).
-- digest.daily becomes a legal event type; existing destinations are
-- backfilled (product decision: the digest is automatic; the unsubscribe
-- toggle ships in the same release). 09:00 local send slot; only the
-- timezone varies per project.

ALTER TABLE notification_destinations
  DROP CONSTRAINT IF EXISTS notification_destinations_event_types_check;
ALTER TABLE notification_destinations
  ADD CONSTRAINT notification_destinations_event_types_check
  CHECK (cardinality(event_types) >= 1
         AND event_types <@ ARRAY['issue.created','digest.daily']);

ALTER TABLE notification_destinations
  ALTER COLUMN event_types SET DEFAULT '{issue.created,digest.daily}';

UPDATE notification_destinations
SET event_types = event_types || '{digest.daily}'
WHERE NOT ('digest.daily' = ANY(event_types));

ALTER TABLE outbound_events
  DROP CONSTRAINT IF EXISTS outbound_events_event_type_check;
ALTER TABLE outbound_events
  ADD CONSTRAINT outbound_events_event_type_check
  CHECK (event_type IN ('issue.created','digest.daily'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS digest_timezone TEXT NOT NULL DEFAULT 'UTC';
```

- [ ] **Step 3: Verify idempotent re-apply**

```bash
bash scripts/check-migration-reapply.sh
```

Expected: passes (migration applies twice cleanly). If the script needs a running Postgres, use the worktree stack env block first.

- [ ] **Step 4: Verify the backfill and default against the dev DB**

```bash
psql "$DATABASE_URL" -c "SELECT event_types FROM notification_destinations LIMIT 5;" \
     -c "INSERT INTO projects (id, org_id, name) SELECT gen_random_uuid(), org_id, '_digestmigck' FROM projects LIMIT 1 RETURNING digest_timezone;" \
     -c "DELETE FROM projects WHERE name='_digestmigck';"
```

Expected: every listed array contains `digest.daily`; the inserted project shows `UTC`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/038_daily_digest.sql
git commit -m "feat(ingestion): migration 038 — digest.daily event type, destination backfill, digest_timezone"
```

---

### Task 2: Envelope tagged union + digest payload types

**Files:**
- Modify: `packages/ingestion/notify/event.go`
- Modify: `packages/ingestion/db/notifications.go` (payload literal in `publishIssueCreated`, ~line 230)
- Modify: `packages/ingestion/handler/notifications.go` (test-send payload literal, ~line 292)
- Modify: `packages/ingestion/notify/slack.go` (nil-guard + event-type switch)
- Create: `packages/ingestion/notify/event_test.go`

**Interfaces:**
- Produces (used by Tasks 5–8):

```go
type EventPayload struct {
    Version      int             `json:"version"`
    EventType    string          `json:"event_type"`
    Issue        *IssueRef       `json:"issue,omitempty"`
    Project      ProjectRef      `json:"project"`
    Environment  string          `json:"environment,omitempty"`
    DashboardURL string          `json:"dashboard_url,omitempty"`
    Digest       *DigestPayload  `json:"digest,omitempty"`
}
func (p EventPayload) Validate() error   // exactly-one-body per event_type

type DigestPayload struct {
    Date                string          `json:"date"`
    Window              DigestWindow    `json:"window"`
    Insights            []DigestInsight `json:"insights"`
    InsightsHasMore     bool            `json:"insights_has_more"`
    TopNewIssues        []DigestIssue   `json:"top_new_issues"`
    TopNewIssuesHasMore bool            `json:"top_new_issues_has_more"`
    Outcomes            DigestOutcomes  `json:"outcomes"`
    NeedsHumanBacklog   int             `json:"needs_human_backlog"`
    Watching            DigestWatching  `json:"watching"`
}
type DigestWindow struct{ From, To string }                 // json: from, to (RFC3339)
type DigestInsight struct {
    SignalType    string   `json:"signal_type"`
    Page          string   `json:"page"`
    Occurrences   int64    `json:"occurrences"`
    AffectedUsers int      `json:"affected_users"`
    Accounts      []string `json:"accounts"`
    AccountsMore  int      `json:"accounts_more"`
    ReplayURL     *string  `json:"replay_url"`
    URL           string   `json:"url"`
}
type DigestIssue struct {
    Title            string   `json:"title"`
    URL              string   `json:"url"`
    RootCauseExcerpt *string  `json:"root_cause_excerpt"`
    Occurrences      int64    `json:"occurrences"`
    AffectedUsers    int      `json:"affected_users"`
    Accounts         []string `json:"accounts"`
    AccountsMore     int      `json:"accounts_more"`
    ReplayURL        *string  `json:"replay_url"`
}
type DigestPROpened struct {
    Title            string  `json:"title"`
    PRURL            string  `json:"pr_url"`
    PRNumber         int     `json:"pr_number"`
    Merged           bool    `json:"merged"`
    RootCauseExcerpt *string `json:"root_cause_excerpt"`
}
type DigestPRMerged struct {
    Title    string `json:"title"`
    PRURL    string `json:"pr_url"`
    PRNumber int    `json:"pr_number"`
}
type DigestNeedsHuman struct {
    Title         string   `json:"title"`
    URL           string   `json:"url"`
    ReasonMessage string   `json:"reason_message"`
    Accounts      []string `json:"accounts"`
    AccountsMore  int      `json:"accounts_more"`
}
type DigestOutcomes struct {
    PRsOpened         []DigestPROpened   `json:"prs_opened"`
    PRsMerged         []DigestPRMerged   `json:"prs_merged"`
    NeedsHuman        []DigestNeedsHuman `json:"needs_human"`
    PRsOpenedHasMore  bool               `json:"prs_opened_has_more"`
    PRsMergedHasMore  bool               `json:"prs_merged_has_more"`
    NeedsHumanHasMore bool               `json:"needs_human_has_more"`
}
type DigestWatching struct {
    Sessions int64 `json:"sessions"`
    Users    int64 `json:"users"`
}
```

- [ ] **Step 1: Write failing envelope tests** in `packages/ingestion/notify/event_test.go`:

```go
package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDigestEnvelopeOmitsIssueAndEnvironment(t *testing.T) {
	p := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "acme"},
		Digest:  &DigestPayload{Date: "2026-08-07"},
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, forbidden := range []string{`"issue"`, `"environment"`} {
		if strings.Contains(s, forbidden) {
			t.Errorf("digest envelope must omit %s, got %s", forbidden, s)
		}
	}
	if !strings.Contains(s, `"digest"`) {
		t.Errorf("digest envelope missing digest body: %s", s)
	}
}

func TestIssueEnvelopeUnchanged(t *testing.T) {
	p := EventPayload{
		Version: 1, EventType: "issue.created",
		Issue:       &IssueRef{ID: "g1", Title: "boom", FirstSeen: "2026-08-07T00:00:00Z"},
		Project:     ProjectRef{ID: "p1", Name: "acme"},
		Environment: "production",
	}
	b, _ := json.Marshal(p)
	s := string(b)
	for _, required := range []string{`"issue"`, `"environment":"production"`, `"title":"boom"`} {
		if !strings.Contains(s, required) {
			t.Errorf("issue envelope missing %s: %s", required, s)
		}
	}
	if strings.Contains(s, `"digest"`) {
		t.Errorf("issue envelope must omit digest: %s", s)
	}
}

func TestValidateExactlyOneBody(t *testing.T) {
	cases := []struct {
		name    string
		payload EventPayload
		wantErr bool
	}{
		{"issue ok", EventPayload{EventType: "issue.created", Issue: &IssueRef{ID: "g"}}, false},
		{"digest ok", EventPayload{EventType: "digest.daily", Digest: &DigestPayload{}}, false},
		{"issue missing body", EventPayload{EventType: "issue.created"}, true},
		{"digest missing body", EventPayload{EventType: "digest.daily"}, true},
		{"issue with digest body", EventPayload{EventType: "issue.created", Issue: &IssueRef{ID: "g"}, Digest: &DigestPayload{}}, true},
		{"unknown type", EventPayload{EventType: "bogus", Issue: &IssueRef{ID: "g"}}, true},
	}
	for _, c := range cases {
		if err := c.payload.Validate(); (err != nil) != c.wantErr {
			t.Errorf("%s: err=%v wantErr=%v", c.name, err, c.wantErr)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/ingestion && go test ./notify/ -run 'TestDigestEnvelope|TestIssueEnvelope|TestValidateExactlyOneBody' -v
```

Expected: compile errors (`Issue` is a value field; `DigestPayload` undefined).

- [ ] **Step 3: Implement in `notify/event.go`**: change `Issue IssueRef` → `Issue *IssueRef \`json:"issue,omitempty"\``, add `omitempty` to `Environment`, add the `Digest *DigestPayload` field, all digest types from the Interfaces block above, and:

```go
// Validate enforces the tagged-union contract: exactly one event body,
// matching event_type. Publish paths must call this before marshalling.
func (p EventPayload) Validate() error {
	switch p.EventType {
	case "issue.created":
		if p.Issue == nil || p.Digest != nil {
			return fmt.Errorf("issue.created requires issue body only")
		}
	case "digest.daily":
		if p.Digest == nil || p.Issue != nil {
			return fmt.Errorf("digest.daily requires digest body only")
		}
	default:
		return fmt.Errorf("unknown event_type %q", p.EventType)
	}
	return nil
}
```

- [ ] **Step 4: Fix the two construction sites and the formatter for the pointer type**
  - `db/notifications.go` `publishIssueCreated`: `Issue: &notify.IssueRef{...}`.
  - `handler/notifications.go` test-send: `Issue: &notify.IssueRef{...}`.
  - `notify/slack.go` `FormatSlack`: wrap the existing body in a switch (digest branch lands in Task 7):

```go
func FormatSlack(payload EventPayload) ([]byte, string, error) {
	switch payload.EventType {
	case "issue.created":
		return formatSlackIssue(payload)
	default:
		return nil, "application/json", fmt.Errorf("no slack formatter for event_type %q", payload.EventType)
	}
}

func formatSlackIssue(payload EventPayload) ([]byte, string, error) {
	if payload.Issue == nil {
		return nil, "application/json", fmt.Errorf("issue.created payload missing issue body")
	}
	// ... existing body, payload.Issue now a pointer ...
}
```

- [ ] **Step 5: Build and run the full notify + db + handler test suites**

```bash
cd packages/ingestion && go build ./... && go test ./notify/ ./db/ ./handler/
```

Expected: PASS (DB-gated tests need `DATABASE_URL` exported).

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/notify/ packages/ingestion/db/notifications.go packages/ingestion/handler/notifications.go
git commit -m "feat(notify): tagged-union event envelope with digest payload types"
```

---

### Task 3: Event-type plumbing — known types, create default, PATCH `event_types`

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (lines ~20-22 known types; ~54-58 update request; ~140-142 create default; update handler body)
- Modify: `packages/ingestion/db/notifications.go` (`UpdateNotificationDestination`, ~line 149)
- Test: `packages/ingestion/handler/notifications_test.go` or the existing handler test file for notifications (follow the file that already tests `UpdateNotificationDestinationEndpoint`; create `notifications_eventtypes_test.go` in the same package if none covers it)

**Interfaces:**
- Consumes: migration 038 (constraint accepts `digest.daily`).
- Produces: `UpdateNotificationDestination(ctx, orgID, projectID, destinationID string, name *string, configEncrypted []byte, configFingerprint *string, enabled *bool, eventTypes []string) error` — `eventTypes == nil` means unchanged. PATCH accepts `"event_types": ["issue.created"]`; create defaults to `["issue.created","digest.daily"]`.

- [ ] **Step 1: Write failing DB-gated test** (same package/style as existing db tests, using `testPool`/`cleanupTenant` from `packages/ingestion/db/testhelper_test.go`):

```go
func TestUpdateNotificationDestinationEventTypes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, _ := q.CreateOrg(ctx, "evt-org")
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, _ := q.CreateProject(ctx, org.ID, "evt-proj", nil)
	destID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO notification_destinations
		(id, project_id, type, name, config_encrypted, config_fingerprint)
		VALUES ($1,$2,'slack','d',E'\\x00','fp')`, destID, project.ID)
	if err != nil { t.Fatal(err) }

	// nil leaves event_types unchanged (default includes digest.daily post-038)
	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	var types []string
	pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types)
	if len(types) != 2 { t.Fatalf("expected default 2 types, got %v", types) }

	// explicit update narrows to issue.created only (unsubscribe digest)
	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, []string{"issue.created"}); err != nil {
		t.Fatal(err)
	}
	pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types)
	if len(types) != 1 || types[0] != "issue.created" { t.Fatalf("got %v", types) }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/ingestion && go test ./db/ -run TestUpdateNotificationDestinationEventTypes -v
```

Expected: compile error (extra argument).

- [ ] **Step 3: Implement.**
  - `db/notifications.go`: add `eventTypes []string` parameter; SQL gains `event_types = COALESCE($8, d.event_types)` with `$8` passed as `eventTypes` (pgx maps nil slice → NULL for text[]).
  - `handler/notifications.go`:

```go
var knownNotificationEventTypes = map[string]struct{}{
	"issue.created": {},
	"digest.daily":  {},
}
// create default (was []string{"issue.created"}):
if len(request.EventTypes) == 0 {
	request.EventTypes = []string{"issue.created", "digest.daily"}
}
// update request struct gains:
EventTypes *[]string `json:"event_types"`
// update handler: validate when present (non-empty + known via validNotificationEventTypes),
// include in the "no fields" guard, pass through to UpdateNotificationDestination.
```

- [ ] **Step 4: Write failing handler test for PATCH validation** (same file as existing notification endpoint tests; assert 400 on `{"event_types": []}` and on `{"event_types": ["bogus"]}`, 200 round-trip for `{"event_types": ["issue.created"]}` with the response JSON reflecting the change).

- [ ] **Step 5: Run both suites, then the full ingestion gate**

```bash
cd packages/ingestion && go build ./... && go test ./db/ ./handler/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/notifications.go packages/ingestion/handler/
git commit -m "feat(ingestion): digest.daily event type — create default + PATCH event_types unsubscribe path"
```

---

### Task 4: `digest_timezone` project setting (PATCH + response)

**Files:**
- Modify: `packages/ingestion/handler/read_api.go` (`UpdateProjectEndpoint` ~line 649; the project response struct — grep `"friction_autonomy"` json tags in the same file)
- Test: colocated handler test file that covers `UpdateProjectEndpoint` (grep `friction_autonomy` under `packages/ingestion/handler/*_test.go`; add cases there)

**Interfaces:**
- Consumes: migration 038 (`projects.digest_timezone`).
- Produces: PATCH `/projects/{id}` accepts `"digest_timezone": "America/Los_Angeles"`; project GET/PATCH responses include `digest_timezone`.

- [ ] **Step 1: Write failing test cases**: PATCH with valid IANA zone persists and echoes; PATCH `"Not/AZone"` → 400; PATCH `""` → 400; project response includes the field.

- [ ] **Step 2: Run to verify failure.** `cd packages/ingestion && go test ./handler/ -run <TestName> -v`

- [ ] **Step 3: Implement.** Request struct gains `DigestTimezone *string \`json:"digest_timezone"\``; validation:

```go
if req.DigestTimezone != nil {
	if *req.DigestTimezone == "" {
		writeJSONError(w, http.StatusBadRequest, "digest_timezone must be a valid IANA zone name")
		return
	}
	if _, err := time.LoadLocation(*req.DigestTimezone); err != nil {
		writeJSONError(w, http.StatusBadRequest, "digest_timezone must be a valid IANA zone name")
		return
	}
}
```

Add the column to the project UPDATE (`digest_timezone = COALESCE($n, digest_timezone)`) and to the project select/response struct. Import `_ "time/tzdata"` in `packages/ingestion/main.go` so zone lookups work in minimal containers.

- [ ] **Step 4: Run tests + build.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/ packages/ingestion/main.go
git commit -m "feat(ingestion): project digest_timezone setting with IANA validation"
```

---

### Task 5: Digest module — `Build(ctx, projectID, now)`

**Files:**
- Create: `packages/ingestion/digest/build.go`
- Create: `packages/ingestion/digest/digest.go` (Sweeper struct + New only, in this task)
- Create: `packages/ingestion/digest/build_test.go`

**Interfaces:**
- Consumes: `notify.EventPayload`/`notify.DigestPayload` types (Task 2), `notify.BuildIncidentURL(dashboardURL, errorGroupID, projectID string) string`.
- Produces (used by Tasks 6 and 8):

```go
package digest

type Sweeper struct { /* pool *pgxpool.Pool; dashboardURL string */ }
func New(pool *pgxpool.Pool, dashboardURL string) *Sweeper
func (s *Sweeper) Build(ctx context.Context, projectID string, now time.Time) (notify.EventPayload, error)
```

Semantics (spec rev 4): window = `[now-24h, now)`. Lists fetch 4, keep 3, set `*_has_more`. Insights aggregate `friction_signals` (`occurred_at` in window, `retracted_at IS NULL AND superseded_by IS NULL`, `incident_id` groups with current status `insight`), metrics = windowed sums/distincts, ranked by windowed affected users desc then group id. Dedup: groups with `pr_created_at` or `needs_human_at` in window are excluded from `top_new_issues`. Accounts ordered by per-account user count desc, then name; `accounts` top 3 + `accounts_more`. Replay: latest in-window signal's session for insights (fallback `representative_session_id`), `representative_session_id` for issues; URL `<dashboardURL>/sessions/<id>`. Ranking casts to BIGINT. `Date` = local date in the project's `digest_timezone`.

- [ ] **Step 1: Write the fixture seeder + first failing test** in `build_test.go`. The digest package needs its own DB gate (the `db` package helpers are package-private):

```go
package digest

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedDigestFixture creates org→project→environment plus one of everything
// the digest reads. Returns projectID. All rows are cleaned up via org cascade
// (mirror db package cleanupTenant: delete in FK order by org).
func seedDigestFixture(t *testing.T, pool *pgxpool.Pool, now time.Time) (orgID, projectID string) {
	t.Helper()
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, sql)
		}
	}
	pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('digest-test') RETURNING id`).Scan(&orgID)
	pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1,'digest-proj') RETURNING id`, orgID).Scan(&projectID)
	var envID string
	pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1,'production') RETURNING id`, projectID).Scan(&envID)
	exec(`UPDATE projects SET default_environment_id=$2 WHERE id=$1`, projectID, envID)

	// Sessions: 2 in window (distinct users), 1 outside.
	exec(`INSERT INTO end_users (id, project_id, external_id, account_name) VALUES
		('11111111-1111-1111-1111-111111111111',$1,'u1','acme.example'),
		('22222222-2222-2222-2222-222222222222',$1,'u2','globex.example')`, projectID)
	exec(`INSERT INTO sessions (id, project_id, environment_id, end_user_id, started_at) VALUES
		('sess-in-1',$1,$2,'11111111-1111-1111-1111-111111111111',$3),
		('sess-in-2',$1,$2,'22222222-2222-2222-2222-222222222222',$3),
		('sess-old',$1,$2,'11111111-1111-1111-1111-111111111111',$4)`,
		projectID, envID, now.Add(-2*time.Hour), now.Add(-30*time.Hour))

	// Friction insight group + windowed signals (one retracted → excluded).
	var frictionGroupID string
	pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, signal_type,
		 page_url_normalized, first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-friction','Rage clicks on /x','friction','insight','rage_click',
		 '/x',$3,$3, 999, 999) RETURNING id`, projectID, envID, now.Add(-48*time.Hour)).Scan(&frictionGroupID)
	exec(`INSERT INTO friction_signals
		(session_id, project_id, environment_id, end_user_id, rule_version, signal_type,
		 fingerprint, page_url_normalized, occurred_at, occurrence_count, incident_id)
		VALUES
		('sess-in-1',$1,$2,'11111111-1111-1111-1111-111111111111',1,'rage_click','fp-friction','/x',$4,3,$3),
		('sess-in-2',$1,$2,'22222222-2222-2222-2222-222222222222',1,'rage_click','fp-friction','/x',$5,2,$3)`,
		projectID, envID, frictionGroupID, now.Add(-3*time.Hour), now.Add(-1*time.Hour))
	exec(`INSERT INTO friction_signals
		(session_id, project_id, environment_id, end_user_id, rule_version, signal_type,
		 fingerprint, page_url_normalized, occurred_at, occurrence_count, incident_id, retracted_at)
		VALUES ('sess-in-1',$1,$2,'11111111-1111-1111-1111-111111111111',1,'rage_click','fp-friction','/x',$4,50,$3, now())`,
		projectID, envID, frictionGroupID, now.Add(-2*time.Hour))

	// New error group in window (uninvestigated), affected user attribution.
	var newGroupID string
	pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status,
		 first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-new','TypeError: boom','error','new',$3,$3,7,2) RETURNING id`,
		projectID, envID, now.Add(-5*time.Hour)).Scan(&newGroupID)
	exec(`INSERT INTO error_group_affected_users (error_group_id, end_user_id) VALUES
		($1,'11111111-1111-1111-1111-111111111111'),($1,'22222222-2222-2222-2222-222222222222')`, newGroupID)

	// PR opened in window; also first_seen in window → must be deduped out of top_new_issues.
	exec(`INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url, root_cause)
		VALUES ($1,$2,'fp-pr','NullPointer in checkout','error','pr_created',$3,$3,4,1,$4,42,'https://github.example/pr/42',
		 'CheckoutForm dereferences cart.items before load. Second sentence.')`,
		projectID, envID, now.Add(-6*time.Hour), now.Add(-4*time.Hour))

	// needs_human in window.
	exec(`INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, needs_human_at, reason_code, reason_message, remediation)
		VALUES ($1,$2,'fp-nh','Error: cancelled','error','needs_human',$3,$3,2,1,$4,'external_cause','Cause looks external.','Review manually.')`,
		projectID, envID, now.Add(-50*time.Hour), now.Add(-2*time.Hour))

	// Backlog: an old needs_human outside the window still counts in backlog.
	exec(`INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, needs_human_at, reason_code, reason_message, remediation)
		VALUES ($1,$2,'fp-nh-old','Old thing','error','needs_human',$3,$3,1,1,$3,'external_cause','Old.','Review.')`,
		projectID, envID, now.Add(-10*24*time.Hour))

	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM friction_signals WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1))`,
			`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)`,
			`DELETE FROM projects WHERE org_id=$1`,
			`DELETE FROM orgs WHERE id=$1`,
		} {
			if _, err := pool.Exec(context.Background(), stmt, orgID); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	})
	return orgID, projectID
}

func TestBuildDigestSections(t *testing.T) {
	pool := testPool(t)
	now := time.Now().UTC().Truncate(time.Second)
	_, projectID := seedDigestFixture(t, pool, now)
	s := New(pool, "https://dash.example")

	payload, err := s.Build(context.Background(), projectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := payload.Validate(); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	d := payload.Digest

	// Insights: windowed metrics, not the group's lifetime counters (999).
	if len(d.Insights) != 1 {
		t.Fatalf("insights = %d, want 1", len(d.Insights))
	}
	in := d.Insights[0]
	if in.Occurrences != 5 || in.AffectedUsers != 2 {
		t.Errorf("windowed metrics = %d occ / %d users, want 5/2 (retracted excluded, lifetime 999 ignored)", in.Occurrences, in.AffectedUsers)
	}
	if in.ReplayURL == nil || *in.ReplayURL != "https://dash.example/sessions/sess-in-2" {
		t.Errorf("replay should be latest in-window signal session, got %v", in.ReplayURL)
	}
	if len(in.Accounts) != 2 || in.AccountsMore != 0 {
		t.Errorf("accounts = %v +%d", in.Accounts, in.AccountsMore)
	}

	// top_new_issues: the PR'd group is deduped out; only fp-new remains.
	if len(d.TopNewIssues) != 1 || d.TopNewIssues[0].Title != "TypeError: boom" {
		t.Fatalf("top_new_issues = %+v", d.TopNewIssues)
	}
	if d.TopNewIssues[0].RootCauseExcerpt != nil {
		t.Errorf("uninvestigated group must have nil excerpt")
	}

	// Outcomes.
	if len(d.Outcomes.PRsOpened) != 1 || d.Outcomes.PRsOpened[0].PRNumber != 42 {
		t.Fatalf("prs_opened = %+v", d.Outcomes.PRsOpened)
	}
	if got := d.Outcomes.PRsOpened[0].RootCauseExcerpt; got == nil || *got != "CheckoutForm dereferences cart.items before load." {
		t.Errorf("excerpt = %v", got)
	}
	if len(d.Outcomes.NeedsHuman) != 1 || d.Outcomes.NeedsHuman[0].Title != "Error: cancelled" {
		t.Fatalf("needs_human = %+v", d.Outcomes.NeedsHuman)
	}
	if d.NeedsHumanBacklog != 2 {
		t.Errorf("backlog = %d, want 2", d.NeedsHumanBacklog)
	}

	// Watching: in-window sessions and distinct users only.
	if d.Watching.Sessions != 2 || d.Watching.Users != 2 {
		t.Errorf("watching = %+v", d.Watching)
	}
}
```

- [ ] **Step 2: Run to verify failure** (`go test ./digest/ -run TestBuildDigestSections -v` → package does not exist).

- [ ] **Step 3: Implement `digest.go` (struct) and `build.go`.** Core shape:

```go
// Package digest computes and publishes the daily digest.
// Deep module: two public operations (Build, RunOnce); everything else is private.
package digest

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
	_ "time/tzdata" // zone data in minimal containers

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

const listCap = 3

type Sweeper struct {
	pool         *pgxpool.Pool
	dashboardURL string
}

func New(pool *pgxpool.Pool, dashboardURL string) *Sweeper {
	return &Sweeper{pool: pool, dashboardURL: strings.TrimRight(dashboardURL, "/")}
}

func (s *Sweeper) sessionURL(sessionID string) *string {
	if sessionID == "" || s.dashboardURL == "" {
		return nil
	}
	u := s.dashboardURL + "/sessions/" + url.PathEscape(sessionID)
	return &u
}

// rootCauseExcerpt returns the first sentence of stored root_cause prose,
// bounded to 220 runes; nil for empty/uninvestigated.
func rootCauseExcerpt(rootCause *string) *string {
	if rootCause == nil || strings.TrimSpace(*rootCause) == "" {
		return nil
	}
	text := strings.TrimSpace(*rootCause)
	if i := strings.Index(text, ". "); i > 0 {
		text = text[:i+1]
	}
	runes := []rune(text)
	if len(runes) > 220 {
		text = string(runes[:219]) + "…"
	}
	return &text
}
```

`Build` queries, in order (all with `from := now.Add(-24*time.Hour)`; every list query `LIMIT listCap+1`, then `hasMore := len(rows) > listCap; rows = rows[:min(len(rows),listCap)]`):

```sql
-- project + timezone + name
SELECT name, digest_timezone FROM projects WHERE id = $1;

-- insights (windowed, retraction-aware)
SELECT g.id, g.signal_type, COALESCE(g.page_url_normalized,''),
       SUM(fs.occurrence_count)::bigint,
       COUNT(DISTINCT fs.end_user_id),
       COALESCE(g.representative_session_id,'')
FROM friction_signals fs
JOIN error_groups g ON g.id = fs.incident_id
WHERE fs.project_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
  AND g.status = 'insight'
GROUP BY g.id
ORDER BY COUNT(DISTINCT fs.end_user_id) DESC, g.id
LIMIT 4;

-- per insight: latest in-window session for the replay link
SELECT fs.session_id FROM friction_signals fs
WHERE fs.incident_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
ORDER BY fs.occurred_at DESC LIMIT 1;

-- per insight: accounts (windowed attribution)
SELECT eu.account_name, COUNT(DISTINCT fs.end_user_id) AS cnt, COUNT(*) OVER () AS total
FROM friction_signals fs JOIN end_users eu ON eu.id = fs.end_user_id
WHERE fs.incident_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
  AND eu.account_name IS NOT NULL
GROUP BY eu.account_name
ORDER BY cnt DESC, eu.account_name
LIMIT 3;
-- accounts_more = total - len(returned)

-- top new issues (dedup: outcomes wins; BIGINT ranking)
SELECT g.id, g.title, g.occurrence_count::bigint, g.affected_users_count,
       g.root_cause, COALESCE(g.representative_session_id,'')
FROM error_groups g
WHERE g.project_id = $1 AND g.kind = 'error'
  AND g.first_seen >= $2 AND g.first_seen < $3
  AND NOT (g.pr_created_at >= $2 AND g.pr_created_at < $3)
  AND NOT (g.needs_human_at >= $2 AND g.needs_human_at < $3)
ORDER BY (g.affected_users_count::bigint * g.occurrence_count::bigint) DESC, g.id
LIMIT 4;

-- per issue: accounts (lifetime attribution — error_group_affected_users has no timestamps)
SELECT eu.account_name, COUNT(*) AS cnt, COUNT(*) OVER () AS total
FROM error_group_affected_users au JOIN end_users eu ON eu.id = au.end_user_id
WHERE au.error_group_id = $1 AND eu.account_name IS NOT NULL
GROUP BY eu.account_name ORDER BY cnt DESC, eu.account_name LIMIT 3;

-- outcomes
SELECT g.id, g.title, COALESCE(g.pr_url,''), COALESCE(g.pr_number,0), g.root_cause,
       EXISTS(SELECT 1 FROM pr_outcomes po WHERE po.error_group_id = g.id AND po.outcome = 'merged')
FROM error_groups g
WHERE g.project_id = $1 AND g.pr_created_at >= $2 AND g.pr_created_at < $3
ORDER BY g.pr_created_at DESC LIMIT 4;

SELECT g.id, g.title, COALESCE(g.pr_url,''), COALESCE(g.pr_number,0)
FROM error_groups g
WHERE g.project_id = $1 AND g.merged_at >= $2 AND g.merged_at < $3
  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2)
ORDER BY g.merged_at DESC LIMIT 4;

SELECT g.id, g.title, COALESCE(g.reason_message,'')
FROM error_groups g
WHERE g.project_id = $1 AND g.needs_human_at >= $2 AND g.needs_human_at < $3
ORDER BY g.needs_human_at DESC LIMIT 4;
-- (+ per-item accounts query, same as issues)

-- backlog
SELECT COUNT(*) FROM error_groups WHERE project_id = $1 AND status = 'needs_human';

-- watching
SELECT COUNT(*), COUNT(DISTINCT end_user_id)
FROM sessions WHERE project_id = $1 AND started_at >= $2 AND started_at < $3;
```

Assemble `notify.EventPayload{Version: 1, EventType: "digest.daily", Project: ..., DashboardURL: s.dashboardURL, Digest: &...}` with `Date` = `now.In(loc).Format("2006-01-02")` (zone from `digest_timezone`; on `LoadLocation` error return it — `Build` is only called for validated projects, the error is surfaced not swallowed). Item `URL` fields use `notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)`. Call `payload.Validate()` before returning.

- [ ] **Step 4: Run the test until green.** `go test ./digest/ -run TestBuildDigestSections -v`

- [ ] **Step 5: Add the quiet-day test** (same file): seed only org/project/env + sessions; assert all lists empty, `Watching.Sessions == 2`, backlog 0, `Validate()` passes.

- [ ] **Step 6: Run full package + build.** `go build ./... && go test ./digest/ -v`

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/digest/
git commit -m "feat(digest): Build — customer-perspective daily digest payload from windowed signals"
```

---

### Task 6: Digest module — due-ness, publish, `RunOnce`, `Start`, wiring

**Files:**
- Modify: `packages/ingestion/digest/digest.go`
- Create: `packages/ingestion/digest/digest_test.go`
- Modify: `packages/ingestion/main.go` (~line 178, next to dispatcher wiring)
- Modify: `docker-compose.yml` (ingestion service env)

**Interfaces:**
- Consumes: `Build` (Task 5), migration 038.
- Produces: `func (s *Sweeper) RunOnce(ctx context.Context, now time.Time) (int, error)`; `func (s *Sweeper) Start(ctx context.Context, interval time.Duration)`; env flag `DIGEST_SWEEP_ENABLED` (string `"true"` enables; anything else disables).

Due-ness (spec rev 4): candidates = projects with an enabled destination subscribed to `digest.daily`. Per candidate in Go: load zone (skip+log invalid); dedup key `digest.daily:<projectID>:<localDate>`; skip if today's event exists; **first digest** (no digest event ever): due when `COALESCE(MIN(sessions.started_at), projects.created_at) <= now-24h` regardless of hour; **subsequent**: due when `localNow.Hour() >= 9`.

- [ ] **Step 1: Write failing DB-gated tests** in `digest_test.go` (reuse `seedDigestFixture`; add a helper `seedDestination(t, pool, projectID string, eventTypes []string)` inserting an enabled `notification_destinations` row with dummy encrypted config). Table-driven over `now`:

```go
func TestRunOnceDueness(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	_, projectID := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, projectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")

	// First digest: anchor is MIN(sessions.started_at) = now-30h → due immediately.
	n, err := s.RunOnce(ctx, now)
	if err != nil || n != 1 {
		t.Fatalf("first RunOnce = %d, %v; want 1", n, err)
	}
	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events WHERE project_id=$1 AND event_type='digest.daily'`, projectID).Scan(&count)
	if count != 1 {
		t.Fatalf("outbound_events = %d", count)
	}
	var deliveries int
	pool.QueryRow(ctx, `SELECT count(*) FROM outbound_deliveries d JOIN outbound_events e ON e.id=d.event_id WHERE e.project_id=$1`, projectID).Scan(&deliveries)
	if deliveries != 1 {
		t.Fatalf("deliveries = %d", deliveries)
	}

	// Same tick again: dedup key exists → 0 published.
	if n, _ := s.RunOnce(ctx, now); n != 0 {
		t.Fatalf("second RunOnce = %d, want 0", n)
	}
}

func TestRunOnceSkipsFreshAndUnsubscribedProjects(t *testing.T) {
	// fresh: seed fixture with sessions only 1h old → anchor too new → 0.
	// unsubscribed: destination with event_types={issue.created} → not a candidate → 0.
	// invalid zone: UPDATE projects SET digest_timezone='Not/AZone' → skipped, no error, 0.
}

func TestRunOnceSubsequentWaitsForNineLocal(t *testing.T) {
	// Insert a prior digest.daily outbound event dated yesterday (dedup key with
	// yesterday's local date). With now at 08:00 local → 0 published; at 09:05 local → 1.
	// Use digest_timezone='UTC' and pick now values by hour.
}
```

Write all three fully (the comments above describe the arrangement; assert published counts).

- [ ] **Step 2: Run to verify failure.** Expected: `RunOnce` undefined.

- [ ] **Step 3: Implement in `digest.go`:**

```go
const (
	defaultInterval = 5 * time.Minute
	sendHourLocal   = 9
)

// Start runs the sweep until cancellation. Caller gates on DIGEST_SWEEP_ENABLED.
func (s *Sweeper) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n, err := s.RunOnce(ctx, time.Now().UTC()); err != nil {
				slog.Error("digest sweep failed", "error", err)
			} else if n > 0 {
				slog.Info("digest sweep", "published", n)
			}
		}
	}
}

type candidate struct {
	projectID string
	timezone  string
	hasPrior  bool
	anchor    time.Time
}

func (s *Sweeper) candidates(ctx context.Context) ([]candidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.digest_timezone,
		       EXISTS(SELECT 1 FROM outbound_events oe
		              WHERE oe.project_id = p.id AND oe.event_type = 'digest.daily') AS has_prior,
		       COALESCE((SELECT MIN(st.started_at) FROM sessions st WHERE st.project_id = p.id), p.created_at) AS anchor
		FROM projects p
		WHERE EXISTS (SELECT 1 FROM notification_destinations d
		              WHERE d.project_id = p.id AND d.enabled AND 'digest.daily' = ANY(d.event_types))`)
	// ... scan ...
}

// RunOnce publishes at most one digest per due project. Failures are
// per-project isolated: logged, skipped, retried next tick.
func (s *Sweeper) RunOnce(ctx context.Context, now time.Time) (int, error) {
	cands, err := s.candidates(ctx)
	if err != nil {
		return 0, err
	}
	published := 0
	for _, c := range cands {
		loc, err := time.LoadLocation(c.timezone)
		if err != nil {
			slog.Warn("digest: invalid timezone, skipping project", "project", c.projectID, "tz", c.timezone)
			continue
		}
		localNow := now.In(loc)
		dedupKey := "digest.daily:" + c.projectID + ":" + localNow.Format("2006-01-02")
		var exists bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM outbound_events WHERE project_id=$1 AND dedup_key=$2)`,
			c.projectID, dedupKey).Scan(&exists); err != nil || exists {
			continue
		}
		if c.hasPrior {
			if localNow.Hour() < sendHourLocal {
				continue
			}
		} else if now.Sub(c.anchor) < 24*time.Hour {
			continue
		}
		payload, err := s.Build(ctx, c.projectID, now)
		if err != nil {
			slog.Error("digest build failed", "project", c.projectID, "error", err)
			continue
		}
		if err := s.publish(ctx, c.projectID, dedupKey, payload); err != nil {
			slog.Error("digest publish failed", "project", c.projectID, "error", err)
			continue
		}
		published++
	}
	return published, nil
}
```

`publish` mirrors `publishIssueCreated`'s CTE exactly (destinations subscribed to `digest.daily` → insert event `ON CONFLICT (project_id, dedup_key) DO NOTHING` → cross-join deliveries), with `payload.Validate()` before marshal.

- [ ] **Step 4: Wire `main.go`** (next to the dispatcher, ~line 178):

```go
digestSweeper := digest.New(pool, dashboardOrigin)
if os.Getenv("DIGEST_SWEEP_ENABLED") == "true" {
	go digestSweeper.Start(ctx, 5*time.Minute)
	slog.Info("digest sweep enabled")
}
```

(The `digestSweeper` handle is also passed to handler deps in Task 8.)

- [ ] **Step 5: docker-compose.yml** — add to the `ingestion` service environment: `DIGEST_SWEEP_ENABLED: ${DIGEST_SWEEP_ENABLED:-false}`. Validate: `docker compose config --quiet`.

- [ ] **Step 6: Run tests + build.** `cd packages/ingestion && go build ./... && go test ./digest/ -v` — PASS, zero skips with `DATABASE_URL` set.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/digest/ packages/ingestion/main.go docker-compose.yml
git commit -m "feat(digest): due-ness sweep, outbox publish, env-gated Start"
```

---

### Task 7: Slack digest renderer

**Files:**
- Create: `packages/ingestion/notify/slack_digest.go`
- Create: `packages/ingestion/notify/slack_digest_test.go`
- Modify: `packages/ingestion/notify/slack.go` (add the switch case)

**Interfaces:**
- Consumes: `DigestPayload` types (Task 2); helpers `slackEscape`, `truncate`, `masking.RedactURL`, `masking.RedactBody`, `headerMax=150`, `sectionMax=2900`.
- Produces: `formatSlackDigest(payload EventPayload) ([]byte, string, error)`, reached via `case "digest.daily":` in `FormatSlack`.

Rendering rules (spec rev 4): customer-first section order — insights ("Where customers struggled"), top new issues ("New errors customers hit"), outcomes ("What we did about it"), backlog line, watching context. Quiet form when all three lists are empty: one line + backlog (if > 0) + watching. Fixed per-signal phrasings:

| signal_type | phrase (n = affected_users) |
| --- | --- |
| `rage_click` | `n customer(s) clicked repeatedly with no response` |
| `dead_click` | `n customer(s) clicked something that did nothing` |
| `form_abandon` | `n customer(s) abandoned a form` |
| anything else | `n customer(s) hit friction` |

Per-field budgets (runes, applied after `masking.RedactURL(masking.RedactBody(...))`, backtick-stripping, and `slackEscape`): title 200, reason/excerpt 300, page 120, account name 60. Every section text additionally hard-truncated to `sectionMax`.

- [ ] **Step 1: Write failing golden test** in `slack_digest_test.go`:

```go
func TestFormatSlackDigestGolden(t *testing.T) {
	replay := "https://dash.example/sessions/s1"
	excerpt := "CheckoutForm dereferences cart.items before load."
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project:      ProjectRef{ID: "p1", Name: "AMFJ 2"},
		DashboardURL: "https://dash.example",
		Digest: &DigestPayload{
			Date:   "2026-08-07",
			Window: DigestWindow{From: "2026-08-06T09:00:00Z", To: "2026-08-07T09:00:00Z"},
			Insights: []DigestInsight{{
				SignalType: "rage_click", Page: "/assets/:id",
				Occurrences: 26, AffectedUsers: 12,
				Accounts: []string{"apptronik.example", "randstadgr.example", "irembo.example"},
				AccountsMore: 9, ReplayURL: &replay, URL: "https://dash.example/i/1",
			}},
			TopNewIssues: []DigestIssue{{
				Title: "RangeError: Invalid time value", URL: "https://dash.example/i/2",
				RootCauseExcerpt: &excerpt, Occurrences: 1, AffectedUsers: 1,
				Accounts: []string{"marcomgroup.example"},
			}},
			TopNewIssuesHasMore: true,
			Outcomes: DigestOutcomes{
				PRsOpened:  []DigestPROpened{{Title: "window title error", PRURL: "https://gh.example/1306", PRNumber: 1306}},
				NeedsHuman: []DigestNeedsHuman{{Title: "Error: cancelled", URL: "https://dash.example/i/3", ReasonMessage: "External cause suspected."}},
			},
			NeedsHumanBacklog: 121,
			Watching:          DigestWatching{Sessions: 13470, Users: 147},
		},
	}
	body, contentType, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatal(contentType)
	}
	s := string(body)
	for _, want := range []string{
		"Daily digest",                                        // header
		"12 customers clicked repeatedly with no response",    // phrasing
		"apptronik.example",                                   // accounts
		"and 9 more",                                          // accounts_more
		"https://dash.example/sessions/s1",                    // replay
		"RangeError: Invalid time value",
		"CheckoutForm dereferences cart.items before load.",
		"#1306",
		"Error: cancelled",
		"121",                                                 // backlog
		"13,470",                                              // formatted sessions? use plain "13470" if no formatting
	} {
		if !strings.Contains(s, want) {
			t.Errorf("digest blocks missing %q", want)
		}
	}
}

func TestFormatSlackDigestQuietDay(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "AMFJ 2"},
		Digest: &DigestPayload{
			Date: "2026-08-08", NeedsHumanBacklog: 3,
			Watching: DigestWatching{Sessions: 986, Users: 178},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, "All quiet") || !strings.Contains(s, "986") || !strings.Contains(s, "3") {
		t.Errorf("quiet form wrong: %s", s)
	}
}

func TestFormatSlackDigestBudgetsAndMasking(t *testing.T) {
	long := strings.Repeat("x", 5000) + " user@example.com"
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "p"},
		Digest: &DigestPayload{
			Date: "2026-08-07",
			TopNewIssues: []DigestIssue{{Title: long, URL: "u", RootCauseExcerpt: &long}},
			Watching: DigestWatching{Sessions: 1},
		},
	}
	body, _, err := FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if strings.Contains(s, "user@example.com") {
		t.Error("email not masked")
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	for _, b := range decoded["blocks"].([]any) {
		if text, ok := b.(map[string]any)["text"].(map[string]any); ok {
			if str, ok := text["text"].(string); ok && len([]rune(str)) > 3000 {
				t.Errorf("section exceeds slack limit: %d runes", len([]rune(str)))
			}
		}
	}
}

func TestFormatSlackUnknownEventTypeErrors(t *testing.T) {
	_, _, err := FormatSlack(EventPayload{EventType: "mystery.event"})
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
}
```

Decide number formatting in implementation and align the golden assertion (plain `13470` is fine; do not add a localization dependency).

- [ ] **Step 2: Run to verify failure.** Expected: unknown event type error path returns error for digest too (no formatter yet).

- [ ] **Step 3: Implement `slack_digest.go`.** One private helper per section building `[]map[string]any` blocks; `cleanProse(value string, budget int) string` applies `masking.RedactBody` → `masking.RedactURL` → backtick strip → `slackEscape` → rune truncate to budget; a final pass truncates each section text to `sectionMax`. Header: `Daily digest — <project name>`; context sub-line with the date. Backlog line: `<n> older issues still awaiting your review` linking `DashboardURL`. Watching context: `Watched <sessions> sessions across <users> users`. Add `case "digest.daily": return formatSlackDigest(payload)` to `FormatSlack`.

- [ ] **Step 4: Run until green:** `go test ./notify/ -v`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/notify/
git commit -m "feat(notify): slack digest renderer — customer-first sections, budgets, quiet form"
```

---

### Task 8: Test-send `event_type` (real-data digest demo button)

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (`TestNotificationDestinationEndpoint`, ~line 264)
- Modify: the handler `Dependencies` struct + options (the struct holding `NotifySender` — grep `NotifySender` in `packages/ingestion/handler/`)
- Modify: `packages/ingestion/main.go` (pass the sweeper into deps)
- Test: handler test file covering the test-send endpoint

**Interfaces:**
- Consumes: `digest.Sweeper.Build` (Task 5), renderer (Task 7).
- Produces: `POST .../notification-destinations/{destID}/test` accepts optional body `{"event_type": "digest.daily"}`; handler dep:

```go
// in handler package
type DigestBuilder interface {
	Build(ctx context.Context, projectID string, now time.Time) (notify.EventPayload, error)
}
```

- [ ] **Step 1: Write failing handler test**: with a stub `DigestBuilder` returning a fixed digest payload, POST `{"event_type":"digest.daily"}` → sender receives a payload whose `EventType == "digest.daily"`; empty body → unchanged `issue.created` behavior; `{"event_type":"bogus"}` → 400; digest request with nil `DigestBuilder` → 503.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Parse optional JSON body (ignore EOF for empty body). For `digest.daily`: `payload, err := d.DigestBuilder.Build(r.Context(), projectID, time.Now().UTC())` → 500 on error → `d.NotifySender.Send(ctx, destination.Type, config.WebhookURL, payload)`. Keep the existing fake `issue.created` payload for the default. Wire `DigestBuilder: digestSweeper` in `main.go` deps literal (the sweeper from Task 6 satisfies the interface).

- [ ] **Step 4: Run handler suite + build.** PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/ packages/ingestion/main.go
git commit -m "feat(ingestion): test-send supports digest.daily with real project data"
```

---

### Task 9: Dashboard — event-type toggles + digest timezone

**Files:**
- Modify: `packages/dashboard/src/types/api.ts` (destination + project types)
- Modify: `packages/dashboard/src/api.ts` (`updateNotificationDestination` gains `event_types`; project update gains `digest_timezone`)
- Modify: `packages/dashboard/src/components/IntegrationsSettings.vue` (per-destination "Daily digest" / "New issue alerts" checkboxes wired to PATCH)
- Modify: `packages/dashboard/src/views/Settings.vue` (digest timezone text input with datalist of common zones, PATCH on change)
- Test: `packages/dashboard/src/api-notifications.test.ts`, `packages/dashboard/src/views/__tests__/settings-integrations.test.ts`

**Interfaces:**
- Consumes: PATCH endpoints from Tasks 3–4.
- Produces: UI controls; no new exported API beyond the two client function signatures:

```ts
updateNotificationDestination(projectId: string, destId: string,
  patch: { name?: string; webhook_url?: string; enabled?: boolean; event_types?: string[] }): Promise<NotificationDestination>
updateProject(projectId: string,
  patch: { /* existing fields */ digest_timezone?: string }): Promise<Project>
```

- [ ] **Step 1: Write failing Vitest cases**: `updateNotificationDestination` sends `event_types` in the PATCH body when provided; IntegrationsSettings renders one checkbox per known event type (`issue.created`, `digest.daily`) checked from the destination's `event_types`, and toggling calls the API with the new array (never empty — the last checked box is disabled).

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @opslane/dashboard test`.

- [ ] **Step 3: Implement** types, api client, component checkboxes, Settings timezone field. Follow existing component idioms in `IntegrationsSettings.vue` (labels, Tailwind classes, existing PATCH wiring for `enabled`).

- [ ] **Step 4: Run tests + build:** `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/
git commit -m "feat(dashboard): digest subscription toggles and digest timezone setting"
```

---

### Task 10: Live smoke + full gate

**Files:** none (verification only; fix regressions where found)

- [ ] **Step 1: Bring up a worktree stack** with the port/env block from root `AGENTS.md` (pick free ports; export the whole block as a unit), plus:

```bash
export DIGEST_SWEEP_ENABLED=true
export NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal
docker compose up -d --build postgres minio ingestion
bash scripts/run-migrations.sh   # or the stack's boot-time migration path
```

- [ ] **Step 2: Start a webhook receiver on the host** (scratchpad):

```bash
python3 - <<'EOF' &
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        sys.stderr.write(body.decode() + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
HTTPServer(('0.0.0.0', 9377), H).serve_forever()
EOF
```

- [ ] **Step 3: Seed** via `scripts/seed-e2e.sql` + psql: one org/project/environment, sessions with `started_at = now() - interval '30 hours'`, a friction insight group + windowed signals, an enabled destination with `event_types='{digest.daily}'` and webhook URL `http://host.docker.internal:9377/hook` (config must be encrypted — create the destination through the API instead: `POST /projects/{id}/notification-destinations` with a session cookie, which also exercises the new create default).

- [ ] **Step 4: Wait ≤6 minutes (one sweep tick), then assert:**

```bash
psql "$DATABASE_URL" -c "SELECT event_type, dedup_key FROM outbound_events ORDER BY created_at DESC LIMIT 3;"
psql "$DATABASE_URL" -c "SELECT status FROM outbound_deliveries ORDER BY created_at DESC LIMIT 3;"
```

Expected: one `digest.daily` event with today's dedup key; delivery `delivered`; the Python receiver printed Block Kit JSON containing "Daily digest".

- [ ] **Step 5: Full repository gate** (root `AGENTS.md`): `pnpm install --frozen-lockfile && pnpm -r build && pnpm test && (cd packages/ingestion && go build ./... && go test ./...) && docker compose config --quiet` — with `DATABASE_URL` exported; confirm **zero** Go test skips.

- [ ] **Step 6: Commit any smoke-revealed fixes; otherwise no commit.**

---

## Self-Review Notes

- Spec coverage: migration (§Schema→T1), envelope (§Payload→T2), subscribe/unsubscribe (§Code-side→T3), timezone (§Schema/§Code-side→T4), Build+sources (§Payload→T5), sweep/due-ness/rollout gate (§Scheduling/§Rollout→T6), renderer (§Rendering→T7), test-send (§API→T8), dashboard toggles (§Code-side→T9), live smoke (§Testing→T10). Two-phase rollout is operational, not code: the env flag defaults off (T6); enabling it in prod is a deploy-time action documented in the spec.
- The dedup key uses the **local** date; the prior-event existence check and the publish CTE use the same key string, so a project can never get two digests on one local day.
- `error_group_affected_users` has no timestamps → issue accounts are lifetime attribution; that's the spec's stated source, acceptable for v1.
