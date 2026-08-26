package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestEventCountLatestGroup(t *testing.T) {
	deps, pool := testDeps(t)
	ctx := context.Background()
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID,
		fmt.Sprintf("event-count-%s@example.com", uuid.NewString()),
		"Event Count User", time.Now().UnixNano(), "event-count-user", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	deps.JWTSecret = []byte(authTestJWTSecret)
	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, orgID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	router := handler.NewRouterWithPool(deps, pool)
	readStatus := func() *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/projects/"+projectID+"/event-count", nil)
		request.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: token})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	fresh := readStatus()
	if fresh.Code != http.StatusOK || fresh.Body.String() != "{\"has_events\":false,\"latest_error_group_id\":null}\n" {
		t.Fatalf("fresh status=%d body=%s", fresh.Code, fresh.Body.String())
	}

	event := `{
		"timestamp":"2026-08-26T00:00:00Z",
		"error":{"type":"Error","message":"event count test","stack":"at event-count.js:1:1"},
		"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"
	}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(event))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-API-Key", rawKey)
	created := httptest.NewRecorder()
	router.ServeHTTP(created, request)
	if created.Code != http.StatusAccepted {
		t.Fatalf("ingest status=%d body=%s", created.Code, created.Body.String())
	}
	var eventID string
	if err := pool.QueryRow(ctx,
		`SELECT id::text FROM error_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
		projectID,
	).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	var groupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups
		  (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
		VALUES ($1, $2, 'event count test', now(), now(), 1, $3, 'javascript')
		RETURNING id::text`, projectID, "event-count-"+uuid.NewString(), eventID,
	).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE error_events SET error_group_id = $1 WHERE id = $2`, groupID, eventID,
	); err != nil {
		t.Fatal(err)
	}

	populated := readStatus()
	if populated.Code != http.StatusOK {
		t.Fatalf("populated status=%d body=%s", populated.Code, populated.Body.String())
	}
	var status struct {
		HasEvents          bool    `json:"has_events"`
		LatestErrorGroupID *string `json:"latest_error_group_id"`
	}
	if err := json.NewDecoder(populated.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if !status.HasEvents || status.LatestErrorGroupID == nil || *status.LatestErrorGroupID != groupID {
		t.Fatalf("event status=%+v group=%s", status, groupID)
	}
}
