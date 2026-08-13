package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestIncidentStatusInternal_TokenGuard(t *testing.T) {
	path := "/internal/v1/projects/p/incidents/i/status"

	t.Setenv("INTERNAL_READ_TOKEN", "")
	disabled := handler.NewRouter(&handler.Dependencies{})
	response := httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unset token returned %d", response.Code)
	}

	t.Setenv("INTERNAL_READ_TOKEN", "expected-token")
	guarded := handler.NewRouter(&handler.Dependencies{})
	for _, token := range []string{"", "wrong-token"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Internal-Token", token)
		response = httptest.NewRecorder()
		guarded.ServeHTTP(response, req)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("token %q returned %d", token, response.Code)
		}
	}
}

func TestIncidentStatusInternal_ReturnsStatusOnly(t *testing.T) {
	deps, _ := testDeps(t)
	ctx := context.Background()
	_, projectID, envID, _ := seedTenant(t, deps.Queries)

	result, err := deps.Queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projectID,
		DefaultEnvironmentID: envID,
		ErrorType:            "DeploySmokeError",
		ErrorMessage:         "internal-status-smoke",
		StackTraceRaw:        "at deploy.sh:1:1",
		Fingerprint:          "fp-internal-status",
		Title:                "DeploySmokeError: internal-status-smoke",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	group, err := deps.Queries.GetErrorGroup(ctx, projectID, result.GroupID)
	if err != nil || group == nil {
		t.Fatalf("GetErrorGroup: group=%v err=%v", group, err)
	}

	t.Setenv("INTERNAL_READ_TOKEN", "test-internal-token")
	router := handler.NewRouter(deps)
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Internal-Token", "test-internal-token")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	response := request(fmt.Sprintf(
		"/internal/v1/projects/%s/incidents/%s/status", projectID, result.GroupID))
	if response.Code != http.StatusOK {
		t.Fatalf("status read returned %d: %s", response.Code, response.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["status"] != group.Status {
		t.Fatalf("status = %q, want %q", body["status"], group.Status)
	}
	if len(body) != 1 {
		t.Fatalf("response has extra fields beyond status: %v", body)
	}

	// A valid but foreign project UUID must not resolve the incident.
	response = request(fmt.Sprintf(
		"/internal/v1/projects/00000000-0000-0000-0000-000000000000/incidents/%s/status",
		result.GroupID))
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-project read returned %d", response.Code)
	}

	// Malformed ids miss cleanly instead of failing the uuid cast in Postgres.
	response = request(fmt.Sprintf(
		"/internal/v1/projects/%s/incidents/not-a-uuid/status", projectID))
	if response.Code != http.StatusNotFound {
		t.Fatalf("malformed incident id returned %d", response.Code)
	}
}
