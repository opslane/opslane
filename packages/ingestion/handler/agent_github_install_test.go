package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentGitHubInstallURL_MintsStateForApprover(t *testing.T) {
	a := approvedRig(t)
	t.Cleanup(func() {
		_, _ = a.deps.Queries.Pool().Exec(context.Background(), `DELETE FROM oauth_login_states WHERE target_org_id = $1`, a.orgID)
	})
	a.deps.GitHubAppSlug = "opslane-test"
	req := agentRequest(http.MethodPost, "/api/v1/agent/github/"+a.pollID+"/install-url", "", a.ip)
	req.AddCookie(a.cookie)
	recorder := httptest.NewRecorder()
	a.r.ServeHTTP(recorder, req)
	body := decodeBody(t, recorder)
	installURL, _ := body["install_url"].(string)
	if recorder.Code != http.StatusOK || !strings.HasPrefix(installURL, "https://github.com/apps/opslane-test/installations/new?state=") {
		t.Fatalf("code=%d body=%v", recorder.Code, body)
	}
	if !strings.Contains(recorder.Header().Get("Set-Cookie"), "__auth_state=") {
		t.Fatalf("missing auth-state cookie: %q", recorder.Header().Get("Set-Cookie"))
	}
	var storedOrg string
	if err := a.deps.Queries.Pool().QueryRow(context.Background(),
		`SELECT target_org_id::text FROM oauth_login_states ORDER BY expires_at DESC LIMIT 1`).Scan(&storedOrg); err != nil || storedOrg != a.orgID {
		t.Fatalf("state org=%q err=%v", storedOrg, err)
	}
}

func TestAgentGitHubInstallURL_Gates(t *testing.T) {
	a := newApproveRig(t)
	a.deps.GitHubAppSlug = "opslane-test"
	if code, body := a.do(t, http.MethodPost, "/api/v1/agent/github/"+a.pollID+"/install-url", ``, true); code != http.StatusConflict || body["code"] != "session_not_provisioned" {
		t.Fatalf("pending session: %d %v", code, body)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/github/"+a.pollID+"/install-url", ``, false); code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", code)
	}
	foreign := approvedRig(t)
	foreign.deps.GitHubAppSlug = "opslane-test"
	foreignRequest := agentRequest(http.MethodPost, "/api/v1/agent/github/"+foreign.pollID+"/install-url", "", foreign.ip)
	foreignRequest.AddCookie(a.cookie)
	foreignResponse := httptest.NewRecorder()
	foreign.r.ServeHTTP(foreignResponse, foreignRequest)
	foreignBody := decodeBody(t, foreignResponse)
	if foreignResponse.Code != http.StatusForbidden || foreignBody["code"] != "foreign_org" {
		t.Fatalf("foreign org: %d %v", foreignResponse.Code, foreignBody)
	}
	b := approvedRig(t)
	b.deps.GitHubAppSlug = ""
	if code, body := b.do(t, http.MethodPost, "/api/v1/agent/github/"+b.pollID+"/install-url", ``, true); code != http.StatusBadRequest || body["code"] != "github_app_not_configured" {
		t.Fatalf("pat mode: %d %v", code, body)
	}
}
