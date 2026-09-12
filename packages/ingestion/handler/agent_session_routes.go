package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type agentSessionCtxKey struct{}

func agentSessionFromCtx(ctx context.Context) *db.AgentSession {
	s, _ := ctx.Value(agentSessionCtxKey{}).(*db.AgentSession)
	return s
}

// loadAgentSessionForToken returns the session when the poll token matches,
// classifying the outcome as one of the HTTP statuses the routes share.
func (d *Dependencies) loadAgentSessionForToken(ctx context.Context, sessionID, token string) (*db.AgentSession, int) {
	session, err := d.Queries.GetAgentSession(ctx, sessionID)
	if err != nil {
		return nil, http.StatusInternalServerError
	}
	if token == "" || session == nil || session.PollTokenHash == nil ||
		!hmac.Equal([]byte(auth.HashToken(token)), []byte(*session.PollTokenHash)) {
		return nil, http.StatusNotFound
	}
	if session.Status == "expired" || time.Now().After(session.ExpiresAt) {
		return session, http.StatusGone
	}
	if session.ProjectID == nil || session.OrgID == nil || session.Status == "pending" || session.Status == "failed" {
		return session, http.StatusConflict
	}
	return session, http.StatusOK
}

func writeSessionGate(w http.ResponseWriter, session *db.AgentSession, status int) {
	switch status {
	case http.StatusNotFound:
		agentJSON(w, status, map[string]any{"status": "not_found"})
	case http.StatusGone:
		agentJSON(w, status, map[string]any{"status": "expired", "approved": false, "message": "session expired; ask the user to run setup again"})
	case http.StatusConflict:
		agentJSON(w, status, map[string]any{"status": session.Status, "message": "session is not approved yet"})
	default:
		agentJSON(w, status, map[string]any{"status": "internal_error", "message": "internal error"})
	}
}

// agentSessionResponse holds the small JSON response until the final expiry
// check. A database or network operation cannot release stale session facts.
type agentSessionResponse struct {
	http.ResponseWriter
	body   bytes.Buffer
	status int
}

func (w *agentSessionResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *agentSessionResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}

// refreshAgentSession guards mutations after decoding a potentially slow body.
func (d *Dependencies) refreshAgentSession(w http.ResponseWriter, r *http.Request) bool {
	s := agentSessionFromCtx(r.Context())
	if !time.Now().Before(s.ExpiresAt) {
		writeSessionGate(w, s, http.StatusGone)
		return false
	}
	current, status := d.loadAgentSessionForToken(r.Context(), s.ID, r.Header.Get("X-Opslane-Poll-Token"))
	if status != http.StatusOK {
		writeSessionGate(w, current, status)
		return false
	}
	*s = *current
	return true
}

// AgentSessionAuth authenticates a session-scoped route with the poll token
// and requires an approved, unexpired session.
func (d *Dependencies) AgentSessionAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store") // every response on these routes, including rejections and the bare 204
		if !agentPollLimiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			agentJSON(w, http.StatusTooManyRequests, map[string]any{"status": "rate_limited", "retry_after": 60})
			return
		}
		sessionID := chi.URLParam(r, "sessionID")
		if _, err := uuid.Parse(sessionID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid session ID")
			return
		}
		session, status := d.loadAgentSessionForToken(r.Context(), sessionID, r.Header.Get("X-Opslane-Poll-Token"))
		if status != http.StatusOK {
			writeSessionGate(w, session, status)
			return
		}
		ctx, cancel := context.WithDeadline(r.Context(), session.ExpiresAt)
		defer cancel()
		response := &agentSessionResponse{ResponseWriter: w}
		next.ServeHTTP(response, r.WithContext(context.WithValue(ctx, agentSessionCtxKey{}, session)))
		if !time.Now().Before(session.ExpiresAt) {
			writeSessionGate(w, session, http.StatusGone)
			return
		}
		if response.status != 0 {
			w.WriteHeader(response.status)
			_, _ = w.Write(response.body.Bytes())
		}
	})
}

// AgentSessionState returns the server facts, optionally holding until one
// flips. The session is re-read every second so expiry ends the wait.
//
// GET /api/v1/agent/poll/{sessionID}/state?wait=30&until=event|github|slack|change
func (d *Dependencies) AgentSessionState(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	token := r.Header.Get("X-Opslane-Poll-Token")
	wait := parseWait(r.URL.Query().Get("wait"))
	until := r.URL.Query().Get("until")
	if until == "" {
		until = "change"
	}
	switch until {
	case "event", "github", "slack", "change":
	default:
		writeJSONError(w, http.StatusBadRequest, "until must be event, github, slack, or change")
		return
	}
	if wait > 0 && !agentWaiters.acquire(s.ID) {
		// Too many holders on one session: answer now instead of stacking
		// per-second fact queries. The runbook only ever holds one wait.
		wait = 0
	} else if wait > 0 {
		defer agentWaiters.release(s.ID)
	}
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	var first *agentFacts
	for {
		// Between ticks only the gating fact is read; the full set is
		// evaluated once for the response.
		done := true
		switch until {
		case "event":
			done, _ = d.Queries.HasEventsSince(r.Context(), *s.ProjectID, s.CreatedAt)
		case "github":
			done = d.agentSessionFacts(r, s).GitHubConnected
		case "slack":
			done, _ = d.Queries.HasEnabledSlackDestination(r.Context(), *s.ProjectID)
		case "change":
			f := d.agentSessionFacts(r, s)
			if first == nil {
				snapshot := f
				first = &snapshot
			}
			done = !reflect.DeepEqual(f, *first)
		}
		if done || wait == 0 || time.Now().After(deadline) {
			f := d.agentSessionFacts(r, s)
			resp := map[string]any{
				"status": s.Status, "project_id": *s.ProjectID, "dashboard_url": d.publicOrigin(r) + "/?project_id=" + *s.ProjectID,
				"expires_at": s.ExpiresAt.UTC().Format(time.RFC3339),
			}
			if s.ProjectName != nil {
				resp["project_name"] = *s.ProjectName
			}
			mergeFacts(resp, f)
			agentJSON(w, http.StatusOK, resp)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
		var status int
		if s, status = d.loadAgentSessionForToken(r.Context(), s.ID, token); status != http.StatusOK {
			writeSessionGate(w, s, status)
			return
		}
	}
}

// sessionWaiters caps concurrent long-polls per session so one leaked or
// looping client cannot multiply per-second fact queries.
type sessionWaiters struct {
	mu    sync.Mutex
	count map[string]int
}

const maxWaitersPerSession = 2

var agentWaiters = &sessionWaiters{count: map[string]int{}}

func (s *sessionWaiters) acquire(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.count[id] >= maxWaitersPerSession {
		return false
	}
	s.count[id]++
	return true
}

func (s *sessionWaiters) release(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.count[id] <= 1 {
		delete(s.count, id)
		return
	}
	s.count[id]--
}

// POST /api/v1/agent/poll/{sessionID}/github  {"repo":"owner/repo"}
func (d *Dependencies) AgentSessionGitHub(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		Repo string `json:"repo"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil || !repoURLPattern.MatchString(req.Repo) {
		writeJSONError(w, http.StatusBadRequest, "repo must be in owner/repo format")
		return
	}
	if !d.refreshAgentSession(w, r) {
		return
	}
	connectURL := d.publicOrigin(r) + "/settings?project_id=" + *s.ProjectID + "#github"
	canonical, failure := d.attachGitHubRepo(r.Context(), *s.OrgID, *s.ProjectID, req.Repo, connectURL)
	if failure != nil {
		writeGitHubFailure(w, failure)
		return
	}
	agentJSON(w, http.StatusOK, map[string]any{"github_connected": true, "github_repo": canonical})
}

// POST /api/v1/agent/poll/{sessionID}/slack  {"webhook_url":"https://hooks.slack.com/..."}
func (d *Dependencies) AgentSessionSlack(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		WebhookURL string `json:"webhook_url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil || req.WebhookURL == "" {
		writeJSONError(w, http.StatusBadRequest, "webhook_url is required")
		return
	}
	if !d.refreshAgentSession(w, r) {
		return
	}
	destID, ok, errMsg, classification, err := d.createTestEnableSlack(r.Context(), *s.OrgID, *s.ProjectID, req.WebhookURL)
	switch {
	case errors.Is(err, errSlackValidation):
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, errSlackUnavailable):
		writeJSONError(w, http.StatusServiceUnavailable, "notifications are not configured on this server")
		return
	case err != nil:
		slog.Error("agent slack: create/test/enable", "error", err, "session_id", s.ID)
		writeJSONError(w, http.StatusInternalServerError, "failed to save destination")
		return
	}
	resp := map[string]any{"ok": ok}
	if ok {
		resp["destination_id"] = destID
	} else {
		resp["error"] = errMsg
		resp["classification"] = classification
	}
	agentJSON(w, http.StatusOK, resp)
}

// POST /api/v1/agent/poll/{sessionID}/progress  {"step":"install_sdk","status":"running","note":""}
func (d *Dependencies) AgentSessionProgress(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	var req struct {
		Step   string `json:"step"`
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Status {
	case "pending", "running", "done", "skipped", "failed":
	default:
		writeJSONError(w, http.StatusBadRequest, "unknown status")
		return
	}
	switch req.Step {
	case "install_sdk", "mcp", "pull_request":
	case "first_event", "github", "slack", "sourcemaps":
		if req.Status != "failed" && req.Status != "skipped" {
			writeJSONError(w, http.StatusBadRequest, "server-derived step accepts only failed or skipped")
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "unknown step")
		return
	}
	if utf8.RuneCountInString(req.Note) > 500 {
		writeJSONError(w, http.StatusBadRequest, "note must be 500 characters or less")
		return
	}
	if !d.refreshAgentSession(w, r) {
		return
	}
	if err := d.Queries.UpsertAgentStep(r.Context(), s.ID, req.Step, req.Status, req.Note); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to record progress")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/v1/agent/poll/{sessionID}/complete
func (d *Dependencies) AgentSessionComplete(w http.ResponseWriter, r *http.Request) {
	s := agentSessionFromCtx(r.Context())
	if !d.refreshAgentSession(w, r) {
		return
	}
	// A 200 here is the runbook's proof that this session's test error
	// arrived, so the event check applies even when the org is already
	// onboarded from an earlier project.
	has, err := d.Queries.HasEventsSince(r.Context(), *s.ProjectID, s.CreatedAt)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to check events")
		return
	}
	if !has {
		agentJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "missing_facts", "missing": []string{"first_event"}})
		return
	}
	if err := d.Queries.MarkOrgOnboarded(r.Context(), *s.OrgID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to complete onboarding")
		return
	}
	agentJSON(w, http.StatusOK, map[string]any{"onboarding_complete": true})
}
