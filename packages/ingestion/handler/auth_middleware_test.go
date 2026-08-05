package handler_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

const authTestJWTSecret = "auth-middleware-test-secret"

// authTestRouter builds the real router against the test database, skipping
// (like the db package helpers) when Postgres is unreachable.
func authTestRouter(t *testing.T) (http.Handler, *db.Queries, *pgxpool.Pool) {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping auth middleware test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("skipping auth middleware test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)

	q := db.New(pool)
	deps := &handler.Dependencies{
		Queries:   q,
		JWTSecret: []byte(authTestJWTSecret),
	}
	return handler.NewRouter(deps), q, pool
}

func doRequest(router http.Handler, method, path string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestRoutes_HealthAndUnknownPath(t *testing.T) {
	router, _, _ := authTestRouter(t)

	if w := doRequest(router, "GET", "/health", nil); w.Code != http.StatusOK {
		t.Errorf("GET /health = %d, want 200", w.Code)
	}
	if w := doRequest(router, "GET", "/api/v1/definitely-not-a-route", nil); w.Code != http.StatusNotFound {
		t.Errorf("GET unknown route = %d, want 404", w.Code)
	}
}

func TestProjectKeyRoutesRejectMissingAndInvalidKeys(t *testing.T) {
	router, _, _ := authTestRouter(t)

	// No key at all.
	if w := doRequest(router, "POST", "/api/v1/events", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("POST /events without key = %d, want 401", w.Code)
	}

	// A key that does not exist.
	w := doRequest(router, "POST", "/api/v1/events", map[string]string{"X-API-Key": "def_bogus"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("POST /events with bogus key = %d, want 401", w.Code)
	}
}

func TestProjectKeyRoutesRejectRevokedKey(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgID, _, _, rawKey := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	// Valid key passes the auth middleware (project mismatch would be 403,
	// anything auth-related is 401).
	path := "/api/v1/ingest/ping"
	if w := doRequest(router, "POST", path, map[string]string{"X-API-Key": rawKey}); w.Code != http.StatusNoContent {
		t.Fatalf("POST ingest ping with valid key = %d, want 204: %s", w.Code, w.Body.String())
	}

	// Revoke it: same request must now be rejected.
	if _, err := pool.Exec(context.Background(),
		`UPDATE project_api_keys SET revoked_at = now()
		 WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		orgID); err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if w := doRequest(router, "POST", path, map[string]string{"X-API-Key": rawKey}); w.Code != http.StatusUnauthorized {
		t.Errorf("POST ingest ping with revoked key = %d, want 401", w.Code)
	}
}

func TestSDKAuth_CrossTenantProjectIsForbidden(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgA, _, _, keyA := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	// Tenant A's key must not read tenant B's project.
	w := doRequest(router, "GET", "/api/v1/projects/"+projectB+"/event-count",
		map[string]string{"X-API-Key": keyA})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("cross-tenant event-count = %d, want 401: %s", w.Code, w.Body.String())
	}
}

func TestSDKKeyCannotAccessSiblingProject(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgID, _, _, keyA := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	projectB, err := q.CreateProject(context.Background(), orgID, "sibling", nil)
	if err != nil {
		t.Fatalf("CreateProject sibling: %v", err)
	}
	response := doRequest(router, http.MethodGet,
		"/api/v1/projects/"+projectB.ID+"/event-count", map[string]string{"X-API-Key": keyA})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("sibling access status=%d body=%s", response.Code, response.Body.String())
	}
}

type cloudAuthStub struct{}

func (cloudAuthStub) Name() string                                  { return "workos" }
func (cloudAuthStub) AuthorizeURL(auth.AuthRequest) (string, error) { return "", nil }
func (cloudAuthStub) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, nil
}
func (cloudAuthStub) SupportsLocalPasswordForm() bool { return false }

func TestRequireMembershipAndRoleUseCurrentDatabaseRole(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "role-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("role-%d@example.com", time.Now().UnixNano()), "Role", time.Now().UnixNano(), "role", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	deps := &handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}}
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if handler.RoleFromCtx(r.Context()) != "admin" {
			t.Errorf("role context=%q, want admin", handler.RoleFromCtx(r.Context()))
		}
		w.WriteHeader(http.StatusNoContent)
	})
	protected := deps.AuthenticateUserSession(deps.RequireRole("admin")(next))
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	request := func(withToken bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		if withToken {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, req)
		return response
	}
	if response := request(false); response.Code != http.StatusUnauthorized || called {
		t.Fatalf("missing auth status=%d called=%v", response.Code, called)
	}
	if response := request(true); response.Code != http.StatusForbidden || called {
		t.Fatalf("member admin status=%d called=%v", response.Code, called)
	}
	if err := q.SetMembershipRole(ctx, user.ID, org.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	if response := request(true); response.Code != http.StatusNoContent || !called {
		t.Fatalf("admin status=%d called=%v", response.Code, called)
	}
	called = false
	if err := q.SetMembershipRole(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if response := request(true); response.Code != http.StatusForbidden || called {
		t.Fatalf("downgraded status=%d called=%v", response.Code, called)
	}
	if err := q.DeleteMembership(ctx, user.ID, org.ID); err != nil {
		t.Fatal(err)
	}
	if response := request(true); response.Code != http.StatusForbidden || called {
		t.Fatalf("removed status=%d called=%v", response.Code, called)
	}
}

func TestAuthenticateSession_RejectsMissingAndInvalidTokens(t *testing.T) {
	router, _, _ := authTestRouter(t)

	if w := doRequest(router, "GET", "/api/v1/projects", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects without token = %d, want 401", w.Code)
	}
	w := doRequest(router, "GET", "/api/v1/projects", map[string]string{"Authorization": "Bearer not-a-jwt"})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects with garbage token = %d, want 401", w.Code)
	}

	// A token signed with the wrong secret is rejected.
	forged, err := auth.SignAccessToken([]byte("some-other-secret"), "user-1", "org-1", "a@b.c")
	if err != nil {
		t.Fatalf("sign forged token: %v", err)
	}
	w = doRequest(router, "GET", "/api/v1/projects", map[string]string{"Authorization": "Bearer " + forged})
	if w.Code != http.StatusUnauthorized {
		t.Errorf("GET /projects with wrong-secret token = %d, want 401", w.Code)
	}
}

func TestAuthenticateSession_ValidTokenAndOrgScope(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgA, projectA, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "user-a", orgA, "a@example.com")
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	authz := map[string]string{"Authorization": "Bearer " + token}

	// Own-org project is accessible.
	if w := doRequest(router, "GET", "/api/v1/projects/"+projectA+"/event-count", authz); w.Code != http.StatusOK {
		t.Errorf("own-org event-count = %d, want 200: %s", w.Code, w.Body.String())
	}

	// Another org's project is forbidden even with a valid session.
	if w := doRequest(router, "GET", "/api/v1/projects/"+projectB+"/event-count", authz); w.Code != http.StatusForbidden {
		t.Errorf("cross-org event-count = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestUpdateProjectEndpoint_FrictionAutonomy(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgID, projectID, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	token, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), "autonomy-user", orgID, "autonomy@example.com",
	)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	patch := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(
			http.MethodPatch, "/api/v1/projects/"+projectID, strings.NewReader(body),
		)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	if response := patch(`{"friction_autonomy":"yolo"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid autonomy status = %d, want 400: %s", response.Code, response.Body.String())
	}
	if response := patch(`{"pr_posture":"publish_everything"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid PR posture status = %d, want 400: %s", response.Code, response.Body.String())
	}

	response := patch(`{"friction_autonomy":"auto_fix","pr_posture":"draft_when_unverified"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("valid autonomy status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var project struct {
		GithubRepo           *string `json:"github_repo"`
		FrictionAutonomy     string  `json:"friction_autonomy"`
		PrPosture            string  `json:"pr_posture"`
		DefaultEnvironmentID *string `json:"default_environment_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&project); err != nil {
		t.Fatalf("decode project response: %v", err)
	}
	if project.FrictionAutonomy != "auto_fix" {
		t.Fatalf("friction_autonomy = %q, want auto_fix", project.FrictionAutonomy)
	}
	if project.PrPosture != "draft_when_unverified" {
		t.Fatalf("pr_posture = %q, want draft_when_unverified", project.PrPosture)
	}

	response = patch(`{"github_repo":"org/other"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("github-only PATCH status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if err := json.NewDecoder(response.Body).Decode(&project); err != nil {
		t.Fatalf("decode github-only response: %v", err)
	}
	if project.FrictionAutonomy != "auto_fix" {
		t.Fatalf("github-only PATCH reset autonomy to %q", project.FrictionAutonomy)
	}
	if project.PrPosture != "draft_when_unverified" {
		t.Fatalf("github-only PATCH reset PR posture to %q", project.PrPosture)
	}
	if project.GithubRepo == nil || *project.GithubRepo != "org/other" {
		t.Fatalf("github_repo = %v, want org/other", project.GithubRepo)
	}

	staging, err := q.CreateEnvironment(context.Background(), projectID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	response = patch(`{"default_environment_id":"` + staging.ID + `"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("default environment PATCH status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if err := json.NewDecoder(response.Body).Decode(&project); err != nil {
		t.Fatalf("decode default environment response: %v", err)
	}
	if project.DefaultEnvironmentID == nil || *project.DefaultEnvironmentID != staging.ID {
		t.Fatalf("default_environment_id = %v, want %s", project.DefaultEnvironmentID, staging.ID)
	}
	for _, body := range []string{
		`{"default_environment_id":null}`,
		`{"default_environment_id":42}`,
		`{"default_environment_id":"not-a-uuid"}`,
	} {
		if response := patch(body); response.Code != http.StatusBadRequest {
			t.Errorf("PATCH %s = %d, want 400: %s", body, response.Code, response.Body.String())
		}
	}
	if response := patch(`{"default_environment_id":"` + uuid.NewString() + `"}`); response.Code != http.StatusNotFound {
		t.Errorf("unknown default = %d, want 404: %s", response.Code, response.Body.String())
	}
	sibling, err := q.CreateProject(context.Background(), orgID, "default-sibling", nil)
	if err != nil || sibling.DefaultEnvironmentID == nil {
		t.Fatalf("sibling = %#v, err=%v", sibling, err)
	}
	if response := patch(`{"default_environment_id":"` + *sibling.DefaultEnvironmentID + `"}`); response.Code != http.StatusNotFound {
		t.Errorf("cross-project default = %d, want 404: %s", response.Code, response.Body.String())
	}
}

func TestGetFixStatsEndpoint_AuthenticatedShape(t *testing.T) {
	router, q, pool := authTestRouter(t)
	orgID, projectID, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	path := "/api/v1/projects/" + projectID + "/fix-stats"

	if response := doRequest(router, http.MethodGet, path, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", response.Code)
	}

	token, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), "stats-user", orgID, "stats@example.com",
	)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	response := doRequest(router, http.MethodGet, path,
		map[string]string{"Authorization": "Bearer " + token})
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated status = %d, want 200: %s", response.Code, response.Body.String())
	}

	var payload map[string]map[string]int
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode fix stats: %v", err)
	}
	for _, kind := range []string{"error", "friction"} {
		stat, ok := payload[kind]
		if !ok {
			t.Fatalf("response missing %q stats: %#v", kind, payload)
		}
		for _, field := range []string{
			"generated_auto", "generated_human",
			"prs_merged", "prs_closed", "prs_merged_auto", "prs_closed_auto",
		} {
			if _, ok := stat[field]; !ok {
				t.Fatalf("%s stats missing %q: %#v", kind, field, stat)
			}
		}
	}
}

func TestHandleWebhook_StatusMapping(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "handler-test-secret")
	router, q, pool := authTestRouter(t)
	orgID, projectID, _, _ := seedTenant(t, q)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	ctx := context.Background()

	var groupID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, kind, status, pr_number, pr_url)
		 VALUES ($1, 'fp-webhook-mapping', 'fp-webhook-mapping', now(), now(), 'error', 'pr_created', 77, 'https://github.com/owner/repo/pull/77')
		 RETURNING id`,
		projectID,
	).Scan(&groupID); err != nil {
		t.Fatalf("insert pr_created group: %v", err)
	}

	post := func(payload []byte, deliveryID string) map[string]string {
		t.Helper()
		mac := hmac.New(sha256.New, []byte("handler-test-secret"))
		mac.Write(payload)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(payload))
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		req.Header.Set("X-GitHub-Event", "pull_request")
		req.Header.Set("X-GitHub-Delivery", deliveryID)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("webhook status = %d, want 200: %s", w.Code, w.Body.String())
		}
		var body map[string]string
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode webhook response: %v", err)
		}
		return body
	}

	merged := []byte(`{"action":"closed","pull_request":{"number":77,"merged":true},"repository":{"full_name":"owner/repo"}}`)
	if body := post(merged, "mapping-d1"); body["status"] != "processed" || body["action"] != "merged" || body["group_id"] != groupID {
		t.Fatalf("first delivery = %v, want processed/merged/%s", body, groupID)
	}
	if body := post(merged, "mapping-d1"); body["status"] != "duplicate" || body["group_id"] != groupID {
		t.Fatalf("redelivery = %v, want duplicate", body)
	}
	noMatch := []byte(`{"action":"closed","pull_request":{"number":9999,"merged":false},"repository":{"full_name":"owner/repo"}}`)
	if body := post(noMatch, "mapping-d2"); body["status"] != "no_match" || body["action"] != "closed" {
		t.Fatalf("unknown PR = %v, want no_match/closed", body)
	}
}

// cleanupTenantHandler mirrors db_test.cleanupTenant for handler tests.
func cleanupTenantHandler(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM outbound_deliveries WHERE destination_id IN (SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM memberships WHERE org_id = $1 OR user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, q, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}
