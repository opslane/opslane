package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
		`{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-19","generated_cards":[{"episode_id":"e-old","incident_id":"i-old","title":"old","label":"new","outcome":"needs_human","copy":"c","action":"a","affected_users":3,"accounts":[]}]}}`)
	insertDeliveredDigest(t, pool, projectID, "2026-08-21",
		`{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-21","generated_cards":[{"episode_id":"e-new","incident_id":"i-new","title":"new","label":"new","outcome":"verified_fix","copy":"c","action":"a","affected_users":9,"accounts":["acme"],"pr_url":"https://github.com/acme/app/pull/1"}]}}`)

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
		Receipts []json.RawMessage `json:"receipts"`
		Empty    bool              `json:"empty"`
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
	if len(body.Receipts) != 0 || body.Empty {
		t.Fatalf("cards-only additions = receipts:%d empty:%v", len(body.Receipts), body.Empty)
	}
}

func TestLatestDigestReturnsReceipts(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	insertDeliveredDigest(t, pool, projectID, "2026-08-27", `{"event_type":"digest.daily","digest":{"schema_version":4,"date":"2026-08-27","receipt_items":[{"kind":"error","incident_id":"i-wait","title":"Dead clicks","receipt_state":"awaiting_approval"}],"receipt_overflow":2}}`)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/digest/latest", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var body struct {
		RunDate  *string `json:"run_date"`
		Cards    []any   `json:"cards"`
		Receipts []struct {
			IncidentID string `json:"incident_id"`
		} `json:"receipts"`
		ReceiptOverflow int  `json:"receipt_overflow"`
		Empty           bool `json:"empty"`
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.RunDate == nil || *body.RunDate != "2026-08-27" || len(body.Cards) != 0 || len(body.Receipts) != 1 || body.Receipts[0].IncidentID != "i-wait" || body.ReceiptOverflow != 2 || body.Empty {
		t.Fatalf("receipts response = %+v", body)
	}
}

func TestLatestDigestReturnsEmptyWhenNoDeliveredRun(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

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
		RunDate  *string           `json:"run_date"`
		Cards    []json.RawMessage `json:"cards"`
		Receipts []json.RawMessage `json:"receipts"`
		Empty    bool              `json:"empty"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.RunDate != nil || len(body.Cards) != 0 || len(body.Receipts) != 0 || !body.Empty {
		t.Fatalf("want empty set, got run_date=%v cards=%d receipts=%d empty=%v", body.RunDate, len(body.Cards), len(body.Receipts), body.Empty)
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
	_ = json.NewDecoder(rec.Body).Decode(&body)
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

// A stored payload the view cannot interpret must be refused, never rendered
// as an empty digest: an empty-looking success is the failure mode the shared
// view exists to remove.
func TestLatestDigestRefusesMalformedStoredPayload(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	for _, tc := range []struct {
		name    string
		payload string
	}{
		{name: "no digest body", payload: `{"event_type":"digest.daily"}`},
		{name: "digest is not an object", payload: `{"event_type":"digest.daily","digest":"nope"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(context.Background(), `DELETE FROM digest_runs WHERE project_id=$1`, projectID); err != nil {
				t.Fatal(err)
			}
			insertDeliveredDigest(t, pool, projectID, "2026-08-20", tc.payload)
			router := handler.NewRouterWithPool(deps, pool)
			req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/digest/latest", nil)
			req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status=%d want 500, body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "malformed") {
				t.Fatalf("body should name the malformed payload, got %s", rec.Body.String())
			}
		})
	}
}

// A stored version whose cards the view does not serve must not leak those
// cards through the raw passthrough: the response would then report legacy
// while carrying a populated cards array, and disagree with the MCP tool.
func TestLatestDigestDoesNotLeakCardsFromAnUnservedVersion(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	// No schema_version: a v1 payload the view reports as legacy, carrying a
	// cards array a later format introduced.
	insertDeliveredDigest(t, pool, projectID, "2026-08-19",
		`{"event_type":"digest.daily","digest":{"date":"2026-08-19","generated_cards":[{"incident_id":"i-stale","title":"Stale","label":"new","copy":"c","action":"a","affected_users":1,"accounts":[]}]}}`)

	router := handler.NewRouterWithPool(deps, pool)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/digest/latest", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Cards  []any `json:"cards"`
		Legacy bool  `json:"legacy"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.Legacy {
		t.Fatal("a payload with no schema_version must report legacy")
	}
	if len(body.Cards) != 0 {
		t.Fatalf("legacy response must not carry cards the view does not serve, got %d", len(body.Cards))
	}
}
