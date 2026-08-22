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
// and a threshold anchor pointing at the event. Returns the incident and episode ids.
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

	var body struct {
		Frames []json.RawMessage `json:"frames"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if len(body.Frames) != 0 {
		t.Fatal("project A read project B's evidence")
	}
}
