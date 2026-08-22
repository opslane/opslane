package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
		"acme/app", 77, true, "delivery-"+t.Name(), time.Now()); err != nil {
		t.Fatalf("webhook: %v", err)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM error_groups WHERE id=$1`, groupID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
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
	if err := pool.QueryRow(context.Background(), `SELECT pr_number FROM error_groups WHERE id=$1`, groupID).Scan(&prNumber); err != nil {
		t.Fatalf("read pr_number: %v", err)
	}
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
	if err := pool.QueryRow(context.Background(), `SELECT pr_url FROM error_groups WHERE id=$1`, groupID).Scan(&prURL); err != nil {
		t.Fatalf("read pr_url: %v", err)
	}
	if prURL != nil {
		t.Fatalf("pr_url = %q; a foreign PR was recorded", *prURL)
	}
}

func TestLinkPRRejectsMalformedURL(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	seedProjectRepo(t, pool, projectID, "acme/app")
	groupID := insertGroup(t, pool, projectID, "error", "link-bad", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/issues/42"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestLinkPRExplainsUnconfiguredRepo(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET github_repo = NULL WHERE id = $1`, projectID); err != nil {
		t.Fatalf("clear github_repo: %v", err)
	}
	groupID := insertGroup(t, pool, projectID, "error", "link-norepo", "boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	if rec := linkPR(t, router, orgID, projectID, groupID, "https://github.com/acme/app/pull/3"); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for an unconfigured repo", rec.Code)
	}
}
