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

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type onboardProvisionResponse struct {
	Status    string `json:"status"`
	APIKey    string `json:"api_key"`
	Endpoint  string `json:"endpoint"`
	OrgID     string `json:"org_id"`
	ProjectID string `json:"project_id"`
	Repo      string `json:"repo"`
	PollID    string `json:"poll_id"`
	PollToken string `json:"poll_token"`
}

func TestOnboardProvisionRealRouterAuthorizationAndLifecycle(t *testing.T) {
	t.Setenv("AUTH_PROVIDER", "workos")
	_, queries, pool := authTestRouter(t)
	ctx := context.Background()

	org, err := queries.CreateOrg(ctx, "onboard-router-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	admin, err := queries.CreateUserGitHub(ctx, org.ID,
		fmt.Sprintf("onboard-admin-%s@example.com", uuid.NewString()),
		"Onboard Admin", time.Now().UnixNano(), "onboard-admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := queries.CreateMembership(ctx, admin.ID, org.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	// Provisioning mints and rotates a production key, so it is admin-gated
	// like every sibling key route; a plain org member must be refused.
	member, err := queries.CreateUserGitHub(ctx, org.ID,
		fmt.Sprintf("onboard-member-%s@example.com", uuid.NewString()),
		"Onboard Member", time.Now().UnixNano()+1, "onboard-member", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := queries.CreateMembership(ctx, member.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	nonMember, err := queries.CreateUserGitHub(ctx, org.ID,
		fmt.Sprintf("onboard-outsider-%s@example.com", uuid.NewString()),
		"Onboard Outsider", time.Now().UnixNano()+2, "onboard-outsider", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
			DELETE FROM sessions
			WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE org_id = $1`, org.ID)
		cleanupTenantHandler(t, pool, org.ID)
	})

	adminToken, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), admin.ID, org.ID, admin.Email,
	)
	if err != nil {
		t.Fatal(err)
	}
	memberToken, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), member.ID, org.ID, member.Email,
	)
	if err != nil {
		t.Fatal(err)
	}
	nonMemberToken, err := auth.SignAccessToken(
		[]byte(authTestJWTSecret), nonMember.ID, org.ID, nonMember.Email,
	)
	if err != nil {
		t.Fatal(err)
	}

	deps := &handler.Dependencies{
		Queries:      queries,
		JWTSecret:    []byte(authTestJWTSecret),
		AuthProvider: cloudAuthStub{},
	}
	router := handler.NewRouter(deps)
	repo := "acme/onboard-" + uuid.NewString()
	body, err := json.Marshal(map[string]string{"repo_url": repo, "agent_name": "codex"})
	if err != nil {
		t.Fatal(err)
	}
	postProvision := func(token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/onboard/provision", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}

	if response := postProvision(""); response.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer status=%d body=%s", response.Code, response.Body.String())
	}
	if response := postProvision("not-a-jwt"); response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid bearer status=%d body=%s", response.Code, response.Body.String())
	}
	if response := postProvision(nonMemberToken); response.Code != http.StatusForbidden {
		t.Fatalf("non-member status=%d body=%s", response.Code, response.Body.String())
	}
	if response := postProvision(memberToken); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin member status=%d body=%s", response.Code, response.Body.String())
	}

	provisionResponse := postProvision(adminToken)
	if provisionResponse.Code != http.StatusCreated {
		t.Fatalf("admin status=%d body=%s", provisionResponse.Code, provisionResponse.Body.String())
	}
	if got := provisionResponse.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
	var provisioned onboardProvisionResponse
	if err := json.NewDecoder(provisionResponse.Body).Decode(&provisioned); err != nil {
		t.Fatal(err)
	}
	if provisioned.Status != "provisioned" || provisioned.APIKey == "" ||
		provisioned.Endpoint == "" || provisioned.OrgID != org.ID ||
		provisioned.ProjectID == "" || provisioned.Repo != repo ||
		provisioned.PollID == "" || provisioned.PollToken == "" {
		t.Fatalf("incomplete provision response: %+v", provisioned)
	}

	var actorID, sessionStatus string
	var createdAt, expiresAt time.Time
	var keyClaimedAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT provisioned_by_user_id, status, created_at, expires_at, key_claimed_at
		FROM agent_sessions WHERE id = $1`, provisioned.PollID,
	).Scan(&actorID, &sessionStatus, &createdAt, &expiresAt, &keyClaimedAt); err != nil {
		t.Fatal(err)
	}
	if actorID != admin.ID || sessionStatus != "provisioned" {
		t.Fatalf("actor/status=%s/%s, want %s/provisioned", actorID, sessionStatus, admin.ID)
	}
	if keyClaimedAt != nil {
		t.Fatal("synchronous provisioning must not mark the key claimed before the CLI polls")
	}
	if ttl := expiresAt.Sub(createdAt); ttl < 23*time.Hour || ttl > 25*time.Hour {
		t.Fatalf("delivery TTL=%v, want approximately 24h", ttl)
	}
	// Move the creation timestamp an hour into the past without changing the
	// delivery deadline. This proves the session remains pollable past the old
	// 15-minute window; key_claimed_at advances only on this actual CLI poll.
	if _, err := pool.Exec(ctx,
		`UPDATE agent_sessions SET created_at = now() - interval '1 hour' WHERE id = $1`,
		provisioned.PollID,
	); err != nil {
		t.Fatal(err)
	}

	poll := func(sessionID, pollToken string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet,
			"/api/v1/agent/poll/"+sessionID, nil)
		req.Header.Set("X-Opslane-Poll-Token", pollToken)
		req.Header.Set("X-Forwarded-For", "198.51.100.211")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var payload map[string]any
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode poll response: %v (%s)", err, response.Body.String())
		}
		return response.Code, payload
	}
	if code, payload := poll(provisioned.PollID, provisioned.PollToken); code != http.StatusOK || payload["status"] != "provisioned" ||
		payload["api_key"] != provisioned.APIKey {
		t.Fatalf("first poll status=%d payload=%v", code, payload)
	}
	if err := pool.QueryRow(ctx,
		`SELECT status, key_claimed_at FROM agent_sessions WHERE id = $1`, provisioned.PollID,
	).Scan(&sessionStatus, &keyClaimedAt); err != nil {
		t.Fatal(err)
	}
	if sessionStatus != "key_ok" || keyClaimedAt == nil {
		t.Fatalf("post-poll status/key_claimed_at=%s/%v, want key_ok/non-nil", sessionStatus, keyClaimedAt)
	}

	sdkBody, err := json.Marshal(map[string]any{
		"session_id": "onboard_" + uuid.NewString(),
		"started_at": time.Now().UTC().Format(time.RFC3339),
		"page_url":   "https://app.example.test/",
		"sdk": map[string]string{
			"name": "@opslane/sdk", "version": "0.5.0",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	sdkRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", bytes.NewReader(sdkBody))
	sdkRequest.Header.Set("Content-Type", "application/json")
	sdkRequest.Header.Set("X-API-Key", provisioned.APIKey)
	sdkResponse := httptest.NewRecorder()
	router.ServeHTTP(sdkResponse, sdkRequest)
	// This DB-only router intentionally has no object store. SessionInit still
	// persists SDK identity and advances onboarding before reporting that replay
	// storage is unavailable; deployments with MinIO return 200 here.
	if sdkResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("SDK init status=%d body=%s, want 503 without object storage",
			sdkResponse.Code, sdkResponse.Body.String())
	}
	if code, payload := poll(provisioned.PollID, provisioned.PollToken); code != http.StatusOK || payload["status"] != "app_reporting" ||
		payload["api_key"] != provisioned.APIKey {
		t.Fatalf("reporting poll status=%d payload=%v", code, payload)
	}

	repeatResponse := postProvision(adminToken)
	if repeatResponse.Code != http.StatusCreated {
		t.Fatalf("repeat status=%d body=%s", repeatResponse.Code, repeatResponse.Body.String())
	}
	var repeated onboardProvisionResponse
	if err := json.NewDecoder(repeatResponse.Body).Decode(&repeated); err != nil {
		t.Fatal(err)
	}
	if repeated.ProjectID != provisioned.ProjectID || repeated.APIKey == provisioned.APIKey {
		t.Fatalf("repeat did not reuse project and rotate key: first=%+v repeat=%+v", provisioned, repeated)
	}
	if code, payload := poll(provisioned.PollID, provisioned.PollToken); code != http.StatusGone ||
		payload["status"] != "expired" || payload["api_key"] != nil {
		t.Fatalf("superseded poll status=%d payload=%v, want 410 expired without key", code, payload)
	}
	if code, payload := poll(repeated.PollID, repeated.PollToken); code != http.StatusOK ||
		payload["status"] != "provisioned" || payload["api_key"] != repeated.APIKey {
		t.Fatalf("replacement poll status=%d payload=%v", code, payload)
	}
	var activeKeys int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM project_api_keys
		WHERE project_id = $1 AND revoked_at IS NULL`, repeated.ProjectID,
	).Scan(&activeKeys); err != nil {
		t.Fatal(err)
	}
	if activeKeys != 2 {
		t.Fatalf("active keys after repeat=%d, want 2", activeKeys)
	}
}
