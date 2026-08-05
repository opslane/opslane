package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestListIncidentsValidatesAndScopesEnvironmentFilter(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, productionID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	ctx := context.Background()

	staging, err := deps.Queries.CreateEnvironment(ctx, projectID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}
	sibling, err := deps.Queries.CreateProject(ctx, orgID, "sibling-project", nil)
	if err != nil {
		t.Fatalf("CreateProject sibling: %v", err)
	}
	siblingEnvironment, err := deps.Queries.CreateEnvironment(ctx, sibling.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment sibling: %v", err)
	}

	insert := func(environmentID, fingerprint string) string {
		t.Helper()
		result, err := deps.Queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            projectID,
			DefaultEnvironmentID: environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         fingerprint,
			StackTraceRaw:        "at app.js:1:1",
			Fingerprint:          fingerprint,
			Title:                fingerprint,
		})
		if err != nil {
			t.Fatalf("InsertErrorEventAndGroup: %v", err)
		}
		return result.GroupID
	}
	productionGroupID := insert(productionID, "fp-handler-production")
	insert(staging.ID, "fp-handler-staging")

	router := handler.NewRouter(deps)
	request := func(environmentID string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet,
			"/api/v1/projects/"+projectID+"/incidents?environment_id="+environmentID, nil)
		req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	if response := request("not-a-uuid"); response.Code != http.StatusBadRequest {
		t.Fatalf("bad UUID status = %d, want 400: %s", response.Code, response.Body.String())
	}
	if response := request(siblingEnvironment.ID); response.Code != http.StatusNotFound {
		t.Fatalf("cross-project environment status = %d, want 404: %s", response.Code, response.Body.String())
	}

	response := request(productionID)
	if response.Code != http.StatusOK {
		t.Fatalf("valid environment status = %d, want 200: %s", response.Code, response.Body.String())
	}
	var incidents []struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&incidents); err != nil {
		t.Fatalf("decode incidents: %v", err)
	}
	if len(incidents) != 1 || incidents[0].ID != productionGroupID {
		t.Fatalf("filtered incidents = %#v, want only %s", incidents, productionGroupID)
	}

	detailRequest := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents/"+productionGroupID, nil)
	detailRequest.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	detailResponse := httptest.NewRecorder()
	router.ServeHTTP(detailResponse, detailRequest)
	if detailResponse.Code != http.StatusOK {
		t.Fatalf("incident detail status = %d: %s", detailResponse.Code, detailResponse.Body.String())
	}
	var detail struct {
		Environments []struct {
			ID              string `json:"id"`
			Name            string `json:"name"`
			OccurrenceCount int64  `json:"occurrence_count"`
			LastSeen        string `json:"last_seen"`
		} `json:"environments"`
	}
	if err := json.NewDecoder(detailResponse.Body).Decode(&detail); err != nil {
		t.Fatalf("decode incident detail: %v", err)
	}
	if len(detail.Environments) != 1 || detail.Environments[0].ID != productionID ||
		detail.Environments[0].Name != "production" || detail.Environments[0].OccurrenceCount != 1 ||
		detail.Environments[0].LastSeen == "" {
		t.Fatalf("incident environments = %#v", detail.Environments)
	}
}
