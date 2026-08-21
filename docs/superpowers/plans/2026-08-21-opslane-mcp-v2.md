# Opslane MCP surface v2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer works the daily Opslane digest from a Claude Code session, reads one issue in full, fixes it or reviews Opslane's fix, records the PR, and never opens the dashboard.

**Architecture:** Three MCP tools inside `@opslane/cli`, over stdio. Two reads come from the landed pipeline: the delivered digest run and a shared evidence bundle assembled from frozen anchors. The one write records a pull request on `error_groups` so the existing merge webhook resolves the issue. MCP-first: the evidence endpoint returns one call, and the dashboard adopts it.

**Tech Stack:** Go 1.24 / chi / pgx (ingestion), Node 22 / TypeScript ESM / `@modelcontextprotocol/sdk` 1.30 / zod 4 / Vitest (CLI).

**Spec:** `docs/design/2026-08-21-opslane-mcp-surface-v2.md`

## Global constraints

- **Next migration number is 061.** Highest present is `060_cutover_backfill.sql`. This plan adds no migration; every table it reads already exists (054-059).
- **The PR lives on `error_groups`, never `diagnosis_decisions`.** Columns `pr_url`, `pr_number`, `pr_created_at`, `status` (`001_baseline.sql:83,91`; `pr_created_at` in `006_admin_observability.sql:4`). `diagnosis_decisions` has no `pr_url`.
- **The merge webhook matches on `p.github_repo` + `eg.pr_number` + `eg.status IN ('pr_created','pr_draft')`** (`packages/ingestion/db/queries.go:1878`). The link-PR write must set `pr_number` and `status='pr_created'` or the merge never resolves.
- **The delivered digest is `rendered_payload.digest.generated_cards`** (`notify/event.go`, `GeneratedDigestCard`), stamped with system facts by `digest/validate.go:143`. Not `writer_payload`, not `included`.
- **Nothing reads `sample_event_id` for evidence.** It is rewritten on every occurrence (`db/queries.go:629`). Read anchors (`issue_evidence_anchors`).
- **MCP-first.** The evidence endpoint returns one bundle in one call. It is a Go port of the worker's `loadEvidence` (`packages/worker/src/evidence/bundle.ts`) minus the inquiry-only fields (`writeRollups`, `productContext`, `relatedCandidates`).
- **The evidence endpoint never errors on missing anchors.** `loadEvidence` throws `no frozen anchors`; the HTTP endpoint returns an empty bundle with stated availability instead, because pre-rewrite and friction-bucket issues legitimately lack anchors.
- ESM, strict TypeScript, `unknown` plus narrowing. Vitest tests colocated in `cli/src/__tests__/`. Go tests colocated in `packages/ingestion/handler/`.
- Go DB tests skip when `DATABASE_URL` is unset (`error_event_test.go:31`); read the skip count. Confirm **zero** skips before trusting green.
- Every new route is `With(deps.AuthenticateUserSession)` and calls `d.verifyProjectAccess(w, r, projectID)` first (`read_api.go:328`).
- **Nothing in the MCP process writes to stdout.** stdio carries JSON-RPC. Diagnostics go to `console.error`.

## What already exists on this branch

`cli/src/mcp/` ships three pre-rewrite tools: `opslane_worklist`, `opslane_issue`, `opslane_resolve` (`tools.ts:53,74,93`). `opslane_resolve` writes `resolved` (`client.ts:88`), which the design forbids: it is **deleted**, not renamed. `opslane mcp` and `opslane init-claude` are wired (`cli/src/index.ts:176,186`). `authedFetch` forwards `method`/`body` and sets `Content-Type` when a body is present (`cli/src/authed-fetch.ts:44`); it takes no `headers` option. `fence`, `truncate`, `clampPayload` exist in `format.ts` and must be kept.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/ingestion/handler/read_api.go` | Add `GetLatestDigest`, `GetIncidentEvidence`, `LinkIncidentPR` |
| `packages/ingestion/db/queries.go` | Add `LatestDeliveredDigest`, `IssueEvidence`, `LinkPR` |
| `packages/ingestion/handler/routes.go` | Register three routes |
| `packages/ingestion/handler/read_api_digest_latest_test.go` | New |
| `packages/ingestion/handler/read_api_evidence_test.go` | New |
| `packages/ingestion/handler/read_api_link_pr_test.go` | New |
| `cli/src/mcp/types.ts` | Digest and evidence types |
| `cli/src/mcp/client.ts` | `latestDigest`, `issueEvidence`, `linkPr` |
| `cli/src/mcp/digest.ts` | New: pure digest-card mapping |
| `cli/src/mcp/format.ts` | Rewrite rendering; keep `fence`/`truncate`/`clampPayload` |
| `cli/src/mcp/tools.ts` | Register the three v2 tools |
| `cli/skills/opslane/SKILL.md` | Rewrite the procedure |

---

### Task 1: Serve the latest delivered digest

**Files:**
- Modify: `packages/ingestion/db/queries.go` (add `LatestDeliveredDigest`)
- Modify: `packages/ingestion/handler/read_api.go` (add `GetLatestDigest`)
- Modify: `packages/ingestion/handler/routes.go`
- Test: `packages/ingestion/handler/read_api_digest_latest_test.go` (create)

**Interfaces:**
- Produces: `GET /api/v1/projects/{projectID}/digest/latest` returning `{"run_date": "<date>", "cards": [GeneratedDigestCard...]}`, or `{"run_date": null, "cards": []}` when no delivered run exists.

The cards are `rendered_payload.digest.generated_cards`, already stamped with system facts. The endpoint returns them plus the run date. It does not join state here; the client joins state per card via the existing incident endpoint only when the developer opens one, keeping the list lean.

- [ ] **Step 1: Write the failing tests**

```go
package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func insertDeliveredDigest(t *testing.T, pool *pgxpool.Pool, projectID, runDate, renderedPayload string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO digest_runs (project_id, window_from, window_to, run_date, status, rendered_payload)
		 VALUES ($1, $2::date - interval '1 day', $2::date, $2::date, 'delivered', $3::jsonb)`,
		projectID, runDate, renderedPayload)
	if err != nil {
		t.Fatalf("insert digest run: %v", err)
	}
}

func TestLatestDigestReturnsMostRecentDeliveredCards(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	insertDeliveredDigest(t, pool, projectID, "2026-08-19",
		`{"digest":{"generated_cards":[{"episode_id":"e-old","incident_id":"i-old","title":"old","label":"new","copy":"c","action":"a","affected_users":3,"accounts":[]}]}}`)
	insertDeliveredDigest(t, pool, projectID, "2026-08-21",
		`{"digest":{"generated_cards":[{"episode_id":"e-new","incident_id":"i-new","title":"new","label":"new","copy":"c","action":"a","affected_users":9,"accounts":["acme"],"pr_url":"https://github.com/acme/app/pull/1"}]}}`)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/digest/latest", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		RunDate *string `json:"run_date"`
		Cards   []struct {
			IncidentID    string `json:"incident_id"`
			Title         string `json:"title"`
			AffectedUsers int    `json:"affected_users"`
			PRURL         string `json:"pr_url"`
		} `json:"cards"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Cards) != 1 || body.Cards[0].Title != "new" {
		t.Fatalf("expected the most recent run's single card, got %+v", body.Cards)
	}
	if body.Cards[0].AffectedUsers != 9 {
		t.Fatalf("affected_users = %d, want the system-stamped 9", body.Cards[0].AffectedUsers)
	}
	if body.Cards[0].PRURL == "" {
		t.Fatal("pr_url is empty; a verified_fix card must carry its PR")
	}
}

func TestLatestDigestReturnsEmptyWhenNoDeliveredRun(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	// A frozen-but-not-delivered run must not count.
	insertDigestRunFrozen(t, pool, projectID)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/digest/latest", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with empty set", rec.Code)
	}
	var body struct {
		RunDate *string           `json:"run_date"`
		Cards   []json.RawMessage `json:"cards"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.RunDate != nil || len(body.Cards) != 0 {
		t.Fatalf("want empty set, got run_date=%v cards=%d", body.RunDate, len(body.Cards))
	}
}

func TestLatestDigestIsScopedToProject(t *testing.T) {
	deps, pool := testDeps(t)
	orgA, projectA, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	insertDeliveredDigest(t, pool, projectB, "2026-08-21",
		`{"digest":{"generated_cards":[{"episode_id":"e-b","incident_id":"i-b","title":"other tenant","label":"new","copy":"c","action":"a","affected_users":1,"accounts":[]}]}}`)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectA+"/digest/latest", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgA))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var body struct {
		Cards []json.RawMessage `json:"cards"`
	}
	json.NewDecoder(rec.Body).Decode(&body)
	if len(body.Cards) != 0 {
		t.Fatal("project A read project B's digest")
	}
}

func insertDigestRunFrozen(t *testing.T, pool *pgxpool.Pool, projectID string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO digest_runs (project_id, window_from, window_to, run_date, status)
		 VALUES ($1, '2026-08-20'::date, '2026-08-21'::date, '2026-08-21'::date, 'frozen')`, projectID)
	if err != nil {
		t.Fatalf("insert frozen run: %v", err)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run TestLatestDigest -v
```

Expected: FAIL with 404 (route not registered).

- [ ] **Step 3: Add the query**

In `packages/ingestion/db/queries.go`:

```go
// LatestDeliveredDigest returns the run date and the generated_cards array of the
// most recent delivered digest run, or ("", nil, nil) when none exists.
// generated_cards is system-stamped truth (digest/validate.go:143), so it is
// returned as-is. Scoped by project_id; the caller is already authorized.
func (q *Queries) LatestDeliveredDigest(ctx context.Context, projectID string) (runDate string, cards []byte, err error) {
	err = q.pool.QueryRow(ctx,
		`SELECT run_date::text, coalesce(rendered_payload->'digest'->'generated_cards','[]'::jsonb)
		   FROM digest_runs
		  WHERE project_id = $1 AND status = 'delivered' AND rendered_payload IS NOT NULL
		  ORDER BY run_date DESC
		  LIMIT 1`, projectID,
	).Scan(&runDate, &cards)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, nil
	}
	return runDate, cards, err
}
```

- [ ] **Step 4: Add the handler**

In `packages/ingestion/handler/read_api.go`:

```go
// GetLatestDigest returns the cards of the latest delivered daily digest.
// GET /api/v1/projects/{projectID}/digest/latest
func (d *Dependencies) GetLatestDigest(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	runDate, cards, err := d.Queries.LatestDeliveredDigest(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to read digest")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if runDate == "" {
		json.NewEncoder(w).Encode(map[string]any{"run_date": nil, "cards": []any{}})
		return
	}
	// cards is already a JSON array of system-stamped GeneratedDigestCard.
	w.Write([]byte(`{"run_date":`))
	json.NewEncoder(w).Encode(runDate) // note: adds a newline; acceptable inside the object
	w.Write([]byte(`,"cards":`))
	w.Write(cards)
	w.Write([]byte(`}`))
}
```

Note: prefer building the response with a small struct if the raw-concat reads fragile:

```go
type latestDigestJSON struct {
	RunDate *string         `json:"run_date"`
	Cards   json.RawMessage `json:"cards"`
}
resp := latestDigestJSON{Cards: json.RawMessage(cards)}
if runDate != "" {
	resp.RunDate = &runDate
}
json.NewEncoder(w).Encode(resp)
```

Use the struct form, and keep the `if runDate == ""` early return above it that emits `"cards": []any{}`. Without it the struct's `json.RawMessage(nil)` encodes as `"cards":null`, and the TS client then calls `.length` on `null` and throws. The empty array is load-bearing.

- [ ] **Step 5: Register the route**

In `packages/ingestion/handler/routes.go`, beside the other project reads:

```go
r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/digest/latest", deps.GetLatestDigest)
```

- [ ] **Step 6: Run to verify they pass**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run TestLatestDigest -v
```

Expected: all three PASS, zero skips.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go \
        packages/ingestion/handler/routes.go packages/ingestion/handler/read_api_digest_latest_test.go
git commit -m "feat(ingestion): serve the latest delivered digest cards"
```

---

### Task 2: The shared evidence endpoint

**Files:**
- Modify: `packages/ingestion/db/queries.go` (add `IssueEvidence`)
- Modify: `packages/ingestion/handler/read_api.go` (add `GetIncidentEvidence`)
- Modify: `packages/ingestion/handler/routes.go`
- Test: `packages/ingestion/handler/read_api_evidence_test.go` (create)

**Interfaces:**
- Produces: `GET /api/v1/projects/{projectID}/incidents/{incidentID}/evidence` returning
  `{frames: [...], failed_requests: [...], replay_pointers: [...], availability: {recording, source_map}}`.

This is a Go port of `loadEvidence` (`packages/worker/src/evidence/bundle.ts:152`), carrying only the fix-shaped fields. It drops `writeRollups`, `productContext`, and `relatedCandidates`, which only the inquiry consumes. It mirrors the anchor and failed-request SQL exactly so the two implementations agree.

**Deliberate deviation from `loadEvidence`:** where `loadEvidence` throws `no frozen anchors`, this endpoint returns an empty bundle with `availability.recording = "missing"`. Pre-rewrite issues and friction buckets legitimately have no episode and no anchors, and the MCP must render them as "no evidence yet", not a 500.

- [ ] **Step 1: Write the failing test**

```go
package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// seedEpisodeWithAnchor creates an episode, an error event, a resolution envelope,
// and a threshold anchor pointing at the event. Returns the incident (group) id.
func seedEpisodeWithAnchor(t *testing.T, pool *pgxpool.Pool, projectID, envID, resolvedEnvelope string) (groupID, episodeID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_groups (project_id, fingerprint, title, kind, status,
		   first_seen, last_seen, occurrence_count, affected_users_count)
		 VALUES ($1,$2,'TypeError: boom','error','needs_human',now(),now(),3,2)
		 RETURNING id`, projectID, "evi-"+t.Name()).Scan(&groupID); err != nil {
		t.Fatalf("group: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
		 VALUES ($1,$2,1) RETURNING id`, projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatalf("episode: %v", err)
	}
	var eventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events (project_id, environment_id, error_group_id, "timestamp",
		   platform, error_type, error_message, stack_trace_raw)
		 VALUES ($1,$2,$3,now(),'javascript','TypeError','boom','at a (b.min.js:1:2)')
		 RETURNING id`, projectID, envID, groupID).Scan(&eventID); err != nil {
		t.Fatalf("event: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_resolutions (project_id, event_id, status, envelope, resolver_version)
		 VALUES ($1,$2,'resolved',$3::jsonb,1)`, projectID, eventID, resolvedEnvelope); err != nil {
		t.Fatalf("resolution: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO issue_evidence_anchors (project_id, episode_id, anchor_kind, event_id)
		 VALUES ($1,$2,'threshold',$3)`, projectID, episodeID, eventID); err != nil {
		t.Fatalf("anchor: %v", err)
	}
	return groupID, episodeID
}

func TestEvidenceReturnsResolvedFramesFromAnchors(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	envelope := `{"version":2,"frames":[{"original_file":"src/components/MainView.tsx","original_function":"handle","original_line":25,"generated":{"line":1,"column":9}}]}`
	groupID, _ := seedEpisodeWithAnchor(t, pool, projectID, envID, envelope)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents/"+groupID+"/evidence", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Frames []struct {
			Status   string          `json:"status"`
			Envelope json.RawMessage `json:"envelope"`
		} `json:"frames"`
		Availability struct {
			Recording string `json:"recording"`
			SourceMap string `json:"source_map"`
		} `json:"availability"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Frames) == 0 {
		t.Fatal("no frames; the resolved stack is not being read from the anchors")
	}
	if body.Frames[0].Status != "resolved" {
		t.Fatalf("frame status = %q", body.Frames[0].Status)
	}
}

// The deliberate deviation: an issue with no anchors returns an empty bundle, not
// an error. loadEvidence throws here; the endpoint must not.
func TestEvidenceReturnsEmptyForAnchorlessIssue(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	groupID := insertGroup(t, pool, projectID, "friction", "no-anchors", "Dead clicks", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents/"+groupID+"/evidence", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 empty bundle, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Frames       []json.RawMessage `json:"frames"`
		Availability struct {
			Recording string `json:"recording"`
		} `json:"availability"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Frames) != 0 {
		t.Fatalf("frames = %d, want 0 for an anchorless issue", len(body.Frames))
	}
	if body.Availability.Recording != "missing" {
		t.Fatalf("availability.recording = %q, want missing", body.Availability.Recording)
	}
}

func TestEvidenceIsScopedToProject(t *testing.T) {
	deps, pool := testDeps(t)
	orgA, projectA, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, envB, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	envelope := `{"version":2,"frames":[{"original_file":"src/x.ts","original_line":1,"generated":{"line":1,"column":1}}]}`
	foreignGroup, _ := seedEpisodeWithAnchor(t, pool, projectB, envB, envelope)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectA+"/incidents/"+foreignGroup+"/evidence", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgA))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// verifyProjectAccess passes (org A owns project A), but the group belongs to
	// project B, so its anchors are not visible under project A: empty bundle.
	var body struct {
		Frames []json.RawMessage `json:"frames"`
	}
	json.NewDecoder(rec.Body).Decode(&body)
	if len(body.Frames) != 0 {
		t.Fatal("project A read project B's evidence")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run TestEvidence -v
```

Expected: FAIL (404).

- [ ] **Step 3: Add the query**

In `packages/ingestion/db/queries.go`, port the anchor and failed-request SQL from
`bundle.ts:152` (frames) and `bundle.ts:200` (failed requests). Resolve the group's
open episode first, then read its anchors. Return typed rows:

```go
type EvidenceFrame struct {
	AnchorKind      string          `json:"anchor_kind"`
	SourceEventID   string          `json:"source_event_id"`
	Status          string          `json:"status"`
	ResolverVersion *int            `json:"resolver_version"`
	Envelope        json.RawMessage `json:"envelope"`
	CommitSHA       *string         `json:"commit_sha"`
}

type EvidenceFailedRequest struct {
	SessionID      string  `json:"session_id"`
	PageRoute      string  `json:"page_route"`
	Method         string  `json:"method"`
	EndpointPattern string `json:"endpoint_pattern"`
	Status         int     `json:"status"`
	ActionKind     *string `json:"action_kind"`
	ActionSelector *string `json:"action_selector"`
	ActionLink     string  `json:"action_link"`
	OccurredAt     string  `json:"occurred_at"`
}

type EvidenceReplayPointer struct {
	AnchorKind string `json:"anchor_kind"`
	EventID    string `json:"event_id"`
	SessionID  string `json:"session_id"`
	AnchorMs   int64  `json:"anchor_ms"`
}

type IssueEvidenceResult struct {
	Frames         []EvidenceFrame
	FailedRequests []EvidenceFailedRequest
	ReplayPointers []EvidenceReplayPointer
	Recording      string // available|partial|expired|missing
	SourceMap      string // resolved|no_map|failed|pending|missing
}

// IssueEvidence assembles the fix-shaped bundle for a group's open episode. It
// mirrors packages/worker/src/evidence/bundle.ts. Unlike loadEvidence it never
// errors on missing anchors: it returns an empty result with Recording="missing".
func (q *Queries) IssueEvidence(ctx context.Context, projectID, groupID string) (IssueEvidenceResult, error) {
	var res IssueEvidenceResult
	res.Recording = "missing"
	res.SourceMap = "missing"

	var episodeID string
	err := q.pool.QueryRow(ctx,
		`SELECT id FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL
		  ORDER BY sequence DESC LIMIT 1`, projectID, groupID).Scan(&episodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return res, nil // anchorless: empty bundle
	}
	if err != nil {
		return res, fmt.Errorf("resolve episode: %w", err)
	}

	// Anchors + resolution, ported from bundle.ts:152 (threshold, first, recent order).
	rows, err := q.pool.Query(ctx,
		`SELECT a.anchor_kind, a.event_id, e.session_id, e.commit_sha,
		        r.status, r.envelope, r.resolver_version,
		        (extract(epoch FROM e."timestamp")*1000)::bigint AS anchor_ms,
		        CASE WHEN s.status <> 'deleting' THEN s.id END AS retained_session_id
		   FROM issue_evidence_anchors a
		   JOIN error_events e ON e.id=a.event_id AND e.project_id=a.project_id
		   LEFT JOIN sessions s ON s.id=e.session_id AND s.project_id=a.project_id
		   LEFT JOIN error_event_resolutions r ON r.event_id=a.event_id AND r.project_id=a.project_id
		  WHERE a.project_id=$1 AND a.episode_id=$2
		  ORDER BY CASE a.anchor_kind WHEN 'threshold' THEN 0 WHEN 'first' THEN 1 ELSE 2 END`,
		projectID, episodeID)
	if err != nil {
		return res, fmt.Errorf("anchors: %w", err)
	}
	defer rows.Close()

	var retained []string
	seenRetained := map[string]bool{}
	for rows.Next() {
		var f EvidenceFrame
		var sessionID *string
		var anchorMs int64
		var retainedID *string
		// r.status is NULL when a frozen anchor's event has no resolution row yet
		// (the LEFT JOIN). loadEvidence maps that to "missing" (bundle.ts:349).
		// Scanning NULL into a Go string errors, so scan into a nullable first.
		var status sql.NullString
		if err := rows.Scan(&f.AnchorKind, &f.SourceEventID, &sessionID, &f.CommitSHA,
			&status, &f.Envelope, &f.ResolverVersion, &anchorMs, &retainedID); err != nil {
			return res, fmt.Errorf("scan anchor: %w", err)
		}
		f.Status = "missing"
		if status.Valid && status.String != "" {
			f.Status = status.String
		}
		res.Frames = append(res.Frames, f)
		if f.AnchorKind == "threshold" {
			res.SourceMap = f.Status
		}
		if sessionID != nil {
			res.ReplayPointers = append(res.ReplayPointers, EvidenceReplayPointer{
				AnchorKind: f.AnchorKind, EventID: f.SourceEventID, SessionID: *sessionID, AnchorMs: anchorMs,
			})
		}
		if retainedID != nil && !seenRetained[*retainedID] {
			seenRetained[*retainedID] = true
			retained = append(retained, *retainedID)
		}
	}
	if len(res.Frames) == 0 {
		return res, nil
	}
	res.Recording = recordingAvailabilityFromRetained(retained, res.ReplayPointers)

	if len(retained) > 0 {
		// Failed requests, ported from bundle.ts:200.
		freq, err := q.pool.Query(ctx,
			`SELECT f.session_id, f.page_route, f.method, f.endpoint_pattern, f.status,
			        f.action_kind, f.action_selector, f.action_link, f.occurred_at::text
			   FROM session_request_failures f
			  WHERE f.project_id=$1 AND f.session_id = ANY($2::text[])
			    AND f.rule_version = (SELECT analysis.rule_version FROM session_analysis analysis
			                           WHERE analysis.project_id=f.project_id AND analysis.session_id=f.session_id)
			  ORDER BY f.occurred_at DESC, f.request_id_hash
			  LIMIT 50`, projectID, retained)
		if err != nil {
			return res, fmt.Errorf("failed requests: %w", err)
		}
		defer freq.Close()
		for freq.Next() {
			var fr EvidenceFailedRequest
			if err := freq.Scan(&fr.SessionID, &fr.PageRoute, &fr.Method, &fr.EndpointPattern,
				&fr.Status, &fr.ActionKind, &fr.ActionSelector, &fr.ActionLink, &fr.OccurredAt); err != nil {
				return res, fmt.Errorf("scan failed request: %w", err)
			}
			res.FailedRequests = append(res.FailedRequests, fr)
		}
	}
	return res, nil
}
```

Port `recordingAvailabilityFromRetained` from `bundle.ts:135` (`recordingAvailability`), keeping all four states so Milestone 2's expired-recording criterion holds:

```go
// Mirrors bundle.ts:135. missing: no anchor referenced a session. expired: sessions
// were referenced but none survived (all 'deleting'/gone). partial: some retained.
// available: every referenced session retained.
func recordingAvailabilityFromRetained(retained []string, pointers []EvidenceReplayPointer) string {
	referenced := map[string]bool{}
	for _, p := range pointers {
		referenced[p.SessionID] = true
	}
	if len(referenced) == 0 {
		return "missing"
	}
	if len(retained) == 0 {
		return "expired"
	}
	if len(retained) < len(referenced) {
		return "partial"
	}
	return "available"
}
```

Confirm the field order against `bundle.ts:135` before trusting this; the worker is the source of truth.

- [ ] **Step 4: Add the handler and register it**

```go
// GetIncidentEvidence returns the fix-shaped evidence bundle for a group's open
// episode. GET /api/v1/projects/{projectID}/incidents/{incidentID}/evidence
func (d *Dependencies) GetIncidentEvidence(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	incidentID := chi.URLParam(r, "incidentID")
	ev, err := d.Queries.IssueEvidence(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to assemble evidence")
		return
	}
	frames := ev.Frames
	if frames == nil {
		frames = []db.EvidenceFrame{}
	}
	failed := ev.FailedRequests
	if failed == nil {
		failed = []db.EvidenceFailedRequest{}
	}
	pointers := ev.ReplayPointers
	if pointers == nil {
		pointers = []db.EvidenceReplayPointer{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"frames":          frames,
		"failed_requests": failed,
		"replay_pointers": pointers,
		"availability":    map[string]string{"recording": ev.Recording, "source_map": ev.SourceMap},
	})
}
```

Route:

```go
r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/incidents/{incidentID}/evidence", deps.GetIncidentEvidence)
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run TestEvidence -v
```

Expected: all three PASS, zero skips.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go \
        packages/ingestion/handler/routes.go packages/ingestion/handler/read_api_evidence_test.go
git commit -m "feat(ingestion): shared issue-evidence endpoint, a Go port of loadEvidence"
```

---

### Task 3: Record a developer's pull request

**Files:**
- Modify: `packages/ingestion/db/queries.go` (add `LinkPR`, errors)
- Modify: `packages/ingestion/handler/read_api.go` (add `LinkIncidentPR`, PR-URL parse)
- Modify: `packages/ingestion/handler/routes.go`
- Test: `packages/ingestion/handler/read_api_link_pr_test.go` (create)

**Interfaces:**
- Produces: `POST /api/v1/projects/{projectID}/incidents/{incidentID}/link-pr` with body `{"url": "..."}`. Responds with the incident JSON. 400 on an unparseable URL, 409 when `pr_number` is already set, 422 when the repository does not match the project's.

Writes `error_groups.pr_url/pr_number/pr_created_at` and `status='pr_created'`. This is the exact set the merge webhook matches (`queries.go:1878`). `projectPullRequest` (`digest/validate.go:287`) is unexported, so the handler rolls its own regex that returns both the repo and the number in one pass.

- [ ] **Step 1: Write the failing tests**

```go
package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func seedProjectRepo(t *testing.T, pool *pgxpool.Pool, projectID, repo string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET github_repo = $1 WHERE id = $2`, repo, projectID); err != nil {
		t.Fatalf("set github_repo: %v", err)
	}
}

func linkPR(t *testing.T, router http.Handler, orgID, projectID, groupID, url string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/"+projectID+"/incidents/"+groupID+"/link-pr",
		strings.NewReader(`{"url":"`+url+`"}`))
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestLinkPRSetsNumberAndPrCreatedStatus(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-1", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/42"); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var prURL, status string
	var prNumber int
	if err := pool.QueryRow(context.Background(),
		`SELECT pr_url, pr_number, status FROM error_groups WHERE id=$1`, groupID).Scan(&prURL, &prNumber, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if prNumber != 42 {
		t.Fatalf("pr_number = %d, want 42 (the webhook matches on it)", prNumber)
	}
	if status != "pr_created" {
		t.Fatalf("status = %q, want pr_created (the webhook matches on it)", status)
	}
}

// The end-to-end claim: link, then a merge webhook drives the issue to merged.
func TestLinkedPRIsFoundByTheMergeWebhook(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-wh", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/77"); rec.Code != http.StatusOK {
		t.Fatalf("link: %d", rec.Code)
	}
	if _, err := deps.Queries.ProcessPRWebhook(context.Background(),
		"acme/app", 77, true, "delivery-"+t.Name(), timeNow(t)); err != nil {
		t.Fatalf("webhook: %v", err)
	}
	var status string
	pool.QueryRow(context.Background(), `SELECT status FROM error_groups WHERE id=$1`, groupID).Scan(&status)
	if status != "merged" {
		t.Fatalf("status after merge = %q, want merged; the linked PR was invisible to the webhook", status)
	}
}

func TestLinkPRRefusesToOverwriteExistingNumber(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-twice", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/7"); rec.Code != http.StatusOK {
		t.Fatalf("first: %d", rec.Code)
	}
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/8"); rec.Code != http.StatusConflict {
		t.Fatalf("second: status = %d, want 409", rec.Code)
	}
	var prNumber int
	pool.QueryRow(context.Background(), `SELECT pr_number FROM error_groups WHERE id=$1`, groupID).Scan(&prNumber)
	if prNumber != 7 {
		t.Fatalf("pr_number = %d; the first PR was overwritten", prNumber)
	}
}

func TestLinkPRRejectsForeignRepo(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-foreign", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/someone-else/app/pull/1")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var prURL *string
	pool.QueryRow(context.Background(), `SELECT pr_url FROM error_groups WHERE id=$1`, groupID).Scan(&prURL)
	if prURL != nil {
		t.Fatalf("pr_url = %q; a foreign PR was recorded", *prURL)
	}
}

func TestLinkPRRejectsMalformedUrl(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-bad", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/issues/42"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	_ = strconv.Itoa // keep import if unused elsewhere
}

func TestLinkPRExplainsUnconfiguredRepo(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	// github_repo left NULL.
	groupID := insertGroup(t, pool, projectID, "error", "link-norepo", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/3"); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for an unconfigured repo", rec.Code)
	}
}
```

`timeNow(t)` is a one-line helper returning `time.Now()`; add it or inline `time.Now()`. (Go test files may call `time.Now()` directly; the plan avoids the frozen-clock constraint that applies to workflow scripts, not to Go tests.)

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run 'TestLinkPR|TestLinkedPR' -v
```

Expected: FAIL (404).

- [ ] **Step 3: Add the parser and query**

In `read_api.go`:

```go
// parseGitHubPR extracts owner/repo and the number from a github.com pull URL.
// It rolls its own regex rather than reusing digest.projectPullRequest, which is
// unexported and returns only a bool.
var githubPRPath = regexp.MustCompile(`^https://github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)/?$`)

func parseGitHubPR(raw string) (repo string, number int, ok bool) {
	m := githubPRPath.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(m[2])
	if err != nil || n <= 0 {
		return "", 0, false
	}
	return m[1], n, true
}
```

In `queries.go` (the evidence scan needs `database/sql` for `sql.NullString`; `read_api.go`'s parser needs `regexp` and `strconv`, neither currently imported):

```go
var (
	ErrPRAlreadyLinked  = errors.New("incident already has a pull request")
	ErrPRRepoMismatch   = errors.New("pull request is not in this project's repository")
	ErrIncidentNotFound = errors.New("incident not found")
)

// LinkPR records a developer's PR on error_groups so the merge webhook can resolve
// it (queries.go:1878 matches github_repo + pr_number + status pr_created/pr_draft).
// Repo match and the no-overwrite guard are folded into the predicate. pr_created_at
// matches the worker invariant (db.ts sets it on every path to pr_created).
func (q *Queries) LinkPR(ctx context.Context, projectID, groupID, prURL, repo string, prNumber int) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE error_groups eg
		    SET pr_url=$3, pr_number=$4, status='pr_created',
		        pr_created_at=COALESCE(eg.pr_created_at, now()), updated_at=now()
		  FROM projects p
		  WHERE eg.id=$1 AND eg.project_id=$2 AND p.id=eg.project_id
		    AND eg.pr_number IS NULL
		    AND eg.status NOT IN ('resolved','archived','merged')
		    AND p.github_repo IS NOT NULL
		    AND lower(p.github_repo)=lower($5)`,
		groupID, projectID, prURL, prNumber, repo)
	if err != nil {
		return fmt.Errorf("link pr: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	// Disambiguate the refusal.
	var repoMatches, hasNumber bool
	if err := q.pool.QueryRow(ctx,
		`SELECT lower(coalesce(p.github_repo,''))=lower($2), eg.pr_number IS NOT NULL
		   FROM error_groups eg JOIN projects p ON p.id=eg.project_id WHERE eg.id=$1`,
		groupID, repo).Scan(&repoMatches, &hasNumber); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrIncidentNotFound
		}
		return ErrPRAlreadyLinked
	}
	if !repoMatches {
		return ErrPRRepoMismatch
	}
	return ErrPRAlreadyLinked
}
```

- [ ] **Step 4: Add the handler and route**

```go
func (d *Dependencies) LinkIncidentPR(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	incidentID := chi.URLParam(r, "incidentID")
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	var req struct{ URL string `json:"url"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	repo, number, ok := parseGitHubPR(req.URL)
	if !ok {
		writeJSONError(w, http.StatusBadRequest,
			"url must be a GitHub pull request, for example https://github.com/owner/repo/pull/123")
		return
	}
	if err := d.Queries.LinkPR(r.Context(), projectID, incidentID, req.URL, repo, number); err != nil {
		switch {
		case errors.Is(err, db.ErrIncidentNotFound):
			writeJSONError(w, http.StatusNotFound, "no such incident")
		case errors.Is(err, db.ErrPRRepoMismatch):
			writeJSONError(w, http.StatusUnprocessableEntity, "that pull request is not in this project's repository")
		case errors.Is(err, db.ErrPRAlreadyLinked):
			writeJSONError(w, http.StatusConflict, "incident already has a pull request, or is resolved, archived, or merged")
		default:
			writeJSONError(w, http.StatusInternalServerError, "failed to link pull request")
		}
		return
	}
	d.respondWithIncident(w, r, projectID, incidentID)
}
```

Route beside `/resolve`:

```go
r.With(deps.AuthenticateUserSession).Post("/projects/{projectID}/incidents/{incidentID}/link-pr", deps.LinkIncidentPR)
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd packages/ingestion && DATABASE_URL="$DATABASE_URL" go test ./handler/ -run 'TestLinkPR|TestLinkedPR' -v
```

Expected: all six PASS, zero skips.

- [ ] **Step 6: Full ingestion gate**

Export the storage block from AGENTS.md first, or ~30 tests skip while reporting `ok`:

```bash
export MINIO_ENDPOINT="$REPLAY_STORE_ENDPOINT" MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
cd packages/ingestion && go build ./... && go test ./... 2>&1 | tail -20
```

Expected: `ok` everywhere, **zero skips**. `error_event_test.go:83` and the minio/retention/scrubber/session suites skip without these; a green `./...` with only `DATABASE_URL` is the AGENTS.md trap.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/db/queries.go packages/ingestion/handler/read_api.go \
        packages/ingestion/handler/routes.go packages/ingestion/handler/read_api_link_pr_test.go
git commit -m "feat(ingestion): let a developer link their PR, resolving via the merge webhook"
```

---

### Task 4: CLI types and client

**Files:**
- Modify: `cli/src/mcp/types.ts`
- Modify: `cli/src/mcp/client.ts`
- Test: `cli/src/__tests__/mcp-client.test.ts` (exists; add to it)

**Interfaces:**
- Produces:

```ts
export interface DigestCard {
  episode_id: string; incident_id: string; title: string; label: string;
  copy: string; action: string; affected_users: number; accounts: string[]; pr_url?: string;
}
export interface LatestDigest { run_date: string | null; cards: DigestCard[] }

export interface EvidenceFrame { anchor_kind: string; status: string; envelope: unknown; commit_sha: string | null }
export interface EvidenceFailedRequest { page_route: string; method: string; endpoint_pattern: string; status: number; action_selector: string | null }
export interface EvidenceReplayPointer { anchor_kind: string; session_id: string; anchor_ms: number }
export interface IssueEvidence {
  frames: EvidenceFrame[]; failed_requests: EvidenceFailedRequest[];
  replay_pointers: EvidenceReplayPointer[];
  availability: { recording: string; source_map: string };
}

export interface OpslaneClient {
  projectId: string; projectLabel: string; dashboardUrl: string | null;
  latestDigest(): Promise<LatestDigest>;   // { run_date: null, cards: [] } when none
  getIncident(id: string): Promise<McpIncident>;  // for state on one opened issue
  issueEvidence(id: string): Promise<IssueEvidence>;
  linkPr(id: string, url: string): Promise<void>; // throws the API message on failure
}
```

`McpIncident` gains `state?: string`, `episode_id?: string | null`, `root_cause?: string | null`, `signal_type?/element_selector?/page_url_normalized?` (already present), `pr_url?: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../authed-fetch.js', () => ({ authedFetch }));
vi.mock('../agent-credentials.js', () => ({
  resolveCredentials: async () => ({ org_id: 'o', project_id: 'proj-1', api_key: 'k', repo: 'acme/app', api_url: 'https://api.test' }),
}));
vi.mock('../config.js', () => ({ defaultApiUrl: () => 'https://api.test' }));

import { createOpslaneClient } from '../mcp/client.js';

function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('OpslaneClient v2', () => {
  beforeEach(() => authedFetch.mockReset());

  it('returns an empty digest rather than throwing when none delivered', async () => {
    authedFetch.mockResolvedValue(res({ run_date: null, cards: [] }));
    const c = await createOpslaneClient({ cwd: '/tmp' });
    const d = await c.latestDigest();
    expect(d.cards).toEqual([]);
    expect(authedFetch.mock.calls.at(-1)![0]).toContain('/projects/proj-1/digest/latest');
  });

  it('reads the evidence bundle', async () => {
    authedFetch.mockResolvedValue(res({ frames: [{ anchor_kind: 'threshold', status: 'resolved', envelope: {}, commit_sha: null }], failed_requests: [], replay_pointers: [], availability: { recording: 'available', source_map: 'resolved' } }));
    const c = await createOpslaneClient({ cwd: '/tmp' });
    const ev = await c.issueEvidence('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(ev.frames[0]!.status).toBe('resolved');
    expect(authedFetch.mock.calls.at(-1)![0]).toContain('/evidence');
  });

  it('POSTs the PR url when linking', async () => {
    authedFetch.mockResolvedValue(res({ id: 'i' }));
    const c = await createOpslaneClient({ cwd: '/tmp' });
    await c.linkPr('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'https://github.com/acme/app/pull/42');
    const [, opts] = authedFetch.mock.calls.at(-1)!;
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ url: 'https://github.com/acme/app/pull/42' });
  });

  it("surfaces the API message when linking is refused", async () => {
    authedFetch.mockResolvedValue(res({ error: "that pull request is not in this project's repository" }, 422));
    const c = await createOpslaneClient({ cwd: '/tmp' });
    await expect(c.linkPr('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'https://github.com/other/app/pull/1'))
      .rejects.toThrow(/not in this project's repository/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd cli && npx vitest run src/__tests__/mcp-client.test.ts
```

Expected: FAIL (`latestDigest` undefined).

- [ ] **Step 3: Extend the types and rewrite the client methods**

Add the interfaces to `types.ts`. In `client.ts`, keep `parseIncidentId`, `buildIncidentUrl`, `currentRepoSlug`, and credential handling. Replace `listFriction`/`resolveIncident`:

```ts
  async function readJson<T>(url: string): Promise<T> {
    const r = await authedFetch(url, { apiUrl });
    if (!r.ok) throw new Error(`Opslane API returned ${r.status} for ${url}`);
    return (await r.json()) as T;
  }
  async function apiError(r: { json: () => Promise<unknown> }): Promise<string | null> {
    try { const b: unknown = await r.json();
      if (b && typeof b === 'object' && 'error' in b) { const m = (b as { error: unknown }).error; return typeof m === 'string' ? m : null; }
    } catch { /* fall through */ } return null;
  }

  return {
    projectId, projectLabel: `${projectId} (${repo ?? 'no git remote'})`,
    dashboardUrl: process.env['OPSLANE_DASHBOARD_URL'] ?? null,
    latestDigest() { return readJson<LatestDigest>(`${base}/digest/latest`); },
    getIncident(id) { return readJson<McpIncident>(buildIncidentUrl(apiUrl, projectId, id)); },
    issueEvidence(id) { return readJson<IssueEvidence>(`${buildIncidentUrl(apiUrl, projectId, id)}/evidence`); },
    async linkPr(id, url) {
      const r = await authedFetch(`${buildIncidentUrl(apiUrl, projectId, id)}/link-pr`,
        { apiUrl, method: 'POST', body: JSON.stringify({ url }) }); // authedFetch sets Content-Type
      if (!r.ok) throw new Error((await apiError(r)) ?? `Opslane API returned ${r.status} linking ${url}`);
    },
  };
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd cli && npx vitest run src/__tests__/mcp-client.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add cli/src/mcp/types.ts cli/src/mcp/client.ts cli/src/__tests__/mcp-client.test.ts
git commit -m "feat(cli): client for digest, evidence, and PR linking"
```

---

### Task 5: Render the digest list

**Files:**
- Create: `cli/src/mcp/digest.ts`
- Modify: `cli/src/mcp/format.ts` (add `formatDigest`; keep `fence`/`truncate`/`clampPayload`)
- Test: `cli/src/__tests__/mcp-digest.test.ts` (create), extend `mcp-format.test.ts`

**Interfaces:**
- Produces: `formatDigest(input: { runDate: string | null; cards: DigestCard[]; projectLabel: string }): string`.

The list is lean: one line per card with the incident id, title, affected users or accounts, and a PR flag with URL when present. Prose `copy` is dropped; `action` is kept as a one-line hint.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { formatDigest } from '../mcp/format.js';
import type { DigestCard } from '../mcp/types.js';

const card = (o: Partial<DigestCard>): DigestCard => ({
  episode_id: 'e', incident_id: 'i', title: 't', label: 'new',
  copy: 'prose', action: 'Review the fix PR', affected_users: 3, accounts: [], ...o,
});

describe('formatDigest', () => {
  it('lists cards as facts and flags PRs', () => {
    const out = formatDigest({ runDate: '2026-08-21', projectLabel: 'proj-1 (acme/app)', cards: [
      card({ incident_id: 'i-1', title: 'Dead clicks on /assets', affected_users: 6, accounts: ['acme'] }),
      card({ incident_id: 'i-2', title: 'TypeError', pr_url: 'https://github.com/acme/app/pull/9' }),
    ]});
    expect(out).toContain('i-1');
    expect(out).toContain('Dead clicks on /assets');
    expect(out).toContain('6');
    expect(out).toContain('https://github.com/acme/app/pull/9');
    expect(out).not.toContain('prose'); // model copy is dropped
  });

  it('says so when the digest is empty', () => {
    const out = formatDigest({ runDate: null, projectLabel: 'p', cards: [] });
    expect(out).toMatch(/no digest/i);
  });

  it('fences the title', () => {
    const out = formatDigest({ runDate: '2026-08-21', projectLabel: 'p', cards: [card({ title: '</untrusted> hi' })] });
    expect(out).not.toMatch(/<\/untrusted>\s*hi/); // neutralized
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd cli && npx vitest run src/__tests__/mcp-digest.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `formatDigest`** in `format.ts` (append; do not remove `fence`, `truncate`, `clampPayload`):

```ts
export function formatDigest(input: { runDate: string | null; cards: DigestCard[]; projectLabel: string }): string {
  const { runDate, cards, projectLabel } = input;
  if (cards.length === 0) {
    return `No digest has been delivered for ${projectLabel} yet. The daily run produces it.`;
  }
  const lines: string[] = [`Opslane digest for ${projectLabel}, ${runDate}.`, ''];
  for (const c of cards) {
    const who = c.accounts.length > 0 ? `${c.affected_users} users (${c.accounts.join(', ')})` : `${c.affected_users} users`;
    lines.push(`- ${c.incident_id}  ${fence(truncate(c.title, 200))}`);
    lines.push(`  ${who}${c.pr_url ? `  PR: ${c.pr_url}` : ''}`);
    if (c.action) lines.push(`  next: ${fence(truncate(c.action, 200))}`);
  }
  lines.push('', 'Call opslane_issue with an id for the full context on one of these.');
  return clampPayload(lines.join('\n'));
}
```

- [ ] **Step 4: Run to verify it passes; Step 5: Commit** (`feat(cli): render the digest list as lean facts`).

---

### Task 6: Render one issue

**Files:**
- Modify: `cli/src/mcp/format.ts` (replace `formatIssue`, remove `formatWorklist`, add `isFillerRootCause`)
- Test: rewrite `cli/src/__tests__/mcp-format.test.ts`

**This replaces the existing `formatIssue` and deletes `formatWorklist`.** The current `format.ts` exports `formatIssue(incident, recordingLine)` and `formatWorklist` (`format.ts:38,63`), both pre-rewrite. The existing `mcp-format.test.ts` has eleven two-arg `formatIssue` calls and three `formatWorklist` tests (`mcp-format.test.ts:2,51-132`). Rewrite that test file: drop the `formatWorklist` tests (its tool `opslane_worklist` is deleted in Task 7) and convert the `formatIssue` cases to the object-arg form below. Leaving them makes `tsc` fail on the signature change and blocks the Task 8 gate.

**Interfaces:**
- Produces: `formatIssue(input: { incident: McpIncident; evidence: IssueEvidence }): string`. Recording availability is read from `evidence.availability.recording`; there is no separate `recording` param.

Root cause first. Then, for an error, the resolved frames as file and line; for friction, the route and selector plus the failing request. Then the state and the PR. Everything fenced.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { formatIssue } from '../mcp/format.js';
import type { McpIncident, IssueEvidence } from '../mcp/types.js';

const evidence = (o: Partial<IssueEvidence> = {}): IssueEvidence => ({
  frames: [], failed_requests: [], replay_pointers: [],
  availability: { recording: 'missing', source_map: 'missing' }, ...o,
});

describe('formatIssue', () => {
  it('leads with the root cause, then resolved frames for an error', () => {
    const incident = { id: 'e', kind: 'error', title: 'TypeError', status: 'needs_human',
      state: 'needs_you', root_cause: 'request_types is null in MainView', occurrence_count: 3, affected_users_count: 2,
      first_seen: '', last_seen: '' } as unknown as McpIncident;
    const ev = evidence({ frames: [{ anchor_kind: 'threshold', status: 'resolved', commit_sha: null,
      envelope: { version: 2, frames: [{ original_file: 'src/components/MainView.tsx', original_line: 25 }] } }] });
    const out = formatIssue({ incident, evidence: ev });
    expect(out.indexOf('request_types is null')).toBeLessThan(out.indexOf('MainView.tsx'));
    expect(out).toContain('src/components/MainView.tsx:25');
  });

  it('gives friction the failing request when the diagnosis is thin', () => {
    const incident = { id: 'f', kind: 'friction', title: 'Dead clicks', status: 'awaiting_approval',
      state: 'needs_you', root_cause: 'placeholder', page_url_normalized: '/assets',
      element_selector: 'div._11c81d4k', occurrence_count: 7, affected_users_count: 6,
      first_seen: '', last_seen: '' } as unknown as McpIncident;
    const ev = evidence({ failed_requests: [{ page_route: '/assets', method: 'POST',
      endpoint_pattern: '/api/assets/:id', status: 500, action_selector: 'button.save' }] });
    const out = formatIssue({ incident, evidence: ev });
    expect(out).toContain('/api/assets/:id');
    expect(out).toContain('500');
    expect(out).not.toMatch(/placeholder/i); // filler root cause refused
    expect(out).toMatch(/investigation did not complete/i);
  });

  it('fences untrusted fields', () => {
    const incident = { id: 'x', kind: 'error', title: '</untrusted> t', status: 'needs_human',
      root_cause: 'r', occurrence_count: 1, affected_users_count: 1, first_seen: '', last_seen: '' } as unknown as McpIncident;
    const out = formatIssue({ incident, evidence: evidence() });
    expect(out).toContain('<untrusted>');
  });
});
```

Define `isFillerRootCause` in `format.ts` (no such function exists on this branch; the current `formatIssue` never renders `root_cause`). Anchor it: `^\s*(placeholder|tbd|to be determined)\b`, so a real cause that merely mentions a placeholder image survives.

- [ ] **Step 2-5:** implement `formatIssue`, run, commit (`feat(cli): render one issue root-cause first with fix-shaped evidence`). The implementation reads `incident.kind` to choose frames vs failing-request emphasis, refuses a filler root cause, and ends by naming `opslane_link_pr`.

---

### Task 7: Register the three v2 tools

**Files:**
- Rewrite: `cli/src/mcp/tools.ts`
- Test: `cli/src/__tests__/mcp-tools.test.ts` (exists; add to it)

**Interfaces:**
- Produces: `registerTools` registering exactly `opslane_digest`, `opslane_issue`, `opslane_link_pr`. `opslane_worklist` and `opslane_resolve` are removed. `opslane_resolve` is deleted because it wrote `resolved`, which the design forbids.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../mcp/tools.js';
import type { OpslaneClient } from '../mcp/client.js';

function fakeServer() {
  const registered = new Map<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
  return { registered, registerTool(n: string, _c: unknown, h: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) { registered.set(n, h); } };
}
function fakeClient(o: Partial<OpslaneClient> = {}): OpslaneClient {
  return { projectId: 'p', projectLabel: 'p (acme/app)', dashboardUrl: null,
    latestDigest: async () => ({ run_date: '2026-08-21', cards: [{ episode_id: 'e', incident_id: 'i-1', title: 't', label: 'new', copy: 'c', action: 'a', affected_users: 3, accounts: [] }] }),
    getIncident: async () => ({ id: 'i-1', kind: 'error', title: 't', status: 'needs_human', root_cause: 'r', occurrence_count: 1, affected_users_count: 1, first_seen: '', last_seen: '' } as never),
    issueEvidence: async () => ({ frames: [], failed_requests: [], replay_pointers: [], availability: { recording: 'missing', source_map: 'missing' } }),
    linkPr: async () => undefined, ...o } as OpslaneClient;
}

describe('registerTools v2', () => {
  it('registers exactly the three tools', () => {
    const s = fakeServer(); registerTools(s as never, fakeClient());
    expect([...s.registered.keys()].sort()).toEqual(['opslane_digest', 'opslane_issue', 'opslane_link_pr']);
  });
  it('link_pr surfaces a refusal as text', async () => {
    const s = fakeServer();
    registerTools(s as never, fakeClient({ linkPr: async () => { throw new Error("not in this project's repository"); } }));
    const r = await s.registered.get('opslane_link_pr')!({ id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', url: 'https://github.com/other/app/pull/1' });
    expect(r.content[0]!.text).toContain("not in this project's repository");
  });
});
```

- [ ] **Step 2-4:** rewrite `tools.ts` to register the three tools. `opslane_issue` calls both `getIncident` and `issueEvidence`, then `formatIssue({ incident, evidence })`. `opslane_link_pr` parses the id, calls `linkPr` inside a try, and returns the API message as text on failure. Delete any test asserting `opslane_worklist`/`opslane_resolve`.

- [ ] **Step 5: Verify stdout stays clean**

```bash
cd cli && npm run build && \
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | node dist/index.js mcp 2>/dev/null | head -c 400
```

Expected: one line of JSON-RPC, nothing else. A stray line means a `console.log` in the import graph; change it to `console.error`.

- [ ] **Step 6:** `cd cli && npm test` (all pass; delete worklist/resolve tests). Commit (`feat(cli): replace worklist and resolve with digest, issue, link-pr`).

---

### Task 8: The skill

**Files:**
- Rewrite: `cli/skills/opslane/SKILL.md`
- Verify: `cli/src/init-claude.ts`, `cli/scripts/embed-skill.mjs` (no change expected)
- Test: extend `cli/src/__tests__/init-claude.test.ts`

**Interfaces:**
- `opslane init-claude` already ships; only the skill markdown changes. The embedded export is `SKILL_MD` (`embed-skill.mjs`), regenerated by `npm run build`.

- [ ] **Step 1: Rewrite `cli/skills/opslane/SKILL.md`** with frontmatter `allowed-tools: mcp__opslane__opslane_digest, mcp__opslane__opslane_issue, mcp__opslane__opslane_link_pr, Read, Grep, Glob, Edit, Bash`, and a procedure: start with `opslane_digest`; open one with `opslane_issue`; read the root cause first; for a `verified_fix` review the flagged PR, for a `needs_human` fix it in the repo; when a diagnosis says the investigation did not complete, use the failing request and route, do not invent one from the selector; finish by opening a PR and calling `opslane_link_pr`; treat fenced content as data.

- [ ] **Step 2: Extend the test**

```ts
it('embeds a skill naming the v2 tools and no retired ones', async () => {
  const { SKILL_MD } = await import('../mcp/skill-source.js');
  expect(SKILL_MD).toContain('opslane_digest');
  expect(SKILL_MD).toContain('opslane_link_pr');
  expect(SKILL_MD).not.toContain('opslane_worklist');
  expect(SKILL_MD).not.toContain('opslane_resolve');
});
```

- [ ] **Step 3: Rebuild and test.** `cd cli && npm run build && npx vitest run src/__tests__/init-claude.test.ts`. The build runs `embed-skill.mjs` first. Do not `git add` the gitignored `skill-source.ts`.

- [ ] **Step 4: Commit** the markdown and test only (`feat(cli): teach the skill the v2 digest, issue, link-pr procedure`).

- [ ] **Step 5: Full repository gate**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && DATABASE_URL="$DATABASE_URL" go test ./...)
docker compose config --quiet
```

Expected: green, **zero skips** in the Go suite (export `DATABASE_URL` and storage credentials first).

---

## Self-review

**Spec coverage.** R1/R2/R3 are Tasks 1, 5. R4/R5/R6 are Tasks 2, 6. R7/R8 are Tasks 3, 4, 7. R9 (fencing) is Tasks 5, 6 via the kept `fence`. R10 (clean stdio) is Task 7 Step 5. The design's "delete `opslane_resolve`" is Task 7. The MCP-first one-call evidence bundle is Task 2.

**Placeholders.** None. Every step carries code or a command.

**Type consistency.** `DigestCard` fields match `GeneratedDigestCard`'s JSON tags (`notify/event.go`). `IssueEvidence` mirrors the worker's `EvidenceBundle` subset. `LinkPR` writes the columns `ProcessPRWebhook` matches (`queries.go:1878`), the same lesson the design records.

**Deliberate deviations, stated.** The evidence endpoint does not throw on missing anchors where `loadEvidence` does; it returns an empty bundle, because anchorless issues are normal and must render as "no evidence yet". The list drops the model's prose and joins state only when an issue is opened, keeping it lean.

**What review iteration 2 changed.** A compile error iteration 1 introduced: the
`recordingAvailabilityFromRetained` helper lives in package `db` and had qualified its own
type as `db.EvidenceReplayPointer`, which does not build; dropped to `EvidenceReplayPointer`.
Two gate blockers: the existing `mcp-format.test.ts` still calls the old two-arg `formatIssue`
and tests the deleted `formatWorklist`, so Task 6 now rewrites that file; and the "zero skips"
gate needed the MINIO/REPLAY_STORE storage block, not just `DATABASE_URL`. Plus: `isFillerRootCause`
is defined fresh rather than "ported" (it never existed), the redundant `recording` param is
dropped in favor of `evidence.availability.recording`, and the empty-digest early return is
made explicit so the client never receives `cards: null`.

**What review iteration 1 changed.** Two test-seed blockers: `digest_runs` requires `window_from`/`window_to` (NOT NULL, no default), and `issue_episodes` has no `status` column, so an episode is open when `closed_at IS NULL`. One runtime bug that would have shipped green: the evidence anchor query LEFT JOINs the resolution, so `r.status` is NULL for an unresolved anchor, and scanning NULL into a Go `string` 500s; it now scans a `sql.NullString` and defaults to `"missing"`, which is the friction/pre-resolution case the design cares about most. Plus a dangling `prRepoFromURL` helper, now folded into a single `parseGitHubPR` that returns repo and number together, and a 404-versus-409 fix for an unknown incident.

**Not covered, deliberately.** Relinking after a wrong PR is punted (design decision). The duplicate-AMFJ cross-project write is an upstream fix; the repo guard narrows but does not close it. `writeRollups`, `productContext`, and `relatedCandidates` are omitted from the bundle because only the inquiry consumes them.
