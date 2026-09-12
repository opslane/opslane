package handler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type webInstallFixture struct {
	deps  *Dependencies
	q     *db.Queries
	state string
	user  *db.User
	orgID string
}

func newWebInstallFixture(t *testing.T, role string) webInstallFixture {
	t.Helper()
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := uuid.NewString()
	home, err := q.CreateOrg(ctx, "install-home-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	target, err := q.CreateOrg(ctx, "install-target-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.CreateUserGitHub(ctx, home.ID, "install-"+suffix+"@example.com", "Install User",
		time.Now().UnixNano(), "install-user-"+suffix, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, target.ID, role); err != nil {
		t.Fatal(err)
	}
	state := "install-state-" + suffix
	if err := q.StoreOAuthLoginStateForOrg(ctx, auth.HashToken(state), target.ID, user.ID, time.Now().Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupGitHubOAuthOrg(t, pool, target.ID)
		cleanupGitHubOAuthOrg(t, pool, home.ID)
	})
	return webInstallFixture{
		deps: &Dependencies{
			Queries: q, JWTSecret: []byte("install-callback-secret"), AuthProvider: &recordingProvider{},
			GitHubAppID: "1", GitHubAppClientID: "cid", GitHubAppClientSecret: "secret",
			GitHubAppPrivateKey: callbackTestKey(t), DashboardOrigin: "https://app.example",
		},
		q: q, state: state, user: user, orgID: target.ID,
	}
}

func (f webInstallFixture) request(t *testing.T, actor *db.User, installationID int64) *http.Request {
	t.Helper()
	token, err := auth.SignAccessToken(f.deps.JWTSecret, actor.ID, f.orgID, actor.Email)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/auth/callback?state=%s&setup_action=install&installation_id=%d&code=github-code",
		f.state, installationID), nil)
	req.AddCookie(&http.Cookie{Name: "__auth_state", Value: f.state})
	req.AddCookie(&http.Cookie{Name: AccessCookieName, Value: token})
	return req
}

func TestWebInstallCallbackTransientFailureReleasesStateAndPreservesCookie(t *testing.T) {
	fixture := newWebInstallFixture(t, "admin")
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 502,
			Header:     make(http.Header),
			Body:       http.NoBody,
			Request:    req,
		}, nil
	})})
	defer restore()

	w := httptest.NewRecorder()
	fixture.deps.OAuthLoginCallback(w, fixture.request(t, fixture.user, time.Now().UnixNano()))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Header().Get("Set-Cookie"), "__auth_state") {
		t.Fatalf("transient failure changed state cookie: %q", w.Header().Get("Set-Cookie"))
	}
	var reservedAt *time.Time
	var reservationToken *string
	var consumedAt *time.Time
	if err := fixture.q.Pool().QueryRow(context.Background(),
		`SELECT reserved_at, reservation_token::text, consumed_at
		 FROM oauth_login_states WHERE state_hash = $1`, auth.HashToken(fixture.state)).
		Scan(&reservedAt, &reservationToken, &consumedAt); err != nil {
		t.Fatal(err)
	}
	if reservedAt != nil || reservationToken != nil || consumedAt != nil {
		t.Fatalf("state reserved=%v token=%v consumed=%v", reservedAt, reservationToken, consumedAt)
	}
}

func TestWebInstallCallbackRetiresGoneInstallation(t *testing.T) {
	fixture := newWebInstallFixture(t, "admin")
	installationID := time.Now().UnixNano()
	ctx := context.Background()
	if _, err := fixture.q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, fixture.orgID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.q.SetOrgGitHubInstallation(ctx, fixture.orgID, installationID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		response := func(status int, body string) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
		}
		switch {
		case req.URL.Host == "github.com" && req.URL.Path == "/login/oauth/access_token":
			return response(http.StatusOK, `{"access_token":"user-token"}`)
		case req.URL.Path == "/user/installations":
			return response(http.StatusOK, fmt.Sprintf(`{"installations":[{"id":%d}]}`, installationID))
		case req.Method == http.MethodGet && req.URL.Path == "/app":
			return response(http.StatusOK, `{"id":1,"slug":"opslane-test"}`)
		case req.Method == http.MethodGet && req.URL.Path == fmt.Sprintf("/app/installations/%d", installationID):
			return response(http.StatusOK, fmt.Sprintf(`{"id":%d,"account":{"login":"acme","id":1}}`, installationID))
		case req.Method == http.MethodPost && req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			return response(http.StatusNotFound, `{"message":"Not Found"}`)
		default:
			return response(http.StatusNotFound, `{}`)
		}
	})})
	defer restore()

	w := httptest.NewRecorder()
	fixture.deps.OAuthLoginCallback(w, fixture.request(t, fixture.user, installationID))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"code":"github_installation_gone"`) {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	if pointer, err := fixture.q.GetOrgGitHubInstallation(ctx, fixture.orgID); err != nil || pointer != 0 {
		t.Fatalf("pointer=%d err=%v", pointer, err)
	}
}

func TestWebInstallCallbackRejectsMismatchedActorBeforeReservation(t *testing.T) {
	fixture := newWebInstallFixture(t, "admin")
	ctx := context.Background()
	otherOrg, err := fixture.q.CreateOrg(ctx, "mismatch-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	other, err := fixture.q.CreateUserGitHub(ctx, otherOrg.ID, "mismatch-"+uuid.NewString()+"@example.com",
		"Other User", time.Now().UnixNano(), "other-user", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, fixture.q.Pool(), otherOrg.ID) })

	w := httptest.NewRecorder()
	fixture.deps.OAuthLoginCallback(w, fixture.request(t, other, time.Now().UnixNano()))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "actor mismatch") {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	assertOAuthStateUnreserved(t, fixture.q, fixture.state)
}

func TestWebInstallCallbackRejectsNonAdminBeforeReservation(t *testing.T) {
	fixture := newWebInstallFixture(t, "member")
	w := httptest.NewRecorder()
	fixture.deps.OAuthLoginCallback(w, fixture.request(t, fixture.user, time.Now().UnixNano()))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "admin") {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	assertOAuthStateUnreserved(t, fixture.q, fixture.state)
}

func assertOAuthStateUnreserved(t *testing.T, q *db.Queries, state string) {
	t.Helper()
	var reservedAt *time.Time
	if err := q.Pool().QueryRow(context.Background(),
		`SELECT reserved_at FROM oauth_login_states WHERE state_hash = $1`, auth.HashToken(state)).Scan(&reservedAt); err != nil {
		t.Fatal(err)
	}
	if reservedAt != nil {
		t.Fatalf("state was reserved at %v", reservedAt)
	}
}

func TestGitHubSetupCallbackIsNonMutating(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	org, err := q.CreateOrg(context.Background(), "setup-inert-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/github/setup?setup_action=install&installation_id=123", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxOrgID, org.ID))
	w := httptest.NewRecorder()
	(&Dependencies{Queries: q, DashboardOrigin: "https://app.example"}).GitHubSetupCallback(w, req)
	if w.Code != http.StatusFound || !strings.Contains(w.Header().Get("Location"), "requires_authorization") {
		t.Fatalf("code=%d location=%q", w.Code, w.Header().Get("Location"))
	}
	if got, err := q.GetOrgGitHubInstallation(context.Background(), org.ID); err != nil || got != 0 {
		t.Fatalf("installation=%d err=%v", got, err)
	}
}

func TestGitHubInstallRoutesRequireCloudAdmin(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "routes-admin-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID, "routes-"+uuid.NewString()+"@example.com", "Route User",
		time.Now().UnixNano(), "route-user", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	secret := []byte("route-admin-secret")
	token, err := auth.SignAccessToken(secret, user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q, JWTSecret: secret, AuthProvider: &recordingProvider{}, DashboardOrigin: "https://app.example"}
	router := NewRouter(deps)
	request := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: AccessCookieName, Value: token})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	for _, path := range []string{"/api/v1/github/setup", "/api/v1/github/status"} {
		if w := request(path); w.Code != http.StatusForbidden {
			t.Fatalf("member %s code=%d body=%q", path, w.Code, w.Body.String())
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND org_id = $2`, user.ID, org.ID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/github/setup", "/api/v1/github/status"} {
		if w := request(path); w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
			t.Fatalf("admin %s code=%d body=%q", path, w.Code, w.Body.String())
		}
	}
}
