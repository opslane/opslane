package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestSnoozeIncidentContractAndAuthorization(t *testing.T) {
	router, queries, pool := authTestRouter(t)
	ctx := context.Background()
	orgID, projectID, _, _ := seedTenant(t, queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	sibling, err := queries.CreateProject(ctx, orgID, "snooze-sibling", nil)
	if err != nil {
		t.Fatal(err)
	}

	seedGroup := func(status string) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,fingerprint,title,kind,status,first_seen,last_seen)
			VALUES ($1,$2,'snooze candidate','friction',$3,now(),now()) RETURNING id::text`,
			projectID, "snooze-"+uuid.NewString(), status).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	actionableID := seedGroup("awaiting_approval")
	nonActionableID := seedGroup("insight")
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), uuid.NewString(), orgID, "snooze@example.com")
	if err != nil {
		t.Fatal(err)
	}

	post := func(target http.Handler, targetProject, targetIncident, body, bearer string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost,
			"/api/v1/projects/"+targetProject+"/incidents/"+targetIncident+"/snooze",
			strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			request.Header.Set("Authorization", "Bearer "+bearer)
		}
		response := httptest.NewRecorder()
		target.ServeHTTP(response, request)
		return response
	}

	if response := post(router, projectID, actionableID, `{"until":null}`, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", response.Code, response.Body.String())
	}
	cloudDeps := &handler.Dependencies{Queries: queries, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}}
	cloudRouter := handler.NewRouterWithPool(cloudDeps, pool)
	if response := post(cloudRouter, projectID, actionableID, `{"until":null}`, token); response.Code != http.StatusForbidden {
		t.Fatalf("non-member status=%d body=%s", response.Code, response.Body.String())
	}
	if response := post(router, sibling.ID, actionableID, `{"until":null}`, token); response.Code != http.StatusNotFound {
		t.Fatalf("wrong-project status=%d body=%s", response.Code, response.Body.String())
	}
	if response := post(router, projectID, nonActionableID, `{"until":null}`, token); response.Code != http.StatusConflict {
		t.Fatalf("non-actionable status=%d body=%s", response.Code, response.Body.String())
	}
	if response := post(router, projectID, actionableID, `{}`, token); response.Code != http.StatusBadRequest {
		t.Fatalf("omitted-until status=%d body=%s", response.Code, response.Body.String())
	}
	tooFar := time.Now().UTC().Add(31 * 24 * time.Hour).Format(time.RFC3339)
	if response := post(router, projectID, actionableID, `{"until":"`+tooFar+`"}`, token); response.Code != http.StatusBadRequest {
		t.Fatalf("over-30-day status=%d body=%s", response.Code, response.Body.String())
	}

	wanted := time.Now().UTC().Add(7 * 24 * time.Hour).Truncate(time.Second)
	if response := post(router, projectID, actionableID, `{"until":"`+wanted.Format(time.RFC3339)+`"}`, token); response.Code != http.StatusNoContent {
		t.Fatalf("snooze status=%d body=%s", response.Code, response.Body.String())
	}
	var stored *time.Time
	if err := pool.QueryRow(ctx, `SELECT snoozed_until FROM error_groups WHERE id=$1`, actionableID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil || !stored.Equal(wanted) {
		t.Fatalf("stored snooze=%v want=%s", stored, wanted)
	}

	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	if response := post(router, projectID, actionableID, `{"until":"`+past+`"}`, token); response.Code != http.StatusNoContent {
		t.Fatalf("past unsnooze status=%d body=%s", response.Code, response.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT snoozed_until FROM error_groups WHERE id=$1`, actionableID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != nil {
		t.Fatalf("past until did not clear snooze: %v", stored)
	}

	if response := post(router, projectID, actionableID, `{"until":"`+wanted.Format(time.RFC3339)+`"}`, token); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	if response := post(router, projectID, actionableID, `{"until":null}`, token); response.Code != http.StatusNoContent {
		t.Fatalf("null unsnooze status=%d body=%s", response.Code, response.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT snoozed_until FROM error_groups WHERE id=$1`, actionableID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != nil {
		t.Fatalf("null until did not clear snooze: %v", stored)
	}
}
