# Daily Digest v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily, customer-perspective digest per project — computed by an ingestion-side sweep, published through the existing notification outbox, rendered to Slack — per `docs/superpowers/specs/2026-08-07-daily-digest-design.md` (rev 4).

**Architecture:** One deep Go module `packages/ingestion/digest/` exposing `RunOnce(ctx, now)` (sweep tick) and `Build(ctx, projectID, now)` (one project's payload). Due-ness is derived from data every tick; idempotency comes from `outbound_events UNIQUE (project_id, dedup_key)`. The envelope becomes a tagged union (`issue` XOR `digest` body). Delivery reuses the existing dispatcher; only `FormatSlack` grows a digest branch. Sweep ships disabled (`DIGEST_SWEEP_ENABLED`) for two-phase rollout.

**Tech Stack:** Go 1.24 (chi, pgx), Postgres, Vue 3 dashboard, Vitest, test-e2e harness.

## Global Constraints

- Migrations are append-only and **re-applied on every boot** — every statement must be idempotent, AND data backfills must be **one-shot** (see Task 1's marker-table guard), or replays undo user changes.
- Go DB-gated tests skip without `DATABASE_URL`; export it before treating green as proof (`AGENTS.md` root).
- No LLM calls anywhere in the digest path. No new dependencies.
- Ingestion package license: AGPL-3.0-only (default for server-side code).
- Preserve the outbox/delivery lease contracts; do not touch dispatcher claiming logic.
- ESM + strict TypeScript in the dashboard; Vitest tests colocated (`__tests__` / `*.test.ts`).
- Verification per package: `(cd packages/ingestion && go build ./... && go test ./...)`; dashboard: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`.
- Window convention everywhere: `[from, to)` = `[now-24h, now)`. "In window" = `col >= $from AND col < $to`. **"Not in window" must be NULL-safe:** `(col IS NULL OR col < $from OR col >= $to)` — never `NOT (col >= $from AND col < $to)`, which is NULL for NULL columns and silently drops rows.
- Reader-facing URLs come from `DASHBOARD_URL` (`queries.DashboardURL`, set in `main.go:144`) — NOT `dashboardOrigin`, which is the auth/browser origin.

## File Structure

```
packages/ingestion/db/migrations/038_daily_digest.sql        (new: checks, default, one-shot backfill, digest_timezone)
packages/ingestion/notify/event.go                           (tagged union + digest payload types + Validate)
packages/ingestion/notify/event_test.go                      (new: envelope marshal/validate tests)
packages/ingestion/notify/slack.go                           (switch on EventType; unknown type errors)
packages/ingestion/notify/slack_test.go                      (existing IssueRef literal → pointer)
packages/ingestion/notify/slack_digest.go                    (new: digest Block Kit renderer)
packages/ingestion/notify/slack_digest_test.go               (new: golden + budget tests)
packages/ingestion/db/notifications.go                       (publishIssueCreated pointer fix; UpdateNotificationDestination event_types)
packages/ingestion/db/queries.go                             (Project struct + UpdateProject + project SELECTs gain digest_timezone)
packages/ingestion/handler/notifications.go                  (known types, create default, PATCH event_types, test-send event_type)
packages/ingestion/handler/read_api.go                       (digest_timezone PATCH validation + response)
packages/ingestion/digest/digest.go                          (new: Sweeper, New, Start, RunOnce, due-ness, publish)
packages/ingestion/digest/build.go                           (new: Build + aggregation queries + excerpt helper)
packages/ingestion/digest/digest_test.go                     (new: DB-gated due-ness/RunOnce tests)
packages/ingestion/digest/build_test.go                      (new: DB-gated Build tests + fixture seeder)
packages/ingestion/main.go                                   (wire sweeper + env flag + DigestBuilder dep; time/tzdata import)
docker-compose.yml                                           (DIGEST_SWEEP_ENABLED env passthrough, default off)
packages/dashboard/src/api.ts                                (updateNotificationDestination event_types; testNotificationDestination event_type; updateProject digest_timezone)
packages/dashboard/src/types/api.ts                          (types)
packages/dashboard/src/components/IntegrationsSettings.vue   (event-type toggles + "Send digest preview" action)
packages/dashboard/src/views/Settings.vue                    (digest timezone field)
test-e2e/digest-contract.test.ts                             (new: wire-level digest contract via test-send)
```

---

### Task 1: Migration 038 — event checks, subscription default, one-shot backfill, digest_timezone

**Files:**
- Create: `packages/ingestion/db/migrations/038_daily_digest.sql`

**Interfaces:**
- Produces: `notification_destinations.event_types` accepts `digest.daily` (default + one-shot backfill); `outbound_events.event_type` accepts `digest.daily`; `projects.digest_timezone TEXT NOT NULL DEFAULT 'UTC'`; `one_shot_migrations` marker table.

- [ ] **Step 1: Confirm the two constraint names before writing DDL**

```bash
psql "$DATABASE_URL" -c "
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid::regclass::text IN ('notification_destinations','outbound_events')
  AND contype='c';"
```

Expected: a check on `notification_destinations.event_types` (likely `notification_destinations_event_types_check`) and one on `outbound_events.event_type` (likely `outbound_events_event_type_check`). Use the actual names below.

- [ ] **Step 2: Write the migration.** The schema statements are naturally idempotent; the backfill is NOT (a boot replay would re-subscribe users who unsubscribed), so it is guarded by a one-shot marker:

```sql
-- Daily digest v1 (docs/superpowers/specs/2026-08-07-daily-digest-design.md).
-- digest.daily becomes a legal event type; existing destinations are
-- backfilled ONCE (product decision: the digest is automatic; the unsubscribe
-- toggle ships in the same release). Migrations replay on every boot, so the
-- backfill is guarded by a one-shot marker — without it, a replay would
-- silently re-subscribe anyone who unsubscribed.

ALTER TABLE notification_destinations
  DROP CONSTRAINT IF EXISTS notification_destinations_event_types_check;
ALTER TABLE notification_destinations
  ADD CONSTRAINT notification_destinations_event_types_check
  CHECK (cardinality(event_types) >= 1
         AND event_types <@ ARRAY['issue.created','digest.daily']);

ALTER TABLE notification_destinations
  ALTER COLUMN event_types SET DEFAULT '{issue.created,digest.daily}';

CREATE TABLE IF NOT EXISTS one_shot_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

UPDATE notification_destinations
SET event_types = event_types || '{digest.daily}'
WHERE NOT ('digest.daily' = ANY(event_types))
  AND NOT EXISTS (SELECT 1 FROM one_shot_migrations WHERE name = '038_digest_backfill');

INSERT INTO one_shot_migrations (name) VALUES ('038_digest_backfill')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE outbound_events
  DROP CONSTRAINT IF EXISTS outbound_events_event_type_check;
ALTER TABLE outbound_events
  ADD CONSTRAINT outbound_events_event_type_check
  CHECK (event_type IN ('issue.created','digest.daily'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS digest_timezone TEXT NOT NULL DEFAULT 'UTC';
```

- [ ] **Step 3: Verify idempotent re-apply AND one-shot semantics**

```bash
bash scripts/check-migration-reapply.sh
# One-shot proof: unsubscribe a row, re-apply, confirm it stays unsubscribed.
psql "$DATABASE_URL" <<'SQL'
BEGIN;
UPDATE notification_destinations SET event_types='{issue.created}'
WHERE id = (SELECT id FROM notification_destinations LIMIT 1);
SQL
# re-run migrations (boot path), then:
psql "$DATABASE_URL" -c "SELECT event_types FROM notification_destinations LIMIT 1;"
```

Expected: reapply passes; the unsubscribed row still shows only `{issue.created}` after replay.

- [ ] **Step 4: Verify the default on a fresh insert**

```bash
psql "$DATABASE_URL" -c "INSERT INTO projects (org_id, name) SELECT org_id, '_digestmigck' FROM projects LIMIT 1 RETURNING digest_timezone;" -c "DELETE FROM projects WHERE name='_digestmigck';"
```

Expected: `UTC`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/migrations/038_daily_digest.sql
git commit -m "feat(ingestion): migration 038 — digest.daily event type, one-shot destination backfill, digest_timezone"
```

---

### Task 2: Envelope tagged union + digest payload types

**Files:**
- Modify: `packages/ingestion/notify/event.go`
- Modify: `packages/ingestion/notify/slack_test.go` (line ~14: `Issue: IssueRef{...}` → `Issue: &IssueRef{...}`)
- Modify: `packages/ingestion/db/notifications.go` (payload literal in `publishIssueCreated`, ~line 230: `Issue: &notify.IssueRef{...}`)
- Modify: `packages/ingestion/handler/notifications.go` (test-send payload literal, ~line 292: `Issue: &notify.IssueRef{...}`)
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
type DigestWindow struct {
    From string `json:"from"`   // RFC3339
    To   string `json:"to"`     // RFC3339
}
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

- [ ] **Step 4: Fix all construction sites and the formatter for the pointer type**
  - `db/notifications.go` `publishIssueCreated`: `Issue: &notify.IssueRef{...}`.
  - `handler/notifications.go` test-send: `Issue: &notify.IssueRef{...}`.
  - `notify/slack_test.go` line ~14: `Issue: &IssueRef{...}`.
  - `notify/slack.go`:

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
	// ... existing body, reading payload.Issue.Title etc. through the pointer ...
}
```

- [ ] **Step 5: Build and run the notify + db + handler suites**

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
- Test: DB test alongside existing db tests; handler test alongside the file that already tests `UpdateNotificationDestinationEndpoint` (grep it; create `notifications_eventtypes_test.go` in the handler package if none covers it)

**Interfaces:**
- Consumes: migration 038 (constraint accepts `digest.daily`).
- Produces: `UpdateNotificationDestination(ctx, orgID, projectID, destinationID string, name *string, configEncrypted []byte, configFingerprint *string, enabled *bool, eventTypes []string) error` — `eventTypes == nil` means unchanged. PATCH accepts `"event_types": ["issue.created"]`; create defaults to `["issue.created","digest.daily"]`.

- [ ] **Step 1: Write failing DB-gated test** (in `packages/ingestion/db/`, same style as existing tests, using `testPool`/`cleanupTenant`/`ptrStr` from `testhelper_test.go`):

```go
func TestUpdateNotificationDestinationEventTypes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "evt-org")
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "evt-proj", nil)
	if err != nil { t.Fatal(err) }
	destID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO notification_destinations
		(id, project_id, type, name, config_encrypted, config_fingerprint)
		VALUES ($1,$2,'slack','d',E'\\x00','fp')`, destID, project.ID); err != nil {
		t.Fatal(err)
	}

	// nil leaves event_types unchanged (default includes digest.daily post-038)
	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	var types []string
	if err := pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types); err != nil {
		t.Fatal(err)
	}
	if len(types) != 2 { t.Fatalf("expected default 2 types, got %v", types) }

	// explicit update narrows to issue.created only (unsubscribe digest)
	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, []string{"issue.created"}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types); err != nil {
		t.Fatal(err)
	}
	if len(types) != 1 || types[0] != "issue.created" { t.Fatalf("got %v", types) }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/ingestion && go test ./db/ -run TestUpdateNotificationDestinationEventTypes -v
```

Expected: compile error (extra argument).

- [ ] **Step 3: Implement.**
  - `db/notifications.go`: add `eventTypes []string` parameter; SQL gains `event_types = COALESCE($8, d.event_types)` with `$8` passed as `eventTypes` (pgx maps a nil `[]string` to SQL NULL for `text[]`).
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

// update handler: the pointer-vs-slice types do NOT pass through directly.
// Explicit nil-preserving conversion before the db call:
var eventTypes []string
if request.EventTypes != nil {
	if len(*request.EventTypes) == 0 || !validNotificationEventTypes(*request.EventTypes) {
		writeJSONError(w, http.StatusBadRequest, "event_types contains an unsupported value")
		return
	}
	eventTypes = *request.EventTypes
}
// include request.EventTypes in the "no fields provided" guard alongside
// Name/WebhookURL/Enabled, then pass eventTypes to UpdateNotificationDestination.
```

- [ ] **Step 4: Write failing handler test for PATCH validation**: 400 on `{"event_types": []}` and `{"event_types": ["bogus"]}`; 200 round-trip for `{"event_types": ["issue.created"]}` with the response JSON reflecting the change; POST create with no `event_types` returns both defaults.

- [ ] **Step 5: Run both suites + build**

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

### Task 4: `digest_timezone` project setting (db layer + PATCH + response)

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `Project` struct (~line 81) gains `DigestTimezone string`; every project `SELECT`/`RETURNING` that scans into `Project` gains the column; `UpdateProject` (~line 2957) gains a `digestTimezone *string` parameter with `digest_timezone = COALESCE(...)`
- Modify: every `UpdateProject` call site (grep `UpdateProject(` across `packages/ingestion/`) — pass `nil` where unchanged
- Modify: `packages/ingestion/handler/read_api.go` (`UpdateProjectEndpoint` ~line 649: request field + validation; project response JSON gains `digest_timezone`)
- Modify: `packages/ingestion/main.go` (add `_ "time/tzdata"` import)
- Test: db test for UpdateProject round-trip; handler test alongside the existing `UpdateProjectEndpoint` tests (grep `friction_autonomy` under `packages/ingestion/handler/*_test.go` and `packages/ingestion/db/*_test.go`)

**Interfaces:**
- Consumes: migration 038 (`projects.digest_timezone`).
- Produces: `UpdateProject(ctx, orgID, projectID string, githubRepo, frictionAutonomy, prPosture, defaultEnvironmentID, digestTimezone *string) (*Project, error)`; PATCH `/projects/{id}` accepts `"digest_timezone": "America/Los_Angeles"`; project responses include `digest_timezone`.

- [ ] **Step 1: Write failing tests**: db test — `UpdateProject` with `digestTimezone: ptrStr("America/Los_Angeles")` persists and the returned `Project.DigestTimezone` reflects it; `nil` leaves it `UTC`. Handler test — PATCH valid zone → 200 echoing the field; PATCH `"Not/AZone"` → 400; PATCH `""` → 400.

- [ ] **Step 2: Run to verify failure.** `cd packages/ingestion && go test ./db/ ./handler/ -run '<TestNames>' -v` — compile errors expected.

- [ ] **Step 3: Implement.** Handler validation:

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

db layer: extend `Project`, `UpdateProject` (new `$n` + COALESCE), and every project scan. Update all `UpdateProject` call sites with `nil`. Add `_ "time/tzdata"` to `main.go` imports so `LoadLocation` works in minimal containers.

- [ ] **Step 4: Run tests + full ingestion build.** `go build ./... && go test ./db/ ./handler/` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/ packages/ingestion/main.go
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

Semantics (spec rev 4): window `[now-24h, now)`. Lists fetch 4, keep 3, set `*_has_more`. Insights aggregate `friction_signals` (`occurred_at` in window, `retracted_at IS NULL AND superseded_by IS NULL`, `incident_id` groups with current status `insight`), windowed metrics, ranked by windowed affected users desc then group id. Dedup: groups with `pr_created_at`, `needs_human_at`, **or `merged_at`** in window are excluded from `top_new_issues` (NULL-safe predicates per Global Constraints). Accounts ordered by per-account user count desc, then name; top 3 + `accounts_more`; error/needs-human account attribution filters `error_group_affected_users.last_seen >= from` (the table has `first_seen`/`last_seen`/`occurrence_count` — windowed attribution is available and used). Replay: latest in-window signal's session for insights (fallback `representative_session_id`); `representative_session_id` for issues. `merged` flag on an opened PR correlates `pr_outcomes.pr_number = error_groups.pr_number` — not mere existence, which would mark a new PR merged because an older PR on the same group merged. Ranking casts to BIGINT. `Date` = local date in the project's `digest_timezone`.

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
// the digest reads. Cleanup mirrors db/testhelper_test.go cleanupTenant:
// dependency order, with default_environment_id nulled before environments.
func seedDigestFixture(t *testing.T, pool *pgxpool.Pool, now time.Time) (orgID, projectID string) {
	t.Helper()
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, sql)
		}
	}
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('digest-test') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM outbound_deliveries WHERE destination_id IN (SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
			`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM friction_signals WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
			`DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM projects WHERE org_id = $1`,
			`DELETE FROM orgs WHERE id = $1`,
		} {
			if _, err := pool.Exec(context.Background(), stmt, orgID); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	})
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1,'digest-proj') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	var envID string
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1,'production') RETURNING id`, projectID).Scan(&envID); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	exec(`UPDATE projects SET default_environment_id=$2 WHERE id=$1`, projectID, envID)

	// End users (external_user_id is NOT NULL) + sessions: 2 in window, 1 outside.
	exec(`INSERT INTO end_users (id, project_id, external_user_id, account_name) VALUES
		('11111111-1111-1111-1111-111111111111',$1,'u1','acme.example'),
		('22222222-2222-2222-2222-222222222222',$1,'u2','globex.example')`, projectID)
	exec(`INSERT INTO sessions (id, project_id, environment_id, end_user_id, started_at) VALUES
		('sess-in-1',$1,$2,'11111111-1111-1111-1111-111111111111',$3),
		('sess-in-2',$1,$2,'22222222-2222-2222-2222-222222222222',$4),
		('sess-old',$1,$2,'11111111-1111-1111-1111-111111111111',$5)`,
		projectID, envID, now.Add(-3*time.Hour), now.Add(-1*time.Hour), now.Add(-30*time.Hour))

	// Friction insight group + windowed signals (one retracted → excluded).
	var frictionGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, signal_type,
		 page_url_normalized, first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-friction','Rage clicks on /x','friction','insight','rage_click',
		 '/x',$3,$3, 999, 999) RETURNING id`, projectID, envID, now.Add(-48*time.Hour)).Scan(&frictionGroupID); err != nil {
		t.Fatalf("seed friction group: %v", err)
	}
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

	// New error group in window (uninvestigated), with windowed affected users.
	var newGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status,
		 first_seen, last_seen, occurrence_count, affected_users_count)
		VALUES ($1,$2,'fp-new','TypeError: boom','error','new',$3,$3,7,2) RETURNING id`,
		projectID, envID, now.Add(-5*time.Hour)).Scan(&newGroupID); err != nil {
		t.Fatalf("seed new group: %v", err)
	}
	exec(`INSERT INTO error_group_affected_users (error_group_id, end_user_id, first_seen, last_seen) VALUES
		($1,'11111111-1111-1111-1111-111111111111',$2,$2),
		($1,'22222222-2222-2222-2222-222222222222',$2,$2)`, newGroupID, now.Add(-5*time.Hour))

	// PR opened in window; also first_seen in window → must be deduped out of
	// top_new_issues. An OLDER merged PR (different pr_number) exists in
	// pr_outcomes — the current PR (#42) must NOT be reported merged.
	var prGroupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, kind, status, first_seen, last_seen,
		 occurrence_count, affected_users_count, pr_created_at, pr_number, pr_url, root_cause)
		VALUES ($1,$2,'fp-pr','NullPointer in checkout','error','pr_created',$3,$3,4,1,$4,42,'https://github.example/pr/42',
		 'CheckoutForm dereferences cart.items before load. Second sentence.') RETURNING id`,
		projectID, envID, now.Add(-6*time.Hour), now.Add(-4*time.Hour)).Scan(&prGroupID); err != nil {
		t.Fatalf("seed pr group: %v", err)
	}
	exec(`INSERT INTO pr_outcomes (project_id, error_group_id, pr_number, outcome, github_delivery_id, occurred_at)
		VALUES ($1,$2,17,'merged','digest-test-old-pr-'||$2,$3)`,
		projectID, prGroupID, now.Add(-72*time.Hour))

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

	// top_new_issues: the PR'd group is deduped out; NULL-safe predicates must
	// keep fp-new (whose pr_created_at/needs_human_at/merged_at are all NULL).
	if len(d.TopNewIssues) != 1 || d.TopNewIssues[0].Title != "TypeError: boom" {
		t.Fatalf("top_new_issues = %+v", d.TopNewIssues)
	}
	if d.TopNewIssues[0].RootCauseExcerpt != nil {
		t.Errorf("uninvestigated group must have nil excerpt")
	}
	if len(d.TopNewIssues[0].Accounts) != 2 {
		t.Errorf("issue accounts = %v", d.TopNewIssues[0].Accounts)
	}

	// Outcomes: PR #42 opened; the old merged PR #17 must NOT mark it merged.
	if len(d.Outcomes.PRsOpened) != 1 || d.Outcomes.PRsOpened[0].PRNumber != 42 {
		t.Fatalf("prs_opened = %+v", d.Outcomes.PRsOpened)
	}
	if d.Outcomes.PRsOpened[0].Merged {
		t.Errorf("PR #42 reported merged from unrelated pr_outcomes row (#17)")
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
// Deep module: two public operations (Build, RunOnce); everything else private.
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

`Build` queries, in order (`from := now.Add(-24*time.Hour)`, `to := now`; every list query `LIMIT listCap+1`, then `hasMore := len(rows) > listCap; rows = rows[:min(len(rows), listCap)]`):

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
-- accounts_more = total - len(returned rows)

-- top new issues. Dedup exclusions are NULL-safe (Global Constraints):
-- NOT-in-window written as (col IS NULL OR col < $2 OR col >= $3).
SELECT g.id, g.title, g.occurrence_count::bigint, g.affected_users_count,
       g.root_cause, COALESCE(g.representative_session_id,'')
FROM error_groups g
WHERE g.project_id = $1 AND g.kind = 'error'
  AND g.first_seen >= $2 AND g.first_seen < $3
  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2 OR g.pr_created_at >= $3)
  AND (g.needs_human_at IS NULL OR g.needs_human_at < $2 OR g.needs_human_at >= $3)
  AND (g.merged_at IS NULL OR g.merged_at < $2 OR g.merged_at >= $3)
ORDER BY (g.affected_users_count::bigint * g.occurrence_count::bigint) DESC, g.id
LIMIT 4;

-- per issue / per needs-human item: accounts, windowed via the rollup's last_seen
SELECT eu.account_name, COUNT(*) AS cnt, COUNT(*) OVER () AS total
FROM error_group_affected_users au JOIN end_users eu ON eu.id = au.end_user_id
WHERE au.error_group_id = $1 AND au.last_seen >= $2 AND eu.account_name IS NOT NULL
GROUP BY eu.account_name ORDER BY cnt DESC, eu.account_name LIMIT 3;

-- outcomes: PRs opened in window; merged flag correlates the CURRENT pr_number
SELECT g.id, g.title, COALESCE(g.pr_url,''), COALESCE(g.pr_number,0), g.root_cause,
       EXISTS(SELECT 1 FROM pr_outcomes po
              WHERE po.error_group_id = g.id AND po.pr_number = g.pr_number
                AND po.outcome = 'merged')
FROM error_groups g
WHERE g.project_id = $1 AND g.pr_created_at >= $2 AND g.pr_created_at < $3
ORDER BY g.pr_created_at DESC LIMIT 4;

-- PRs merged in window but opened before it (NULL-safe opened-before check)
SELECT g.id, g.title, COALESCE(g.pr_url,''), COALESCE(g.pr_number,0)
FROM error_groups g
WHERE g.project_id = $1 AND g.merged_at >= $2 AND g.merged_at < $3
  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2)
ORDER BY g.merged_at DESC LIMIT 4;

-- needs_human in window
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

Assemble `notify.EventPayload{Version: 1, EventType: "digest.daily", Project: ..., DashboardURL: s.dashboardURL, Digest: &...}` with `Date` = `now.In(loc).Format("2006-01-02")` (zone from `digest_timezone`; a `LoadLocation` error is returned, not swallowed — `RunOnce` pre-validates zones, so `Build` hitting this means a direct caller passed an invalid project). Item `URL` fields use `notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)`. Call `payload.Validate()` before returning.

- [ ] **Step 4: Run the test until green.** `go test ./digest/ -run TestBuildDigestSections -v`

- [ ] **Step 5: Add remaining Build tests** (same file, extending the fixture where needed):
  - Quiet day: seed only org/project/env + sessions → all lists empty, `Watching.Sessions == 2`, backlog 0, `Validate()` passes.
  - Caps and `has_more`: seed 4 in-window new issues → `len(TopNewIssues) == 3`, `TopNewIssuesHasMore == true`.
  - Accounts overflow + anonymous: 4 distinct account names on one insight → 3 returned, `AccountsMore == 1`; signals with NULL `end_user_id`/`account_name` → empty `Accounts`, no error.
  - Replay fallback: insight whose windowed signals all have empty sessions is impossible (session_id NOT NULL) — instead delete the in-window signals' sessions? No: cover the fallback by an insight group whose signals are in-window but `representative_session_id` is used when the per-insight session query returns no row (e.g., signals retracted after selection); simpler deterministic arrangement: assert `sessionURL("")` returns nil via a unit test, and fallback ordering via a group with signals only at the window edge. Keep it minimal: unit-test `sessionURL` and `rootCauseExcerpt` directly.
  - Superseded signal excluded: insert a signal with `superseded_by` set → not counted.
  - `prs_merged`: group with `merged_at` in window, `pr_created_at` 3 days ago → appears in `PRsMerged`, not `PRsOpened`, and is excluded from `top_new_issues` only if its `first_seen` is in window.
  - Local date: project with `digest_timezone='Pacific/Auckland'` and `now` chosen so UTC date ≠ Auckland date → `Digest.Date` is the Auckland date.

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
- Produces: `func (s *Sweeper) RunOnce(ctx context.Context, now time.Time) (int, error)` (count of digests actually inserted); `func (s *Sweeper) Start(ctx context.Context, interval time.Duration)`; env flag `DIGEST_SWEEP_ENABLED` (string `"true"` enables; anything else disables).

Due-ness (spec rev 4): candidates = projects with an enabled destination subscribed to `digest.daily`. Per candidate in Go: load zone (skip+log invalid); dedup key `digest.daily:<projectID>:<localDate>`; skip if today's event exists; **first digest** (no digest event ever): due when `COALESCE(MIN(sessions.started_at), projects.created_at) <= now-24h` regardless of hour; **subsequent**: due when `localNow.Hour() >= 9`.

- [ ] **Step 1: Write failing DB-gated tests** in `digest_test.go`, reusing `seedDigestFixture` plus:

```go
func seedDestination(t *testing.T, pool *pgxpool.Pool, projectID string, eventTypes []string) string {
	t.Helper()
	destID := uuid.NewString()
	if _, err := pool.Exec(context.Background(), `INSERT INTO notification_destinations
		(id, project_id, type, name, config_encrypted, config_fingerprint, event_types)
		VALUES ($1,$2,'slack','digest-test',E'\\x00','fp',$3)`, destID, projectID, eventTypes); err != nil {
		t.Fatalf("seed destination: %v", err)
	}
	return destID
}
```

Tests (write all fully):

```go
func TestRunOnceFirstDigestAndIdempotency(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	_, projectID := seedDigestFixture(t, pool, now) // sessions back to now-30h → anchor old enough
	seedDestination(t, pool, projectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")

	n, err := s.RunOnce(ctx, now)
	if err != nil || n != 1 {
		t.Fatalf("first RunOnce = %d, %v; want 1", n, err)
	}
	var events, deliveries int
	pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events WHERE project_id=$1 AND event_type='digest.daily'`, projectID).Scan(&events)
	pool.QueryRow(ctx, `SELECT count(*) FROM outbound_deliveries d JOIN outbound_events e ON e.id=d.event_id WHERE e.project_id=$1`, projectID).Scan(&deliveries)
	if events != 1 || deliveries != 1 {
		t.Fatalf("events=%d deliveries=%d", events, deliveries)
	}

	// Same tick again: dedup key exists → 0 published (and RunOnce must not
	// count a conflicting no-op insert as published).
	if n, err := s.RunOnce(ctx, now); err != nil || n != 0 {
		t.Fatalf("second RunOnce = %d, %v; want 0", n, err)
	}
}

func TestRunOnceSkipsIneligibleProjects(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	// (a) fresh project: sessions only 1h old → anchor too new → 0.
	orgA, projA := seedDigestFixtureWithSessionAge(t, pool, now, 1*time.Hour)
	_ = orgA
	seedDestination(t, pool, projA, []string{"digest.daily"})

	// (b) unsubscribed: destination without digest.daily → not a candidate.
	_, projB := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, projB, []string{"issue.created"})

	// (c) invalid zone: skipped and logged, not an error, and must not abort
	// other projects in the same tick.
	_, projC := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, projC, []string{"digest.daily"})
	pool.Exec(ctx, `UPDATE projects SET digest_timezone='Not/AZone' WHERE id=$1`, projC)

	s := New(pool, "https://dash.example")
	n, err := s.RunOnce(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("published %d, want 0 (a: too fresh, b: unsubscribed, c: invalid zone)", n)
	}
}

func TestRunOnceSubsequentWaitsForNineLocal(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	// Fix "now" at 08:00 UTC today so hour comparisons are deterministic (UTC zone).
	base := time.Now().UTC().Truncate(24 * time.Hour).Add(8 * time.Hour)
	_, projectID := seedDigestFixture(t, pool, base)
	seedDestination(t, pool, projectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")

	// Seed a prior digest event dated YESTERDAY (local) so the project is in
	// "subsequent" mode.
	yesterday := base.Add(-24 * time.Hour).Format("2006-01-02")
	if _, err := pool.Exec(ctx, `INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
		VALUES ($1,'digest.daily','digest.daily:'||$1||':'||$2,'{}')`, projectID, yesterday); err != nil {
		t.Fatal(err)
	}

	if n, _ := s.RunOnce(ctx, base); n != 0 { // 08:00 local < 09:00
		t.Fatalf("08:00 published %d, want 0", n)
	}
	if n, _ := s.RunOnce(ctx, base.Add(65*time.Minute)); n != 1 { // 09:05
		t.Fatalf("09:05 published %d, want 1", n)
	}
}
```

`seedDigestFixtureWithSessionAge` is `seedDigestFixture` with the session timestamps parameterized — refactor the seeder to take the oldest-session age (default 30h) rather than duplicating it.

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
	if err != nil {
		return nil, fmt.Errorf("digest candidates: %w", err)
	}
	defer rows.Close()
	var out []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.projectID, &c.timezone, &c.hasPrior, &c.anchor); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RunOnce publishes at most one digest per due project and returns the number
// actually inserted (replica-conflict no-ops are not counted). Failures are
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
			c.projectID, dedupKey).Scan(&exists); err != nil {
			slog.Error("digest: dedup check failed", "project", c.projectID, "error", err)
			continue
		}
		if exists {
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
		inserted, err := s.publish(ctx, c.projectID, dedupKey, payload)
		if err != nil {
			slog.Error("digest publish failed", "project", c.projectID, "error", err)
			continue
		}
		if inserted {
			published++
		}
	}
	return published, nil
}

// publish inserts the outbox event and its deliveries in one transaction.
// Returns false when the dedup key already existed (replica conflict) —
// expected, not an error.
func (s *Sweeper) publish(ctx context.Context, projectID, dedupKey string, payload notify.EventPayload) (bool, error) {
	if err := payload.Validate(); err != nil {
		return false, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	var eventID string
	err = tx.QueryRow(ctx, `
		INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
		VALUES ($1, 'digest.daily', $2, $3::jsonb)
		ON CONFLICT (project_id, dedup_key) DO NOTHING
		RETURNING id`, projectID, dedupKey, string(body)).Scan(&eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // dedup conflict: another replica won
	}
	if err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbound_deliveries (event_id, destination_id)
		SELECT $1, d.id FROM notification_destinations d
		WHERE d.project_id = $2 AND d.enabled AND 'digest.daily' = ANY(d.event_types)`,
		eventID, projectID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
```

- [ ] **Step 4: Wire `main.go`** (next to the dispatcher, ~line 178). Reader-facing links use `DASHBOARD_URL` — the same variable `publishIssueCreated` links use via `queries.DashboardURL` (set at `main.go:144`) — NOT `dashboardOrigin`:

```go
digestSweeper := digest.New(pool, queries.DashboardURL)
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
git commit -m "feat(digest): due-ness sweep, transactional outbox publish, env-gated Start"
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

Rendering rules (spec rev 4): customer-first section order — insights ("Where customers struggled"), top new issues ("New errors customers hit"), outcomes ("What we did about it"), backlog line, watching context. Quiet form when all three lists are empty: one line + backlog (if > 0) + watching. Fixed per-signal phrasings (spec wording, exact):

| signal_type | phrase (n = affected_users) |
| --- | --- |
| `rage_click` | `n customer(s) clicked repeatedly with no response` |
| `dead_click` | `n customer(s) clicked and nothing happened` |
| `form_abandon` | `n customer(s) abandoned a form` |
| anything else | `n customer(s) hit friction` |

Per-field budgets (runes, applied after `masking.RedactBody` → `masking.RedactURL` → backtick strip → `slackEscape`): title 200, reason/excerpt 300, page 120, account name 60. Every section text additionally hard-truncated to `sectionMax`. Numbers render unformatted (`13470`, not `13,470`) — no localization dependency.

- [ ] **Step 1: Write failing tests** in `slack_digest_test.go`:

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
		"Daily digest",
		"12 customers clicked repeatedly with no response",
		"apptronik.example",
		"and 9 more",
		"https://dash.example/sessions/s1",
		"RangeError: Invalid time value",
		"CheckoutForm dereferences cart.items before load.",
		"#1306",
		"Error: cancelled",
		"121",
		"13470",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("digest blocks missing %q", want)
		}
	}
}

func TestFormatSlackDigestPhrasings(t *testing.T) {
	mk := func(sig string, n int) EventPayload {
		return EventPayload{
			Version: 1, EventType: "digest.daily",
			Project: ProjectRef{ID: "p", Name: "p"},
			Digest: &DigestPayload{Date: "2026-08-07",
				Insights: []DigestInsight{{SignalType: sig, Page: "/p", AffectedUsers: n}},
				Watching: DigestWatching{Sessions: 1}},
		}
	}
	cases := map[string]string{
		"rage_click":   "clicked repeatedly with no response",
		"dead_click":   "clicked and nothing happened",
		"form_abandon": "abandoned a form",
		"mystery":      "hit friction",
	}
	for sig, want := range cases {
		body, _, err := FormatSlack(mk(sig, 3))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), want) {
			t.Errorf("%s: missing %q", sig, want)
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
	long := strings.Repeat("x", 5000) + " user@example.com *bold* `tick`"
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project: ProjectRef{ID: "p1", Name: "p"},
		Digest: &DigestPayload{
			Date:         "2026-08-07",
			TopNewIssues: []DigestIssue{{Title: long, URL: "u", RootCauseExcerpt: &long}},
			Watching:     DigestWatching{Sessions: 1},
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
	if strings.Contains(s, "`tick`") {
		t.Error("backticks not stripped")
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

- [ ] **Step 2: Run to verify failure.** Digest payloads currently hit the `default:` error branch from Task 2.

- [ ] **Step 3: Implement `slack_digest.go`.** One private helper per section building `[]map[string]any` blocks; `cleanProse(value string, budget int) string` applies `masking.RedactBody` → `masking.RedactURL` → backtick strip → `slackEscape` → rune truncate to budget; a final pass truncates each section text to `sectionMax`. Header: `Daily digest — <project name>`; context sub-line with the date. Backlog line: `<n> older issues still awaiting your review` linking `DashboardURL`. Watching context: `Watched <sessions> sessions across <users> users`. Add `case "digest.daily": return formatSlackDigest(payload)` to `FormatSlack`.

- [ ] **Step 4: Run until green:** `go test ./notify/ -v`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/notify/
git commit -m "feat(notify): slack digest renderer — customer-first sections, budgets, quiet form"
```

---

### Task 8: Test-send `event_type` (real-data digest demo button, API side)

**Files:**
- Modify: `packages/ingestion/handler/notifications.go` (`TestNotificationDestinationEndpoint`, ~line 264)
- Modify: the handler `Dependencies` options struct (the one holding `NotifySender` — grep `NotifySender` in `packages/ingestion/handler/`)
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

- [ ] **Step 1: Write failing handler tests**: with a stub `DigestBuilder` returning a fixed digest payload, POST `{"event_type":"digest.daily"}` → sender receives a payload with `EventType == "digest.daily"`; empty body → unchanged `issue.created` behavior; `{"event_type":"bogus"}` → 400; digest request with nil `DigestBuilder` → 503 (no panic).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Parse the optional JSON body (treat `io.EOF` as empty). The digest branch nil-checks the builder before use:

```go
var req struct {
	EventType string `json:"event_type"`
}
if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
	writeJSONError(w, http.StatusBadRequest, "invalid request body")
	return
}
switch req.EventType {
case "", "issue.created":
	// existing fake issue payload path, unchanged
case "digest.daily":
	if d.DigestBuilder == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "digest unavailable")
		return
	}
	payload, err := d.DigestBuilder.Build(r.Context(), projectID, time.Now().UTC())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to build digest")
		return
	}
	outcome := d.NotifySender.Send(r.Context(), destination.Type, config.WebhookURL, payload)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": outcome.Class == "delivered", "classification": outcome.Class, "status_code": outcome.StatusCode,
	})
	return
default:
	writeJSONError(w, http.StatusBadRequest, "unsupported event_type")
	return
}
```

Wire `DigestBuilder: digestSweeper` in the `main.go` deps literal (the Task 6 sweeper satisfies the interface).

- [ ] **Step 4: Run handler suite + build.** PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/handler/ packages/ingestion/main.go
git commit -m "feat(ingestion): test-send supports digest.daily with real project data"
```

---

### Task 9: Dashboard — event-type toggles, digest preview button, timezone

**Files:**
- Modify: `packages/dashboard/src/types/api.ts` (destination + project types)
- Modify: `packages/dashboard/src/api.ts` (`updateNotificationDestination` gains `event_types`; `testNotificationDestination` gains optional `eventType`; project update gains `digest_timezone`)
- Modify: `packages/dashboard/src/components/IntegrationsSettings.vue` (per-destination "New issue alerts" / "Daily digest" checkboxes wired to PATCH; a "Send digest preview" action next to the existing test button, calling test-send with `event_type: "digest.daily"`)
- Modify: `packages/dashboard/src/views/Settings.vue` (digest timezone text input with a datalist of common zones, PATCH on change)
- Test: `packages/dashboard/src/api-notifications.test.ts`, `packages/dashboard/src/views/__tests__/settings-integrations.test.ts`

**Interfaces:**
- Consumes: PATCH endpoints from Tasks 3–4, test-send from Task 8.
- Produces:

```ts
updateNotificationDestination(projectId: string, destId: string,
  patch: { name?: string; webhook_url?: string; enabled?: boolean; event_types?: string[] }): Promise<NotificationDestination>
testNotificationDestination(projectId: string, destId: string,
  opts?: { eventType?: 'issue.created' | 'digest.daily' }): Promise<TestSendResult>
updateProject(projectId: string,
  patch: { /* existing fields */ digest_timezone?: string }): Promise<Project>
```

- [ ] **Step 1: Write failing Vitest cases**: `updateNotificationDestination` sends `event_types` in the PATCH body when provided; `testNotificationDestination` sends `{"event_type":"digest.daily"}` when `eventType` passed and an empty body otherwise; IntegrationsSettings renders one checkbox per known event type checked from the destination's `event_types`, toggling calls the API with the new array (the last checked box is disabled so the array is never empty); the digest preview button calls test-send with the digest event type.

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @opslane/dashboard test`.

- [ ] **Step 3: Implement** types, api client, component checkboxes + preview button, Settings timezone field. Follow existing component idioms in `IntegrationsSettings.vue` (labels, Tailwind classes, existing PATCH/test wiring).

- [ ] **Step 4: Run tests + build:** `pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/dashboard build`.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/
git commit -m "feat(dashboard): digest subscription toggles, digest preview, timezone setting"
```

---

### Task 10: Wire-level digest contract (e2e) + full gate

**Files:**
- Create: `test-e2e/digest-contract.test.ts` (modeled on `test-e2e/notifications-contract.test.ts` — same sink/tenant/JWT helpers)

The e2e harness already solves auth and delivery assertions: `seedTenant()` + `seedUserWithJWT(orgId)` from `test-e2e/helpers.ts` mint a working `Authorization: Bearer <jwt>`; an in-process HTTP sink receives webhook POSTs; `getPool()` gives SQL access. The sweep path (due-ness) is covered by Task 6's Go tests; this e2e proves the wire: real HTTP create-destination (exercising the new default), real digest build from seeded data via test-send, real Slack Block Kit body at the sink.

- [ ] **Step 1: Write the test**, following `notifications-contract.test.ts` structure:

```ts
// test-e2e/digest-contract.test.ts — wire-level digest contract.
// 1. seedTenant + seedUserWithJWT.
// 2. Start sink server (same pattern as notifications-contract.test.ts beforeAll).
// 3. POST /projects/{id}/notification-destinations with NO event_types →
//    assert the response event_types contains BOTH 'issue.created' and
//    'digest.daily' (the new create default).
// 4. Seed digest data via getPool(): sessions (started_at now-3h), a friction
//    insight group + 2 active friction_signals in-window, one needs_human
//    group with needs_human_at in-window (reuse the SQL shapes from
//    packages/ingestion/digest/build_test.go's seeder, adapted to pg client).
// 5. POST /projects/{id}/notification-destinations/{destId}/test with
//    {"event_type":"digest.daily"} and the JWT.
// 6. Assert response {ok: true, classification: 'delivered'}.
// 7. Assert the sink received exactly one POST whose body parses as JSON,
//    has a blocks array, and contains 'Daily digest', the seeded page path,
//    and the needs-human title.
// 8. PATCH the destination {"event_types":["issue.created"]} → 200; then
//    test-send digest again → still delivers (test-send is explicit, not
//    subscription-gated) — and assert GET shows the narrowed event_types
//    round-tripped.
```

Write it fully (real code, not the comment sketch) with the same imports, env handling (`INGESTION_URL` default `http://localhost:8082`), and teardown as the sibling test.

- [ ] **Step 2: Run against the worktree stack.** Export the port/URL env block from root `AGENTS.md` as a unit, bring up `postgres`, `minio`, `ingestion` (`docker compose up -d --build`), run migrations, then `pnpm --filter test-e2e test -- digest-contract`. Expected: PASS.

- [ ] **Step 3 (manual, optional but recommended once): sweep smoke.** With the same stack: `export DIGEST_SWEEP_ENABLED=true` and `export NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9377` (exact `host:port` — the allowlist matches the URL's host **including port**), restart ingestion, create a destination pointed at `http://host.docker.internal:9377/hook` (a `python3 -m http.server`-style POST logger from the scratchpad), seed sessions older than 24h, and confirm within ~6 minutes: one `digest.daily` row in `outbound_events` with today's dedup key and a delivered `outbound_deliveries` row.

- [ ] **Step 4: Full repository gate** (root `AGENTS.md`): `pnpm install --frozen-lockfile && pnpm -r build && pnpm test && (cd packages/ingestion && go build ./... && go test ./...) && docker compose config --quiet` — with `DATABASE_URL` exported; confirm **zero** Go test skips.

- [ ] **Step 5: Commit**

```bash
git add test-e2e/digest-contract.test.ts
git commit -m "test(e2e): wire-level digest contract — create default, test-send, slack body"
```

---

## Self-Review Notes

- Spec coverage: migration (§Schema→T1), envelope (§Payload→T2), subscribe/unsubscribe (§Code-side→T3), timezone (§Schema/§Code-side→T4), Build+sources (§Payload→T5), sweep/due-ness/rollout gate (§Scheduling/§Rollout→T6), renderer (§Rendering→T7), test-send (§API→T8), dashboard toggles + preview (§Code-side/§API→T9), wire contract + gate (§Testing→T10). Two-phase rollout is operational: the env flag defaults off (T6); enabling it in prod is a deploy-time action documented in the spec.
- The dedup key uses the **local** date; the prior-event existence check and the publish insert use the same key string, so a project can never get two digests on one local day.
- `error_group_affected_users` **does** carry `first_seen`/`last_seen`/`occurrence_count`; issue/needs-human account attribution therefore filters on `au.last_seen >= from` (windowed) — a deliberate improvement over lifetime attribution, matching the insights sections' windowed semantics.
- The one-shot backfill marker (`one_shot_migrations`) is new machinery, justified by a real failure mode (boot replay re-subscribing unsubscribed users); it is generic for future data backfills.
