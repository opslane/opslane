package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/handler"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func sessionCall(t *testing.T, a approveRig, method, sub, body, token string) (int, map[string]any) {
	t.Helper()
	req := agentRequest(method, "/api/v1/agent/poll/"+a.pollID+"/"+sub, body, a.ip)
	if token != "" {
		req.Header.Set("X-Opslane-Poll-Token", token)
	}
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	return rec.Code, decodeBody(t, rec)
}

func approvedRig(t *testing.T) approveRig {
	t.Helper()
	a := newApproveRig(t)
	if code, _ := a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true); code != http.StatusOK {
		t.Fatalf("approve: %d", code)
	}
	return a
}

func expireSession(a approveRig) {
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, a.pollID)
}

func TestAgentSessionRoutes_AuthGate(t *testing.T) {
	a := newApproveRig(t)
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", ""); code != http.StatusNotFound {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", "opt_wrong"); code != http.StatusNotFound {
		t.Fatalf("wrong token: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodGet, "state", "", a.token); code != http.StatusConflict {
		t.Fatalf("pending session on state: %d", code)
	}
	b := approvedRig(t)
	expireSession(b)
	if code, _ := sessionCall(t, b, http.MethodGet, "state", "", b.token); code != http.StatusGone {
		t.Fatalf("expired session on state: %d", code)
	}
}

func TestAgentSessionRoutes_ProgressAndState(t *testing.T) {
	a := approvedRig(t)
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"install_sdk","status":"running"}`, a.token); code != http.StatusNoContent {
		t.Fatalf("progress: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"first_event","status":"done"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("server-derived done must be refused: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"sourcemaps","status":"failed","note":"no CI access"}`, a.token); code != http.StatusNoContent {
		t.Fatalf("server-derived failure note must be accepted: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"mcp","status":"nope"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad status: %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "progress", `{"step":"mcp","status":"done","note":"`+strings.Repeat("é", 501)+`"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("501-rune note must be refused: %d", code)
	}
	code, out := sessionCall(t, a, http.MethodGet, "state", "", a.token)
	if code != http.StatusOK || out["has_events"] != false || out["slack_connected"] != false || out["project_id"] != a.project {
		t.Fatalf("state: %d %v", code, out)
	}
	steps, _ := out["steps"].(map[string]any)
	install, _ := steps["install_sdk"].(map[string]any)
	sm, _ := steps["sourcemaps"].(map[string]any)
	if install["status"] != "running" || sm["status"] != "failed" || sm["note"] != "no CI access" {
		t.Fatalf("steps in state: %v", out["steps"])
	}
}

func TestAgentSessionRoutes_StateLongPollExpiresMidWait(t *testing.T) {
	a := approvedRig(t)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		expireSession(a)
	}()
	start := time.Now()
	code, _ := sessionCall(t, a, http.MethodGet, "state?wait=10&until=event", "", a.token)
	if code != http.StatusGone || time.Since(start) > 4*time.Second {
		t.Fatalf("state must return 410 promptly on expiry: %d after %s", code, time.Since(start))
	}
}

func TestAgentSessionRoutes_CompleteRequiresSessionEventEvenWhenOrgOnboarded(t *testing.T) {
	a := approvedRig(t)
	code, out := sessionCall(t, a, http.MethodPost, "complete", "", a.token)
	if code != http.StatusUnprocessableEntity || out["error"] != "missing_facts" {
		t.Fatalf("complete without event: %d %v", code, out)
	}
	ingestTestEvent(t, a)
	if code, out = sessionCall(t, a, http.MethodPost, "complete", "", a.token); code != http.StatusOK || out["onboarding_complete"] != true {
		t.Fatalf("complete with event: %d %v", code, out)
	}
	ctx := context.Background()
	if _, err := a.deps.Queries.Pool().Exec(ctx, `DELETE FROM error_events WHERE project_id = $1`, a.project); err != nil {
		t.Fatal(err)
	}
	if has, err := a.deps.Queries.HasEvents(ctx, a.project); err != nil || has {
		t.Fatalf("events must be gone before the retry: %v %v", has, err)
	}
	if code, out = sessionCall(t, a, http.MethodPost, "complete", "", a.token); code != http.StatusUnprocessableEntity || out["error"] != "missing_facts" {
		t.Fatalf("complete on an onboarded org still needs this session's event: %d %v", code, out)
	}
}

func TestAgentSessionRoutes_StateDefaultWaitsForChangeAndRejectsUnknownUntil(t *testing.T) {
	a := approvedRig(t)
	if code, _ := sessionCall(t, a, http.MethodGet, "state?until=bogus", "", a.token); code != http.StatusBadRequest {
		t.Fatalf("unknown until: %d", code)
	}
	go func() {
		time.Sleep(1200 * time.Millisecond)
		sessionCall(t, a, http.MethodPost, "progress", `{"step":"install_sdk","status":"running"}`, a.token)
	}()
	start := time.Now()
	code, out := sessionCall(t, a, http.MethodGet, "state?wait=10", "", a.token)
	steps, _ := out["steps"].(map[string]any)
	if code != http.StatusOK || steps["install_sdk"] == nil || time.Since(start) > 4*time.Second {
		t.Fatalf("default wait must return on a progress change: %d %v after %s", code, out, time.Since(start))
	}
	rec := httptest.NewRecorder()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"/state", "", a.ip)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	a.r.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("state must be no-store")
	}
	rec = httptest.NewRecorder()
	a.r.ServeHTTP(rec, agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"/state", "", a.ip))
	if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("gate rejection must be no-store: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestAgentSessionRoutes_GitHubAttachPATModeWithoutToken(t *testing.T) {
	a := approvedRig(t) // testDeps leaves GitHubAppSlug empty → PAT mode
	t.Setenv("GITHUB_TOKEN", "")
	code, out := sessionCall(t, a, http.MethodPost, "github", `{"repo":"acme/web"}`, a.token)
	if code != http.StatusBadRequest || out["error"] == nil {
		t.Fatalf("PAT mode without token must fail loudly: %d %v", code, out)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "github", `{"repo":"not a repo"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad repo: %d", code)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

// wireNotifySender mirrors notificationRouter (notifications_test.go:34): the
// sender and the extra-host allowlist must both carry the exact host:port.
// Dependencies is a pointer captured by the router, so mutating it after the
// router was built is visible to the handlers.
func wireNotifySender(t *testing.T, deps *handler.Dependencies, hosts []string) {
	t.Helper()
	cipher, err := notify.NewConfigCipher([]byte(notificationCipherSecret))
	if err != nil {
		t.Fatal(err)
	}
	deps.ConfigCipher = cipher
	deps.NotifyExtraHosts = hosts
	deps.NotifySender = notify.NewSender(time.Second, hosts)
}

func TestAgentSessionRoutes_SlackCreateDisabledTestEnable(t *testing.T) {
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer okSrv.Close()
	badSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	defer badSrv.Close()
	hosts := []string{mustHost(t, okSrv.URL), mustHost(t, badSrv.URL)}

	a := approvedRig(t)
	wireNotifySender(t, a.deps, hosts)
	// While the test message is in flight the destination must still be disabled.
	var enabledDuringSend []bool
	okSrv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		var enabled bool
		if err := a.deps.Queries.Pool().QueryRow(context.Background(), `SELECT enabled FROM notification_destinations WHERE project_id = $1`, a.project).Scan(&enabled); err != nil {
			enabled = true // a missing row reads as the worst case
		}
		enabledDuringSend = append(enabledDuringSend, enabled)
		w.WriteHeader(http.StatusOK)
	})
	code, out := sessionCall(t, a, http.MethodPost, "slack", `{"webhook_url":"`+okSrv.URL+`/hook"}`, a.token)
	if code != http.StatusOK || out["ok"] != true || out["destination_id"] == nil {
		t.Fatalf("slack ok: %d %v", code, out)
	}
	if len(enabledDuringSend) != 1 || enabledDuringSend[0] {
		t.Fatalf("destination must be disabled while the test sends: %v", enabledDuringSend)
	}
	if _, out = sessionCall(t, a, http.MethodGet, "state", "", a.token); out["slack_connected"] != true {
		t.Fatalf("slack_connected after enable: %v", out)
	}

	b := approvedRig(t)
	wireNotifySender(t, b.deps, hosts)
	code, out = sessionCall(t, b, http.MethodPost, "slack", `{"webhook_url":"`+badSrv.URL+`/hook"}`, b.token)
	if code != http.StatusOK || out["ok"] != false || out["error"] == nil {
		t.Fatalf("slack failure must be ok:false with error: %d %v", code, out)
	}
	if _, out = sessionCall(t, b, http.MethodGet, "state", "", b.token); out["slack_connected"] != false {
		t.Fatalf("failed test must not enable: %v", out)
	}
	var n int
	if err := b.deps.Queries.Pool().QueryRow(context.Background(), `SELECT count(*) FROM notification_destinations WHERE project_id = $1`, b.project).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("failed test must leave no destination row, found %d", n)
	}
	c := approvedRig(t) // no cipher or sender wired → 503, never a 400 blaming the URL
	if code, _ := sessionCall(t, c, http.MethodPost, "slack", `{"webhook_url":"`+okSrv.URL+`/hook"}`, c.token); code != http.StatusServiceUnavailable {
		t.Fatalf("missing notify config must be 503, got %d", code)
	}
	if code, _ := sessionCall(t, a, http.MethodPost, "slack", `{"webhook_url":"not a url"}`, a.token); code != http.StatusBadRequest {
		t.Fatalf("bad webhook url must be 400, got %d", code)
	}
}

func TestAgentSessionRoutes_AllActionsRejectOtherTokensAndExpiredSessions(t *testing.T) {
	a := approvedRig(t)
	b := approvedRig(t)
	routes := []struct{ method, sub, body string }{
		{http.MethodGet, "state", ""},
		{http.MethodPost, "github", `{"repo":"acme/web"}`},
		{http.MethodPost, "slack", `{"webhook_url":"https://hooks.slack.com/services/test"}`},
		{http.MethodPost, "progress", `{"step":"mcp","status":"done"}`},
		{http.MethodPost, "complete", ""},
	}
	for _, route := range routes {
		req := agentRequest(route.method, "/api/v1/agent/poll/"+a.pollID+"/"+route.sub, route.body, a.ip)
		req.Header.Set("X-Opslane-Poll-Token", b.token)
		rec := httptest.NewRecorder()
		a.r.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("other session token %s: %d %s", route.sub, rec.Code, rec.Body.String())
		}
	}
	expireSession(a)
	for _, route := range routes {
		req := agentRequest(route.method, "/api/v1/agent/poll/"+a.pollID+"/"+route.sub, route.body, a.ip)
		req.Header.Set("X-Opslane-Poll-Token", a.token)
		rec := httptest.NewRecorder()
		a.r.ServeHTTP(rec, req)
		if rec.Code != http.StatusGone || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("expired %s: %d %s", route.sub, rec.Code, rec.Body.String())
		}
	}
}
