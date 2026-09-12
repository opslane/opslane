package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

const (
	oauthVerificationCookieName = "__oauth_verify"
	oauthVerificationTTL        = 10 * time.Minute
)

type oauthVerificationStore interface {
	StoreOAuthVerificationContinuation(context.Context, string, db.OAuthVerificationContinuation, time.Time) error
	ReserveOAuthVerificationAttempt(context.Context, string) (*db.OAuthVerificationContinuation, error)
	ConsumeOAuthVerificationContinuation(context.Context, string) (bool, error)
}

func (d *Dependencies) verificationStore() oauthVerificationStore {
	if d.oauthVerificationStore != nil {
		return d.oauthVerificationStore
	}
	if d.Queries == nil {
		return nil
	}
	return d.Queries
}

func setOAuthVerificationCookie(w http.ResponseWriter, r *http.Request, rawFlowID string) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthVerificationCookieName,
		Value:    rawFlowID,
		Path:     "/auth",
		MaxAge:   int(oauthVerificationTTL.Seconds()),
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearOAuthVerificationCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthVerificationCookieName,
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func (d *Dependencies) startOAuthEmailVerification(w http.ResponseWriter, r *http.Request, pending *auth.PendingVerificationError, cont oauthContinuation) {
	preventAuthResponseCaching(w)
	if pending == nil || strings.TrimSpace(pending.PendingAuthenticationToken) == "" {
		slog.Error("OAuth provider returned an email-verification challenge without a pending token")
		writeGitHubFailure(w, &githubFailure{Status: http.StatusServiceUnavailable, Code: "identity_provider_unreachable", Message: "authentication failed"})
		return
	}
	store := d.verificationStore()
	if store == nil || d.PendingCipher == nil {
		slog.Error("OAuth email verification dependencies are not configured")
		writeJSONError(w, http.StatusServiceUnavailable, "could not start email verification; sign in again")
		return
	}

	rawFlowID, flowHash, err := auth.GenerateAuthCode()
	if err != nil {
		slog.Error("generate OAuth verification flow failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "could not start email verification; sign in again")
		return
	}
	sealed, err := d.PendingCipher.Seal([]byte(pending.PendingAuthenticationToken), []byte(flowHash))
	if err != nil {
		slog.Error("seal OAuth pending verification token failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "could not start email verification; sign in again")
		return
	}
	record := db.OAuthVerificationContinuation{
		PendingTokenSealed:     sealed,
		FlowKind:               cont.FlowKind,
		TargetOrgID:            cont.TargetOrgID,
		CLIClientID:            cont.CLIClientID,
		CLIRedirectURI:         cont.CLIRedirectURI,
		CLIOAuthState:          cont.CLIOAuthState,
		CLICodeChallenge:       cont.CLICodeChallenge,
		CLICodeChallengeMethod: cont.CLICodeChallengeMethod,
	}
	if err := store.StoreOAuthVerificationContinuation(r.Context(), flowHash, record, time.Now().Add(oauthVerificationTTL)); err != nil {
		slog.Error("store OAuth verification continuation failed", "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "could not start email verification; sign in again")
		return
	}
	setOAuthVerificationCookie(w, r, rawFlowID)
	http.Redirect(w, r, d.DashboardOrigin+"/login?challenge=email", http.StatusFound)
}

type oauthVerifyEmailRequest struct {
	Code string `json:"code"`
	// Accepted only for backward/hostile-client compatibility and deliberately
	// ignored. The trusted pending token comes exclusively from sealed storage.
	PendingAuthenticationToken string `json:"pending_authentication_token,omitempty"`
}

// OAuthVerifyEmail resumes a hosted OAuth flow after WorkOS verifies the code.
func (d *Dependencies) OAuthVerifyEmail(w http.ResponseWriter, r *http.Request) {
	preventAuthResponseCaching(w)
	if r.Header.Get("Origin") == "" || r.Header.Get("Origin") != d.DashboardOrigin {
		writeJSONError(w, http.StatusForbidden, "invalid request origin")
		return
	}
	if !d.rateLimitAuth(w, r) {
		return
	}
	verifier, ok := d.provider().(auth.EmailVerifier)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "email verification is not enabled")
		return
	}
	store := d.verificationStore()
	if store == nil || d.PendingCipher == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "email verification is not configured")
		return
	}

	var request oauthVerifyEmailRequest
	if !decodeAuthBody(w, r, &request) {
		return
	}
	request.Code = strings.TrimSpace(request.Code)
	if request.Code == "" {
		writeJSONError(w, http.StatusBadRequest, "code is required")
		return
	}
	flowCookie, err := r.Cookie(oauthVerificationCookieName)
	if err != nil || flowCookie.Value == "" {
		writeJSONError(w, http.StatusBadRequest, "email verification flow is missing; sign in again")
		return
	}
	flowHash := auth.HashToken(flowCookie.Value)
	continuation, err := store.ReserveOAuthVerificationAttempt(r.Context(), flowHash)
	if err != nil {
		slog.Error("reserve OAuth verification attempt failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "could not verify email")
		return
	}
	if continuation == nil {
		_, _ = store.ConsumeOAuthVerificationContinuation(r.Context(), flowHash)
		clearOAuthVerificationCookie(w, r)
		writeJSONError(w, http.StatusUnauthorized, "email verification flow expired or exhausted; sign in again")
		return
	}
	pendingToken, err := d.PendingCipher.Open(continuation.PendingTokenSealed, []byte(flowHash))
	if err != nil {
		slog.Error("open OAuth pending verification token failed", "error", err)
		_, _ = store.ConsumeOAuthVerificationContinuation(r.Context(), flowHash)
		clearOAuthVerificationCookie(w, r)
		writeJSONError(w, http.StatusUnauthorized, "email verification flow is invalid; sign in again")
		return
	}

	providerCtx, cancel := providerContext(r)
	defer cancel()
	identity, err := verifier.VerifyEmail(providerCtx, string(pendingToken), request.Code)
	if err != nil {
		if continuation.Attempts >= db.MaxOAuthVerificationAttempts {
			_, _ = store.ConsumeOAuthVerificationContinuation(r.Context(), flowHash)
			clearOAuthVerificationCookie(w, r)
			writeJSONError(w, http.StatusUnauthorized, "too many invalid verification attempts; sign in again")
			return
		}
		if !errors.Is(err, auth.ErrInvalidCredentials) {
			slog.Warn("OAuth email verification failed", "error", err, "attempt", continuation.Attempts)
		}
		writeJSONError(w, http.StatusUnauthorized, "invalid or expired verification code")
		return
	}

	won, err := store.ConsumeOAuthVerificationContinuation(r.Context(), flowHash)
	if err != nil {
		slog.Error("consume verified OAuth continuation failed", "error", err)
		clearOAuthVerificationCookie(w, r)
		writeJSONError(w, http.StatusInternalServerError, "email verified, but session could not be created; sign in again")
		return
	}
	if !won {
		clearOAuthVerificationCookie(w, r)
		writeJSONError(w, http.StatusUnauthorized, "email verification flow was already completed; sign in again")
		return
	}

	cont := oauthContinuation{
		FlowKind:               continuation.FlowKind,
		TargetOrgID:            continuation.TargetOrgID,
		CLIClientID:            continuation.CLIClientID,
		CLIRedirectURI:         continuation.CLIRedirectURI,
		CLIOAuthState:          continuation.CLIOAuthState,
		CLICodeChallenge:       continuation.CLICodeChallenge,
		CLICodeChallengeMethod: continuation.CLICodeChallengeMethod,
	}
	completion, err := d.completeOAuthIdentity(r.Context(), identity, cont)
	if err != nil {
		slog.Error("identity verified but OAuth completion failed", "error", err)
		clearOAuthVerificationCookie(w, r)
		if errors.Is(err, errGitHubUpstream) {
			writeGitHubFailure(w, &githubFailure{Status: http.StatusServiceUnavailable, Code: "github_unreachable", Message: "could not load GitHub installation; retry the installation"})
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "email verified, but session could not be created; sign in again")
		return
	}
	if completion.Mode == completionBrowser {
		setAuthCookies(w, r, completion.AccessToken, completion.RefreshToken)
	}
	clearOAuthVerificationCookie(w, r)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"redirect_to": completion.RedirectTo})
}
