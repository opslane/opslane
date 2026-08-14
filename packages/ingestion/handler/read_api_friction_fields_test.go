package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// error_groups.id defaults to gen_random_uuid(), so let the database mint it and
// read it back. Nothing here needs a uuid helper.
func insertGroup(t *testing.T, pool *pgxpool.Pool, projectID, kind, fingerprint, title string,
	signal, selector, page *string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO error_groups (project_id, fingerprint, title, kind, status,
		   first_seen, last_seen, occurrence_count, affected_users_count,
		   signal_type, element_selector, page_url_normalized)
		 VALUES ($1,$2,$3,$4,'insight',now(),now(),75,39,$5,$6,$7)
		 RETURNING id`,
		projectID, fingerprint, title, kind, signal, selector, page,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert %s group: %v", kind, err)
	}
	return id
}

func TestGetIncidentExposesFrictionIdentityFields(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	signal, selector, page := "dead_click", "div.field-container", "/assets/:id/edit"
	groupID := insertGroup(t, pool, projectID, "friction", "friction-fields-1", "Dead clicks",
		ptrStr(signal), ptrStr(selector), ptrStr(page))

	router := handler.NewRouterWithPool(deps, pool)
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
	request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		SignalType        *string `json:"signal_type"`
		ElementSelector   *string `json:"element_selector"`
		PageURLNormalized *string `json:"page_url_normalized"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.SignalType == nil || *body.SignalType != signal {
		t.Errorf("signal_type = %v, want %q", body.SignalType, signal)
	}
	if body.ElementSelector == nil || *body.ElementSelector != selector {
		t.Errorf("element_selector = %v, want %q", body.ElementSelector, selector)
	}
	if body.PageURLNormalized == nil || *body.PageURLNormalized != page {
		t.Errorf("page_url_normalized = %v, want %q", body.PageURLNormalized, page)
	}
}

func TestErrorIncidentOmitsFrictionIdentityFields(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	groupID := insertGroup(t, pool, projectID, "error", "error-fields-1",
		"TypeError: boom", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
	request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(response.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"signal_type", "element_selector", "page_url_normalized"} {
		if _, present := raw[key]; present {
			t.Errorf("%s present on an error incident; want omitted", key)
		}
	}
}

func TestListIncidentsFiltersByKind(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	frictionID := insertGroup(t, pool, projectID, "friction", "kind-friction-1", "t",
		ptrStr("dead_click"), ptrStr("div.x"), ptrStr("/x"))
	errorID := insertGroup(t, pool, projectID, "error", "kind-error-1", "t", nil, nil, nil)

	router := handler.NewRouterWithPool(deps, pool)
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents?kind=friction", nil)
	request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, frictionID) {
		t.Errorf("friction incident missing from kind=friction list: %s", body)
	}
	if strings.Contains(body, errorID) {
		t.Errorf("error incident present in kind=friction list: %s", body)
	}
}

func TestListIncidentsRejectsUnknownKind(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	router := handler.NewRouterWithPool(deps, pool)
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents?kind=banana", nil)
	request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", response.Code, response.Body.String())
	}
}
