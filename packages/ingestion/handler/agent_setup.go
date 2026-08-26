package handler

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// Rate limiters for agent endpoints
var agentSetupLimiter = newRateLimiter(5) // 5/min per IP — session creation
var agentPollLimiter = newRateLimiter(30) // 30/min per IP — polling

// repoURLPattern validates owner/repo format
var repoURLPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`)

// agentJSON writes the stable response shape consumed by the agent CLI.
func agentJSON(w http.ResponseWriter, code int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// AgentSetup creates a new agent session for a CLI-initiated auth flow.
// No auth required — this initiates the auth flow.
//
// POST /api/v1/agent/setup
func (d *Dependencies) AgentSetup(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !agentSetupLimiter.allow(ip) {
		slog.Warn("agent setup rate limit exceeded", "ip", ip)
		w.Header().Set("Retry-After", "60")
		agentJSON(w, http.StatusTooManyRequests, map[string]any{
			"status": "rate_limited", "retry_after": 60,
			"message": "too many requests, try again later",
		})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64KB
	var req struct {
		RepoURL   string `json:"repo_url"`
		AgentName string `json:"agent_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RepoURL == "" {
		writeJSONError(w, http.StatusBadRequest, "repo_url is required")
		return
	}
	if !repoURLPattern.MatchString(req.RepoURL) {
		writeJSONError(w, http.StatusBadRequest, "repo_url must be in owner/repo format")
		return
	}

	// Check for returning user — repo already has a project
	existingProject, err := d.Queries.FindProjectByRepoURL(r.Context(), req.RepoURL)
	if err != nil {
		slog.Error("agent setup: find project by repo", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{
			"status": "internal_error", "message": "internal error",
		})
		return
	}
	if existingProject != nil {
		agentJSON(w, http.StatusOK, map[string]any{
			"status":  "already_configured",
			"repo":    req.RepoURL,
			"message": "This repo already has an Opslane project. Run 'opslane onboard' in this repo to get a fresh key.",
		})
		return
	}

	pollToken, tokenHash, agentKeyPub, err := auth.NewAgentPollToken()
	if err != nil {
		slog.Error("agent setup: generate poll token", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{
			"status": "internal_error", "message": "internal error",
		})
		return
	}

	var agentName *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}
	session, err := d.Queries.CreateAgentSession(r.Context(), db.CreateAgentSessionParams{
		RepoURL: req.RepoURL, AgentName: agentName,
		PollTokenHash: tokenHash, AgentKeyPub: agentKeyPub,
	})
	if err != nil {
		slog.Error("agent setup: create session", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{
			"status": "internal_error", "message": "failed to create setup session",
		})
		return
	}

	// Build the auth URL — human clicks this to install the GitHub App
	origin := d.AuthCallbackOrigin
	if origin == "" {
		origin = backendOrigin(r)
	}
	authURL := fmt.Sprintf("%s/agent/auth/%s", origin, session.ID)

	agentJSON(w, http.StatusCreated, map[string]any{
		"status":     "auth_required",
		"auth_url":   authURL,
		"poll_id":    session.ID,
		"poll_token": pollToken,
		"message":    fmt.Sprintf("Authorize Opslane: %s", authURL),
	})
}

// AgentPoll checks the status of an agent session.
// The session UUID is a routing identifier; X-Opslane-Poll-Token is the secret.
//
// GET /api/v1/agent/poll/{sessionID}
func (d *Dependencies) AgentPoll(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !agentPollLimiter.allow(ip) {
		w.Header().Set("Retry-After", "60")
		agentJSON(w, http.StatusTooManyRequests, map[string]any{
			"status": "rate_limited", "retry_after": 60,
			"message": "too many requests, try again later",
		})
		return
	}

	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing session ID")
		return
	}

	// Validate UUID format
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}

	pollToken := r.Header.Get("X-Opslane-Poll-Token")
	if pollToken == "" {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}

	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent poll: get session", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{
			"status": "internal_error", "message": "internal error",
		})
		return
	}
	if session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(pollToken)), []byte(*session.PollTokenHash)) {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}

	switch session.Status {
	case "completed", "provisioned", "key_ok", "app_reporting":
		resp := map[string]any{
			"status": session.Status,
			"repo":   session.RepoURL,
		}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
		}

		if session.APIKeySealed == nil || time.Now().After(session.ExpiresAt) {
			resp["message"] = "key delivery window closed; run \"opslane onboard\" for an existing project, or re-run provisioning"
		} else {
			apiKey, openErr := auth.OpenAgentKey(pollToken, session.ID, *session.APIKeySealed)
			if openErr != nil {
				slog.Error("agent poll: open sealed key", "error", openErr, "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{
					"status": "internal_error", "message": "internal error",
				})
				return
			}
			resp["api_key"] = apiKey
			if err := d.Queries.MarkAgentKeyDelivered(r.Context(), session.ID); err != nil {
				slog.Warn("agent poll: mark delivered", "error", err)
			}
		}
		agentJSON(w, http.StatusOK, resp)

	case "failed":
		reason := ""
		if session.FailureReason != nil {
			reason = *session.FailureReason
		}
		agentJSON(w, http.StatusOK, map[string]any{
			"status": "failed", "failure_reason": reason,
			"message": agentFailureMessage(reason),
		})

	case "expired":
		agentJSON(w, http.StatusGone, map[string]any{
			"status": "expired", "message": "session expired; re-run setup",
		})

	default: // pending
		// ExpireAgentSessions only flips the status column hourly. Read the
		// window directly so a lapsed session reports expired immediately,
		// matching what AgentAuthRedirect already tells the human.
		if time.Now().After(session.ExpiresAt) {
			agentJSON(w, http.StatusGone, map[string]any{
				"status": "expired", "message": "session expired; re-run setup",
			})
			return
		}
		resp := map[string]any{"status": "pending"}
		if installationID, _, lookupErr := d.Queries.FindRecentInstallationLandedByRepo(r.Context(), session.RepoURL); lookupErr != nil {
			slog.Warn("agent poll: landed installation diagnosis failed", "error", lookupErr)
		} else if installationID != 0 {
			resp["diagnosis"] = "A GitHub App installation for this repository completed outside this setup session. Reopen this session's authorization link to verify ownership and continue."
		}
		agentJSON(w, http.StatusOK, resp)
	}
}

// AgentAuthRedirect redirects the human to the GitHub App installation page.
// The session ID is passed as state so we can complete the session on callback.
//
// GET /agent/auth/{sessionID}
func (d *Dependencies) AgentAuthRedirect(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing session ID")
		return
	}

	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}

	if d.GitHubAppSlug == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	// Verify session exists and is pending
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent auth redirect: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	if session.Status != "pending" {
		writeJSONError(w, http.StatusGone, "session already completed or expired")
		return
	}
	if time.Now().After(session.ExpiresAt) {
		writeJSONError(w, http.StatusGone, "session expired")
		return
	}
	if err := d.Queries.MarkAgentSessionAuthClicked(r.Context(), sessionID); err != nil {
		slog.Warn("agent auth redirect: stamp click", "error", err)
	}

	// Redirect to GitHub App installation with state=sessionID
	installURL := fmt.Sprintf(
		"https://github.com/apps/%s/installations/new?state=%s",
		d.GitHubAppSlug,
		sessionID,
	)
	http.Redirect(w, r, installURL, http.StatusFound)
}

func agentFailureMessage(reason string) string {
	switch reason {
	case "identity_unverified":
		return "Your GitHub account has no verified email. Verify an email on GitHub, then re-run setup."
	case "installation_not_yours":
		return "The GitHub App installation could not be verified as yours. Re-run setup and complete the authorization yourself."
	case "repo_not_granted":
		return "The GitHub App installation does not include this repository. Add the repo to the installation on GitHub, then re-run setup."
	case "org_exists_needs_invite":
		return "This GitHub org already has an Opslane organization. Ask an Opslane admin of that org to invite you, then use the dashboard for a key."
	case "repo_already_configured":
		return "This repo already has an Opslane project. Run 'opslane onboard' in this repo."
	case "authorization_denied":
		return "GitHub authorization was denied. Re-run setup when you are ready to approve access."
	default:
		return "Setup failed. Re-run setup to try again."
	}
}

// AgentAuthCallback completes an agent session after GitHub authorizes the
// human and installs the App. Transient failures leave the session pending;
// only definitive business outcomes mark it failed.
func (d *Dependencies) AgentAuthCallback(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("state")
	if sessionID == "" {
		http.Error(w, "Missing session ID", http.StatusBadRequest)
		return
	}
	if _, err := uuid.Parse(sessionID); err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent callback: get session", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
		return
	}
	if session == nil || session.Status != "pending" || time.Now().After(session.ExpiresAt) {
		agentResultPage(w, http.StatusGone, "Session expired",
			"This setup session is no longer active. Ask your agent to run setup again.")
		return
	}
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		if providerError == "access_denied" {
			d.failAgentSession(r.Context(), sessionID, "authorization_denied")
			agentResultPage(w, http.StatusOK, "Authorization denied", agentFailureMessage("authorization_denied"))
			return
		}
		agentResultPage(w, http.StatusBadRequest, "Authorization incomplete",
			"GitHub did not complete authorization. Reopen the authorization link to retry.")
		return
	}

	installationIDStr := r.URL.Query().Get("installation_id")
	if installationIDStr == "" {
		agentResultPage(w, http.StatusBadRequest, "Authorization incomplete",
			"GitHub did not return an installation reference. Reopen the authorization link to retry.")
		return
	}
	installationID, parseErr := strconv.ParseInt(installationIDStr, 10, 64)
	if parseErr != nil || installationID <= 0 {
		agentResultPage(w, http.StatusBadRequest, "Invalid installation",
			"GitHub sent an invalid installation reference. Reopen the authorization link to retry.")
		return
	}
	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 || d.GitHubAppClientID == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "GitHub App not configured")
		return
	}

	code := r.URL.Query().Get("code")
	if code == "" {
		agentResultPage(w, http.StatusBadRequest, "Authorization incomplete",
			"GitHub did not return an authorization code. Reopen the authorization link and approve access.")
		return
	}
	token, err := gh.ExchangeOAuthCode(d.GitHubAppClientID, d.GitHubAppClientSecret, code)
	if err != nil {
		slog.Warn("agent callback: code exchange failed", "error", err)
		agentResultPage(w, http.StatusBadGateway, "GitHub authorization failed",
			"Could not confirm your GitHub identity. Reopen the authorization link to retry.")
		return
	}
	ghUser, err := gh.GetUser(token.AccessToken)
	if err != nil || ghUser == nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub authorization failed",
			"Could not load your GitHub profile. Reopen the authorization link to retry.")
		return
	}
	email, emailVerified, err := pickVerifiedEmail(token.AccessToken)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed",
			"Could not load your GitHub email addresses. Reopen the authorization link to retry.")
		return
	}

	userInstalls, err := gh.ListUserInstallations(token.AccessToken)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed",
			"Could not verify the installation. Reopen the authorization link to retry.")
		return
	}
	if !containsInstallation(userInstalls, installationID) {
		d.failAgentSession(r.Context(), sessionID, "installation_not_yours")
		agentResultPage(w, http.StatusForbidden, "Installation mismatch",
			agentFailureMessage("installation_not_yours"))
		return
	}

	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		slog.Error("agent callback: app jwt", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
		return
	}
	installInfo, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil {
		agentResultPage(w, http.StatusBadRequest, "Installation not recognized",
			"This installation does not belong to the Opslane app. Reopen the authorization link to retry.")
		return
	}
	instToken, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed", "Reopen the authorization link to retry.")
		return
	}
	repos, err := gh.ListInstallationRepos(instToken.Token)
	if err != nil {
		agentResultPage(w, http.StatusBadGateway, "GitHub check failed", "Reopen the authorization link to retry.")
		return
	}
	canonical := ""
	canonicalDefaultBranch := ""
	for _, repo := range repos {
		if strings.EqualFold(repo.FullName, session.RepoURL) {
			canonical = repo.FullName
			canonicalDefaultBranch = repo.DefaultBranch
			break
		}
	}
	if canonical == "" {
		d.failAgentSession(r.Context(), sessionID, "repo_not_granted")
		agentResultPage(w, http.StatusForbidden, "Repository not granted",
			agentFailureMessage("repo_not_granted"))
		return
	}

	agentKeyPub := ""
	if session.AgentKeyPub != nil {
		agentKeyPub = *session.AgentKeyPub
	}
	res, err := d.Queries.ProvisionAgentSession(r.Context(), db.AgentProvisionInput{
		SessionID:              sessionID,
		InstallationID:         installationID,
		CanonicalRepo:          canonical,
		Repos:                  toInstallationRepos(repos),
		CanonicalDefaultBranch: canonicalDefaultBranch,
		GitHubOrgName:          installInfo.Account.Login,
		GitHubOrgID:            installInfo.Account.ID,
		GitHubUserID:           ghUser.ID,
		GitHubLogin:            ghUser.Login,
		DisplayName:            ghUser.Name,
		Email:                  email,
		EmailVerified:          emailVerified,
		AvatarURL:              ghUser.AvatarURL,
		SealKey: func(rawKey string) (string, error) {
			return auth.SealAgentKey(agentKeyPub, sessionID, rawKey)
		},
	})
	switch {
	case err == nil:
		emitProvisioningUsage(auth.Identity{
			Provider: "github", Email: email,
		}, res.UserID, res.OrgID, res.Created, false)
		slog.Info("agent session provisioned", "session_id", sessionID,
			"org_id", res.OrgID, "project_id", res.ProjectID, "repo", canonical)
		agentResultPage(w, http.StatusOK, "Done!",
			fmt.Sprintf("Opslane is set up for <strong>%s</strong>. Your agent is finishing the integration — you can close this tab.",
				template.HTMLEscapeString(canonical)))
	case errors.Is(err, db.ErrAgentIdentityUnverified),
		errors.Is(err, db.ErrAgentOrgExistsNeedsInvite),
		errors.Is(err, db.ErrAgentRepoAlreadyConfigured):
		reason := agentReasonForErr(err)
		agentResultPage(w, http.StatusForbidden, "Setup could not finish", agentFailureMessage(reason))
	case errors.Is(err, db.ErrAgentSessionNotPending):
		agentResultPage(w, http.StatusGone, "Session already handled",
			"This setup session was already provisioned or expired. Check back with your agent.")
	default:
		slog.Error("agent callback: provision failed", "error", err)
		agentResultPage(w, http.StatusInternalServerError, "Something went wrong", "Reopen the authorization link to retry.")
	}
}

func (d *Dependencies) failAgentSession(ctx context.Context, sessionID, reason string) {
	if _, err := d.Queries.MarkAgentSessionFailed(ctx, sessionID, reason); err != nil {
		slog.Error("agent callback: mark failed", "error", err, "reason", reason)
	}
}

func agentReasonForErr(err error) string {
	switch {
	case errors.Is(err, db.ErrAgentIdentityUnverified):
		return "identity_unverified"
	case errors.Is(err, db.ErrAgentOrgExistsNeedsInvite):
		return "org_exists_needs_invite"
	case errors.Is(err, db.ErrAgentRepoAlreadyConfigured):
		return "repo_already_configured"
	default:
		return ""
	}
}

func pickVerifiedEmail(userToken string) (string, bool, error) {
	emails, err := gh.GetUserEmails(userToken)
	if err != nil {
		return "", false, fmt.Errorf("fetch user emails: %w", err)
	}
	for _, email := range emails {
		if email.Primary && email.Verified {
			return email.Email, true, nil
		}
	}
	for _, email := range emails {
		if email.Verified {
			return email.Email, true, nil
		}
	}
	return "", false, nil
}

func containsInstallation(ids []int64, id int64) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func agentResultPage(w http.ResponseWriter, status int, title, bodyHTML string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Opslane Setup</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
<h1>%s</h1><p>%s</p>
</body></html>`, template.HTMLEscapeString(title), bodyHTML)
}
