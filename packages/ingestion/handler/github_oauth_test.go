package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

func TestListGitHubReposRetiresGoneInstallation(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.ListGitHubRepos(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"github_installation_gone"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared: %d", pointer)
	}
	recorder = httptest.NewRecorder()
	deps.ListGitHubRepos(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"github_not_installed"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("after retire: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestGetGitHubAppStatusReflectsSuspension(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	deps.GitHubAppSlug = ""
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	status := func() map[string]any {
		recorder := httptest.NewRecorder()
		deps.GetGitHubAppStatus(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status code=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	if got := status(); got["installed"] != true {
		t.Fatalf("active installation must read installed: %v", got)
	}
	if _, err := q.SetGitHubInstallationSuspended(ctx, installationID, true); err != nil {
		t.Fatal(err)
	}
	if got := status(); got["installed"] != false {
		t.Fatalf("suspended installation must read not installed: %v", got)
	}
}

type recordingProvider struct {
	authorizeCalls int
	lastReq        auth.AuthRequest
	exchangeCodes  []string
}

func (*recordingProvider) Name() string { return "workos" }
func (provider *recordingProvider) AuthorizeURL(req auth.AuthRequest) (string, error) {
	provider.authorizeCalls++
	provider.lastReq = req
	return "https://auth.example/authorize?provider=" + string(req.SocialProvider), nil
}
func (provider *recordingProvider) ExchangeCode(_ context.Context, code string) (auth.Identity, error) {
	provider.exchangeCodes = append(provider.exchangeCodes, code)
	return auth.Identity{}, nil
}
func (*recordingProvider) SupportsLocalPasswordForm() bool { return false }

type oauthStateStoreSpy struct{ calls int }

func (store *oauthStateStoreSpy) StoreOAuthLoginState(context.Context, string, time.Time) error {
	store.calls++
	return nil
}

func newLoginDeps(provider auth.AuthProvider, cfg auth.SocialProviderConfig, store *oauthStateStoreSpy) *Dependencies {
	return &Dependencies{
		AuthProvider:       provider,
		SocialProviders:    cfg,
		oauthStateStore:    store,
		JWTSecret:          []byte("test-secret-at-least-32-bytes-long!!"),
		AuthCallbackOrigin: "https://app.example",
	}
}

func TestOAuthLoginPassesSocialProviderThrough(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google,github")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	store := &oauthStateStoreSpy{}
	recorder := httptest.NewRecorder()
	newLoginDeps(provider, cfg, store).OAuthLoginStart(
		recorder,
		httptest.NewRequest(http.MethodGet, "/auth/login?provider=google", nil),
	)

	if recorder.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if provider.lastReq.SocialProvider != auth.SocialProviderGoogle {
		t.Fatalf("provider received SocialProvider=%q, want google", provider.lastReq.SocialProvider)
	}
	if store.calls != 1 {
		t.Fatalf("want exactly one StoreOAuthLoginState call, got %d", store.calls)
	}
}

func TestOAuthLoginBareUsesEmptyProvider(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	recorder := httptest.NewRecorder()
	newLoginDeps(provider, cfg, &oauthStateStoreSpy{}).OAuthLoginStart(
		recorder,
		httptest.NewRequest(http.MethodGet, "/auth/login", nil),
	)
	if recorder.Code != http.StatusFound || provider.lastReq.SocialProvider != "" {
		t.Fatalf("bare login status=%d social=%q (want 302, empty)", recorder.Code, provider.lastReq.SocialProvider)
	}
}

func TestOAuthLoginRejectsWithoutSideEffects(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google")
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingProvider{}
	store := &oauthStateStoreSpy{}
	deps := newLoginDeps(provider, cfg, store)

	for _, target := range []string{
		"/auth/login?provider=github",
		"/auth/login?provider=evil",
		"/auth/login?provider=",
		"/auth/login?provider=google&provider=github",
	} {
		recorder := httptest.NewRecorder()
		deps.OAuthLoginStart(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d, want 400", target, recorder.Code)
		}
		if recorder.Header().Get("Location") != "" || recorder.Header().Get("Set-Cookie") != "" {
			t.Fatalf("%s produced a Location/cookie side effect", target)
		}
	}
	if store.calls != 0 || provider.authorizeCalls != 0 {
		t.Fatalf("rejections must not store state (%d) or call the provider (%d)", store.calls, provider.authorizeCalls)
	}
}

func TestValidOAuthState(t *testing.T) {
	if validOAuthState("", "x") {
		t.Error("empty cookie must fail")
	}
	if validOAuthState("a", "b") {
		t.Error("mismatch must fail")
	}
	if !validOAuthState("same", "same") {
		t.Error("match must pass")
	}
}

func TestApplyCombinedGitHubInstallationBindsAuthenticatedUser(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "web-binding-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_login_states WHERE target_org_id = $1`, org.ID)
		cleanupGitHubOAuthOrg(t, pool, org.ID)
	})
	installationID := time.Now().UnixNano()%1_000_000_000 + 4_000_000_000
	visible := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case fmt.Sprintf("/app/installations/%d", installationID):
			fmt.Fprintf(w, `{"id":%d,"account":{"login":"web-owner","id":1}}`, installationID)
		case fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"token":"web-installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"full_name":"web-owner/repo"}]}`)
		case "/user/installations":
			if visible {
				fmt.Fprintf(w, `{"installations":[{"id":%d}]}`, installationID)
			} else {
				fmt.Fprint(w, `{"installations":[]}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})})
	defer restore()

	deps := &Dependencies{Queries: q, GitHubAppID: "1", GitHubAppPrivateKey: callbackTestKey(t)}
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/auth/callback?setup_action=install&installation_id=%d", installationID), nil)
	identity := auth.Identity{AccessToken: "ghu_web"}
	if err := deps.applyCombinedGitHubInstallation(req, &db.User{OrgID: org.ID}, identity, ""); err != nil {
		t.Fatalf("bound install: %v", err)
	}
	got, err := q.GetOrgGitHubInstallation(ctx, org.ID)
	if err != nil || got != installationID {
		t.Fatalf("stored installation=%d err=%v", got, err)
	}

	visible = false
	if err := deps.applyCombinedGitHubInstallation(req, &db.User{OrgID: org.ID}, identity, ""); err == nil {
		t.Fatal("expected installation ownership mismatch")
	}
}

func TestWorkosInstallCallbackPreservesActiveOrgAndBypassesProvider(t *testing.T) {
	t.Setenv("AUTH_PROVIDER", "workos")
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	homeOrg, err := q.CreateOrg(ctx, "wizard-home-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	activeOrg, err := q.CreateOrg(ctx, "wizard-active-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	githubID := time.Now().UnixNano()
	email := "wizard-" + suffix + "@example.com"
	user, err := q.CreateUserGitHub(ctx, homeOrg.ID, email, "Wizard User", githubID, "wizard-user", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", strconv.FormatInt(githubID, 10), email, true); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, activeOrg.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM oauth_login_states WHERE target_org_id = $1`, activeOrg.ID)
		cleanupGitHubOAuthOrg(t, pool, homeOrg.ID)
		cleanupGitHubOAuthOrg(t, pool, activeOrg.ID)
	})

	installationID := time.Now().UnixNano()%1_000_000_000 + 5_000_000_000
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/login/oauth/access_token":
			fmt.Fprint(w, `{"access_token":"ghu_wizard","token_type":"bearer"}`)
		case "/user":
			fmt.Fprintf(w, `{"id":%d,"login":"wizard-user","name":"Wizard User"}`, githubID)
		case "/user/emails":
			fmt.Fprintf(w, `[{"email":%q,"primary":true,"verified":true}]`, email)
		case "/user/installations":
			fmt.Fprintf(w, `{"installations":[{"id":%d}]}`, installationID)
		case fmt.Sprintf("/app/installations/%d", installationID):
			fmt.Fprintf(w, `{"id":%d,"account":{"login":"wizard-org","id":1}}`, installationID)
		case fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"token":"wizard-installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"full_name":"wizard-org/repo"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})})
	defer restore()

	provider := &recordingProvider{}
	deps := &Dependencies{
		Queries: q, JWTSecret: []byte("wizard-secret"), GitHubAppSlug: "opslane",
		GitHubAppID: "1", GitHubAppClientID: "cid", GitHubAppClientSecret: "sec",
		GitHubAppPrivateKey: callbackTestKey(t), DashboardOrigin: "https://app.example",
		AuthProvider: provider,
	}
	startReq := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	startCtx := context.WithValue(startReq.Context(), ctxOrgID, activeOrg.ID)
	startCtx = context.WithValue(startCtx, ctxUserID, user.ID)
	startReq = startReq.WithContext(startCtx)
	startW := httptest.NewRecorder()
	deps.GitHubInstallURL(startW, startReq)
	if startW.Code != http.StatusOK {
		t.Fatalf("install-url code=%d body=%q", startW.Code, startW.Body.String())
	}
	var startBody struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(startW.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	installURL, err := url.Parse(startBody.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := installURL.Query().Get("state")
	var stateCookie *http.Cookie
	for _, cookie := range startW.Result().Cookies() {
		if cookie.Name == "__auth_state" {
			stateCookie = cookie
		}
	}
	if state == "" || stateCookie == nil {
		t.Fatalf("missing state or cookie: url=%q cookies=%v", startBody.InstallURL, startW.Result().Cookies())
	}

	callbackReq := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/auth/callback?code=x&state=%s&setup_action=install&installation_id=%d", state, installationID), nil)
	callbackReq.AddCookie(stateCookie)
	accessToken, err := auth.SignAccessToken(deps.JWTSecret, user.ID, activeOrg.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	callbackReq.AddCookie(&http.Cookie{Name: AccessCookieName, Value: accessToken})
	callbackW := httptest.NewRecorder()
	deps.OAuthLoginCallback(callbackW, callbackReq)
	if callbackW.Code != http.StatusFound {
		t.Fatalf("callback code=%d body=%q", callbackW.Code, callbackW.Body.String())
	}
	if len(provider.exchangeCodes) != 0 {
		t.Fatalf("WorkOS exchanged GitHub codes: %v", provider.exchangeCodes)
	}
	for _, cookie := range callbackW.Result().Cookies() {
		if cookie.Name == AccessCookieName || cookie.Name == RefreshCookieName {
			t.Fatalf("install callback minted identity cookies: %v", callbackW.Result().Cookies())
		}
	}
	activeInstallation, err := q.GetOrgGitHubInstallation(ctx, activeOrg.ID)
	if err != nil {
		t.Fatal(err)
	}
	homeInstallation, err := q.GetOrgGitHubInstallation(ctx, homeOrg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activeInstallation != installationID || homeInstallation != 0 {
		t.Fatalf("active/home installations=%d/%d, want %d/0", activeInstallation, homeInstallation, installationID)
	}
	var auditRepos []string
	if err := pool.QueryRow(ctx,
		`SELECT repos FROM installation_landed WHERE installation_id = $1 ORDER BY landed_at DESC LIMIT 1`,
		installationID).Scan(&auditRepos); err != nil {
		t.Fatal(err)
	}
	if len(auditRepos) != 1 || auditRepos[0] != "wizard-org/repo" {
		t.Fatalf("audit repos=%v", auditRepos)
	}
}

func githubOAuthTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cleanupGitHubOAuthOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, query := range []string{
		`DELETE FROM oauth_login_states WHERE target_org_id = $1 OR initiating_user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM installation_landed WHERE org_id = $1`,
		`DELETE FROM github_app_installations WHERE org_id = $1`,
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

func TestGitHubProvisioningResolvesIdentityFirstAndWritesFreshIdentity(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "github-identity-first")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	userA, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-a-%d@example.com", time.Now().UnixNano()), "A", time.Now().UnixNano(), "a", "")
	if err != nil {
		t.Fatal(err)
	}
	legacyID := time.Now().UnixNano()
	if _, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-b-%d@example.com", time.Now().UnixNano()), "B", legacyID, "b", ""); err != nil {
		t.Fatal(err)
	}
	subject := strconv.FormatInt(legacyID, 10)
	if err := q.UpsertIdentity(ctx, userA.ID, "github", subject); err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q}
	request := httptest.NewRequest("GET", "/auth/callback", nil)
	resolved, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: subject, Email: userA.Email,
		EmailVerified: true, Name: "A", Username: "identity-first",
	})
	if err != nil || resolved.ID != userA.ID {
		t.Fatalf("resolved user=%+v err=%v, want %s", resolved, err, userA.ID)
	}

	freshID := time.Now().UnixNano()
	freshEmail := fmt.Sprintf("github-fresh-%d@example.com", freshID)
	fresh, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: strconv.FormatInt(freshID, 10), Email: freshEmail,
		EmailVerified: true, Name: "Fresh", Username: "fresh",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, fresh.OrgID) })
	gotUserID, err := q.GetUserIDByIdentity(ctx, "github", strconv.FormatInt(freshID, 10))
	if err != nil || gotUserID != fresh.ID {
		t.Fatalf("fresh identity user=%q err=%v, want %s", gotUserID, err, fresh.ID)
	}
}

func TestProvisionGitHubIdentityGrantsOwnerMembership(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	deps := &Dependencies{Queries: q}
	request := httptest.NewRequest("GET", "/auth/callback", nil)

	freshID := time.Now().UnixNano()
	fresh, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: strconv.FormatInt(freshID, 10),
		Email:         fmt.Sprintf("github-owner-%d@example.com", freshID),
		EmailVerified: true, Name: "Owner", Username: fmt.Sprintf("owner-%d", freshID),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, fresh.OrgID) })
	role, err := q.GetMembership(ctx, fresh.ID, fresh.OrgID)
	if err != nil || role != "owner" {
		t.Fatalf("new GitHub user role=%q err=%v, want owner", role, err)
	}
}

func TestProvisionGitHubIdentityHealsMissingMembership(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, fmt.Sprintf("github-heal-%d", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	githubID := time.Now().UnixNano()
	user, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-heal-%d@example.com", githubID), "Heal", githubID, "heal", "")
	if err != nil {
		t.Fatal(err)
	}
	subject := strconv.FormatInt(githubID, 10)
	if err := q.UpsertIdentity(ctx, user.ID, "github", subject); err != nil {
		t.Fatal(err)
	}
	// Simulate a legacy account created before membership rows existed.
	if _, err := pool.Exec(ctx, `DELETE FROM memberships WHERE user_id = $1 AND org_id = $2`, user.ID, org.ID); err != nil {
		t.Fatal(err)
	}

	deps := &Dependencies{Queries: q}
	request := httptest.NewRequest("GET", "/auth/callback", nil)
	identity := auth.Identity{
		Provider: "github", ProviderSubject: subject, Email: user.Email,
		EmailVerified: true, Name: "Heal", Username: "heal",
	}
	if _, err := deps.provisionGitHubIdentity(request, identity); err != nil {
		t.Fatal(err)
	}
	role, err := q.GetMembership(ctx, user.ID, org.ID)
	if err != nil || role != "owner" {
		t.Fatalf("healed role=%q err=%v, want owner", role, err)
	}

	// A deliberately downgraded role must survive later logins.
	if err := q.SetMembershipRole(ctx, user.ID, org.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.provisionGitHubIdentity(request, identity); err != nil {
		t.Fatal(err)
	}
	role, err = q.GetMembership(ctx, user.ID, org.ID)
	if err != nil || role != "member" {
		t.Fatalf("downgraded role=%q err=%v, want member preserved", role, err)
	}
}
