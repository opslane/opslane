package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestGitHubStatusPollingDoesNotReplaceInstallState(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "install-start-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, "install-start-"+uuid.NewString()+"@example.com",
		"Install Start", time.Now().UnixNano(), "install-start", "")
	if err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q, GitHubAppSlug: "opslane", JWTSecret: []byte("secret")}
	asUser := func(req *http.Request) *http.Request {
		reqCtx := context.WithValue(req.Context(), ctxOrgID, org.ID)
		reqCtx = context.WithValue(reqCtx, ctxUserID, user.ID)
		return req.WithContext(reqCtx)
	}
	// Scoped to this org and user: other packages' tests share the database.
	stateRows := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM oauth_login_states WHERE target_org_id = $1 OR initiating_user_id = $2`,
			org.ID, user.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	start := httptest.NewRecorder()
	requestedAt := time.Now()
	deps.GitHubInstallURL(start, asUser(httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)))
	respondedAt := time.Now()
	if start.Code != http.StatusOK {
		t.Fatalf("install-url code=%d body=%q", start.Code, start.Body.String())
	}
	if got := start.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("install-url Cache-Control=%q", got)
	}
	var body struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(body.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := parsed.Query().Get("state")
	if parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.Path != "/apps/opslane/installations/new" || state == "" {
		t.Fatalf("install_url=%q", body.InstallURL)
	}
	var cookie *http.Cookie
	for _, c := range start.Result().Cookies() {
		if c.Name == "__auth_state" {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value != state || cookie.Path != "/auth" || cookie.MaxAge != 1800 ||
		!cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure {
		t.Fatalf("state cookie=%+v", cookie)
	}
	details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state))
	if err != nil || details == nil || details.TargetOrgID == nil || *details.TargetOrgID != org.ID ||
		details.InitiatingUserID == nil || *details.InitiatingUserID != user.ID {
		t.Fatalf("stored state=%+v err=%v", details, err)
	}
	var expiresAt time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM oauth_login_states WHERE state_hash = $1`,
		auth.HashToken(state)).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	if expiresAt.Before(requestedAt.Add(30*time.Minute).Add(-time.Second)) || expiresAt.After(respondedAt.Add(30*time.Minute).Add(time.Second)) {
		t.Fatalf("state expires at %v, want 30 minutes after the request at %v", expiresAt, requestedAt)
	}

	rowsBeforePolling := stateRows()
	for i := 0; i < 3; i++ {
		poll := httptest.NewRecorder()
		deps.GetGitHubAppStatus(poll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
		if poll.Code != http.StatusOK {
			t.Fatalf("status code=%d body=%q", poll.Code, poll.Body.String())
		}
		if cookies := poll.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("status poll set cookies: %v", cookies)
		}
		if got := poll.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("status Cache-Control=%q", got)
		}
		var status map[string]any
		if err := json.Unmarshal(poll.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		installationID, hasInstallationID := status["installation_id"]
		if status["install_available"] != true || status["installed"] != false || !hasInstallationID || installationID != nil {
			t.Fatalf("status=%v", status)
		}
		if _, ok := status["install_url"]; ok {
			t.Fatalf("status still returns install_url: %v", status)
		}
	}
	if got := stateRows(); got != rowsBeforePolling {
		t.Fatalf("status polls wrote install state: %d rows before, %d after", rowsBeforePolling, got)
	}
	if details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state)); err != nil || details == nil {
		t.Fatalf("clicked state no longer valid after polling: %+v err=%v", details, err)
	}

	secureReq := asUser(httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil))
	secureReq.Header.Set("X-Forwarded-Proto", "https")
	secureStart := httptest.NewRecorder()
	deps.GitHubInstallURL(secureStart, secureReq)
	secure := false
	for _, c := range secureStart.Result().Cookies() {
		if c.Name == "__auth_state" {
			secure = c.Secure
		}
	}
	if secureStart.Code != http.StatusOK || !secure {
		t.Fatalf("HTTPS install-url code=%d secure cookie=%v", secureStart.Code, secure)
	}

	noApp := &Dependencies{Queries: q, JWTSecret: []byte("secret")}
	noAppPoll := httptest.NewRecorder()
	noApp.GetGitHubAppStatus(noAppPoll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
	if !strings.Contains(noAppPoll.Body.String(), `"install_available":false`) {
		t.Fatalf("status without an App slug=%q", noAppPoll.Body.String())
	}
}

func TestGitHubInstallURLWithoutAppIsTypedAndSetsNoCookie(t *testing.T) {
	deps := &Dependencies{JWTSecret: []byte("secret")}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	reqCtx := context.WithValue(req.Context(), ctxOrgID, uuid.NewString())
	reqCtx = context.WithValue(reqCtx, ctxUserID, uuid.NewString())
	w := httptest.NewRecorder()
	deps.GitHubInstallURL(w, req.WithContext(reqCtx))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"github_app_not_configured"`) {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("cookies=%v", cookies)
	}
}

func TestGitHubInstallURLRequiresUser(t *testing.T) {
	deps := &Dependencies{GitHubAppSlug: "opslane", JWTSecret: []byte("secret")}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	w := httptest.NewRecorder()
	deps.GitHubInstallURL(w, req.WithContext(context.WithValue(req.Context(), ctxOrgID, uuid.NewString())))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
}
