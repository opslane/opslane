package handler

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var agentSetupLimiter = newRateLimiter(5)
var agentPollLimiter = newRateLimiter(60)
var repoURLPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`)

func agentJSON(w http.ResponseWriter, code int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func (d *Dependencies) AgentSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
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
		ProjectName string `json:"project_name"`
		AgentName   string `json:"agent_name"`
		GitRemote   string `json:"git_remote"`
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
	w.Header().Set("Cache-Control", "no-store")
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

	wait := parseWait(r.URL.Query().Get("wait"))
	untilEvent := r.URL.Query().Get("until") == "event"
	if wait > 0 && !agentWaiters.acquire(sessionID) {
		wait = 0 // too many holders on this session: answer now
	} else if wait > 0 {
		defer agentWaiters.release(sessionID)
	}
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	for {
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
		terminal := session.Status == "failed" || session.Status == "expired" || time.Now().After(session.ExpiresAt)
		approved := session.Status != "pending" && !terminal
		var facts agentFacts
		if approved {
			ctx, cancel := context.WithDeadline(r.Context(), session.ExpiresAt)
			facts = d.agentSessionFacts(r.WithContext(ctx), session)
			cancel()
		}
		// completed is approved and final: never hold a wait on it.
		done := terminal || session.Status == "completed" || (approved && (!untilEvent || facts.HasEvents))
		if done || wait == 0 || time.Now().After(deadline) {
			d.writeAgentPollResponse(w, r, session, pollToken, facts)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// writeAgentPollResponse renders a session for the agent. Expiry is checked
// first for every status: nothing about an expired session is returned.
func (d *Dependencies) writeAgentPollResponse(w http.ResponseWriter, r *http.Request, session *db.AgentSession, pollToken string, facts agentFacts) {
	if session.Status == "expired" || time.Now().After(session.ExpiresAt) {
		agentJSON(w, http.StatusGone, map[string]any{"status": "expired", "approved": false, "message": "session expired; ask the user to run setup again"})
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), session.ExpiresAt)
	defer cancel()
	r = r.WithContext(ctx)
	switch session.Status {
	case "completed", "provisioned", "key_ok", "app_reporting":
		resp := map[string]any{
			"status":        session.Status,
			"approved":      true,
			"dashboard_url": d.publicOrigin(r),
		}
		mergeFacts(resp, facts)
		resp["next"] = agentNextHint(session.Status, facts)
		resp["status_help"] = agentStatusHelp

		if session.ProjectName != nil {
			resp["project_name"] = *session.ProjectName
		}
		if session.ProjectID != nil {
			resp["project_id"] = *session.ProjectID
			resp["dashboard_url"] = d.publicOrigin(r) + "/?project_id=" + *session.ProjectID
		}
		if session.OrgID != nil {
			resp["org_id"] = *session.OrgID
		}
		windowClosed := session.APIKeySealed == nil ||
			(session.KeyClaimedAt != nil && time.Since(*session.KeyClaimedAt) > db.AgentKeyDeliveryWindow)
		if windowClosed {
			resp["message"] = "key delivery window closed; ask the user to run setup again"
		} else {
			opened, openErr := auth.OpenAgentKey(pollToken, session.ID, *session.APIKeySealed)
			if openErr != nil {
				slog.Error("agent poll: open sealed key", "error", openErr, "session_id", session.ID)
				agentJSON(w, http.StatusInternalServerError, map[string]any{"status": "internal_error", "message": "internal error"})
				return
			}
			var bundle db.AgentKeyBundle
			if err := json.Unmarshal([]byte(opened), &bundle); err != nil || bundle.IngestKey == "" || bundle.APIKey == "" || bundle.SourcemapKey == "" {
				// A session sealed by the retired CLI path holds a raw key,
				// not a bundle. Its keys are unrecoverable here; report the
				// window closed rather than a server error.
				slog.Warn("agent poll: sealed payload is not a key bundle", "session_id", session.ID)
				resp["message"] = "key delivery window closed; ask the user to run setup again"
			} else {
				resp["ingest_key"] = bundle.IngestKey
				resp["api_key"] = bundle.APIKey
				resp["sourcemap_key"] = bundle.SourcemapKey
				if err := d.Queries.MarkAgentKeyDelivered(r.Context(), session.ID); err != nil {
					slog.Warn("agent poll: mark delivered", "error", err)
				}
			}
		}
		if !time.Now().Before(session.ExpiresAt) {
			writeSessionGate(w, session, http.StatusGone)
			return
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
func containsInstallation(ids []int64, id int64) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}
