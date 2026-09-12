package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// Each fixture gets its own client IP so the process-wide agent limiters
// (5 registrations/min/IP) never couple tests.
var agentTestIP atomic.Int64

func nextAgentIP() string {
	n := agentTestIP.Add(1)
	return fmt.Sprintf("10.42.%d.%d", (n/250)%250, n%250+1)
}

func agentRequest(method, path, body, ip string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", ip)
	return req
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("non-JSON body (%d): %s", rec.Code, rec.Body.String())
		}
	}
	return out
}

func TestAgentSetup_RequiresProjectName(t *testing.T) {
	deps, pool := testDeps(t)
	rec := httptest.NewRecorder()
	handler.NewRouterWithPool(deps, pool).ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"agent_name":"x"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "project_name is required") {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentSetup_ContractAndRedirectWithoutGitHubApp(t *testing.T) {
	deps, pool := testDeps(t)
	deps.AuthCallbackOrigin = "https://app.example.test"
	deps.GitHubAppSlug = ""
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"acme","agent_name":"Claude Code on box","git_remote":"acme/web"}`, ip))
	if rec.Code != http.StatusCreated {
		t.Fatalf("setup: %d %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
	body := decodeBody(t, rec)
	for _, k := range []string{"auth_url", "poll_id", "poll_token", "expires_at", "project_name", "message"} {
		if body[k] == nil {
			t.Fatalf("missing %s in %v", k, body)
		}
	}
	if body["status"] != "auth_required" {
		t.Fatalf("status %v", body["status"])
	}
	authURL, _ := body["auth_url"].(string)
	if !strings.HasPrefix(authURL, "https://app.example.test/agent/auth/") {
		t.Fatalf("auth_url %s", authURL)
	}
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(authURL, "https://app.example.test"), nil))
	if rec2.Code != http.StatusFound {
		t.Fatalf("redirect: %d %s", rec2.Code, rec2.Body.String())
	}
	if want := "https://app.example.test/agent/approve/" + body["poll_id"].(string); rec2.Header().Get("Location") != want {
		t.Fatalf("Location %s want %s", rec2.Header().Get("Location"), want)
	}
}

func TestAgentSetup_RejectsBadRemoteAndLongName(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"a","git_remote":"not a remote"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("remote: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"`+strings.Repeat("x", 101)+`"}`, nextAgentIP()))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("long: %d", rec.Code)
	}
}

func TestAgentSetup_RateLimitPerIP(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	var last int
	for i := 0; i < 6; i++ {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"rl"}`, ip))
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("sixth registration from one IP should be 429, got %d", last)
	}
}

func TestAgentAuthCallbackRouteIsGone(t *testing.T) {
	deps, pool := testDeps(t)
	rec := httptest.NewRecorder()
	handler.NewRouterWithPool(deps, pool).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/agent/auth/callback?state=00000000-0000-0000-0000-000000000000", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 from the redirect handler for a non-UUID id, got %d", rec.Code)
	}
}

// TestOAuthLoginCallbackRejectsBareUUIDState replaces the deleted dispatch
// test: a real agent-session UUID in `state` now goes through ordinary OAuth
// state validation, fails it, and leaves the session untouched.
func TestOAuthLoginCallbackRejectsBareUUIDState(t *testing.T) {
	deps, pool := testDeps(t)
	r := handler.NewRouterWithPool(deps, pool)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"state"}`, nextAgentIP()))
	body := decodeBody(t, rec)
	pollID, _ := body["poll_id"].(string)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, pollID) })
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/auth/callback?code=x&installation_id=1&state="+pollID, nil))
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("bare UUID state must fail OAuth state validation, got %d %s", rec2.Code, rec2.Body.String())
	}
	var status string
	pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id = $1`, pollID).Scan(&status)
	if status != "pending" {
		t.Fatalf("session must be untouched, got %s", status)
	}
}

// Cloud mode: RequireRoleIfCloud only enforces roles under a cloud provider.
// cloudAuthStub is the WorkOS-mode stub notifications_test.go already uses.
func TestAgentApprove_CloudRequiresAdmin(t *testing.T) {
	a := newApproveRig(t)
	a.deps.AuthProvider = cloudAuthStub{}
	a.r = handler.NewRouterWithPool(a.deps, a.deps.Queries.Pool())
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE memberships SET role = 'member' WHERE org_id = $1`, a.orgID)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true); code != http.StatusForbidden {
		t.Fatalf("member approve in cloud must be 403, got %d", code)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID+"/deny", ``, true); code != http.StatusForbidden {
		t.Fatalf("member deny in cloud must be 403, got %d", code)
	}
	if code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true); code != http.StatusOK || info["status"] != "pending" {
		t.Fatalf("rejected approve must leave the session pending: %d %v", code, info)
	}
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE memberships SET role = 'admin' WHERE org_id = $1`, a.orgID)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true); code != http.StatusOK {
		t.Fatalf("admin approve in cloud must succeed, got %d", code)
	}
}
