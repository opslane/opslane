package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/debugid"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestAPIKeyCreateListRevokeScoped(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgA, projectA, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgA) })
	orgB, projectB, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgB) })

	user, err := deps.Queries.CreateUserGitHub(ctx, orgA,
		"api-key-admin-"+time.Now().Format("150405.000000000")+"@example.test",
		"API Key Admin", time.Now().UnixNano(), "api-key-admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgA, "admin"); err != nil {
		t.Fatal(err)
	}
	deps.JWTSecret = sessionReadSecret
	token, err := auth.SignAccessToken(sessionReadSecret, user.ID, orgA, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	ingest, err := deps.Queries.CreateProjectKey(ctx, projectA, db.ScopeIngest, "browser", &user.ID, "")
	if err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	expires := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	created := request(http.MethodPost, "/api/v1/projects/"+projectA+"/api-keys",
		`{"label":"Claude Code","expires_at":"`+expires.Format(time.RFC3339)+`"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var createBody struct {
		KeyID     string     `json:"key_id"`
		Token     string     `json:"token"`
		Label     string     `json:"label"`
		Scope     string     `json:"scope"`
		ExpiresAt *time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(created.Body).Decode(&createBody); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(createBody.Token, "opslane_ak_") || createBody.Scope != db.ScopeAPI ||
		createBody.Label != "Claude Code" || createBody.ExpiresAt == nil {
		t.Fatalf("created api key = %+v", createBody)
	}

	listed := request(http.MethodGet, "/api/v1/projects/"+projectA+"/api-keys", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listed.Code, listed.Body.String())
	}
	var listBody []struct {
		KeyID    string `json:"key_id"`
		Scope    string `json:"scope"`
		Redacted string `json:"redacted"`
		Status   string `json:"status"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	var listedCreated, listedIngest bool
	for _, key := range listBody {
		if key.KeyID == createBody.KeyID && key.Scope == db.ScopeAPI && key.Status == "active" &&
			key.Redacted == "opslane_ak_"+createBody.KeyID+"_…" {
			listedCreated = true
		}
		if key.KeyID == ingest.KeyID && key.Scope == db.ScopeIngest &&
			key.Redacted == "opslane_pk_"+ingest.KeyID+"_…" {
			listedIngest = true
		}
	}
	if !listedCreated || !listedIngest {
		t.Fatalf("listed api keys = %+v", listBody)
	}
	if strings.Contains(listed.Body.String(), createBody.Token) || strings.Contains(listed.Body.String(), ingest.Raw) {
		t.Fatalf("list leaked plaintext: %s", listed.Body.String())
	}

	foreign := request(http.MethodPost, "/api/v1/projects/"+projectB+"/api-keys", `{"label":"foreign"}`)
	if foreign.Code != http.StatusForbidden {
		t.Fatalf("cross-org create status = %d, body = %s", foreign.Code, foreign.Body.String())
	}

	revoked := request(http.MethodDelete,
		"/api/v1/projects/"+projectA+"/api-keys/"+createBody.KeyID, "")
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body = %s", revoked.Code, revoked.Body.String())
	}
	var revokedAt *time.Time
	var revokedBy *string
	if err := pool.QueryRow(ctx, `
		SELECT revoked_at, revoked_by_user_id FROM project_api_keys
		WHERE key_id = $1`, createBody.KeyID).Scan(&revokedAt, &revokedBy); err != nil {
		t.Fatal(err)
	}
	if revokedAt == nil || revokedBy == nil || *revokedBy != user.ID {
		t.Fatalf("revocation = at:%v by:%v", revokedAt, revokedBy)
	}
	if _, err := deps.Queries.LookupProjectKey(ctx, ingest.Raw); err != nil {
		t.Fatalf("revoke touched ingest sibling: %v", err)
	}
	if again := request(http.MethodDelete,
		"/api/v1/projects/"+projectA+"/api-keys/"+createBody.KeyID, ""); again.Code != http.StatusNoContent {
		t.Fatalf("idempotent revoke status = %d", again.Code)
	}
	if missing := request(http.MethodDelete,
		"/api/v1/projects/"+projectA+"/api-keys/aaaaaaaaaaaaaaaaaaaaaaaaaa", ""); missing.Code != http.StatusNotFound {
		t.Fatalf("missing revoke status = %d", missing.Code)
	}
}

func TestIngestScopeKeyLifecycleAndCap(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID,
		"ingest-key-admin-"+time.Now().Format("150405.000000000")+"@example.test",
		"Ingest Key Admin", time.Now().UnixNano(), "ingest-key-admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	deps.JWTSecret = sessionReadSecret
	token, err := auth.SignAccessToken(sessionReadSecret, user.ID, orgID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	router := handler.NewRouterWithPool(deps, pool)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	var lastKeyID string
	for i := 0; i < 6; i++ {
		created := request(http.MethodPost, "/api/v1/projects/"+projectID+"/api-keys",
			`{"label":"onboarding","expires_at":null,"scope":"ingest"}`)
		if created.Code != http.StatusCreated {
			t.Fatalf("create %d: %d %s", i, created.Code, created.Body.String())
		}
		var body struct {
			KeyID string `json:"key_id"`
			Token string `json:"token"`
			Scope string `json:"scope"`
		}
		if err := json.NewDecoder(created.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Scope != db.ScopeIngest || !strings.HasPrefix(body.Token, "opslane_pk_") {
			t.Fatalf("wrong scope/prefix: %+v", body)
		}
		lastKeyID = body.KeyID
	}

	listed := request(http.MethodGet, "/api/v1/projects/"+projectID+"/api-keys", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	var keys []struct {
		KeyID  string `json:"key_id"`
		Scope  string `json:"scope"`
		Label  string `json:"label"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&keys); err != nil {
		t.Fatal(err)
	}
	live := 0
	for _, key := range keys {
		if key.Scope == db.ScopeIngest && key.Label == "onboarding" && key.Status == "active" {
			live++
		}
	}
	if live != 5 {
		t.Fatalf("cap failed: %d live ingest keys", live)
	}

	revoked := request(http.MethodDelete,
		"/api/v1/projects/"+projectID+"/api-keys/"+lastKeyID, "")
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke ingest key: %d body=%s", revoked.Code, revoked.Body.String())
	}
}

func TestCreateAPIKeyScopeValidation(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID,
		"scope-validation-"+time.Now().Format("150405.000000000")+"@example.test",
		"Scope Validation", time.Now().UnixNano(), "scope-validation", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	deps.JWTSecret = sessionReadSecret
	token, err := auth.SignAccessToken(sessionReadSecret, user.ID, orgID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	router := handler.NewRouterWithPool(deps, pool)
	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+projectID+"/api-keys", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	// Unknown scope is rejected, not defaulted.
	if res := request(`{"label":"x","expires_at":null,"scope":"bogus"}`); res.Code != http.StatusBadRequest {
		t.Fatalf("bogus scope: got %d want 400 (%s)", res.Code, res.Body.String())
	}

	// Ingest keys have no expiry support; a supplied expires_at must not be
	// silently dropped.
	if res := request(`{"label":"onboarding","expires_at":"2030-01-01T00:00:00Z","scope":"ingest"}`); res.Code != http.StatusBadRequest {
		t.Fatalf("ingest+expires_at: got %d want 400 (%s)", res.Code, res.Body.String())
	}
}

// apiKeyRouter seeds a tenant with an admin user and returns a router, the
// project id, an admin session cookie, and the raw ingest key.
func apiKeyRouter(t *testing.T) (deps *handler.Dependencies, router http.Handler, projectID string, cookie *http.Cookie) {
	t.Helper()
	deps, pool := testDeps(t)
	ctx := context.Background()
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.SourcemapStore = newMemorySourceMapStore() // the store sourcemap_upload_test.go:104 uses; needed for the upload round-trip below
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	email := fmt.Sprintf("keys-%s@example.com", uuid.NewString())
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID, email, "Keys", time.Now().UnixNano(), "keys", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	tok, err := auth.SignAccessToken(deps.JWTSecret, user.ID, orgID, email)
	if err != nil {
		t.Fatal(err)
	}
	return deps, handler.NewRouterWithPool(deps, pool), projectID, &http.Cookie{Name: handler.AccessCookieName, Value: tok}
}

func TestAPIKeySourcemapsScopeMintsListsRevokes(t *testing.T) {
	deps, router, projectID, cookie := apiKeyRouter(t)
	deps.AuthCallbackOrigin = "https://app.example.test"

	create := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+projectID+"/api-keys", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	rec := create(`{"label":"ci","scope":"sourcemaps"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		KeyID string `json:"key_id"`
		Token string `json:"token"`
		Scope string `json:"scope"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	if !strings.HasPrefix(created.Token, "opslane_sk_") || created.Scope != "sourcemaps" {
		t.Fatalf("token %q scope %q", created.Token, created.Scope)
	}
	if rec := create(`{"label":"ci","scope":"sourcemaps","expires_at":"2030-01-01T00:00:00Z"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("expires_at on sourcemaps must be refused: %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/api-keys", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"scope":"sourcemaps"`) || !strings.Contains(rec.Body.String(), `"redacted":"opslane_sk_`+created.KeyID) {
		t.Fatalf("listing: %s", rec.Body.String())
	}

	// The minted key must work before revocation, or the 401 below proves nothing.
	mapBody := []byte(`{"version":3,"file":"a.js","sources":["a.ts"],"names":[],"mappings":"AAAA"}`)
	computed, err := debugid.Compute(mapBody)
	if err != nil {
		t.Fatal(err)
	}
	debugID := computed.DebugID // the helper sourcemap_upload_test.go:104 uses to derive the id from the bytes
	upload := func() *httptest.ResponseRecorder {
		up := httptest.NewRequest(http.MethodPut, "/api/v1/sourcemaps/"+debugID, bytes.NewReader(mapBody))
		up.Header.Set("Content-Type", "application/json")
		up.Header.Set("X-API-Key", created.Token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, up)
		return rec
	}
	if rec := upload(); rec.Code != http.StatusCreated {
		t.Fatalf("upload with the fresh sourcemaps key: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/v1/projects/"+projectID+"/api-keys/"+created.KeyID, nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	if rec := upload(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked sourcemaps key must be rejected on upload, got %d", rec.Code)
	}
}
