package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func postJSONRequest(router http.Handler, method, target, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

func TestCreateProjectEndpointReturnsCompositeProvisioningBundle(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	org, err := deps.Queries.CreateOrg(ctx, "handler-project-provision")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	deps.JWTSecret = sessionReadSecret
	router := handler.NewRouterWithPool(deps, pool)
	token := dashboardToken(t, org.ID)

	response := postJSONRequest(router, http.MethodPost, "/api/v1/projects", token,
		`{"name":"Checkout","github_repo":"acme/checkout","idempotency_token":"handler-attempt-1"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create project = %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
		Environment struct {
			ID        string `json:"id"`
			ProjectID string `json:"project_id"`
			Name      string `json:"name"`
		} `json:"environment"`
		APIKey struct {
			ID     string `json:"id"`
			RawKey string `json:"raw_key"`
		} `json:"api_key"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Project.ID == "" || body.Environment.ProjectID != body.Project.ID ||
		body.Environment.Name != "production" || body.APIKey.ID == "" ||
		body.APIKey.RawKey == "" {
		t.Fatalf("incomplete provisioning response: %+v", body)
	}
	if lookup, err := deps.Queries.LookupProjectKey(ctx, body.APIKey.RawKey); err != nil || lookup.ProjectID != body.Project.ID {
		t.Fatalf("returned raw key lookup = (%+v, %v)", lookup, err)
	}
}

func TestRequireRoleIfCloudAndProvisioningRoutes(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "role-if-cloud")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "existing", nil)
	if err != nil {
		t.Fatal(err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID,
		fmt.Sprintf("role-if-cloud-%d@example.test", time.Now().UnixNano()),
		"Role User", time.Now().UnixNano(), "role-if-cloud", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	cloudDeps := &handler.Dependencies{
		Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{},
	}
	cloudRouter := handler.NewRouter(cloudDeps)

	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/onboarding/setup"},
		{http.MethodPost, "/api/v1/projects"},
		{http.MethodPatch, "/api/v1/projects/" + project.ID},
	} {
		response := postJSONRequest(cloudRouter, route.method, route.path, token, `{}`)
		if response.Code != http.StatusForbidden {
			t.Errorf("cloud member %s %s = %d, want 403: %s",
				route.method, route.path, response.Code, response.Body.String())
		}
	}
	removedEnvironmentRoute := postJSONRequest(cloudRouter, http.MethodPost,
		"/api/v1/projects/"+project.ID+"/environments", token, `{}`)
	if removedEnvironmentRoute.Code != http.StatusNotFound {
		t.Fatalf("removed environment route = %d, want 404", removedEnvironmentRoute.Code)
	}
	removedKeyRoute := postJSONRequest(cloudRouter, http.MethodPost,
		"/api/v1/environments/"+environment.ID+"/api-keys", token, `{}`)
	if removedKeyRoute.Code != http.StatusNotFound {
		t.Fatalf("removed key-management route = %d, want 404", removedKeyRoute.Code)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	protected := cloudDeps.AuthenticateUserSession(cloudDeps.RequireRoleIfCloud("admin")(next))
	request := httptest.NewRequest(http.MethodPost, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	memberResponse := httptest.NewRecorder()
	protected.ServeHTTP(memberResponse, request)
	if memberResponse.Code != http.StatusForbidden {
		t.Fatalf("cloud member middleware = %d, want 403", memberResponse.Code)
	}
	if err := q.SetMembershipRole(ctx, user.ID, org.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	adminResponse := httptest.NewRecorder()
	protected.ServeHTTP(adminResponse, request.Clone(context.Background()))
	if adminResponse.Code != http.StatusNoContent {
		t.Fatalf("cloud admin middleware = %d, want 204: %s", adminResponse.Code, adminResponse.Body.String())
	}

	ossDeps := &handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret)}
	ossProtected := ossDeps.AuthenticateUserSession(ossDeps.RequireRoleIfCloud("admin")(next))
	ossResponse := httptest.NewRecorder()
	ossProtected.ServeHTTP(ossResponse, request.Clone(context.Background()))
	if ossResponse.Code != http.StatusNoContent {
		t.Fatalf("OSS middleware = %d, want 204: %s", ossResponse.Code, ossResponse.Body.String())
	}
}
