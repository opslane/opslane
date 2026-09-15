package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func seedTenantNoProject(t *testing.T, q *db.Queries) (string, string) {
	t.Helper()
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "onboarding-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID,
		fmt.Sprintf("onboarding-%s@example.com", uuid.NewString()),
		"Onboarding Admin", time.Now().UnixNano(), "onboarding-admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, org.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	return org.ID, token
}

func onboardingHTTP(t *testing.T, router http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-For", token)
	request.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: token})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func mustDecodeOnboarding(t *testing.T, body io.Reader, out any) {
	t.Helper()
	if err := json.NewDecoder(body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

type onboardingCreatedProject struct {
	Project struct {
		ID string `json:"id"`
	} `json:"project"`
	APIKey struct {
		RawKey string `json:"raw_key"`
	} `json:"api_key"`
}

// createProjectForOnboarding creates a project the way Settings does. The
// endpoint requires an idempotency token, so every body must carry one.
func createProjectForOnboarding(t *testing.T, router http.Handler, token, body string) onboardingCreatedProject {
	t.Helper()
	response := onboardingHTTP(t, router, http.MethodPost, "/api/v1/projects", token, body)
	if response.Code != http.StatusCreated {
		t.Fatalf("create project: got %d body=%s", response.Code, response.Body.String())
	}
	var created onboardingCreatedProject
	mustDecodeOnboarding(t, response.Body, &created)
	return created
}

func ingestOnboardingEvent(t *testing.T, router http.Handler, rawKey string) {
	t.Helper()
	body := `{
		"timestamp":"2026-08-26T00:00:00Z",
		"error":{"type":"Error","message":"onboarding event","stack":"at onboarding.js:1:1"},
		"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-API-Key", rawKey)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("event: got %d body=%s", response.Code, response.Body.String())
	}
}

func TestOnboardingState_GitHubConnectedRequiresRepoCoverage(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	deps.GitHubAppSlug = "opslane-test"
	router := handler.NewRouterWithPool(deps, pool)
	orgID, cred := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	createProjectForOnboarding(t, router, cred,
		`{"name":"web","github_repo":"acme/web","idempotency_token":"coverage-test"}`)

	installationID := time.Now().UnixNano()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["acme/other"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM github_app_installations WHERE installation_id = $1`, installationID)
	})
	if err := deps.Queries.SetOrgGitHubInstallation(context.Background(), orgID, installationID); err != nil {
		t.Fatal(err)
	}

	stateResponse := onboardingHTTP(t, router, http.MethodGet, "/api/v1/onboarding/state", cred, "")
	var state onboardingStateResponse
	mustDecodeOnboarding(t, stateResponse.Body, &state)
	if stateResponse.Code != http.StatusOK || state.GitHubConnected {
		t.Fatalf("uncovered repo state: got %d %+v", stateResponse.Code, state)
	}

	if _, err := deps.Queries.AddGitHubInstallationRepos(context.Background(), installationID, []string{"acme/web"}); err != nil {
		t.Fatal(err)
	}
	stateResponse = onboardingHTTP(t, router, http.MethodGet, "/api/v1/onboarding/state", cred, "")
	mustDecodeOnboarding(t, stateResponse.Body, &state)
	if stateResponse.Code != http.StatusOK || !state.GitHubConnected {
		t.Fatalf("covered repo state: got %d %+v", stateResponse.Code, state)
	}
}
