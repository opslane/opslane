package handler_test

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func seedWatchableFrictionGroup(t *testing.T, q *db.Queries, pool *pgxpool.Pool, projectID, envID string) (frictionID, sessionID string, anchorMs int64) {
	t.Helper()
	ctx := context.Background()
	anchor := time.Now().UTC().Truncate(time.Millisecond).Add(-time.Minute)
	sessionID = fmt.Sprintf("sess_mcp_friction_%d", time.Now().UnixNano())
	seedReadableSession(t, q, projectID, envID, sessionID, anchor)

	fingerprint := "mcp-friction-" + sessionID
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, first_seen, last_seen, status, kind,
		 signal_type, element_selector, page_url_normalized)
		VALUES ($1, $2, $3, 'Send does nothing', now(), now(), 'insight', 'friction',
		        'dead_click', 'button.send', '/invoices')
		RETURNING id`, projectID, envID, fingerprint).Scan(&frictionID); err != nil {
		t.Fatalf("insert friction group: %v", err)
	}

	spans := [][2]int64{
		{anchor.Add(-20 * time.Second).UnixMilli(), anchor.Add(-8 * time.Second).UnixMilli()},
		{anchor.Add(-8 * time.Second).UnixMilli(), anchor.Add(2 * time.Second).UnixMilli()},
		{anchor.Add(2 * time.Second).UnixMilli(), anchor.Add(16 * time.Second).UnixMilli()},
	}
	for seq, span := range spans {
		if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
			(session_id, seq, project_id, object_key, has_full_snapshot, scrubbed_at, first_event_ms, last_event_ms)
			VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`,
			sessionID, seq, projectID, fmt.Sprintf("mcp-friction/%s/%d", sessionID, seq), seq == 0, span[0], span[1]); err != nil {
			t.Fatalf("insert friction session chunk %d: %v", seq, err)
		}
	}

	var signalID string
	if err := pool.QueryRow(ctx, `INSERT INTO friction_signals
		(session_id, project_id, environment_id, rule_version, signal_type, fingerprint,
		 page_url_normalized, occurred_at, adjudication_status, incident_id)
		VALUES ($1, $2, $3, 1, 'dead_click', $4, '/invoices', $5, 'accepted', $6)
		RETURNING id`, sessionID, projectID, envID, fingerprint, anchor, frictionID).Scan(&signalID); err != nil {
		t.Fatalf("insert friction signal: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET representative_signal_id=$2 WHERE id=$1`, frictionID, signalID); err != nil {
		t.Fatalf("set representative friction signal: %v", err)
	}
	return frictionID, sessionID, anchor.UnixMilli()
}

func seedFrictionGroupNoSession(t *testing.T, pool *pgxpool.Pool, projectID, envID string) string {
	t.Helper()
	var frictionID string
	fingerprint := fmt.Sprintf("mcp-bare-friction-%d", time.Now().UnixNano())
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id, environment_id, fingerprint, title, first_seen, last_seen, status, kind,
		 signal_type, element_selector, page_url_normalized)
		VALUES ($1, $2, $3, 'Bare friction', now(), now(), 'insight', 'friction',
		        'dead_click', 'button.send', '/invoices')
		RETURNING id`, projectID, envID, fingerprint).Scan(&frictionID); err != nil {
		t.Fatalf("insert bare friction group: %v", err)
	}
	return frictionID
}

func TestMCPIssueReturnsPresentedIncidentAndEvidence(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	groupID, _ := seedEpisodeWithAnchor(t, pool, projectID, envID,
		`{"version":2,"frames":[{"original_file":"src/MainView.tsx","original_line":25}]}`)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET root_cause = 'request_types is null' WHERE id = $1`, groupID); err != nil {
		t.Fatal(err)
	}
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": "https://app.opslane.test/issues/" + groupID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("issue result = %+v", result)
	}
	text := result.Content[0].(*mcpsdk.TextContent).Text
	for _, want := range []string{"request_types is null", "src/MainView.tsx:25", groupID, "3 occurrences"} {
		if !strings.Contains(text, want) {
			t.Fatalf("issue text missing %q:\n%s", want, text)
		}
	}

	missing, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !missing.IsError || !strings.Contains(missing.Content[0].(*mcpsdk.TextContent).Text, "not found") {
		t.Fatalf("missing issue result = %+v", missing)
	}
}

func TestPresentMCPIncidentFrictionAttachesReplayPointer(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	frictionID, sessionID, anchorMs := seedWatchableFrictionGroup(t, deps.Queries, pool, projectID, envID)
	bareID := seedFrictionGroupNoSession(t, pool, projectID, envID)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE error_groups SET representative_signal_id=NULL WHERE id=$1`, frictionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM friction_signals WHERE incident_id=$1`, frictionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM session_chunks WHERE session_id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE id=$1`, sessionID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_groups WHERE id IN ($1, $2)`, frictionID, bareID)
	})
	key, err := deps.Queries.CreateProjectKey(ctx, projectID, db.ScopeAPI, "mcp-friction", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.NewRouterWithPool(deps, pool))
	t.Cleanup(server.Close)
	session := connectMCP(t, server.URL+"/mcp", key.Raw)

	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": frictionID},
	})
	if err != nil {
		t.Fatalf("opslane_issue friction: %v", err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("friction issue result = %+v", result)
	}
	text := result.Content[0].(*mcpsdk.TextContent).Text
	for _, want := range []string{"Recording: available", "Replay: watch session", sessionID, "t=" + strconv.FormatInt(anchorMs, 10)} {
		if !strings.Contains(text, want) {
			t.Fatalf("friction issue text missing %q:\n%s", want, text)
		}
	}

	bare, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "opslane_issue", Arguments: map[string]any{"id": bareID},
	})
	if err != nil {
		t.Fatalf("opslane_issue bare friction: %v", err)
	}
	if bare.IsError || len(bare.Content) != 1 {
		t.Fatalf("bare friction issue result = %+v", bare)
	}
	bareText := bare.Content[0].(*mcpsdk.TextContent).Text
	if strings.Contains(bareText, "Replay:") || strings.Contains(bareText, "Recording: available") {
		t.Fatalf("bare friction issue got replay evidence:\n%s", bareText)
	}
}
