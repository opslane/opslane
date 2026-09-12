package handler_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type approveRig struct {
	deps    *handler.Dependencies
	r       http.Handler
	ip      string
	pollID  string
	token   string
	cookie  *http.Cookie
	orgID   string
	project string
	rawKey  string
}

// newApproveRig seeds a tenant (org, project, env, ingest key), an admin user
// with a unique email, registers one agent session, and returns everything a
// test needs to approve it and poll as the agent.
func newApproveRig(t *testing.T) approveRig {
	t.Helper()
	deps, pool := testDeps(t)
	ctx := context.Background()
	deps.AuthCallbackOrigin = "https://app.example.test"
	deps.JWTSecret = []byte(authTestJWTSecret)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	// seedTenant attaches github_repo = "owner/repo"; a fresh onboarding project has none.
	if _, err := pool.Exec(ctx, `UPDATE projects SET github_repo = NULL WHERE id = $1`, projectID); err != nil {
		t.Fatal(err)
	}
	email := fmt.Sprintf("approver-%s@example.com", uuid.NewString())
	user, err := deps.Queries.CreateUserGitHub(ctx, orgID, email, "Approver", time.Now().UnixNano(), "approver", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Queries.CreateMembership(ctx, user.ID, orgID, "admin"); err != nil {
		t.Fatal(err)
	}
	tok, err := auth.SignAccessToken(deps.JWTSecret, user.ID, orgID, email)
	if err != nil {
		t.Fatal(err)
	}
	r := handler.NewRouterWithPool(deps, pool)
	ip := nextAgentIP()
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, agentRequest(http.MethodPost, "/api/v1/agent/setup", `{"project_name":"acme","agent_name":"Claude Code","git_remote":"acme/web"}`, ip))
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	pollID, _ := body["poll_id"].(string)
	token, _ := body["poll_token"].(string)
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, pollID) })
	return approveRig{deps: deps, r: r, ip: ip, pollID: pollID, token: token,
		cookie: &http.Cookie{Name: handler.AccessCookieName, Value: tok}, orgID: orgID, project: projectID, rawKey: rawKey}
}

func (a approveRig) do(t *testing.T, method, path, body string, cookie bool) (int, map[string]any) {
	t.Helper()
	req := agentRequest(method, path, body, a.ip)
	if cookie {
		req.AddCookie(a.cookie)
	}
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	return rec.Code, decodeBody(t, rec)
}

func (a approveRig) poll(t *testing.T, query string) (int, map[string]any) {
	t.Helper()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+query, "", a.ip)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("poll Cache-Control %q", cc)
	}
	return rec.Code, decodeBody(t, rec)
}

func TestAgentApprove_InfoRequiresCookieAndListsProjects(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", false); code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", code)
	}
	code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true)
	if code != http.StatusOK || info["status"] != "pending" || info["project_name"] != "acme" || info["git_remote"] != "acme/web" {
		t.Fatalf("info: %d %v", code, info)
	}
	if projects, _ := info["projects"].([]any); len(projects) != 1 {
		t.Fatalf("expected the seeded project listed, got %v", info["projects"])
	}
}

func TestAgentApprove_CreateThenPollDeliversBundle(t *testing.T) {
	a := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"project_name":"Acme Web"}`, true)
	if code != http.StatusOK || out["status"] != "provisioned" || out["project_name"] != "Acme Web" {
		t.Fatalf("approve: %d %v", code, out)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, ``, true); code != http.StatusConflict {
		t.Fatalf("second approve: %d", code)
	}
	code, poll := a.poll(t, "")
	if code != http.StatusOK || poll["approved"] != true || poll["status"] != "provisioned" {
		t.Fatalf("poll: %d %v", code, poll)
	}
	for _, k := range []string{"ingest_key", "api_key", "sourcemap_key", "project_id", "org_id", "dashboard_url"} {
		if poll[k] == nil {
			t.Fatalf("missing %s: %v", k, poll)
		}
	}
	if _, second := a.poll(t, ""); second["status"] != "key_ok" {
		t.Fatalf("second poll should report key_ok: %v", second)
	}
}

func TestAgentApprove_BodyValidation(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{not json`, true); code != http.StatusBadRequest {
		t.Fatalf("malformed: %d", code)
	}
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"nope"}`, true); code != http.StatusBadRequest {
		t.Fatalf("non-uuid: %d", code)
	}
	code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true)
	if code != http.StatusOK || info["status"] != "pending" {
		t.Fatalf("session must still be pending after rejected bodies: %d %v", code, info)
	}
}

func TestAgentApprove_AttachExistingAndDeny(t *testing.T) {
	a := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	if code != http.StatusOK || out["project_id"] != a.project {
		t.Fatalf("attach: %d %v", code, out)
	}
	if code, info := a.do(t, http.MethodGet, "/api/v1/agent/approve/"+a.pollID, "", true); code != http.StatusOK || info["project_id"] != a.project {
		t.Fatalf("bound info: %d %v", code, info)
	}
	b := newApproveRig(t)
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID+"/deny", ``, true); code != http.StatusOK {
		t.Fatalf("deny: %d", code)
	}
	if code, poll := b.poll(t, ""); code != http.StatusOK || poll["status"] != "failed" || poll["failure_reason"] != "authorization_denied" || poll["approved"] != false {
		t.Fatalf("poll after deny: %d %v", code, poll)
	}
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID+"/deny", ``, true); code != http.StatusConflict {
		t.Fatalf("second deny: %d", code)
	}
}

func TestAgentApprove_ForeignProjectAndForeignOrgInfo(t *testing.T) {
	a := newApproveRig(t)
	b := newApproveRig(t)
	code, out := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+b.project+`"}`, true)
	if code != http.StatusUnprocessableEntity || out["code"] != "project_not_in_org" {
		t.Fatalf("foreign project: %d %v", code, out)
	}
	if code, _ := b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID, `{}`, true); code != http.StatusOK {
		t.Fatalf("b approve: %d", code)
	}
	req := agentRequest(http.MethodGet, "/api/v1/agent/approve/"+b.pollID, "", a.ip)
	req.AddCookie(a.cookie)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a reading b's bound session must be 403, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentPoll_ExpiredAfterApprovalIsGone(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{}`, true)
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, a.pollID)
	code, poll := a.poll(t, "")
	if code != http.StatusGone || poll["ingest_key"] != nil {
		t.Fatalf("expired provisioned session must be 410 with no keys: %d %v", code, poll)
	}
}

func TestAgentPoll_RejectsLegacyAndIncompleteKeyBundles(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	session, err := a.deps.Queries.GetAgentSession(context.Background(), a.pollID)
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{"legacy_raw_key", `{"ingest_key":"legacy_ingest"}`} {
		sealed, err := auth.SealAgentKey(*session.AgentKeyPub, a.pollID, payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET api_key_sealed=$2 WHERE id=$1`, a.pollID, sealed); err != nil {
			t.Fatal(err)
		}
		if code, body := a.poll(t, ""); code != http.StatusInternalServerError || body["ingest_key"] != nil {
			t.Fatalf("legacy payload delivered: %d %v", code, body)
		}
	}
}
