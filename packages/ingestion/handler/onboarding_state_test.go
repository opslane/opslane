package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

type onboardingStateResponse struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	NextStep           string  `json:"next_step"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

func TestOnboardingStateAndCompleteShareTheEventGate(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, token := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		return onboardingHTTP(t, router, method, path, token, body)
	}
	readState := func() onboardingStateResponse {
		t.Helper()
		response := request(http.MethodGet, "/api/v1/onboarding/state", "")
		if response.Code != http.StatusOK {
			t.Fatalf("state status=%d body=%s", response.Code, response.Body.String())
		}
		var state onboardingStateResponse
		if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}

	if state := readState(); state.NextStep != "create_project" || state.ProjectID != nil {
		t.Fatalf("fresh state=%+v", state)
	}
	setup := request(http.MethodPost, "/api/v1/onboarding/setup",
		`{"project_name":"web","idempotency_token":"state-test"}`)
	if setup.Code != http.StatusCreated {
		t.Fatalf("setup status=%d body=%s", setup.Code, setup.Body.String())
	}
	var provisioned struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
		APIKey struct {
			RawKey string `json:"raw_key"`
		} `json:"api_key"`
	}
	if err := json.NewDecoder(setup.Body).Decode(&provisioned); err != nil {
		t.Fatal(err)
	}
	if state := readState(); state.NextStep != "install_sdk" || state.HasEvents {
		t.Fatalf("pre-event state=%+v", state)
	}
	blocked := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if blocked.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(blocked.Body.String(), `"missing":["first_event"]`) {
		t.Fatalf("blocked complete status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	eventBody := `{
		"timestamp":"2026-08-26T00:00:00Z",
		"error":{"type":"Error","message":"onboarding event","stack":"at onboarding.js:1:1"},
		"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"
	}`
	eventRequest := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(eventBody))
	eventRequest.Header.Set("Content-Type", "application/json")
	eventRequest.Header.Set("X-API-Key", provisioned.APIKey.RawKey)
	eventResponse := httptest.NewRecorder()
	router.ServeHTTP(eventResponse, eventRequest)
	if eventResponse.Code != http.StatusAccepted {
		t.Fatalf("event status=%d body=%s", eventResponse.Code, eventResponse.Body.String())
	}
	if state := readState(); state.NextStep != "connect_github" || !state.HasEvents {
		t.Fatalf("post-event state=%+v", state)
	}

	completed := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if completed.Code != http.StatusOK || !strings.Contains(completed.Body.String(), `"onboarding_complete":true`) {
		t.Fatalf("complete status=%d body=%s", completed.Code, completed.Body.String())
	}
	state := readState()
	if !state.OnboardingComplete || state.NextStep != "done" {
		t.Fatalf("completed state=%+v", state)
	}
	me := request(http.MethodGet, "/api/v1/auth/me", "")
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"onboarding_complete":true`) {
		t.Fatalf("auth/me status=%d body=%s", me.Code, me.Body.String())
	}
	second := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if second.Code != http.StatusOK {
		t.Fatalf("second complete status=%d body=%s", second.Code, second.Body.String())
	}
}
