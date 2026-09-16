package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

type onboardingStateResponse struct {
	OnboardingComplete bool    `json:"onboarding_complete"`
	ProjectID          *string `json:"project_id"`
	HasEvents          bool    `json:"has_events"`
	GitHubConnected    bool    `json:"github_connected"`
	GitHubMode         string  `json:"github_mode"`
	SlackConnected     bool    `json:"slack_connected"`
}

func readOnboardingState(t *testing.T, router http.Handler, token string) (onboardingStateResponse, string) {
	t.Helper()
	response := onboardingHTTP(t, router, http.MethodGet, "/api/v1/onboarding/state", token, "")
	if response.Code != http.StatusOK {
		t.Fatalf("state status=%d body=%s", response.Code, response.Body.String())
	}
	raw := response.Body.String()
	var state onboardingStateResponse
	if err := json.NewDecoder(strings.NewReader(raw)).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state, raw
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

	state, raw := readOnboardingState(t, router, token)
	if state.ProjectID != nil || state.HasEvents || state.OnboardingComplete {
		t.Fatalf("fresh state=%+v", state)
	}
	if strings.Contains(raw, "next_step") {
		t.Fatalf("state must not carry next_step: %s", raw)
	}

	created := createProjectForOnboarding(t, router, token, `{"name":"web","idempotency_token":"state-test"}`)
	if state, _ := readOnboardingState(t, router, token); state.ProjectID == nil || *state.ProjectID != created.Project.ID || state.HasEvents {
		t.Fatalf("pre-event state=%+v", state)
	}
	blocked := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if blocked.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(blocked.Body.String(), `"missing":["first_event"]`) {
		t.Fatalf("blocked complete status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	ingestOnboardingEvent(t, router, created.APIKey.RawKey)
	if state, _ := readOnboardingState(t, router, token); !state.HasEvents || state.OnboardingComplete {
		t.Fatalf("post-event state=%+v", state)
	}

	completed := request(http.MethodPost, "/api/v1/onboarding/complete", `{}`)
	if completed.Code != http.StatusOK || !strings.Contains(completed.Body.String(), `"onboarding_complete":true`) {
		t.Fatalf("complete status=%d body=%s", completed.Code, completed.Body.String())
	}
	if state, _ := readOnboardingState(t, router, token); !state.OnboardingComplete || !state.HasEvents {
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
	retiredSetupPR := request(http.MethodPost, "/api/v1/projects/"+created.Project.ID+"/setup-pr", `{}`)
	if retiredSetupPR.Code != http.StatusNotFound {
		t.Fatalf("retired setup-pr route status=%d body=%s", retiredSetupPR.Code, retiredSetupPR.Body.String())
	}
	retiredSetup := request(http.MethodPost, "/api/v1/onboarding/setup", `{"project_name":"web","idempotency_token":"retired"}`)
	if retiredSetup.Code != http.StatusNotFound {
		t.Fatalf("retired onboarding setup route status=%d body=%s", retiredSetup.Code, retiredSetup.Body.String())
	}
}

// An org can be onboarded with no project (a backfilled org, or one whose
// projects were removed). The setup page waits on exactly this state instead of
// redirecting, so the response shape it reads is pinned here.
func TestOnboardingStateForAnOnboardedOrgWithNoProject(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, token := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	if _, err := pool.Exec(context.Background(),
		`UPDATE orgs SET onboarded_at = now() WHERE id = $1`, orgID); err != nil {
		t.Fatal(err)
	}

	state, raw := readOnboardingState(t, router, token)
	if !state.OnboardingComplete || state.ProjectID != nil || state.HasEvents {
		t.Fatalf("onboarded org with no project: %+v", state)
	}
	if strings.Contains(raw, "next_step") {
		t.Fatalf("state must not carry next_step: %s", raw)
	}
}

func TestOnboardingCompleteCountsAnEventOnAnOlderProject(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, token := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	older := createProjectForOnboarding(t, router, token, `{"name":"older","idempotency_token":"older-project"}`)
	newer := createProjectForOnboarding(t, router, token, `{"name":"newer","idempotency_token":"newer-project"}`)
	ingestOnboardingEvent(t, router, older.APIKey.RawKey)

	state, _ := readOnboardingState(t, router, token)
	if state.ProjectID == nil || *state.ProjectID != newer.Project.ID || !state.HasEvents {
		t.Fatalf("state must name the newest project and count the older project's event: %+v", state)
	}
	completed := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/complete", token, `{}`)
	if completed.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", completed.Code, completed.Body.String())
	}
}
