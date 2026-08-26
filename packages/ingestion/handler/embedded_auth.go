package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/usageevents"
)

// authProviderTimeout bounds each identity-provider (WorkOS) call so a slow or
// hung upstream fails fast instead of stalling a user-facing login for the
// SDK's 60s default.
const authProviderTimeout = 10 * time.Second

// providerContext derives a bounded context for identity-provider calls.
func providerContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), authProviderTimeout)
}

type passwordResetSessionStore interface {
	GetUserIDByIdentity(context.Context, string, string) (string, error)
	RevokeAllUserRefreshTokens(context.Context, string) (int64, error)
}

// completeEmbeddedLogin mirrors the provisioning and local-session tail of the
// OAuth callback for the JSON embedded-auth flow.
func (d *Dependencies) completeEmbeddedLogin(w http.ResponseWriter, r *http.Request, identity auth.Identity, flow string) {
	if d.Queries == nil {
		writeJSONError(w, http.StatusInternalServerError, "authentication is not configured")
		return
	}
	userID, orgID, created, err := d.Queries.ProvisionFromIdentity(r.Context(), identity)
	if err != nil {
		slog.Error("embedded login provisioning failed", "error", err)
		writeJSONError(w, http.StatusConflict, "could not provision identity")
		return
	}
	user, err := d.Queries.GetUserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "could not load provisioned user")
		return
	}
	d.issueTokenPairCookie(w, r, user.ID, user.OrgID, user.Email, user.Name, uuid.NewString())
	// A signup form that authenticated an already-existing account is an
	// interactive login too; only the verify flow stays silent for returning
	// users.
	emitProvisioningUsage(identity, userID, orgID, created, flow == "login" || flow == "signup")
}

func emitProvisioningUsage(identity auth.Identity, userID, orgID string, created, interactiveLogin bool) {
	if created {
		usageevents.Emit("user_signed_up", map[string]string{
			"email": identity.Email, "provider": identity.Provider,
			"user_id": userID, "org_id": orgID,
		})
	} else if interactiveLogin {
		usageevents.Emit("user_logged_in", map[string]string{
			"email": identity.Email, "user_id": userID, "org_id": orgID,
		})
	}
}

func writeAuthFlowError(w http.ResponseWriter, err error, invalidMessage string) {
	var pending *auth.PendingVerificationError
	switch {
	case errors.As(err, &pending):
		if strings.TrimSpace(pending.PendingAuthenticationToken) == "" {
			slog.Warn("embedded auth provider returned verification challenge without a pending token")
			writeJSONError(w, http.StatusBadGateway, "authentication failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":                       "email_verification_required",
			"pending_authentication_token": pending.PendingAuthenticationToken,
		})
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeJSONError(w, http.StatusUnauthorized, invalidMessage)
	case errors.Is(err, auth.ErrUnsupportedChallenge):
		writeJSONError(w, http.StatusForbidden, "this account requires a sign-in method Opslane does not support yet")
	case errors.Is(err, auth.ErrWeakPassword):
		writeJSONError(w, http.StatusBadRequest, "password does not meet strength requirements")
	default:
		slog.Warn("embedded auth provider error", "error", err)
		writeJSONError(w, http.StatusBadGateway, "authentication failed")
	}
}

func decodeAuthBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeJSONError(w, http.StatusUnsupportedMediaType, "content type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func preventAuthResponseCaching(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

func (d *Dependencies) rateLimitAuth(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r)
	if loginLimiter.allow(ip) {
		return true
	}
	slog.Warn("embedded auth rate limit exceeded", "ip", ip)
	writeJSONError(w, http.StatusTooManyRequests, "too many login attempts, try again later")
	return false
}

// AuthConfig reports independently negotiated embedded-auth capabilities.
func (d *Dependencies) AuthConfig(w http.ResponseWriter, _ *http.Request) {
	preventAuthResponseCaching(w)
	provider := d.provider()
	_, supportsPassword := provider.(auth.PasswordAuthenticator)
	_, supportsRegistration := provider.(auth.UserRegistrar)
	_, supportsVerification := provider.(auth.EmailVerifier)
	supportsSignup := supportsPassword && supportsRegistration && supportsVerification
	_, supportsReset := provider.(auth.PasswordResetter)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"provider":          provider.Name(),
		"supports_password": supportsPassword,
		"supports_signup":   supportsSignup,
		"supports_reset":    supportsReset,
		"social_providers":  d.SocialProviders.Ordered(),
	})
}

type passwordLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (d *Dependencies) PasswordLogin(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if !d.rateLimitAuth(w, r) {
		return
	}
	authenticator, ok := d.provider().(auth.PasswordAuthenticator)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password login is not enabled")
		return
	}
	var req passwordLoginRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if email == "" || req.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}
	providerCtx, cancel := providerContext(r)
	defer cancel()
	identity, err := authenticator.AuthenticateWithPassword(providerCtx, email, req.Password)
	if err != nil {
		writeAuthFlowError(w, err, "invalid email or password")
		return
	}
	d.completeEmbeddedLogin(w, r, identity, "login")
}

func (d *Dependencies) Signup(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if !d.rateLimitAuth(w, r) {
		return
	}
	provider := d.provider()
	registrar, canRegister := provider.(auth.UserRegistrar)
	authenticator, canAuthenticate := provider.(auth.PasswordAuthenticator)
	_, canVerify := provider.(auth.EmailVerifier)
	if !canRegister || !canAuthenticate || !canVerify {
		writeJSONError(w, http.StatusNotFound, "sign-up is not enabled")
		return
	}
	var req passwordLoginRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if email == "" || req.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	providerCtx, cancel := providerContext(r)
	defer cancel()
	if err := registrar.RegisterUser(providerCtx, email, req.Password); err != nil {
		switch {
		case errors.Is(err, auth.ErrEmailTaken):
			// Signup is two non-atomic calls; a retry after a half-completed
			// signup lands here. Fall through and authenticate so the real
			// account owner still gets in. A wrong password yields the same
			// generic invalid-credentials response as sign-in, so signup does
			// not become an account-existence oracle.
		case errors.Is(err, auth.ErrWeakPassword):
			writeJSONError(w, http.StatusBadRequest, "password does not meet strength requirements")
			return
		default:
			slog.Warn("embedded signup failed", "error", err)
			writeJSONError(w, http.StatusBadGateway, "could not create account")
			return
		}
	}

	identity, err := authenticator.AuthenticateWithPassword(providerCtx, email, req.Password)
	if err != nil {
		writeAuthFlowError(w, err, "invalid email or password")
		return
	}
	d.completeEmbeddedLogin(w, r, identity, "signup")
}

type verifyEmailRequest struct {
	PendingAuthenticationToken string `json:"pending_authentication_token"`
	Code                       string `json:"code"`
}

func (d *Dependencies) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if !d.rateLimitAuth(w, r) {
		return
	}
	verifier, ok := d.provider().(auth.EmailVerifier)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "email verification is not enabled")
		return
	}
	var req verifyEmailRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Code == "" || req.PendingAuthenticationToken == "" {
		writeJSONError(w, http.StatusBadRequest, "code and pending_authentication_token are required")
		return
	}
	providerCtx, cancel := providerContext(r)
	defer cancel()
	identity, err := verifier.VerifyEmail(providerCtx, req.PendingAuthenticationToken, req.Code)
	if err != nil {
		writeAuthFlowError(w, err, "invalid or expired verification code")
		return
	}
	d.completeEmbeddedLogin(w, r, identity, "verify")
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

func (d *Dependencies) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if !d.rateLimitAuth(w, r) {
		return
	}
	resetter, ok := d.provider().(auth.PasswordResetter)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password reset is not enabled")
		return
	}
	var req forgotPasswordRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if email == "" {
		writeJSONError(w, http.StatusBadRequest, "email is required")
		return
	}
	providerCtx, cancel := providerContext(r)
	defer cancel()
	if err := resetter.StartPasswordReset(providerCtx, email); err != nil {
		// Keep provider failures indistinguishable from unknown accounts.
		slog.Warn("password reset start failed", "error", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "sent"})
}

type resetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (d *Dependencies) ResetPassword(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if !d.rateLimitAuth(w, r) {
		return
	}
	resetter, ok := d.provider().(auth.PasswordResetter)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "password reset is not enabled")
		return
	}
	var req resetPasswordRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if req.Token == "" || req.NewPassword == "" {
		writeJSONError(w, http.StatusBadRequest, "token and new_password are required")
		return
	}
	providerCtx, cancel := providerContext(r)
	defer cancel()
	identity, err := resetter.CompletePasswordReset(providerCtx, req.Token, req.NewPassword)
	if err != nil {
		writeAuthFlowError(w, err, "invalid or expired reset link")
		return
	}
	clearAuthCookies(w, r)

	store := d.resetSessionStore
	if store == nil && d.Queries != nil {
		store = d.Queries
	}
	if store == nil {
		slog.Error("password reset completed without a local session store")
		writeJSONError(w, http.StatusInternalServerError, "password updated, but local sessions could not be revoked")
		return
	}
	userID, lookupErr := store.GetUserIDByIdentity(r.Context(), identity.Provider, identity.ProviderSubject)
	if lookupErr != nil {
		slog.Error("failed to resolve local identity after password reset", "error", lookupErr)
		writeJSONError(w, http.StatusInternalServerError, "password updated, but local sessions could not be revoked")
		return
	}
	if userID != "" {
		if _, revokeErr := store.RevokeAllUserRefreshTokens(r.Context(), userID); revokeErr != nil {
			slog.Error("failed to revoke sessions after password reset", "error", revokeErr)
			writeJSONError(w, http.StatusInternalServerError, "password updated, but local sessions could not be revoked")
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}
