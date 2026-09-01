package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

type redirectOnlyProvider struct{}

func (redirectOnlyProvider) Name() string { return "redirect-only" }
func (redirectOnlyProvider) AuthorizeURL(auth.AuthRequest) (string, error) {
	return "https://identity.example", nil
}
func (redirectOnlyProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, nil
}
func (redirectOnlyProvider) SupportsLocalPasswordForm() bool { return false }

type registrationOnlyProvider struct{ redirectOnlyProvider }

func (registrationOnlyProvider) RegisterUser(context.Context, string, string) error { return nil }

type embeddedAuthProvider struct {
	passwordIdentity auth.Identity
	passwordErr      error
	registerErr      error
	verifyIdentity   auth.Identity
	verifyErr        error
	forgotErr        error
	resetIdentity    auth.Identity
	resetErr         error
	passwordCalls    int
}

func (*embeddedAuthProvider) Name() string { return "workos" }
func (*embeddedAuthProvider) AuthorizeURL(auth.AuthRequest) (string, error) {
	return "https://identity.example", nil
}
func (*embeddedAuthProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, nil
}
func (*embeddedAuthProvider) SupportsLocalPasswordForm() bool { return false }
func (p *embeddedAuthProvider) AuthenticateWithPassword(context.Context, string, string) (auth.Identity, error) {
	p.passwordCalls++
	return p.passwordIdentity, p.passwordErr
}
func (p *embeddedAuthProvider) RegisterUser(context.Context, string, string) error {
	return p.registerErr
}
func (p *embeddedAuthProvider) VerifyEmail(context.Context, string, string) (auth.Identity, error) {
	return p.verifyIdentity, p.verifyErr
}
func (p *embeddedAuthProvider) StartPasswordReset(context.Context, string) error {
	return p.forgotErr
}
func (p *embeddedAuthProvider) CompletePasswordReset(context.Context, string, string) (auth.Identity, error) {
	return p.resetIdentity, p.resetErr
}

type resetSessionStoreStub struct {
	lookupProvider string
	lookupSubject  string
	userID         string
	revokedID      string
	lookupErr      error
	revokeErr      error
}

func (s *resetSessionStoreStub) GetUserIDByIdentity(_ context.Context, provider, subject string) (string, error) {
	s.lookupProvider = provider
	s.lookupSubject = subject
	return s.userID, s.lookupErr
}
func (s *resetSessionStoreStub) RevokeAllUserRefreshTokens(_ context.Context, userID string) (int64, error) {
	s.revokedID = userID
	return 1, s.revokeErr
}

func resetEmbeddedAuthLimiter(t *testing.T) {
	t.Helper()
	original := loginLimiter
	loginLimiter = newRateLimiter(10)
	t.Cleanup(func() { loginLimiter = original })
}

func embeddedRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = "192.0.2.10:1234"
	return r
}

func TestEmbeddedAuthConfigNegotiatesCapabilities(t *testing.T) {
	t.Run("workos", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		(&Dependencies{AuthProvider: &embeddedAuthProvider{}}).AuthConfig(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Cache-Control=%q", recorder.Header().Get("Cache-Control"))
		}
		for _, fragment := range []string{`"provider":"workos"`, `"supports_password":true`, `"supports_signup":true`, `"supports_reset":true`, `"billing_enabled":false`} {
			if !strings.Contains(recorder.Body.String(), fragment) {
				t.Fatalf("body missing %s: %s", fragment, recorder.Body.String())
			}
		}
	})

	t.Run("default github", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		(&Dependencies{}).AuthConfig(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
		for _, fragment := range []string{`"provider":"github"`, `"supports_password":false`, `"supports_signup":false`, `"supports_reset":false`, `"billing_enabled":false`} {
			if !strings.Contains(recorder.Body.String(), fragment) {
				t.Fatalf("body missing %s: %s", fragment, recorder.Body.String())
			}
		}
	})

	t.Run("registration alone does not advertise signup", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		(&Dependencies{AuthProvider: registrationOnlyProvider{}}).AuthConfig(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
		if !strings.Contains(recorder.Body.String(), `"supports_signup":false`) {
			t.Fatalf("body=%s", recorder.Body.String())
		}
	})
}

func TestAuthConfigReportsSocialProviders(t *testing.T) {
	cfg, err := auth.ParseSocialProviders("google,github")
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	(&Dependencies{AuthProvider: &embeddedAuthProvider{}, SocialProviders: cfg}).AuthConfig(
		recorder,
		embeddedRequest(http.MethodGet, "/auth/config", ""),
	)
	if !strings.Contains(recorder.Body.String(), `"social_providers":["google","github"]`) {
		t.Fatalf("body=%s", recorder.Body.String())
	}
}

func TestAuthConfigSocialProvidersEmptyIsArrayNotNull(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Dependencies{AuthProvider: &embeddedAuthProvider{}}).AuthConfig(
		recorder,
		embeddedRequest(http.MethodGet, "/auth/config", ""),
	)
	if !strings.Contains(recorder.Body.String(), `"social_providers":[]`) {
		t.Fatalf("empty must serialize as [], body=%s", recorder.Body.String())
	}
}

func TestEmbeddedAuthPasswordErrorContracts(t *testing.T) {
	tests := []struct {
		name       string
		provider   auth.AuthProvider
		wantStatus int
		wantBody   string
	}{
		{
			name:       "invalid credentials",
			provider:   &embeddedAuthProvider{passwordErr: auth.ErrInvalidCredentials},
			wantStatus: http.StatusUnauthorized,
			wantBody:   "invalid email or password",
		},
		{
			name: "verification pending",
			provider: &embeddedAuthProvider{passwordErr: &auth.PendingVerificationError{
				PendingAuthenticationToken: "pat_1",
			}},
			wantStatus: http.StatusForbidden,
			wantBody:   `"pending_authentication_token":"pat_1"`,
		},
		{
			name:       "verification pending without continuation token",
			provider:   &embeddedAuthProvider{passwordErr: &auth.PendingVerificationError{}},
			wantStatus: http.StatusBadGateway,
			wantBody:   "authentication failed",
		},
		{
			name:       "capability missing",
			provider:   redirectOnlyProvider{},
			wantStatus: http.StatusNotFound,
			wantBody:   "password login is not enabled",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resetEmbeddedAuthLimiter(t)
			recorder := httptest.NewRecorder()
			(&Dependencies{AuthProvider: tc.provider}).PasswordLogin(recorder,
				embeddedRequest(http.MethodPost, "/auth/password", `{"email":"a@b.co","password":"secret"}`))
			if recorder.Code != tc.wantStatus || !strings.Contains(recorder.Body.String(), tc.wantBody) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if recorder.Header().Get("Set-Cookie") != "" {
				t.Fatal("error response unexpectedly set a cookie")
			}
		})
	}
}

func TestEmbeddedAuthSignupHealingAndValidation(t *testing.T) {
	t.Run("email taken and wrong password stays generic (no enumeration)", func(t *testing.T) {
		resetEmbeddedAuthLimiter(t)
		provider := &embeddedAuthProvider{registerErr: auth.ErrEmailTaken, passwordErr: auth.ErrInvalidCredentials}
		recorder := httptest.NewRecorder()
		(&Dependencies{AuthProvider: provider}).Signup(recorder,
			embeddedRequest(http.MethodPost, "/auth/signup", `{"email":"a@b.co","password":"secret"}`))
		// Must NOT return a distinct 409 confirming the account exists; the
		// healing re-auth still runs, and a wrong password looks like any other
		// invalid-credential rejection.
		if recorder.Code != http.StatusUnauthorized || provider.passwordCalls != 1 {
			t.Fatalf("status=%d calls=%d body=%s", recorder.Code, provider.passwordCalls, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "already exists") {
			t.Fatalf("response leaks account existence: %s", recorder.Body.String())
		}
	})

	t.Run("email taken retry continues verification", func(t *testing.T) {
		resetEmbeddedAuthLimiter(t)
		provider := &embeddedAuthProvider{registerErr: auth.ErrEmailTaken, passwordErr: &auth.PendingVerificationError{PendingAuthenticationToken: "pat_retry"}}
		recorder := httptest.NewRecorder()
		(&Dependencies{AuthProvider: provider}).Signup(recorder,
			embeddedRequest(http.MethodPost, "/auth/signup", `{"email":"a@b.co","password":"secret"}`))
		if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "pat_retry") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("weak password", func(t *testing.T) {
		resetEmbeddedAuthLimiter(t)
		recorder := httptest.NewRecorder()
		(&Dependencies{AuthProvider: &embeddedAuthProvider{registerErr: auth.ErrWeakPassword}}).Signup(recorder,
			embeddedRequest(http.MethodPost, "/auth/signup", `{"email":"a@b.co","password":"123"}`))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "strength") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestEmbeddedAuthVerifyEmailUsesCodeSpecificError(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	recorder := httptest.NewRecorder()
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{verifyErr: auth.ErrInvalidCredentials}}
	deps.VerifyEmail(recorder, embeddedRequest(http.MethodPost, "/auth/verify-email",
		`{"pending_authentication_token":"pat_1","code":"000000"}`))
	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "invalid or expired verification code") ||
		strings.Contains(recorder.Body.String(), "email or password") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestEmbeddedAuthForgotPasswordIsAntiEnumerationSafe(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	recorder := httptest.NewRecorder()
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{forgotErr: errors.New("unknown account")}}
	deps.ForgotPassword(recorder, embeddedRequest(http.MethodPost, "/auth/password/forgot", `{"email":"missing@example.com"}`))
	if recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"status":"sent"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestEmbeddedAuthResetUsesProviderConfirmedIdentityForRevocation(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	provider := &embeddedAuthProvider{resetIdentity: auth.Identity{
		Provider: "workos", ProviderSubject: "workos-user-1", Email: "confirmed@example.com",
	}}
	store := &resetSessionStoreStub{userID: "confirmed-user"}
	deps := &Dependencies{AuthProvider: provider, resetSessionStore: store}
	recorder := httptest.NewRecorder()
	deps.ResetPassword(recorder, embeddedRequest(http.MethodPost, "/auth/password/reset",
		`{"token":"reset-token","new_password":"NewPassw0rd!"}`))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if store.lookupProvider != "workos" || store.lookupSubject != "workos-user-1" || store.revokedID != "confirmed-user" {
		t.Fatalf("lookup=%s:%s revoked=%q", store.lookupProvider, store.lookupSubject, store.revokedID)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 || cookies[0].MaxAge != -1 || cookies[1].MaxAge != -1 {
		t.Fatalf("expected both auth cookies to be cleared, got %+v", cookies)
	}
}

func TestEmbeddedAuthResetUsesTokenSpecificError(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	recorder := httptest.NewRecorder()
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{resetErr: auth.ErrInvalidCredentials}}
	deps.ResetPassword(recorder, embeddedRequest(http.MethodPost, "/auth/password/reset",
		`{"token":"expired","new_password":"NewPassw0rd!"}`))
	if recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "invalid or expired reset link") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestEmbeddedAuthResetUsesPasswordStrengthError(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	recorder := httptest.NewRecorder()
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{resetErr: auth.ErrWeakPassword}}
	deps.ResetPassword(recorder, embeddedRequest(http.MethodPost, "/auth/password/reset",
		`{"token":"valid","new_password":"weak"}`))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "strength") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestEmbeddedAuthRejectsMalformedAndOversizedJSON(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "malformed", body: "{"},
		{name: "oversized", body: `{"email":"` + strings.Repeat("x", (1<<16)+1) + `","password":"secret"}`},
		{name: "second object", body: `{"email":"a@b.co","password":"secret"}{}`},
		{name: "oversized trailing data", body: `{"email":"a@b.co","password":"secret"}` + strings.Repeat(" ", (1<<16)+1)},
		{name: "unknown field", body: `{"email":"a@b.co","password":"secret","unexpected":true}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resetEmbeddedAuthLimiter(t)
			recorder := httptest.NewRecorder()
			(&Dependencies{AuthProvider: &embeddedAuthProvider{}}).PasswordLogin(recorder,
				embeddedRequest(http.MethodPost, "/auth/password", tc.body))
			if recorder.Code < 400 || recorder.Code >= 500 {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestEmbeddedAuthRejectsNonJSONContentType(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	recorder := httptest.NewRecorder()
	request := embeddedRequest(http.MethodPost, "/auth/password", `{"email":"attacker@example.com","password":"secret"}`)
	request.Header.Set("Content-Type", "text/plain")
	(&Dependencies{AuthProvider: &embeddedAuthProvider{}}).PasswordLogin(recorder, request)
	if recorder.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestEmbeddedAuthRateLimit(t *testing.T) {
	resetEmbeddedAuthLimiter(t)
	deps := &Dependencies{AuthProvider: &embeddedAuthProvider{passwordErr: auth.ErrInvalidCredentials}}
	for i := 0; i < 11; i++ {
		recorder := httptest.NewRecorder()
		deps.PasswordLogin(recorder, embeddedRequest(http.MethodPost, "/auth/password", `{"email":"a@b.co","password":"bad"}`))
		if i == 10 && recorder.Code != http.StatusTooManyRequests {
			t.Fatalf("request %d status=%d body=%s", i+1, recorder.Code, recorder.Body.String())
		}
	}
}

func TestEmbeddedAuthRoutesAreRegistered(t *testing.T) {
	router := NewRouter(&Dependencies{AuthProvider: &embeddedAuthProvider{}})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, embeddedRequest(http.MethodGet, "/auth/config", ""))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"supports_password":true`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
