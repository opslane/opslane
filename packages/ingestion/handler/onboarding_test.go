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

func TestOnboardingSetupIdempotency(t *testing.T) {
	deps, pool := testDeps(t)
	deps.JWTSecret = []byte(authTestJWTSecret)
	deps.AuthProvider = cloudAuthStub{}
	router := handler.NewRouterWithPool(deps, pool)
	orgID, cred := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	body := `{"project_name":"web","idempotency_token":"tok-1"}`
	first := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred, body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first create: got %d body=%s", first.Code, first.Body.String())
	}
	second := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred, body)
	if second.Code != http.StatusCreated {
		t.Fatalf("replay: got %d body=%s", second.Code, second.Body.String())
	}
	var a, b struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
		APIKey struct {
			RawKey string `json:"raw_key"`
		} `json:"api_key"`
	}
	mustDecodeOnboarding(t, first.Body, &a)
	mustDecodeOnboarding(t, second.Body, &b)
	if a.Project.ID != b.Project.ID {
		t.Fatal("replay created a second project")
	}
	if a.APIKey.RawKey == b.APIKey.RawKey || a.APIKey.RawKey == "" {
		t.Fatal("expected two distinct working keys")
	}

	third := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred,
		`{"project_name":"other","idempotency_token":"tok-2"}`)
	if third.Code != http.StatusCreated {
		t.Fatalf("different-token call: got %d body=%s", third.Code, third.Body.String())
	}
	var c struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	mustDecodeOnboarding(t, third.Body, &c)
	if c.Project.ID != a.Project.ID {
		t.Fatal("has-project rule violated: new project created")
	}

	orgID2, cred2 := seedTenantNoProject(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID2) })
	legacy := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred2,
		`{"project_name":"legacy","github_repo":"acme/web"}`)
	if legacy.Code != http.StatusCreated {
		t.Fatalf("legacy shape: got %d body=%s", legacy.Code, legacy.Body.String())
	}

	if _, err := pool.Exec(context.Background(), `UPDATE orgs SET onboarded_at = now() WHERE id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	fourth := onboardingHTTP(t, router, http.MethodPost, "/api/v1/onboarding/setup", cred, body)
	if fourth.Code != http.StatusConflict {
		t.Fatalf("onboarded org: got %d, want 409", fourth.Code)
	}
}
