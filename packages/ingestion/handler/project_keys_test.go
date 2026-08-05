package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestProjectKeyMiddlewareStatuses(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "middleware-statuses")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	provisioning, err := q.ProvisionProject(ctx, org.ID, "mw-app", nil, "mw-token")
	if err != nil {
		t.Fatal(err)
	}
	pk, err := q.CreateProjectKey(ctx, provisioning.Project.ID, db.ScopeIngest, "pk", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	sk, err := q.CreateProjectKey(ctx, provisioning.Project.ID, db.ScopeSourcemaps, "sk", nil, "https://ingest.test")
	if err != nil {
		t.Fatal(err)
	}

	deps := &handler.Dependencies{Queries: q}
	srv := httptest.NewServer(
		deps.ProjectKey(db.ScopeIngest)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if handler.ProjectIDFromCtx(r.Context()) == "" ||
				handler.EnvironmentIDFromCtx(r.Context()) == "" {
				t.Error("handler ran without project and environment context")
			}
			w.WriteHeader(http.StatusNoContent)
		})),
	)
	t.Cleanup(srv.Close)

	cases := []struct {
		name string
		key  string
		want int
		code string
	}{
		{"valid ingest key", pk.Raw, http.StatusNoContent, ""},
		{"source-map key", sk.Raw, http.StatusForbidden, "insufficient_scope"},
		{"no credential", "", http.StatusUnauthorized, "invalid_api_key"},
		{"malformed", "not-a-key", http.StatusUnauthorized, "invalid_api_key"},
		{"legacy", "def_2f1c9a44-1b3e-4f4a-9c7a-4b2d8e6f0a11", http.StatusUnauthorized, "invalid_api_key"},
		{"unknown key id", "opslane_pk_aaaaaaaaaaaaaaaaaaaaaaaaaa_" +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", http.StatusUnauthorized, "invalid_api_key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, srv.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.key != "" {
				req.Header.Set("X-API-Key", tc.key)
			}
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.want)
			}
			if tc.code == "" {
				return
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
		})
	}
}

func TestProjectKeyDefaultEnvironmentAndNullableCompatibility(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "middleware-defaults-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })

	request := func(key string, wantEnvironmentID string) int {
		t.Helper()
		deps := &handler.Dependencies{Queries: q}
		protected := deps.ProjectKey(db.ScopeIngest)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := handler.EnvironmentIDFromCtx(r.Context()); got != wantEnvironmentID {
				t.Errorf("environment context = %s, want %s", got, wantEnvironmentID)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		req.Header.Set("X-API-Key", key)
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, req)
		return response.Code
	}

	nonProduction, err := q.CreateProject(ctx, org.ID, "non-production", nil)
	if err != nil || nonProduction.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", nonProduction, err)
	}
	staging, err := q.CreateEnvironment(ctx, nonProduction.ID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_environment_id = $2 WHERE id = $1`,
		nonProduction.ID, staging.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM environments WHERE project_id = $1 AND name = 'production'`,
		nonProduction.ID); err != nil {
		t.Fatal(err)
	}
	nonProductionKey, err := q.CreateProjectKey(ctx, nonProduction.ID, db.ScopeIngest, "key", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if status := request(nonProductionKey.Raw, staging.ID); status != http.StatusNoContent {
		t.Fatalf("non-production default status = %d, want 204", status)
	}

	nullWithProduction, err := q.CreateProject(ctx, org.ID, "nullable", nil)
	if err != nil || nullWithProduction.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", nullWithProduction, err)
	}
	productionID := *nullWithProduction.DefaultEnvironmentID
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_environment_id = NULL WHERE id = $1`,
		nullWithProduction.ID); err != nil {
		t.Fatal(err)
	}
	nullKey, err := q.CreateProjectKey(ctx, nullWithProduction.ID, db.ScopeIngest, "key", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if status := request(nullKey.Raw, productionID); status != http.StatusNoContent {
		t.Fatalf("nullable compatibility status = %d, want 204", status)
	}

	nullWithoutProduction, err := q.CreateProject(ctx, org.ID, "broken-nullable", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_environment_id = NULL WHERE id = $1`,
		nullWithoutProduction.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM environments WHERE project_id = $1 AND name = 'production'`,
		nullWithoutProduction.ID); err != nil {
		t.Fatal(err)
	}
	brokenKey, err := q.CreateProjectKey(ctx, nullWithoutProduction.ID, db.ScopeIngest, "key", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if status := request(brokenKey.Raw, ""); status != http.StatusInternalServerError {
		t.Fatalf("missing compatibility environment status = %d, want 500", status)
	}
}
