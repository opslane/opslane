package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

const oauthVerificationTestSecret = "oauth-verification-test-secret-32-bytes"

type oauthVerificationProvider struct {
	exchangeErr error
	exchange    func() (auth.Identity, error)
	verify      func(string, string) (auth.Identity, error)

	mu              sync.Mutex
	pendingReceived []string
}

func (*oauthVerificationProvider) Name() string { return "workos" }
func (*oauthVerificationProvider) AuthorizeURL(auth.AuthRequest) (string, error) {
	return "https://identity.example/authorize", nil
}
func (p *oauthVerificationProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	if p.exchange != nil {
		return p.exchange()
	}
	return auth.Identity{}, p.exchangeErr
}
func (*oauthVerificationProvider) SupportsLocalPasswordForm() bool { return false }
func (p *oauthVerificationProvider) VerifyEmail(_ context.Context, pending, code string) (auth.Identity, error) {
	p.mu.Lock()
	p.pendingReceived = append(p.pendingReceived, pending)
	p.mu.Unlock()
	if p.verify != nil {
		return p.verify(pending, code)
	}
	return auth.Identity{Provider: "workos", ProviderSubject: "user_1", Email: "user@example.com", EmailVerified: true}, nil
}

type oauthVerificationStoreStub struct {
	mu sync.Mutex

	flowHash     string
	record       *db.OAuthVerificationContinuation
	consumed     bool
	storeErr     error
	reserveErr   error
	consumeErr   error
	reserveCalls int
}

type cliPKCEStoreStub struct {
	request *db.CLIPKCERequest
	err     error
	called  atomic.Bool
	hash    string
}

func (s *cliPKCEStoreStub) ConsumeCLIPKCERequest(_ context.Context, hash string) (*db.CLIPKCERequest, error) {
	s.hash = hash
	s.called.Store(true)
	return s.request, s.err
}

func (s *oauthVerificationStoreStub) StoreOAuthVerificationContinuation(_ context.Context, flowHash string, record db.OAuthVerificationContinuation, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.storeErr != nil {
		return s.storeErr
	}
	copyRecord := record
	copyRecord.PendingTokenSealed = append([]byte(nil), record.PendingTokenSealed...)
	s.flowHash = flowHash
	s.record = &copyRecord
	return nil
}

func (s *oauthVerificationStoreStub) ReserveOAuthVerificationAttempt(_ context.Context, flowHash string) (*db.OAuthVerificationContinuation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reserveCalls++
	if s.reserveErr != nil {
		return nil, s.reserveErr
	}
	if s.record == nil || s.flowHash != flowHash || s.consumed || s.record.Attempts >= db.MaxOAuthVerificationAttempts {
		return nil, nil
	}
	s.record.Attempts++
	copyRecord := *s.record
	copyRecord.PendingTokenSealed = append([]byte(nil), s.record.PendingTokenSealed...)
	return &copyRecord, nil
}

func (s *oauthVerificationStoreStub) ConsumeOAuthVerificationContinuation(_ context.Context, flowHash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.consumeErr != nil {
		return false, s.consumeErr
	}
	if s.record == nil || s.flowHash != flowHash || s.consumed {
		return false, nil
	}
	s.consumed = true
	return true, nil
}

func resetOAuthVerificationLimiter(t *testing.T, limit int) {
	t.Helper()
	original := loginLimiter
	loginLimiter = newRateLimiter(limit)
	t.Cleanup(func() { loginLimiter = original })
}

func testPendingCipher(t *testing.T) *auth.PendingCipher {
	t.Helper()
	cipher, err := auth.NewPendingCipher([]byte(oauthVerificationTestSecret))
	if err != nil {
		t.Fatal(err)
	}
	return cipher
}

func seedVerificationStore(t *testing.T, rawFlow, pendingToken string, record db.OAuthVerificationContinuation) *oauthVerificationStoreStub {
	t.Helper()
	flowHash := auth.HashToken(rawFlow)
	sealed, err := testPendingCipher(t).Seal([]byte(pendingToken), []byte(flowHash))
	if err != nil {
		t.Fatal(err)
	}
	record.PendingTokenSealed = sealed
	return &oauthVerificationStoreStub{flowHash: flowHash, record: &record}
}

func verificationRequest(rawFlow, body, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/auth/oauth/verify-email", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if rawFlow != "" {
		r.AddCookie(&http.Cookie{Name: oauthVerificationCookieName, Value: rawFlow})
	}
	return r
}

func findResponseCookie(response *http.Response, name string) *http.Cookie {
	for _, cookie := range response.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func TestNewDependenciesRejectsMissingPendingCipher(t *testing.T) {
	if _, err := NewDependencies(nil); err == nil {
		t.Fatal("NewDependencies accepted nil dependencies")
	}
	if _, err := NewDependencies(&Dependencies{}); err == nil {
		t.Fatal("NewDependencies accepted a nil pending cipher")
	}
	if _, err := NewDependencies(&Dependencies{PendingCipher: testPendingCipher(t)}); err != nil {
		t.Fatalf("NewDependencies rejected configured cipher: %v", err)
	}
}

func TestOAuthCallbackStartsSealedEmailVerificationChallenge(t *testing.T) {
	resetOAuthVerificationLimiter(t, 10)
	const pendingToken = "pat_never_expose_this"
	provider := &oauthVerificationProvider{exchangeErr: &auth.PendingVerificationError{PendingAuthenticationToken: pendingToken}}
	store := &oauthVerificationStoreStub{}
	deps := &Dependencies{
		AuthProvider: provider, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "http://dashboard.example",
	}
	request := httptest.NewRequest(http.MethodGet, "/auth/callback?code=code_1&state=state_1", nil)
	request.AddCookie(&http.Cookie{Name: "__auth_state", Value: "state_1"})
	recorder := httptest.NewRecorder()

	deps.OAuthLoginCallback(recorder, request)

	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "http://dashboard.example/login?challenge=email" {
		t.Fatalf("status=%d location=%q body=%s", recorder.Code, recorder.Header().Get("Location"), recorder.Body.String())
	}
	if strings.Contains(recorder.Header().Get("Location"), pendingToken) || strings.Contains(recorder.Body.String(), pendingToken) {
		t.Fatal("pending token leaked into callback response")
	}
	flowCookie := findResponseCookie(recorder.Result(), oauthVerificationCookieName)
	if flowCookie == nil {
		t.Fatal("missing OAuth verification cookie")
	}
	if !flowCookie.HttpOnly || flowCookie.Secure || flowCookie.SameSite != http.SameSiteLaxMode || flowCookie.Path != "/auth" {
		t.Fatalf("unexpected flow cookie: %+v", flowCookie)
	}
	if strings.Contains(recorder.Header().Get("Location"), flowCookie.Value) || strings.Contains(recorder.Body.String(), flowCookie.Value) {
		t.Fatal("raw flow id leaked into callback response")
	}
	store.mu.Lock()
	storedHash, stored := store.flowHash, *store.record
	store.mu.Unlock()
	if storedHash != auth.HashToken(flowCookie.Value) || stored.FlowKind != "browser" {
		t.Fatalf("stored continuation hash/kind mismatch: hash=%q kind=%q", storedHash, stored.FlowKind)
	}
	opened, err := deps.PendingCipher.Open(stored.PendingTokenSealed, []byte(storedHash))
	if err != nil || string(opened) != pendingToken {
		t.Fatalf("open stored token = %q, %v", opened, err)
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
}

func TestOAuthCallbackChallengeFailureModes(t *testing.T) {
	tests := []struct {
		name        string
		target      string
		exchangeErr error
		storeErr    error
		wantStatus  int
		wantBody    string
	}{
		{name: "ordinary exchange failure", target: "/auth/callback?code=x&state=s", exchangeErr: errors.New("provider down"), wantStatus: http.StatusServiceUnavailable, wantBody: "authentication failed"},
		{name: "empty pending token", target: "/auth/callback?code=x&state=s", exchangeErr: &auth.PendingVerificationError{}, wantStatus: http.StatusServiceUnavailable, wantBody: "authentication failed"},
		{name: "install context rejected", target: "/auth/callback?code=x&state=s&setup_action=install", exchangeErr: &auth.PendingVerificationError{PendingAuthenticationToken: "pat"}, wantStatus: http.StatusConflict, wantBody: "sign in again"},
		{name: "continuation write failure", target: "/auth/callback?code=x&state=s", exchangeErr: &auth.PendingVerificationError{PendingAuthenticationToken: "pat"}, storeErr: errors.New("write failed"), wantStatus: http.StatusServiceUnavailable, wantBody: "sign in again"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &oauthVerificationStoreStub{storeErr: tc.storeErr}
			deps := &Dependencies{
				AuthProvider:  &oauthVerificationProvider{exchangeErr: tc.exchangeErr},
				PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
				DashboardOrigin: "http://dashboard.example",
			}
			request := httptest.NewRequest(http.MethodGet, tc.target, nil)
			request.AddCookie(&http.Cookie{Name: "__auth_state", Value: "s"})
			recorder := httptest.NewRecorder()
			deps.OAuthLoginCallback(recorder, request)
			if recorder.Code != tc.wantStatus || !strings.Contains(recorder.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
			}
			if findResponseCookie(recorder.Result(), oauthVerificationCookieName) != nil {
				t.Fatal("failure emitted verification cookie")
			}
		})
	}
}

func TestStartOAuthEmailVerificationPersistsCLISnapshot(t *testing.T) {
	store := &oauthVerificationStoreStub{}
	deps := &Dependencies{PendingCipher: testPendingCipher(t), oauthVerificationStore: store, DashboardOrigin: "http://dashboard.example"}
	request := httptest.NewRequest(http.MethodGet, "/auth/callback", nil)
	recorder := httptest.NewRecorder()
	want := oauthContinuation{
		FlowKind: "cli", TargetOrgID: "00000000-0000-0000-0000-000000000123",
		CLIClientID: "opslane-cli", CLIRedirectURI: "http://127.0.0.1:3456/callback",
		CLIOAuthState: "cli-state", CLICodeChallenge: "challenge", CLICodeChallengeMethod: "S256",
	}
	deps.startOAuthEmailVerification(recorder, request, &auth.PendingVerificationError{PendingAuthenticationToken: "pat_cli"}, want)
	store.mu.Lock()
	got := *store.record
	store.mu.Unlock()
	if got.FlowKind != want.FlowKind || got.TargetOrgID != want.TargetOrgID || got.CLIClientID != want.CLIClientID ||
		got.CLIRedirectURI != want.CLIRedirectURI || got.CLIOAuthState != want.CLIOAuthState ||
		got.CLICodeChallenge != want.CLICodeChallenge || got.CLICodeChallengeMethod != want.CLICodeChallengeMethod {
		t.Fatalf("stored CLI snapshot=%+v want=%+v", got, want)
	}
}

func TestOAuthCallbackSnapshotsCLIBeforeProviderExchange(t *testing.T) {
	store := &oauthVerificationStoreStub{}
	cli := &cliPKCEStoreStub{request: &db.CLIPKCERequest{
		ClientID: "opslane-cli", RedirectURI: "http://127.0.0.1:3456/callback", OAuthState: "cli-state",
		CodeChallenge: "challenge", CodeChallengeMethod: "S256",
	}}
	provider := &oauthVerificationProvider{}
	provider.exchange = func() (auth.Identity, error) {
		if !cli.called.Load() {
			t.Fatal("provider exchange ran before CLI snapshot was consumed")
		}
		return auth.Identity{}, &auth.PendingVerificationError{PendingAuthenticationToken: "pat_cli"}
	}
	deps := &Dependencies{
		AuthProvider: provider, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		cliPKCEStore: cli, DashboardOrigin: "http://dashboard.example",
	}
	request := httptest.NewRequest(http.MethodGet, "/auth/callback?code=x&state=state-cli", nil)
	request.AddCookie(&http.Cookie{Name: "__auth_state", Value: "state-cli"})
	recorder := httptest.NewRecorder()
	deps.OAuthLoginCallback(recorder, request)
	if recorder.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	got := *store.record
	store.mu.Unlock()
	if cli.hash != auth.HashToken("state-cli") || got.FlowKind != "cli" || got.CLIClientID != cli.request.ClientID ||
		got.CLIRedirectURI != cli.request.RedirectURI || got.CLIOAuthState != cli.request.OAuthState ||
		got.CLICodeChallenge != cli.request.CodeChallenge || got.CLICodeChallengeMethod != cli.request.CodeChallengeMethod {
		t.Fatalf("CLI snapshot mismatch: hash=%q record=%+v", cli.hash, got)
	}
}

func TestOAuthSessionOrgIDRequiresCurrentMembership(t *testing.T) {
	user := &db.User{ID: "user-1", OrgID: "home-org"}
	tests := []struct {
		name string
		role string
		err  error
		want string
	}{
		{name: "member", role: "member", want: "target-org"},
		{name: "not a member", want: "home-org"},
		{name: "lookup failure", err: errors.New("database unavailable"), want: "home-org"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			deps := &Dependencies{membershipLookup: func(context.Context, string, string) (string, error) {
				return tc.role, tc.err
			}}
			if got := deps.oauthSessionOrgID(context.Background(), user, "target-org"); got != tc.want {
				t.Fatalf("session org=%q want=%q", got, tc.want)
			}
		})
	}
}

func TestOAuthVerifyEmailBrowserSuccessUsesSealedTokenAndSetsCookies(t *testing.T) {
	resetOAuthVerificationLimiter(t, 10)
	const rawFlow = "flow-browser"
	store := seedVerificationStore(t, rawFlow, "pat_server", db.OAuthVerificationContinuation{FlowKind: "browser"})
	provider := &oauthVerificationProvider{}
	var completed oauthContinuation
	deps := &Dependencies{
		AuthProvider: provider, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "https://dashboard.example",
		oauthCompletion: func(_ context.Context, _ auth.Identity, cont oauthContinuation) (*oauthCompletion, error) {
			completed = cont
			return &oauthCompletion{Mode: completionBrowser, RedirectTo: "https://dashboard.example/auth/complete", AccessToken: "access", RefreshToken: "refresh"}, nil
		},
	}
	recorder := httptest.NewRecorder()
	deps.OAuthVerifyEmail(recorder, verificationRequest(rawFlow, `{"code":"123456","pending_authentication_token":"pat_attacker"}`, deps.DashboardOrigin))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body["redirect_to"] != "https://dashboard.example/auth/complete" {
		t.Fatalf("body=%v err=%v", body, err)
	}
	provider.mu.Lock()
	received := append([]string(nil), provider.pendingReceived...)
	provider.mu.Unlock()
	if len(received) != 1 || received[0] != "pat_server" {
		t.Fatalf("provider pending tokens=%v", received)
	}
	if completed.FlowKind != "browser" {
		t.Fatalf("completion continuation=%+v", completed)
	}
	response := recorder.Result()
	if findResponseCookie(response, AccessCookieName) == nil || findResponseCookie(response, RefreshCookieName) == nil {
		t.Fatalf("missing browser auth cookies: %v", response.Cookies())
	}
	cleared := findResponseCookie(response, oauthVerificationCookieName)
	if cleared == nil || cleared.MaxAge != -1 {
		t.Fatalf("flow cookie not cleared: %+v", cleared)
	}
}

func TestOAuthVerifyEmailCLICompletionNeverSetsBrowserCookies(t *testing.T) {
	resetOAuthVerificationLimiter(t, 10)
	const rawFlow = "flow-cli"
	record := db.OAuthVerificationContinuation{
		FlowKind: "cli", CLIClientID: "opslane-cli", CLIRedirectURI: "http://127.0.0.1:4321/callback",
		CLIOAuthState: "cli-state", CLICodeChallenge: "challenge", CLICodeChallengeMethod: "S256",
	}
	store := seedVerificationStore(t, rawFlow, "pat_cli", record)
	deps := &Dependencies{
		AuthProvider: &oauthVerificationProvider{}, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "https://dashboard.example",
		oauthCompletion: func(_ context.Context, _ auth.Identity, cont oauthContinuation) (*oauthCompletion, error) {
			if cont.CLIClientID != record.CLIClientID || cont.CLIRedirectURI != record.CLIRedirectURI {
				t.Fatalf("CLI snapshot not passed to completion: %+v", cont)
			}
			return &oauthCompletion{Mode: completionCLI, RedirectTo: record.CLIRedirectURI + "?code=one-time&state=cli-state"}, nil
		},
	}
	recorder := httptest.NewRecorder()
	deps.OAuthVerifyEmail(recorder, verificationRequest(rawFlow, `{"code":"123456"}`, deps.DashboardOrigin))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	response := recorder.Result()
	if findResponseCookie(response, AccessCookieName) != nil || findResponseCookie(response, RefreshCookieName) != nil {
		t.Fatalf("CLI completion minted browser cookies: %v", response.Cookies())
	}
}

func TestOAuthVerifyEmailReportsPostVerificationCompletionFailure(t *testing.T) {
	resetOAuthVerificationLimiter(t, 10)
	const rawFlow = "flow-completion-failure"
	store := seedVerificationStore(t, rawFlow, "pat", db.OAuthVerificationContinuation{FlowKind: "browser"})
	deps := &Dependencies{
		AuthProvider: &oauthVerificationProvider{}, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "https://dashboard.example",
		oauthCompletion: func(context.Context, auth.Identity, oauthContinuation) (*oauthCompletion, error) {
			return nil, errors.New("refresh token store failed")
		},
	}
	recorder := httptest.NewRecorder()
	deps.OAuthVerifyEmail(recorder, verificationRequest(rawFlow, `{"code":"123456"}`, deps.DashboardOrigin))
	store.mu.Lock()
	consumed := store.consumed
	store.mu.Unlock()
	cleared := findResponseCookie(recorder.Result(), oauthVerificationCookieName)
	if recorder.Code != http.StatusInternalServerError || !strings.Contains(recorder.Body.String(), "email verified") ||
		!consumed || cleared == nil || cleared.MaxAge != -1 {
		t.Fatalf("status=%d consumed=%v cleared=%+v body=%s", recorder.Code, consumed, cleared, recorder.Body.String())
	}
}

func TestOAuthVerifyEmailWrongCodeSurvivesUntilAttemptCap(t *testing.T) {
	resetOAuthVerificationLimiter(t, 20)
	const rawFlow = "flow-retry"
	store := seedVerificationStore(t, rawFlow, "pat_retry", db.OAuthVerificationContinuation{FlowKind: "browser"})
	provider := &oauthVerificationProvider{verify: func(_ string, code string) (auth.Identity, error) {
		if code == "right" {
			return auth.Identity{Provider: "workos", ProviderSubject: "u", Email: "u@example.com", EmailVerified: true}, nil
		}
		return auth.Identity{}, auth.ErrInvalidCredentials
	}}
	deps := &Dependencies{
		AuthProvider: provider, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "https://dashboard.example",
		oauthCompletion: func(context.Context, auth.Identity, oauthContinuation) (*oauthCompletion, error) {
			return &oauthCompletion{Mode: completionBrowser, RedirectTo: "https://dashboard.example/auth/complete", AccessToken: "a", RefreshToken: "r"}, nil
		},
	}
	wrong := httptest.NewRecorder()
	deps.OAuthVerifyEmail(wrong, verificationRequest(rawFlow, `{"code":"wrong"}`, deps.DashboardOrigin))
	if wrong.Code != http.StatusUnauthorized || findResponseCookie(wrong.Result(), oauthVerificationCookieName) != nil {
		t.Fatalf("wrong code status=%d cookies=%v body=%s", wrong.Code, wrong.Result().Cookies(), wrong.Body.String())
	}
	store.mu.Lock()
	attempts, consumed := store.record.Attempts, store.consumed
	store.mu.Unlock()
	if attempts != 1 || consumed {
		t.Fatalf("after typo attempts=%d consumed=%v", attempts, consumed)
	}
	right := httptest.NewRecorder()
	deps.OAuthVerifyEmail(right, verificationRequest(rawFlow, `{"code":"right"}`, deps.DashboardOrigin))
	if right.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", right.Code, right.Body.String())
	}

	capStore := seedVerificationStore(t, "flow-cap", "pat_cap", db.OAuthVerificationContinuation{FlowKind: "browser", Attempts: db.MaxOAuthVerificationAttempts - 1})
	deps.oauthVerificationStore = capStore
	capped := httptest.NewRecorder()
	deps.OAuthVerifyEmail(capped, verificationRequest("flow-cap", `{"code":"wrong"}`, deps.DashboardOrigin))
	capStore.mu.Lock()
	capConsumed := capStore.consumed
	capStore.mu.Unlock()
	cleared := findResponseCookie(capped.Result(), oauthVerificationCookieName)
	if capped.Code != http.StatusUnauthorized || !capConsumed || cleared == nil || cleared.MaxAge != -1 {
		t.Fatalf("cap status=%d consumed=%v cleared=%+v body=%s", capped.Code, capConsumed, cleared, capped.Body.String())
	}
}

func TestOAuthVerifyEmailRejectsMissingUnknownOriginAndRateLimit(t *testing.T) {
	const rawFlow = "flow-reject"
	newDeps := func(t *testing.T) (*Dependencies, *oauthVerificationStoreStub) {
		store := seedVerificationStore(t, rawFlow, "pat", db.OAuthVerificationContinuation{FlowKind: "browser"})
		return &Dependencies{
			AuthProvider: &oauthVerificationProvider{}, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
			DashboardOrigin: "https://dashboard.example",
			oauthCompletion: func(context.Context, auth.Identity, oauthContinuation) (*oauthCompletion, error) {
				return &oauthCompletion{Mode: completionBrowser, RedirectTo: "https://dashboard.example/auth/complete"}, nil
			},
		}, store
	}

	t.Run("missing cookie", func(t *testing.T) {
		resetOAuthVerificationLimiter(t, 10)
		deps, _ := newDeps(t)
		w := httptest.NewRecorder()
		deps.OAuthVerifyEmail(w, verificationRequest("", `{"code":"123456"}`, deps.DashboardOrigin))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("unknown flow", func(t *testing.T) {
		resetOAuthVerificationLimiter(t, 10)
		deps, _ := newDeps(t)
		w := httptest.NewRecorder()
		deps.OAuthVerifyEmail(w, verificationRequest("unknown", `{"code":"123456"}`, deps.DashboardOrigin))
		cleared := findResponseCookie(w.Result(), oauthVerificationCookieName)
		if w.Code != http.StatusUnauthorized || cleared == nil || cleared.MaxAge != -1 {
			t.Fatalf("status=%d cleared=%+v body=%s", w.Code, cleared, w.Body.String())
		}
	})
	for _, origin := range []string{"", "https://evil.example"} {
		t.Run("origin "+origin, func(t *testing.T) {
			resetOAuthVerificationLimiter(t, 10)
			deps, store := newDeps(t)
			w := httptest.NewRecorder()
			deps.OAuthVerifyEmail(w, verificationRequest(rawFlow, `{"code":"123456"}`, origin))
			store.mu.Lock()
			reserveCalls := store.reserveCalls
			store.mu.Unlock()
			if w.Code != http.StatusForbidden || reserveCalls != 0 {
				t.Fatalf("status=%d reserveCalls=%d body=%s", w.Code, reserveCalls, w.Body.String())
			}
		})
	}
	t.Run("rate limit", func(t *testing.T) {
		resetOAuthVerificationLimiter(t, 0)
		deps, store := newDeps(t)
		w := httptest.NewRecorder()
		deps.OAuthVerifyEmail(w, verificationRequest(rawFlow, `{"code":"123456"}`, deps.DashboardOrigin))
		store.mu.Lock()
		reserveCalls := store.reserveCalls
		store.mu.Unlock()
		if w.Code != http.StatusTooManyRequests || reserveCalls != 0 {
			t.Fatalf("status=%d reserveCalls=%d body=%s", w.Code, reserveCalls, w.Body.String())
		}
	})
}

func TestOAuthVerifyEmailConcurrentCorrectCodesCompleteExactlyOnce(t *testing.T) {
	resetOAuthVerificationLimiter(t, 20)
	const rawFlow = "flow-concurrent-correct"
	store := seedVerificationStore(t, rawFlow, "pat", db.OAuthVerificationContinuation{FlowKind: "browser"})
	var completions atomic.Int32
	deps := &Dependencies{
		AuthProvider: &oauthVerificationProvider{}, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
		DashboardOrigin: "https://dashboard.example",
		oauthCompletion: func(context.Context, auth.Identity, oauthContinuation) (*oauthCompletion, error) {
			completions.Add(1)
			return &oauthCompletion{Mode: completionBrowser, RedirectTo: "https://dashboard.example/auth/complete", AccessToken: "a", RefreshToken: "r"}, nil
		},
	}
	const callers = 5
	statuses := make(chan int, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			deps.OAuthVerifyEmail(w, verificationRequest(rawFlow, `{"code":"123456"}`, deps.DashboardOrigin))
			statuses <- w.Code
		}()
	}
	wg.Wait()
	close(statuses)
	successes := 0
	for status := range statuses {
		if status == http.StatusOK {
			successes++
		}
	}
	if successes != 1 || completions.Load() != 1 {
		t.Fatalf("successes=%d completions=%d", successes, completions.Load())
	}
}

func TestOAuthVerifyEmailCapRaceWinnerControlsCompletion(t *testing.T) {
	for _, validWins := range []bool{false, true} {
		name := "cap wins"
		if validWins {
			name = "valid wins"
		}
		t.Run(name, func(t *testing.T) {
			resetOAuthVerificationLimiter(t, 20)
			const rawFlow = "flow-cap-race"
			store := seedVerificationStore(t, rawFlow, "pat", db.OAuthVerificationContinuation{FlowKind: "browser", Attempts: db.MaxOAuthVerificationAttempts - 2})
			validStarted, wrongStarted := make(chan struct{}), make(chan struct{})
			releaseValid, releaseWrong := make(chan struct{}), make(chan struct{})
			provider := &oauthVerificationProvider{verify: func(_ string, code string) (auth.Identity, error) {
				if code == "valid" {
					close(validStarted)
					<-releaseValid
					return auth.Identity{Provider: "workos", ProviderSubject: "u", Email: "u@example.com", EmailVerified: true}, nil
				}
				close(wrongStarted)
				<-releaseWrong
				return auth.Identity{}, auth.ErrInvalidCredentials
			}}
			var completions atomic.Int32
			deps := &Dependencies{
				AuthProvider: provider, PendingCipher: testPendingCipher(t), oauthVerificationStore: store,
				DashboardOrigin: "https://dashboard.example",
				oauthCompletion: func(context.Context, auth.Identity, oauthContinuation) (*oauthCompletion, error) {
					completions.Add(1)
					return &oauthCompletion{Mode: completionBrowser, RedirectTo: "https://dashboard.example/auth/complete", AccessToken: "a", RefreshToken: "r"}, nil
				},
			}
			run := func(code string) <-chan int {
				result := make(chan int, 1)
				go func() {
					w := httptest.NewRecorder()
					deps.OAuthVerifyEmail(w, verificationRequest(rawFlow, `{"code":"`+code+`"}`, deps.DashboardOrigin))
					result <- w.Code
				}()
				return result
			}
			validResult := run("valid")
			<-validStarted
			wrongResult := run("wrong")
			<-wrongStarted
			if validWins {
				close(releaseValid)
				if status := <-validResult; status != http.StatusOK {
					t.Fatalf("valid status=%d", status)
				}
				close(releaseWrong)
				<-wrongResult
			} else {
				close(releaseWrong)
				<-wrongResult
				close(releaseValid)
				if status := <-validResult; status != http.StatusUnauthorized {
					t.Fatalf("valid loser status=%d", status)
				}
			}
			wantCompletions := int32(0)
			if validWins {
				wantCompletions = 1
			}
			if completions.Load() != wantCompletions {
				t.Fatalf("completions=%d want=%d", completions.Load(), wantCompletions)
			}
		})
	}
}
