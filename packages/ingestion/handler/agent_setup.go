package handler

import (
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var agentSetupLimiter = newRateLimiter(5)
var agentPollLimiter = newRateLimiter(30)
var repoURLPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`)

func agentJSON(w http.ResponseWriter, code int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

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

	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req struct {
		ProjectName   string `json:"project_name"`
		AgentName     string `json:"agent_name"`
		GitRemote     string `json:"git_remote"`
		FrameworkHint string `json:"framework_hint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.ProjectName = strings.TrimSpace(req.ProjectName)
	if req.ProjectName == "" {
		writeJSONError(w, http.StatusBadRequest, "project_name is required")
		return
	}
	if utf8.RuneCountInString(req.ProjectName) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}
	if req.GitRemote != "" && !repoURLPattern.MatchString(req.GitRemote) {
		writeJSONError(w, http.StatusBadRequest, "git_remote must be in owner/repo format")
		return
	}
	if utf8.RuneCountInString(req.AgentName) > 100 {
		req.AgentName = string([]rune(req.AgentName)[:100])
	}

	pollToken, tokenHash, agentKeyPub, err := auth.NewAgentPollToken()
	if err != nil {
		slog.Error("agent setup: generate poll token", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
		return
	}
	var agentName, gitRemote *string
	if req.AgentName != "" {
		agentName = &req.AgentName
	}
	if req.GitRemote != "" {
		gitRemote = &req.GitRemote
	}
	session, err := d.Queries.CreateAgentSession(r.Context(), db.CreateAgentSessionParams{
		RepoURL: req.GitRemote, AgentName: agentName, ProjectName: &req.ProjectName, GitRemote: gitRemote,
		PollTokenHash: tokenHash, AgentKeyPub: agentKeyPub,
	})
	if err != nil {
		slog.Error("agent setup: create session", "error", err)
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "failed to create setup session"})
		return
	}
	authURL := d.publicOrigin(r) + "/agent/auth/" + session.ID
	agentJSON(w, http.StatusCreated, map[string]any{
		"status":       "auth_required",
		"auth_url":     authURL,
		"poll_id":      session.ID,
		"poll_token":   pollToken,
		"expires_at":   session.ExpiresAt.UTC().Format(time.RFC3339),
		"project_name": req.ProjectName,
		"message":      "Ask the user to open " + authURL + ", sign in or create an account, and click Approve. Then poll with ?wait=30 until approved is true; stop on failed or expired.",
	})
}
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
		agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
		return
	}
	if session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(pollToken)), []byte(*session.PollTokenHash)) {
		agentJSON(w, http.StatusNotFound, map[string]any{"status": "not_found"})
		return
	}
	d.writeAgentPollResponse(w, r, session, pollToken)
}

// writeAgentPollResponse renders a session for the agent. Expiry is checked
// first for every status: nothing about an expired session is returned.
func (d *Dependencies) writeAgentPollResponse(w http.ResponseWriter, r *http.Request, session *db.AgentSession, pollToken string) {
	if session.Status == "expired" || time.Now().After(session.ExpiresAt) {
		agentJSON(w, http.StatusGone, map[string]any{"status": "expired", "approved": false, "message": "session expired; ask the user to run setup again"})
		return
	}
	switch session.Status {
	case "completed", "provisioned", "key_ok", "app_reporting":
		resp := map[string]any{
			"status":        session.Status,
			"approved":      true,
			"dashboard_url": d.publicOrigin(r),
		}
		if session.ProjectName != nil {
			resp["project_name"] = *session.ProjectName
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
		}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		if session.APIKeySealed == nil {
			resp["message"] = "key delivery window closed; ask the user to run setup again"
		} else {
			opened, openErr := auth.OpenAgentKey(pollToken, session.ID, *session.APIKeySealed)
			if openErr != nil {
				slog.Error("agent poll: open sealed key", "error", openErr, "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
				return
			}
			var bundle db.AgentKeyBundle
			if err := json.Unmarshal([]byte(opened), &bundle); err != nil || bundle.IngestKey == "" {
				slog.Error("agent poll: sealed payload is not a key bundle", "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
				return
			}
			resp["ingest_key"] = bundle.IngestKey
			resp["api_key"] = bundle.APIKey
			resp["sourcemap_key"] = bundle.SourcemapKey
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
			"status": "failed", "approved": false, "failure_reason": reason, "message": agentFailureMessage(reason),
		})
	default:
		agentJSON(w, http.StatusOK, map[string]any{
			"status": "pending", "approved": false,
			"message": "Waiting for the user to approve in the browser. Poll again with ?wait=30.",
		})
	}
}

func agentFailureMessage(reason string) string {
	if reason == "authorization_denied" {
		return "The user declined this setup in Opslane. Stop here."
	}
	return "Setup failed. Ask the user to run setup again."
}

// AgentAuthRedirect sends the human to the dashboard approve page. Sign-in
// happens there through the normal provider; the SPA parks this path and
// returns to it after login.
//
// GET /agent/auth/{sessionID}
func (d *Dependencies) AgentAuthRedirect(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return
	}
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	if time.Now().After(session.ExpiresAt) {
		http.Error(w, "This setup link has expired. Ask your agent to run setup again.", http.StatusGone)
		return
	}
	if err := d.Queries.MarkAgentSessionAuthClicked(r.Context(), sessionID); err != nil {
		slog.Warn("agent auth redirect: stamp click", "error", err)
	}
	http.Redirect(w, r, d.publicOrigin(r)+"/agent/approve/"+sessionID, http.StatusFound)
}

// publicOrigin is the origin humans use for links: the configured callback
// origin in production, the request's own origin in tests and dev.
func (d *Dependencies) publicOrigin(r *http.Request) string {
	if d.AuthCallbackOrigin != "" {
		return d.AuthCallbackOrigin
	}
	return backendOrigin(r)
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
