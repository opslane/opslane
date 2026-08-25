package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
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
	if len(listBody) != 1 || listBody[0].KeyID != createBody.KeyID || listBody[0].Scope != db.ScopeAPI ||
		listBody[0].Status != "active" || listBody[0].Redacted != "opslane_ak_"+createBody.KeyID+"_…" {
		t.Fatalf("listed api keys = %+v", listBody)
	}
	if strings.Contains(listed.Body.String(), createBody.Token) || strings.Contains(listed.Body.String(), ingest.KeyID) {
		t.Fatalf("list leaked plaintext or ingest sibling: %s", listed.Body.String())
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
