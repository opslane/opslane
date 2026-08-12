package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
)

type actionScopeProjectResponse struct {
	ID                   string   `json:"id"`
	DefaultEnvironmentID *string  `json:"default_environment_id"`
	ActionScopeEnabled   bool     `json:"action_scope_enabled"`
	ActionEnvironmentIDs []string `json:"action_environment_ids"`
}

func TestUpdateProjectEndpointActionScopeContract(t *testing.T) {
	router, queries, pool := authTestRouter(t)
	orgID, projectID, productionID, _ := seedTenant(t, queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	staging, err := queries.CreateEnvironment(context.Background(), projectID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := queries.CreateProject(context.Background(), orgID, "scope-sibling", nil)
	if err != nil || sibling.DefaultEnvironmentID == nil {
		t.Fatalf("sibling = %#v, err=%v", sibling, err)
	}

	token, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), "scope-user", orgID, "scope@example.com",
	)
	if err != nil {
		t.Fatal(err)
	}
	patch := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/"+projectID, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	decode := func(response *httptest.ResponseRecorder) actionScopeProjectResponse {
		t.Helper()
		var project actionScopeProjectResponse
		if err := json.NewDecoder(response.Body).Decode(&project); err != nil {
			t.Fatal(err)
		}
		return project
	}

	response := patch(`{"action_environment_ids":["` + staging.ID + `","` + staging.ID + `"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("enable scope = %d: %s", response.Code, response.Body.String())
	}
	project := decode(response)
	if !project.ActionScopeEnabled || len(project.ActionEnvironmentIDs) != 1 || project.ActionEnvironmentIDs[0] != staging.ID {
		t.Fatalf("enabled scope response = %#v", project)
	}

	response = patch(`{"github_repo":"owner/updated"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("omitted scope = %d: %s", response.Code, response.Body.String())
	}
	project = decode(response)
	if !project.ActionScopeEnabled || len(project.ActionEnvironmentIDs) != 1 {
		t.Fatalf("omitted field changed scope: %#v", project)
	}

	response = patch(`{"action_environment_ids":[]}`)
	project = decode(response)
	if response.Code != http.StatusOK || !project.ActionScopeEnabled || project.ActionEnvironmentIDs == nil || len(project.ActionEnvironmentIDs) != 0 {
		t.Fatalf("empty enabled scope = status %d %#v", response.Code, project)
	}

	response = patch(`{"action_environment_ids":null}`)
	project = decode(response)
	if response.Code != http.StatusOK || project.ActionScopeEnabled || project.ActionEnvironmentIDs == nil || len(project.ActionEnvironmentIDs) != 0 {
		t.Fatalf("disabled scope = status %d %#v", response.Code, project)
	}

	if response := patch(`{"action_environment_ids":["not-a-uuid"]}`); response.Code != http.StatusBadRequest {
		t.Fatalf("malformed UUID = %d: %s", response.Code, response.Body.String())
	}
	if response := patch(`{"action_environment_ids":"abc"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("non-array scope = %d: %s", response.Code, response.Body.String())
	}
	if response := patch(`{"action_environment_ids":[1]}`); response.Code != http.StatusBadRequest {
		t.Fatalf("non-string element = %d: %s", response.Code, response.Body.String())
	}
	unknownID := uuid.NewString()
	if response := patch(`{"action_environment_ids":["` + unknownID + `"]}`); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown environment = %d: %s", response.Code, response.Body.String())
	}

	response = patch(`{"default_environment_id":"` + staging.ID + `","action_environment_ids":["` + *sibling.DefaultEnvironmentID + `"]}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("cross-project environment = %d: %s", response.Code, response.Body.String())
	}
	stored, err := queries.GetProjectByOrgID(context.Background(), orgID, projectID)
	if err != nil || stored == nil || stored.DefaultEnvironmentID == nil || *stored.DefaultEnvironmentID != productionID {
		t.Fatalf("failed PATCH changed default atomically: project=%#v err=%v", stored, err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	listResponse := httptest.NewRecorder()
	router.ServeHTTP(listResponse, req)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list projects = %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var projects []actionScopeProjectResponse
	if err := json.NewDecoder(listResponse.Body).Decode(&projects); err != nil {
		t.Fatal(err)
	}
	for _, listed := range projects {
		if listed.ID == projectID && (listed.ActionScopeEnabled || listed.ActionEnvironmentIDs == nil || len(listed.ActionEnvironmentIDs) != 0) {
			t.Fatalf("list response scope = %#v", listed)
		}
	}
}
