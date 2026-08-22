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
