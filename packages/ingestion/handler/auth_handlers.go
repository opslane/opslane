package handler

import (
	"context"
	"crypto/hmac"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// === Rate limiter (in-memory, per-IP, resets every minute) ===

type rateLimiter struct {
	mu         sync.Mutex
	counts     map[string]int
	resetAt    time.Time
	maxPerIP   int
	maxEntries int
}

func newRateLimiter(maxPerIP int) *rateLimiter {
	return &rateLimiter{
		counts:     make(map[string]int),
		resetAt:    time.Now().Add(time.Minute),
		maxPerIP:   maxPerIP,
		maxEntries: 10000,
	}
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	if now.After(rl.resetAt) {
		rl.counts = make(map[string]int)
		rl.resetAt = now.Add(time.Minute)
	}

	// Evict all entries if map grows too large (DDoS protection)
	if len(rl.counts) >= rl.maxEntries {
		rl.counts = make(map[string]int)
		rl.resetAt = now.Add(time.Minute)
	}

	rl.counts[ip]++
	return rl.counts[ip] <= rl.maxPerIP
}

// byteBudget caps aggregate uploaded bytes per key in a fixed one-minute window.
//
// The request-count rateLimiter above bounds how *often* a project may call in;
// this bounds how *much* it may store. Both are needed: the SDK key is public,
// so without a byte budget a single attacker under the request limit can still
// flood storage with large objects (#48).
//
// Same limitations as rateLimiter, deliberately: in-memory and per-process, so
// N ingestion replicas allow N times the budget. Accepted for now — see the
// note on rateLimiter.
type byteBudget struct {
	mu         sync.Mutex
	used       map[string]int64
	resetAt    time.Time
	maxPerKey  int64
	maxEntries int
}

func newByteBudget(maxPerKey int64) *byteBudget {
	return &byteBudget{
		used:       make(map[string]int64),
		resetAt:    time.Now().Add(time.Minute),
		maxPerKey:  maxPerKey,
		maxEntries: 10000,
	}
}

// allow reserves n bytes for key, reporting whether the reservation fit.
// A rejected reservation consumes nothing.
func (b *byteBudget) allow(key string, n int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	if now.After(b.resetAt) {
		b.used = make(map[string]int64)
		b.resetAt = now.Add(time.Minute)
	}
	if len(b.used) >= b.maxEntries {
		if _, known := b.used[key]; !known {
			b.used = make(map[string]int64)
			b.resetAt = now.Add(time.Minute)
		}
	}

	if b.used[key]+n > b.maxPerKey {
		return false
	}
	b.used[key] += n
	return true
}

// forceRollover expires the current window. Test hook.
func (b *byteBudget) forceRollover() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.resetAt = time.Now().Add(-time.Second)
}

// loginLimiter is shared across login and OAuth authorize endpoints.
var loginLimiter = newRateLimiter(10)

var refreshLimiter = newRateLimiter(10)
var tokenLimiter = newRateLimiter(10)

// clientIP extracts the client IP from the request, preferring X-Forwarded-For.
// NOTE: X-Forwarded-For is trivially spoofable if the service is exposed directly.
// This assumes ingestion runs behind a reverse proxy that overwrites the header.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first (leftmost) IP
		if i := strings.IndexByte(xff, ','); i != -1 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	// Strip port from RemoteAddr
	if i := strings.LastIndex(r.RemoteAddr, ":"); i != -1 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// === Token helpers ===

const refreshTokenTTL = 30 * 24 * time.Hour // 30 days

type tokenResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	ExpiresIn    int      `json:"expires_in"`
	User         userJSON `json:"user"`
}

type userJSON struct {
	ID                 string          `json:"id"`
	OrgID              string          `json:"org_id"`
	ActiveOrgID        string          `json:"active_org_id,omitempty"`
	Email              string          `json:"email"`
	Name               string          `json:"name"`
	IsAdmin            bool            `json:"is_admin"`
	Memberships        []db.Membership `json:"memberships,omitempty"`
	ActiveRole         string          `json:"active_role,omitempty"`
	OnboardingComplete *bool           `json:"onboarding_complete,omitempty"`
}

func (d *Dependencies) mintTokenPair(ctx context.Context, userID, orgID, email, familyID string) (string, string, error) {
	accessToken, err := auth.SignAccessToken(d.JWTSecret, userID, orgID, email)
	if err != nil {
		return "", "", fmt.Errorf("sign access token: %w", err)
	}
	rawRefresh, hashRefresh, err := auth.GenerateRefreshToken()
	if err != nil {
		return "", "", fmt.Errorf("generate refresh token: %w", err)
	}
	if err := d.Queries.StoreRefreshToken(ctx, userID, hashRefresh, familyID, orgID, time.Now().Add(refreshTokenTTL)); err != nil {
		return "", "", err
	}
	return accessToken, rawRefresh, nil
}

// issueTokenPair creates a JWT + refresh token and stores the refresh token hash.
// familyID groups refresh tokens for rotation reuse detection.
func (d *Dependencies) issueTokenPair(w http.ResponseWriter, r *http.Request, userID, orgID, email, name, familyID string) {
	accessToken, rawRefresh, err := d.mintTokenPair(r.Context(), userID, orgID, email, familyID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tokenResponse{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		ExpiresIn:    int(auth.DefaultAccessTokenTTL.Seconds()),
		User: userJSON{
			ID:      userID,
			OrgID:   orgID,
			Email:   email,
			Name:    name,
			IsAdmin: d.isAdminEmail(email),
		},
	})
}

// issueTokenPairCookie mints a JWT + refresh token, stores the refresh hash, and
// delivers both via httpOnly cookies. The JSON body contains no raw tokens.
func (d *Dependencies) issueTokenPairCookie(w http.ResponseWriter, r *http.Request, userID, orgID, email, name, familyID string) {
	accessToken, rawRefresh, err := d.mintTokenPair(r.Context(), userID, orgID, email, familyID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store refresh token")
		return
	}

	setAuthCookies(w, r, accessToken, rawRefresh)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"expires_in": int(auth.DefaultAccessTokenTTL.Seconds()),
		"user": userJSON{
			ID:      userID,
			OrgID:   orgID,
			Email:   email,
			Name:    name,
			IsAdmin: d.isAdminEmail(email),
		},
	})
}

// === POST /auth/refresh ===

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

func (d *Dependencies) Refresh(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !refreshLimiter.allow(ip) {
		slog.Warn("refresh rate limit exceeded", "ip", ip)
		writeJSONError(w, http.StatusTooManyRequests, "too many refresh attempts, try again later")
		return
	}

	rawRefresh := ""
	cookieMode := false
	if c, err := r.Cookie(RefreshCookieName); err == nil && c.Value != "" {
		rawRefresh = c.Value
		cookieMode = true
	} else {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
		var req refreshRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		rawRefresh = req.RefreshToken
	}
	if rawRefresh == "" {
		writeJSONError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	tokenHash := auth.HashToken(rawRefresh)

	// Atomically consume the old refresh token (soft-revoke + reuse detection).
	userID, familyID, orgID, err := d.Queries.ConsumeRefreshToken(r.Context(), tokenHash)
	if errors.Is(err, db.ErrTokenReuse) {
		slog.Warn("refresh token reuse detected", "ip", ip)
		if cookieMode {
			clearAuthCookies(w, r)
		}
		writeJSONError(w, http.StatusUnauthorized, "token reuse detected; all sessions revoked")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if userID == "" {
		if cookieMode {
			clearAuthCookies(w, r)
		}
		writeJSONError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	user, err := d.Queries.GetUserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if orgID == "" {
		orgID = user.OrgID
	}
	// A refresh token can carry a switched-into org. Re-check membership so a
	// user removed from that org cannot keep minting tokens scoped to it; fall
	// back to the home org rather than issuing a session they can't act on.
	if d.cloudAuthEnabled() && orgID != user.OrgID {
		role, membershipErr := d.Queries.GetMembership(r.Context(), user.ID, orgID)
		if membershipErr != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to verify membership")
			return
		}
		if role == "" {
			orgID = user.OrgID
		}
	}
	if cookieMode {
		d.issueTokenPairCookie(w, r, user.ID, orgID, user.Email, user.Name, familyID)
	} else {
		d.issueTokenPair(w, r, user.ID, orgID, user.Email, user.Name, familyID)
	}
}

// === GET /api/v1/auth/me ===

func (d *Dependencies) AuthMe(w http.ResponseWriter, r *http.Request) {
	userID := UserIDFromCtx(r.Context())
	user, err := d.Queries.GetUserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "user not found")
		return
	}

	response := userJSON{
		ID:      user.ID,
		OrgID:   user.OrgID,
		Email:   user.Email,
		Name:    user.Name,
		IsAdmin: d.isAdminEmail(user.Email),
	}
	if d.cloudAuthEnabled() {
		memberships, err := d.Queries.ListMembershipsByUser(r.Context(), user.ID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to load memberships")
			return
		}
		response.Memberships = memberships
		response.ActiveOrgID = OrgIDFromCtx(r.Context())
		response.ActiveRole = RoleFromCtx(r.Context())
	}
	onboarded, err := d.Queries.OrgOnboarded(r.Context(), OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load onboarding state")
		return
	}
	response.OnboardingComplete = &onboarded
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// === GET /api/v1/auth/verify ===

func (d *Dependencies) AuthVerify(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// === POST /auth/logout ===

func (d *Dependencies) Logout(w http.ResponseWriter, r *http.Request) {
	userID := UserIDFromCtx(r.Context())
	if userID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if _, err := d.Queries.RevokeAllUserRefreshTokens(r.Context(), userID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to revoke tokens")
		return
	}
	clearAuthCookies(w, r)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

type switchOrgRequest struct {
	OrgID        string `json:"org_id"`
	RefreshToken string `json:"refresh_token"`
}

// SwitchOrg rotates the current session into another organization without
// changing the OSS-compatible users.org_id home organization.
func (d *Dependencies) SwitchOrg(w http.ResponseWriter, r *http.Request) {
	if !d.cloudAuthEnabled() {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var request switchOrgRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.OrgID == "" {
		writeJSONError(w, http.StatusBadRequest, "org_id is required")
		return
	}
	userID := UserIDFromCtx(r.Context())
	role, err := d.Queries.GetMembership(r.Context(), userID, request.OrgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to verify membership")
		return
	}
	if role == "" {
		writeJSONError(w, http.StatusForbidden, "organization membership required")
		return
	}

	rawRefresh := request.RefreshToken
	cookieMode := false
	if cookie, err := r.Cookie(RefreshCookieName); err == nil && cookie.Value != "" {
		rawRefresh = cookie.Value
		cookieMode = true
	}
	if rawRefresh == "" {
		writeJSONError(w, http.StatusBadRequest, "current refresh token is required")
		return
	}
	consumedUserID, familyID, _, err := d.Queries.ConsumeRefreshToken(r.Context(), auth.HashToken(rawRefresh))
	if err != nil || consumedUserID == "" || consumedUserID != userID {
		if cookieMode {
			clearAuthCookies(w, r)
		}
		writeJSONError(w, http.StatusUnauthorized, "invalid current refresh token")
		return
	}
	user, err := d.Queries.GetUserByID(r.Context(), userID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "user not found")
		return
	}
	accessToken, newRefresh, err := d.mintTokenPair(r.Context(), user.ID, request.OrgID, user.Email, familyID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to rotate session")
		return
	}
	if cookieMode {
		setAuthCookies(w, r, accessToken, newRefresh)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "active_org_id": request.OrgID})
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{
		AccessToken: accessToken, RefreshToken: newRefresh,
		ExpiresIn: int(auth.DefaultAccessTokenTTL.Seconds()),
		User: userJSON{ID: user.ID, OrgID: user.OrgID, ActiveOrgID: request.OrgID,
			Email: user.Email, Name: user.Name, IsAdmin: d.isAdminEmail(user.Email)},
	})
}

type createInvitationRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (d *Dependencies) CreateInvitation(w http.ResponseWriter, r *http.Request) {
	if !d.cloudAuthEnabled() {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var request createInvitationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	request.Email = db.NormalizeEmail(request.Email)
	// An inviter may never grant a role above their own: this is the ceiling
	// that stops an admin from minting an owner and seizing the organization.
	if request.Email == "" || !auth.RoleSatisfies(request.Role, "member") ||
		!auth.RoleSatisfies(RoleFromCtx(r.Context()), request.Role) {
		writeJSONError(w, http.StatusBadRequest, "valid email and role are required")
		return
	}
	rawToken, tokenHash, err := auth.GenerateRefreshToken()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	invitation, err := d.Queries.CreateInvitation(r.Context(), OrgIDFromCtx(r.Context()),
		request.Email, request.Role, UserIDFromCtx(r.Context()), tokenHash, time.Now().Add(7*24*time.Hour))
	if err != nil {
		writeJSONError(w, http.StatusConflict, "an outstanding invitation already exists")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"invitation": invitation, "token": rawToken})
}

func (d *Dependencies) ListInvitations(w http.ResponseWriter, r *http.Request) {
	if !d.cloudAuthEnabled() {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	invitations, err := d.Queries.ListInvitationsByOrg(r.Context(), OrgIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list invitations")
		return
	}
	writeJSON(w, http.StatusOK, invitations)
}

func (d *Dependencies) RevokeInvitation(w http.ResponseWriter, r *http.Request) {
	if !d.cloudAuthEnabled() {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if err := d.Queries.RevokeInvitation(r.Context(), OrgIDFromCtx(r.Context()), chi.URLParam(r, "invitationID")); err != nil {
		writeJSONError(w, http.StatusNotFound, "invitation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type acceptInvitationRequest struct {
	Token string `json:"token"`
}

func (d *Dependencies) AcceptInvitation(w http.ResponseWriter, r *http.Request) {
	if !d.cloudAuthEnabled() {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	var request acceptInvitationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&request); err != nil || request.Token == "" {
		writeJSONError(w, http.StatusBadRequest, "token is required")
		return
	}
	orgID, err := d.Queries.AcceptInvitation(r.Context(), auth.HashToken(request.Token), UserIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid, expired, or mismatched invitation")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "org_id": orgID})
}

// === OAuth endpoints ===

// isAllowedRedirectURI validates that the redirect URI is localhost-only (CLI PKCE).
func isAllowedRedirectURI(uri string) bool {
	parsed, err := url.Parse(uri)
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1")
}

const authCodeTTL = 5 * time.Minute

// OAuthAuthorize handles GET (serve login form) and POST (validate creds, redirect with code).
func (d *Dependencies) OAuthAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		d.oauthAuthorizeGET(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	d.oauthAuthorizePOST(w, r)
}

func generateCSRFToken() (string, error) {
	b := make([]byte, 32)
	if _, err := crand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (d *Dependencies) oauthAuthorizeGET(w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("client_id")
	redirectURI := r.URL.Query().Get("redirect_uri")
	state := r.URL.Query().Get("state")
	codeChallenge := r.URL.Query().Get("code_challenge")
	codeChallengeMethod := r.URL.Query().Get("code_challenge_method")

	if !isAllowedRedirectURI(redirectURI) {
		writeJSONError(w, http.StatusBadRequest, "invalid redirect_uri: must be localhost")
		return
	}
	if !d.provider().SupportsLocalPasswordForm() {
		if clientID == "" || codeChallenge == "" || codeChallengeMethod != "S256" {
			writeJSONError(w, http.StatusBadRequest, "client_id, code_challenge, and S256 code_challenge_method are required")
			return
		}
		providerState, err := generateOAuthState(d.JWTSecret)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := d.Queries.StoreCLIPKCERequest(r.Context(), auth.HashToken(providerState), db.CLIPKCERequest{
			ClientID:            clientID,
			RedirectURI:         redirectURI,
			OAuthState:          state,
			CodeChallenge:       codeChallenge,
			CodeChallengeMethod: codeChallengeMethod,
		}, time.Now().Add(authCodeTTL)); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := d.redirectToProvider(w, r, providerState, ""); err != nil {
			writeJSONError(w, http.StatusServiceUnavailable, "authentication provider is not configured")
		}
		return
	}

	csrfToken, err := generateCSRFToken()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "__csrf",
		Value:    csrfToken,
		Path:     "/oauth/authorize",
		MaxAge:   600,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	// Serve inline HTML login form with hidden OAuth params
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Opslane Login</title>
<style>
body{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;padding:0 20px}
h1{font-size:1.5em}
label{display:block;margin-top:16px;font-size:0.9em;color:#555}
input{width:100%%;padding:8px;margin-top:4px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box}
button{margin-top:20px;width:100%%;padding:10px;background:#2563eb;color:white;border:none;border-radius:4px;font-size:1em;cursor:pointer}
button:hover{background:#1d4ed8}
.error{color:#dc2626;font-size:0.9em;margin-top:8px}
</style></head><body>
<h1>Opslane Login</h1>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="%s">
<input type="hidden" name="redirect_uri" value="%s">
<input type="hidden" name="state" value="%s">
<input type="hidden" name="code_challenge" value="%s">
<input type="hidden" name="code_challenge_method" value="%s">
<input type="hidden" name="csrf_token" value="%s">
<label>Email<input type="email" name="email" required autofocus></label>
<label>Password<input type="password" name="password" required></label>
<button type="submit">Sign in</button>
</form></body></html>`,
		html.EscapeString(clientID),
		html.EscapeString(redirectURI),
		html.EscapeString(state),
		html.EscapeString(codeChallenge),
		html.EscapeString(codeChallengeMethod),
		html.EscapeString(csrfToken),
	)
}

func (d *Dependencies) oauthAuthorizePOST(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !loginLimiter.allow(ip) {
		slog.Warn("oauth authorize rate limit exceeded", "ip", ip)
		writeJSONError(w, http.StatusTooManyRequests, "too many login attempts, try again later")
		return
	}

	if err := r.ParseForm(); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid form data")
		return
	}

	// CSRF validation: compare cookie value with hidden form field
	csrfCookie, err := r.Cookie("__csrf")
	csrfForm := r.FormValue("csrf_token")
	if err != nil || csrfCookie.Value == "" || csrfForm == "" ||
		!hmac.Equal([]byte(csrfCookie.Value), []byte(csrfForm)) {
		writeJSONError(w, http.StatusForbidden, "CSRF validation failed")
		return
	}

	email := r.FormValue("email")
	password := r.FormValue("password")
	clientID := r.FormValue("client_id")
	redirectURI := r.FormValue("redirect_uri")
	state := r.FormValue("state")
	codeChallenge := r.FormValue("code_challenge")
	codeChallengeMethod := r.FormValue("code_challenge_method")

	if !isAllowedRedirectURI(redirectURI) {
		writeJSONError(w, http.StatusBadRequest, "invalid redirect_uri: must be localhost")
		return
	}

	if email == "" || password == "" {
		writeJSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}
	if codeChallengeMethod != "S256" {
		writeJSONError(w, http.StatusBadRequest, "only S256 code_challenge_method is supported")
		return
	}

	user, err := d.Queries.GetUserByEmail(r.Context(), email)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if user == nil {
		slog.Info("oauth login failed: unknown email", "email", email, "ip", ip)
		writeJSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	if user.PasswordHash == nil {
		slog.Info("oauth login failed: user has no password (GitHub-only account)", "email", email, "ip", ip)
		writeJSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err := auth.CheckPassword(*user.PasswordHash, password); err != nil {
		slog.Info("oauth login failed: wrong password", "email", email, "ip", ip)
		writeJSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	// Generate auth code, store hashed
	rawCode, codeHash, err := auth.GenerateAuthCode()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := d.Queries.StoreAuthorizationCode(
		r.Context(), user.ID, codeHash,
		codeChallenge, codeChallengeMethod, redirectURI, clientID,
		time.Now().Add(authCodeTTL),
	); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Redirect back to CLI callback with code + state
	redirectURL := fmt.Sprintf("%s?code=%s&state=%s",
		redirectURI,
		url.QueryEscape(rawCode),
		url.QueryEscape(state),
	)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// === POST /oauth/token ===

type oauthTokenRequest struct {
	GrantType    string `json:"grant_type"`
	ClientID     string `json:"client_id"`
	Code         string `json:"code"`
	CodeVerifier string `json:"code_verifier"`
	RedirectURI  string `json:"redirect_uri"`
}

func (d *Dependencies) OAuthToken(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !tokenLimiter.allow(ip) {
		slog.Warn("oauth token rate limit exceeded", "ip", ip)
		writeJSONError(w, http.StatusTooManyRequests, "too many token requests, try again later")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
	var req oauthTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.GrantType != "authorization_code" {
		writeJSONError(w, http.StatusBadRequest, "unsupported grant_type")
		return
	}
	if req.Code == "" || req.CodeVerifier == "" || req.RedirectURI == "" || req.ClientID == "" {
		writeJSONError(w, http.StatusBadRequest, "code, code_verifier, redirect_uri, and client_id are required")
		return
	}

	if !isAllowedRedirectURI(req.RedirectURI) {
		writeJSONError(w, http.StatusBadRequest, "invalid redirect_uri: must be localhost")
		return
	}

	codeHash := auth.HashToken(req.Code)

	// Atomically consume the auth code (single-use).
	result, err := d.Queries.ConsumeAuthorizationCode(r.Context(), codeHash)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if result == nil {
		writeJSONError(w, http.StatusBadRequest, "invalid, expired, or already-used authorization code")
		return
	}

	// Verify client_id matches
	if result.ClientID != req.ClientID {
		writeJSONError(w, http.StatusBadRequest, "client_id mismatch")
		return
	}

	// Verify redirect_uri matches
	if result.RedirectURI != req.RedirectURI {
		writeJSONError(w, http.StatusBadRequest, "redirect_uri mismatch")
		return
	}

	// Verify PKCE
	if !auth.VerifyPKCE(req.CodeVerifier, result.CodeChallenge) {
		writeJSONError(w, http.StatusBadRequest, "PKCE verification failed")
		return
	}

	// Look up user
	user, err := d.Queries.GetUserByID(r.Context(), result.UserID)
	if err != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	d.issueTokenPair(w, r, user.ID, user.OrgID, user.Email, user.Name, uuid.New().String())
}
