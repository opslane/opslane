package handler

import (
	"context"
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type oauthLoginStateStore interface {
	StoreOAuthLoginState(ctx context.Context, tokenHash string, expiresAt time.Time) error
}

type cliPKCEConsumer interface {
	ConsumeCLIPKCERequest(context.Context, string) (*db.CLIPKCERequest, error)
}

type oauthContinuation struct {
	FlowKind    string
	TargetOrgID string

	CLIClientID            string
	CLIRedirectURI         string
	CLIOAuthState          string
	CLICodeChallenge       string
	CLICodeChallengeMethod string

	// GitHub App installation context is live-request-only. It is deliberately
	// never persisted in an email-verification continuation.
	SetupAction    string
	InstallationID string
}

type completionMode int

const (
	completionBrowser completionMode = iota
	completionCLI
)

type oauthCompletion struct {
	Mode                      completionMode
	RedirectTo                string
	AccessToken, RefreshToken string
	OrgID                     string
}

// OAuthLoginStart begins the configured browser identity-provider flow.
func (d *Dependencies) OAuthLoginStart(w http.ResponseWriter, r *http.Request) {
	var socialProvider auth.SocialProvider
	if values, present := r.URL.Query()["provider"]; present {
		if len(values) != 1 {
			writeJSONError(w, http.StatusBadRequest, "unsupported sign-in provider")
			return
		}
		provider, ok := auth.DecodeSocialProvider(values[0])
		if !ok || !d.SocialProviders.Allows(provider) {
			writeJSONError(w, http.StatusBadRequest, "unsupported sign-in provider")
			return
		}
		socialProvider = provider
	}
	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := d.redirectToProvider(w, r, state, socialProvider); err != nil {
		slog.Error("build provider authorization URL failed", "provider", d.provider().Name(), "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "authentication provider is not configured")
	}
}

// GitHubOAuthStart is retained for internal compatibility; public /auth/github
// is now a redirect to /auth/login.
func (d *Dependencies) GitHubOAuthStart(w http.ResponseWriter, r *http.Request) {
	d.OAuthLoginStart(w, r)
}

func (d *Dependencies) redirectToProvider(w http.ResponseWriter, r *http.Request, state string, socialProvider auth.SocialProvider) error {
	callbackOrigin := d.AuthCallbackOrigin
	if callbackOrigin == "" {
		callbackOrigin = "http://localhost:8080"
	}
	redirectURL, err := d.provider().AuthorizeURL(auth.AuthRequest{
		State:          state,
		RedirectURI:    callbackOrigin + "/auth/callback",
		SocialProvider: socialProvider,
	})
	if err != nil {
		return err
	}
	store := d.oauthStateStore
	if store == nil && d.Queries != nil {
		store = d.Queries
	}
	if store != nil {
		if err := store.StoreOAuthLoginState(r.Context(), auth.HashToken(state), time.Now().Add(5*time.Minute)); err != nil {
			return err
		}
	}
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     "__auth_state",
		Value:    state,
		Path:     "/auth",
		MaxAge:   300,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, redirectURL, http.StatusFound)
	return nil
}

// OAuthLoginCallback completes either the browser login or the durable CLI bridge.
func (d *Dependencies) OAuthLoginCallback(w http.ResponseWriter, r *http.Request) {
	// OAuth-during-install sends all GitHub App installs to this shared
	// callback. UUID state belongs to an agent session; browser state is HMAC
	// hex and continues through the ordinary login path.
	if state := r.URL.Query().Get("state"); state != "" {
		if _, err := uuid.Parse(state); err == nil {
			d.AgentAuthCallback(w, r)
			return
		}
	}
	if r.URL.Query().Get("setup_action") == "install" && r.URL.Query().Get("installation_id") != "" {
		d.gitHubInstallCallback(w, r)
		return
	}
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		writeJSONError(w, http.StatusBadRequest, "authentication was denied: "+providerError)
		return
	}

	stateCookie, cookieErr := r.Cookie("__auth_state")
	state := r.URL.Query().Get("state")
	cookieValue := ""
	if cookieErr == nil {
		cookieValue = stateCookie.Value
	}
	if !validOAuthState(cookieValue, state) {
		writeJSONError(w, http.StatusForbidden, "invalid OAuth state")
		return
	}
	installTargetOrgID := ""
	if d.Queries != nil {
		loginState, err := d.Queries.ConsumeOAuthLoginStateDetails(r.Context(), auth.HashToken(state))
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if loginState == nil {
			writeJSONError(w, http.StatusForbidden, "OAuth state already used or expired")
			return
		}
		if loginState.TargetOrgID != nil {
			installTargetOrgID = *loginState.TargetOrgID
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "__auth_state",
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
	})

	code := r.URL.Query().Get("code")
	if code == "" {
		writeJSONError(w, http.StatusBadRequest, "missing code parameter")
		return
	}

	// Decide whether this is a CLI flow before the provider round trip. The
	// source PKCE row expires sooner than an email-verification continuation,
	// so this classification and snapshot must not be deferred.
	cont := oauthContinuation{
		FlowKind:       "browser",
		TargetOrgID:    installTargetOrgID,
		SetupAction:    r.URL.Query().Get("setup_action"),
		InstallationID: r.URL.Query().Get("installation_id"),
	}
	cliStore := d.cliPKCEStore
	if cliStore == nil && d.Queries != nil {
		cliStore = d.Queries
	}
	if cliStore != nil {
		pendingCLI, err := cliStore.ConsumeCLIPKCERequest(r.Context(), auth.HashToken(state))
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if pendingCLI != nil {
			cont.FlowKind = "cli"
			cont.CLIClientID = pendingCLI.ClientID
			cont.CLIRedirectURI = pendingCLI.RedirectURI
			cont.CLIOAuthState = pendingCLI.OAuthState
			cont.CLICodeChallenge = pendingCLI.CodeChallenge
			cont.CLICodeChallengeMethod = pendingCLI.CodeChallengeMethod
		}
	}

	providerCtx, cancel := providerContext(r)
	defer cancel()
	identity, err := d.provider().ExchangeCode(providerCtx, code)
	if err != nil {
		var pending *auth.PendingVerificationError
		if errors.As(err, &pending) {
			if cont.SetupAction == "install" {
				slog.Error("OAuth email verification cannot preserve GitHub App installation context")
				writeJSONError(w, http.StatusConflict, "email verification cannot continue during GitHub App installation; sign in again")
				return
			}
			d.startOAuthEmailVerification(w, r, pending, cont)
			return
		}
		slog.Warn("identity provider code exchange failed", "provider", d.provider().Name(), "error", err)
		writeJSONError(w, http.StatusBadGateway, "authentication failed")
		return
	}

	completion, err := d.completeOAuthIdentity(r.Context(), identity, cont)
	if err != nil {
		slog.Error("OAuth login completion failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "could not complete authentication")
		return
	}
	if completion.Mode == completionBrowser {
		setAuthCookies(w, r, completion.AccessToken, completion.RefreshToken)
	}
	http.Redirect(w, r, completion.RedirectTo, http.StatusFound)
}

// gitHubInstallCallback completes an install for an already-authenticated
// browser actor. GitHub's authorization code never crosses the identity
// provider boundary.
func (d *Dependencies) gitHubInstallCallback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	stateCookie, stateCookieErr := r.Cookie("__auth_state")
	if stateCookieErr != nil || !validOAuthState(stateCookie.Value, state) {
		writeJSONError(w, http.StatusForbidden, "invalid OAuth state")
		return
	}
	accessCookie, err := r.Cookie(AccessCookieName)
	if err != nil || accessCookie.Value == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	claims, err := auth.ValidateToken(d.JWTSecret, accessCookie.Value)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "invalid or expired session")
		return
	}
	if d.Queries == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "authentication database is not configured")
		return
	}

	stateHash := auth.HashToken(state)
	loginState, err := d.Queries.GetOAuthLoginStateDetails(r.Context(), stateHash)
	if err != nil {
		slog.Error("inspect install OAuth state failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if loginState == nil || loginState.TargetOrgID == nil || loginState.InitiatingUserID == nil {
		writeJSONError(w, http.StatusForbidden, "OAuth state already used, expired, or not valid for installation")
		return
	}
	if *loginState.InitiatingUserID != claims.Sub {
		writeJSONError(w, http.StatusForbidden, "OAuth installation actor mismatch")
		return
	}
	role, err := d.Queries.GetMembership(r.Context(), claims.Sub, *loginState.TargetOrgID)
	if err != nil {
		slog.Error("revalidate install callback membership failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !auth.RoleSatisfies(role, "admin") {
		writeJSONError(w, http.StatusForbidden, "organization admin role required")
		return
	}

	code := r.URL.Query().Get("code")
	installationID, parseErr := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	if code == "" || parseErr != nil || installationID <= 0 {
		writeJSONError(w, http.StatusBadRequest, "missing or invalid GitHub installation callback parameters")
		return
	}
	if d.GitHubAppID == "" || d.GitHubAppClientID == "" || len(d.GitHubAppPrivateKey) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	reservation, err := d.Queries.ReserveOAuthLoginState(r.Context(), stateHash)
	if errors.Is(err, db.ErrOAuthLoginStateInFlight) {
		writeJSONError(w, http.StatusConflict, "OAuth installation callback is already in progress")
		return
	}
	if err != nil {
		slog.Error("reserve install OAuth state failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if reservation == nil {
		writeJSONError(w, http.StatusForbidden, "OAuth state already used or expired")
		return
	}
	release := func() {
		if releaseErr := d.Queries.ReleaseOAuthLoginState(r.Context(), stateHash, reservation.ReservationToken); releaseErr != nil {
			slog.Warn("release install OAuth state failed", "error", releaseErr)
		}
	}

	userToken, err := gh.ExchangeOAuthCode(d.GitHubAppClientID, d.GitHubAppClientSecret, code)
	if err != nil {
		release()
		slog.Warn("GitHub install code exchange failed", "error", err)
		writeJSONError(w, http.StatusBadGateway, "GitHub authorization failed")
		return
	}
	userInstalls, err := gh.ListUserInstallations(userToken.AccessToken)
	if err != nil {
		release()
		writeJSONError(w, http.StatusBadGateway, "could not verify GitHub installation ownership")
		return
	}
	if !containsInstallation(userInstalls, installationID) {
		release()
		writeJSONError(w, http.StatusForbidden, "installation does not belong to the authenticated GitHub user")
		return
	}
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		release()
		writeJSONError(w, http.StatusInternalServerError, "could not verify GitHub installation")
		return
	}
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		release()
		writeJSONError(w, http.StatusBadRequest, "invalid or unauthorized installation")
		return
	}
	installationToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		release()
		writeJSONError(w, http.StatusBadGateway, "could not load GitHub installation repositories")
		return
	}
	repos, err := gh.ListInstallationRepos(installationToken.Token)
	if err != nil {
		release()
		writeJSONError(w, http.StatusBadGateway, "could not load GitHub installation repositories")
		return
	}
	installationRepos := toInstallationRepos(repos)

	tx, err := d.Queries.Pool().Begin(r.Context())
	if err != nil {
		release()
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := d.Queries.FinalizeOAuthLoginState(r.Context(), tx, stateHash, reservation.ReservationToken); err != nil {
		writeJSONError(w, http.StatusConflict, "OAuth installation reservation expired; retry the installation")
		return
	}
	if err := d.Queries.PersistInstallation(r.Context(), tx, db.PersistInstallationParams{
		InstallationID: installationID,
		GitHubOrgName:  installInfo.Account.Login,
		GitHubOrgID:    installInfo.Account.ID,
		OrgID:          *reservation.TargetOrgID,
		Repos:          installationRepos,
	}); err != nil {
		if errors.Is(err, db.ErrInstallationOrgConflict) {
			writeJSONError(w, http.StatusConflict, "installation is already mapped to another organization")
			return
		}
		slog.Error("persist GitHub installation failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to store installation")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store installation")
		return
	}
	clearOAuthStateCookie(w)
	http.Redirect(w, r, d.DashboardOrigin+"/settings?github_installed=true", http.StatusFound)
}

func clearOAuthStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: "__auth_state", Value: "", Path: "/auth", MaxAge: -1, HttpOnly: true,
	})
}

func (d *Dependencies) completeOAuthIdentity(ctx context.Context, identity auth.Identity, cont oauthContinuation) (*oauthCompletion, error) {
	if d.oauthCompletion != nil {
		return d.oauthCompletion(ctx, identity, cont)
	}
	if d.Queries == nil {
		return nil, fmt.Errorf("authentication database is not configured")
	}
	if cont.FlowKind != "browser" && cont.FlowKind != "cli" {
		return nil, fmt.Errorf("invalid OAuth continuation kind %q", cont.FlowKind)
	}

	var user *db.User
	var created bool
	var err error
	if d.cloudAuthEnabled() {
		userID, orgID, provisioned, provisionErr := d.Queries.ProvisionFromIdentity(ctx, identity)
		if provisionErr != nil {
			return nil, fmt.Errorf("provision cloud identity: %w", provisionErr)
		}
		if provisioned {
			emitProvisioningUsage(identity, userID, orgID, true, false)
		}
		user, err = d.Queries.GetUserByID(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("load provisioned user: %w", err)
		}
		if user == nil {
			return nil, fmt.Errorf("load provisioned user: not found")
		}
		created = provisioned
	} else {
		user, created, err = d.provisionGitHubIdentityContext(ctx, identity)
		if err != nil {
			return nil, fmt.Errorf("provision GitHub identity: %w", err)
		}
	}

	if err := d.applyCombinedGitHubInstallationContext(ctx, user, identity, cont.TargetOrgID, cont.SetupAction, cont.InstallationID); err != nil {
		return nil, err
	}

	if cont.FlowKind == "cli" {
		if cont.CLIClientID == "" || cont.CLIRedirectURI == "" || cont.CLIOAuthState == "" ||
			cont.CLICodeChallenge == "" || cont.CLICodeChallengeMethod == "" {
			return nil, fmt.Errorf("incomplete CLI OAuth continuation; start a fresh login")
		}
		rawCode, codeHash, err := auth.GenerateAuthCode()
		if err != nil {
			return nil, fmt.Errorf("generate CLI authorization code: %w", err)
		}
		if err := d.Queries.StoreAuthorizationCode(ctx, user.ID, codeHash,
			cont.CLICodeChallenge, cont.CLICodeChallengeMethod, cont.CLIRedirectURI,
			cont.CLIClientID, time.Now().Add(authCodeTTL)); err != nil {
			return nil, fmt.Errorf("store CLI authorization code: %w", err)
		}
		redirectURL := fmt.Sprintf("%s?code=%s&state=%s", cont.CLIRedirectURI,
			url.QueryEscape(rawCode), url.QueryEscape(cont.CLIOAuthState))
		return &oauthCompletion{Mode: completionCLI, RedirectTo: redirectURL, OrgID: user.OrgID}, nil
	}

	sessionOrgID := d.oauthSessionOrgID(ctx, user, cont.TargetOrgID)
	accessToken, err := auth.SignAccessToken(d.JWTSecret, user.ID, sessionOrgID, user.Email)
	if err != nil {
		return nil, fmt.Errorf("sign access token: %w", err)
	}
	rawRefresh, hashRefresh, err := auth.GenerateRefreshToken()
	if err != nil {
		return nil, fmt.Errorf("generate refresh token: %w", err)
	}
	if err := d.Queries.StoreRefreshToken(ctx, user.ID, hashRefresh, uuid.NewString(), sessionOrgID, time.Now().Add(refreshTokenTTL)); err != nil {
		return nil, fmt.Errorf("store refresh token: %w", err)
	}
	if !created {
		emitProvisioningUsage(identity, user.ID, user.OrgID, false, true)
	}
	return &oauthCompletion{
		Mode: completionBrowser, RedirectTo: d.DashboardOrigin + "/auth/complete",
		AccessToken: accessToken, RefreshToken: rawRefresh, OrgID: sessionOrgID,
	}, nil
}

func (d *Dependencies) oauthSessionOrgID(ctx context.Context, user *db.User, targetOrgID string) string {
	sessionOrgID := user.OrgID
	if targetOrgID == "" {
		return sessionOrgID
	}
	lookup := d.membershipLookup
	if lookup == nil && d.Queries != nil {
		lookup = d.Queries.GetMembership
	}
	if lookup == nil {
		slog.Error("target organization membership revalidation unavailable; using home organization",
			"user_id", user.ID, "target_org_id", targetOrgID)
		return sessionOrgID
	}
	role, membershipErr := lookup(ctx, user.ID, targetOrgID)
	if membershipErr != nil {
		slog.Error("target organization membership revalidation failed; using home organization",
			"user_id", user.ID, "target_org_id", targetOrgID, "error", membershipErr)
	} else if role != "" {
		sessionOrgID = targetOrgID
	} else {
		slog.Warn("target organization membership no longer exists; using home organization",
			"user_id", user.ID, "target_org_id", targetOrgID)
	}
	return sessionOrgID
}

func (d *Dependencies) GitHubOAuthCallback(w http.ResponseWriter, r *http.Request) {
	d.OAuthLoginCallback(w, r)
}

func (d *Dependencies) provisionGitHubIdentity(r *http.Request, identity auth.Identity) (*db.User, error) {
	user, _, err := d.provisionGitHubIdentityContext(r.Context(), identity)
	return user, err
}

func (d *Dependencies) provisionGitHubIdentityContext(ctx context.Context, identity auth.Identity) (*db.User, bool, error) {
	githubID, err := strconv.ParseInt(identity.ProviderSubject, 10, 64)
	if err != nil {
		return nil, false, fmt.Errorf("invalid GitHub subject: %w", err)
	}
	userID, err := d.Queries.GetUserIDByIdentity(ctx, "github", identity.ProviderSubject)
	if err != nil {
		return nil, false, err
	}
	var user *db.User
	if userID != "" {
		user, err = d.Queries.GetUserByID(ctx, userID)
	} else {
		user, err = d.Queries.GetUserByGitHubID(ctx, githubID)
	}
	if err != nil {
		return nil, false, err
	}
	created := false
	if user == nil {
		existing, err := d.Queries.GetUserByEmail(ctx, identity.Email)
		if err != nil {
			return nil, false, err
		}
		if existing != nil {
			if !identity.EmailVerified {
				return nil, false, fmt.Errorf("unverified GitHub email cannot link an existing account")
			}
			if err := d.Queries.LinkUserGitHub(ctx, existing.ID, githubID, identity.Username, identity.AvatarURL); err != nil {
				return nil, false, err
			}
			user = existing
		} else {
			// Fail closed: never create an account for an unverified email, or an
			// attacker can seed an org under a victim's address and be adopted into
			// it when the victim later signs in with their verified email.
			if !identity.EmailVerified {
				return nil, false, fmt.Errorf("unverified GitHub email cannot create an account")
			}
			org, err := d.Queries.CreateOrg(ctx, identity.Username)
			if err != nil {
				return nil, false, err
			}
			user, err = d.Queries.CreateUserGitHub(ctx, org.ID, identity.Email,
				identity.Name, githubID, identity.Username, identity.AvatarURL)
			if err != nil {
				return nil, false, err
			}
			created = true
			emitProvisioningUsage(identity, user.ID, user.OrgID, true, false)
		}
	}
	// RequireMembership 403s any session without a memberships row; GitHub
	// accounts created before membership rows existed have none, so grant the
	// home-org owner row here without touching an existing (possibly
	// downgraded) role.
	role, err := d.Queries.GetMembership(ctx, user.ID, user.OrgID)
	if err != nil {
		return nil, false, err
	}
	if role == "" {
		if err := d.Queries.CreateMembership(ctx, user.ID, user.OrgID, "owner"); err != nil {
			return nil, false, err
		}
	}
	if err := d.Queries.UpdateUserGitHub(ctx, user.ID, identity.Username, identity.AvatarURL, identity.Email); err != nil {
		slog.Warn("refresh GitHub profile failed", "user_id", user.ID, "error", err)
	}
	if err := d.Queries.UpsertIdentityDetails(ctx, user.ID, "github", identity.ProviderSubject, identity.Email, identity.EmailVerified); err != nil {
		return nil, false, err
	}
	user.Email = db.NormalizeEmail(identity.Email)
	return user, created, nil
}

func (d *Dependencies) applyCombinedGitHubInstallation(r *http.Request, user *db.User, identity auth.Identity, targetOrgID string) error {
	return d.applyCombinedGitHubInstallationContext(r.Context(), user, identity, targetOrgID,
		r.URL.Query().Get("setup_action"), r.URL.Query().Get("installation_id"))
}

func (d *Dependencies) applyCombinedGitHubInstallationContext(ctx context.Context, user *db.User, identity auth.Identity, targetOrgID, setupAction, installationIDText string) error {
	if d.provider().Name() != "github" || setupAction != "install" {
		return nil
	}
	if installationIDText == "" {
		return nil
	}
	installationID, err := strconv.ParseInt(installationIDText, 10, 64)
	if err != nil || installationID <= 0 {
		return fmt.Errorf("invalid installation_id")
	}
	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		return fmt.Errorf("GitHub App not configured")
	}
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		return fmt.Errorf("generate GitHub App token: %w", err)
	}
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		return fmt.Errorf("invalid or unauthorized installation")
	}
	if identity.AccessToken == "" {
		return fmt.Errorf("cannot verify installation ownership")
	}
	userInstalls, err := gh.ListUserInstallations(identity.AccessToken)
	if err != nil {
		return fmt.Errorf("verify installation ownership: %w", err)
	}
	if !containsInstallation(userInstalls, installationID) {
		return fmt.Errorf("installation does not belong to the authenticated user")
	}
	installationToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		return fmt.Errorf("get installation token: %w", err)
	}
	repos, err := gh.ListInstallationRepos(installationToken.Token)
	if err != nil {
		return fmt.Errorf("list installation repositories: %w", err)
	}
	installationRepos := toInstallationRepos(repos)
	orgID := user.OrgID
	if targetOrgID != "" {
		role, err := d.Queries.GetMembership(ctx, user.ID, targetOrgID)
		if err != nil {
			return fmt.Errorf("verify target organization membership: %w", err)
		}
		if role == "" {
			return fmt.Errorf("authenticated user is not a member of the target organization")
		}
		orgID = targetOrgID
	}
	tx, err := d.Queries.Pool().Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin installation persistence: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := d.Queries.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: installationID,
		GitHubOrgName:  installInfo.Account.Login,
		GitHubOrgID:    installInfo.Account.ID,
		OrgID:          orgID,
		Repos:          installationRepos,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// === helpers ===

func toInstallationRepos(repos []gh.Repo) []db.InstallationRepo {
	result := make([]db.InstallationRepo, 0, len(repos))
	for _, repo := range repos {
		result = append(result, db.InstallationRepo{
			FullName:      repo.FullName,
			DefaultBranch: repo.DefaultBranch,
		})
	}
	return result
}

func generateOAuthState(secret []byte) (string, error) {
	nonce := make([]byte, 16)
	if _, err := crand.Read(nonce); err != nil {
		return "", err
	}
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write(nonce)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func validOAuthState(cookie, param string) bool {
	return cookie != "" && param != "" && hmac.Equal([]byte(cookie), []byte(param))
}

// backendOrigin returns the origin of the backend for redirect_uri construction.
func backendOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, r.Host)
}

// === GitHub App installation + repo endpoints ===

// GitHubSetupCallback is the legacy Setup URL landing page. OAuth-during-install
// callbacks use OAuthLoginCallback; this endpoint intentionally never mutates.
// GET /api/v1/github/setup?installation_id=123&setup_action=install
func (d *Dependencies) GitHubSetupCallback(w http.ResponseWriter, r *http.Request) {
	if OrgIDFromCtx(r.Context()) == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	http.Redirect(w, r, d.DashboardOrigin+"/settings?github_install_requires_authorization=true", http.StatusFound)
}

// GetGitHubAppStatus returns the GitHub App installation status for the user's org.
// GET /api/v1/github/status
func (d *Dependencies) GetGitHubAppStatus(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	installURL := ""
	if d.GitHubAppSlug != "" {
		state, err := generateOAuthState(d.JWTSecret)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if d.Queries != nil {
			if err := d.Queries.StoreOAuthLoginStateForOrg(r.Context(), auth.HashToken(state), orgID, UserIDFromCtx(r.Context()), time.Now().Add(5*time.Minute)); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}
		isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
		http.SetCookie(w, &http.Cookie{
			Name:     "__auth_state",
			Value:    state,
			Path:     "/auth",
			MaxAge:   300,
			HttpOnly: true,
			Secure:   isSecure,
			SameSite: http.SameSiteLaxMode,
		})
		installURL = fmt.Sprintf("https://github.com/apps/%s/installations/new?state=%s", d.GitHubAppSlug, url.QueryEscape(state))
	}

	type statusResponse struct {
		Installed      bool   `json:"installed"`
		InstallationID *int64 `json:"installation_id"`
		InstallURL     string `json:"install_url"`
	}

	resp := statusResponse{
		Installed:  installationID > 0,
		InstallURL: installURL,
	}
	if installationID > 0 {
		resp.InstallationID = &installationID
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ListGitHubRepos returns the repos accessible to the org's GitHub App installation.
// GET /api/v1/github/repos
func (d *Dependencies) ListGitHubRepos(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if installationID == 0 {
		writeJSONError(w, http.StatusBadRequest, "GitHub App not installed")
		return
	}

	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		slog.Error("failed to generate app JWT", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	installToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		slog.Error("failed to get installation token", "error", err, "installation_id", installationID)
		writeJSONError(w, http.StatusBadGateway, "failed to get GitHub access")
		return
	}

	repos, err := gh.ListInstallationRepos(installToken.Token)
	if err != nil {
		slog.Error("failed to list repos", "error", err)
		writeJSONError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(repos)
}
