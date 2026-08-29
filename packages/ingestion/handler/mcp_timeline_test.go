package handler_test

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestTimelineAnchorEventAndFailures(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	groupID, _ := seedEpisodeWithAnchor(t, pool, projectID, envID, `{"version":2,"frames":[]}`)
	sessionID := fmt.Sprintf("sess_tl_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, sessionID, time.Now().UTC().Add(-time.Minute))
	anchorAt := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := pool.Exec(ctx, `UPDATE error_events
		SET session_id=$1, "timestamp"=$2,
		    breadcrumbs='[{"type":"console","timestamp":"2026-08-28T10:00:00Z","category":"console","message":"boom","level":"error"}]'::jsonb,
		    network_timings='[{"transport":"fetch","method":"GET","url":"https://a.example/api/auth/session?tok=x","started_at_ms":1787911190000,"duration_ms":180,"outcome":"http_error","status":401}]'::jsonb
		WHERE error_group_id=$3`, sessionID, anchorAt, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_analysis
		(session_id, project_id, session_started_at, coverage, activity_class, rule_version)
		VALUES ($1, $2, now(), 'complete', 'active', 1)`, sessionID, projectID); err != nil {
		t.Fatal(err)
	}
	for i, off := range []time.Duration{2 * time.Second, 10 * time.Minute} {
		if _, err := pool.Exec(ctx, `INSERT INTO session_request_failures
			(project_id, session_id, request_id_hash, page_route, method, endpoint_pattern, status, action_link, occurred_at, rule_version)
			VALUES ($1, $2, $3, '/settings', 'POST', $4, 401, 'none', $5, 1)`,
			projectID, sessionID, fmt.Sprintf("h%d", i), fmt.Sprintf("/api/f%d", i), anchorAt.Add(off)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM session_request_failures WHERE session_id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM session_analysis WHERE session_id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `UPDATE error_events SET session_id=NULL WHERE error_group_id=$1`, groupID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, sessionID)
	})

	anchor, state, err := deps.Queries.TimelineAnchorEvent(ctx, projectID, groupID)
	if err != nil || state != "ok" {
		t.Fatalf("anchor: state=%q err=%v", state, err)
	}
	if anchor.SessionID != sessionID || !anchor.SessionRetained || anchor.AnchorMs != anchorAt.UnixMilli() {
		t.Fatalf("anchor = %+v", anchor)
	}
	if !strings.Contains(string(anchor.NetworkTimings), "auth/session") || !strings.Contains(string(anchor.Breadcrumbs), "boom") {
		t.Fatalf("anchor payloads = %s / %s", anchor.NetworkTimings, anchor.Breadcrumbs)
	}

	failures, analysisRan, err := deps.Queries.RequestFailuresNear(ctx, projectID, sessionID, anchor.AnchorMs, 60_000)
	if err != nil || !analysisRan {
		t.Fatalf("failures: analysisRan=%v err=%v", analysisRan, err)
	}
	if len(failures) != 1 || failures[0].EndpointPattern != "/api/f0" {
		t.Fatalf("windowing failed: %+v", failures)
	}
	wantMs := anchorAt.Add(2 * time.Second).UnixMilli()
	if failures[0].OccurredAtMs != wantMs {
		t.Fatalf("occurred_at ms = %d, want %d", failures[0].OccurredAtMs, wantMs)
	}

	if _, state, _ := deps.Queries.TimelineAnchorEvent(ctx, "00000000-0000-0000-0000-000000000000", groupID); state == "ok" {
		t.Fatal("anchor leaked across projects")
	}

	for _, stmt := range []string{
		`DELETE FROM session_request_failures WHERE session_id=$1`,
		`DELETE FROM session_analysis WHERE session_id=$1`,
		`DELETE FROM sessions WHERE id=$1`,
	} {
		if _, err := pool.Exec(ctx, stmt, sessionID); err != nil {
			t.Fatal(err)
		}
	}
	anchor, state, err = deps.Queries.TimelineAnchorEvent(ctx, projectID, groupID)
	if err != nil || state != "ok" || anchor.SessionRetained {
		t.Fatalf("post-delete anchor: state=%q retained=%v err=%v", state, anchor.SessionRetained, err)
	}

	if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET closed_at=now() WHERE canonical_issue_id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, state, _ := deps.Queries.TimelineAnchorEvent(ctx, projectID, groupID); state != "closed" {
		t.Fatalf("closed episode state = %q", state)
	}
}

func TestTimelineAnchorEventNoAnchors(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	var groupID, episodeID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups (project_id, fingerprint, title, kind, status,
		first_seen, last_seen) VALUES ($1,'tl-noanchor','Boom','error','new',now(),now()) RETURNING id`,
		projectID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes (project_id, canonical_issue_id, sequence)
		VALUES ($1,$2,1) RETURNING id`, projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatal(err)
	}
	if _, state, err := deps.Queries.TimelineAnchorEvent(ctx, projectID, groupID); err != nil || state != "no_anchors" {
		t.Fatalf("state = %q err = %v", state, err)
	}

	var bareID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups (project_id, fingerprint, title, kind, status,
		first_seen, last_seen) VALUES ($1,'tl-noepisode','Boom','error','new',now(),now()) RETURNING id`,
		projectID).Scan(&bareID); err != nil {
		t.Fatal(err)
	}
	if _, state, err := deps.Queries.TimelineAnchorEvent(ctx, projectID, bareID); err != nil || state != "no_episode" {
		t.Fatalf("bare group state = %q err = %v", state, err)
	}
}

func TestRequestFailuresNearWithoutAnalysis(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	sessionID := fmt.Sprintf("sess_noan_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, sessionID, time.Now().UTC())
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, sessionID) })

	failures, analysisRan, err := deps.Queries.RequestFailuresNear(ctx, projectID, sessionID, time.Now().UnixMilli(), 60_000)
	if err != nil {
		t.Fatal(err)
	}
	if analysisRan || len(failures) != 0 {
		t.Fatalf("expected no analysis: ran=%v failures=%+v", analysisRan, failures)
	}
	_ = db.ScopeAPI
}

func TestMCPSessionTimelineEndToEnd(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	groupID, _ := seedEpisodeWithAnchor(t, pool, projectID, envID, `{"version":2,"frames":[]}`)
	sessionID := fmt.Sprintf("sess_tle2e_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, sessionID, time.Now().UTC().Add(-time.Minute))
	anchorAt := time.Now().UTC().Truncate(time.Millisecond)
	crumbs := fmt.Sprintf(`[{"type":"click","timestamp":"%s","category":"ui.click","message":"button.try-again"}]`,
		anchorAt.Add(-3*time.Second).UTC().Format(time.RFC3339))
	timings := fmt.Sprintf(`[{"transport":"fetch","method":"GET","url":"https://a.example/api/auth/session?tok=x","started_at_ms":%d,"duration_ms":180,"outcome":"http_error","status":401}]`,
		anchorAt.Add(-2*time.Second).UnixMilli())
	if _, err := pool.Exec(ctx, `UPDATE error_events
		SET session_id=$1, "timestamp"=$2, breadcrumbs=$3::jsonb, network_timings=$4::jsonb
		WHERE error_group_id=$5`, sessionID, anchorAt, crumbs, timings, groupID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE error_events SET session_id=NULL WHERE error_group_id=$1`, groupID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, sessionID)
	})

	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp-tl", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_session_timeline", Arguments: map[string]any{"id": groupID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("timeline errored: %+v", result)
	}
	text := result.Content[0].(*mcpsdk.TextContent).Text
	for _, want := range []string{sessionID, "/api/auth/session", "-> 401", "button.try-again", "analysis has not run"} {
		if !strings.Contains(text, want) {
			t.Fatalf("timeline missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "tok=x") {
		t.Fatalf("query string leaked:\n%s", text)
	}

	missing, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_session_timeline", Arguments: map[string]any{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !missing.IsError || !strings.Contains(missing.Content[0].(*mcpsdk.TextContent).Text, "not found") {
		t.Fatalf("missing issue result = %+v", missing)
	}

	if _, err := pool.Exec(ctx, `UPDATE issue_episodes SET closed_at=now() WHERE canonical_issue_id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	closed, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_session_timeline", Arguments: map[string]any{"id": groupID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if closed.IsError || !strings.Contains(closed.Content[0].(*mcpsdk.TextContent).Text, "episode is closed") {
		t.Fatalf("closed episode result = %+v", closed)
	}
}

func TestMCPSessionTimelineFriction(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	frictionID, sessionID, _ := seedWatchableFrictionGroup(t, deps.Queries, pool, projectID, envID)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE error_groups SET representative_signal_id=NULL WHERE id=$1`, frictionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM friction_signals WHERE incident_id=$1`, frictionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM session_chunks WHERE session_id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_groups WHERE id=$1`, frictionID)
	})
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp-tlf", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_session_timeline", Arguments: map[string]any{"id": frictionID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("friction timeline errored: %+v", result)
	}
	text := result.Content[0].(*mcpsdk.TextContent).Text
	if !strings.Contains(text, "browser-log evidence only exists for thrown errors") {
		t.Fatalf("friction statement missing:\n%s", text)
	}
}

// A retained session outranks anchor kind. FormatIssue points the agent at the
// first pointer whose session survived; if the timeline still insisted on the
// threshold anchor, the two tools would disagree about the same issue and the
// retained session's analyzed failures would never be read.
func TestTimelineAnchorPrefersRetainedSessionOverAnchorKind(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	groupID, episodeID := seedEpisodeWithAnchor(t, pool, projectID, envID, `{"version":2,"frames":[]}`)
	live := fmt.Sprintf("sess_retained_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, live, time.Now().UTC().Add(-time.Minute))
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, live) })

	// The seeded threshold anchor's event points at a session that retention
	// already took; a 'first' anchor points at one that survived.
	if _, err := pool.Exec(ctx, `UPDATE error_events SET session_id='sess_swept_away' WHERE error_group_id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	var firstEventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events (project_id, environment_id, error_group_id, "timestamp", platform,
		   error_type, error_message, stack_trace_raw, session_id)
		 VALUES ($1,$2,$3,now(),'javascript','TypeError','boom','at a (b.min.js:1:2)',$4)
		 RETURNING id`, projectID, envID, groupID, live).Scan(&firstEventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO issue_evidence_anchors (project_id, episode_id, anchor_kind, event_id)
		 VALUES ($1,$2,'first',$3)`, projectID, episodeID, firstEventID); err != nil {
		t.Fatal(err)
	}

	anchor, state, err := deps.Queries.TimelineAnchorEvent(ctx, projectID, groupID)
	if err != nil || state != "ok" {
		t.Fatalf("state=%q err=%v", state, err)
	}
	if anchor.SessionID != live || !anchor.SessionRetained {
		t.Fatalf("timeline chose %+v, want the retained session %s", anchor, live)
	}
}
