package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type approveProjectJSON struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	GithubRepo *string `json:"github_repo"`
}

// loadApproveSession loads the session for a cookie-authenticated approve
// route and enforces org ownership once the session is bound to an org.
func (d *Dependencies) loadApproveSession(w http.ResponseWriter, r *http.Request) (*db.AgentSession, bool) {
	sessionID := chi.URLParam(r, "sessionID")
	if _, err := uuid.Parse(sessionID); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session ID")
		return nil, false
	}
	session, err := d.Queries.GetAgentSession(r.Context(), sessionID)
	if err != nil {
		slog.Error("agent approve: get session", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return nil, false
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return nil, false
	}
	if session.OrgID != nil && *session.OrgID != OrgIDFromCtx(r.Context()) {
		writeJSONError(w, http.StatusForbidden, "this setup belongs to another organization")
		return nil, false
	}
	return session, true
}

// AgentApproveInfo describes a session to the signed-in approver, with the
// org's projects so the page can offer "attach" next to "create".
//
// GET /api/v1/agent/approve/{sessionID}
func (d *Dependencies) AgentApproveInfo(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	orgID := OrgIDFromCtx(r.Context())
	status := session.Status
	if time.Now().After(session.ExpiresAt) {
		switch status {
		case "pending", "provisioned", "key_ok", "app_reporting":
			status = "expired"
		}
	}
	resp := map[string]any{
		"status":     status,
		"expires_at": session.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if session.AgentName != nil {
		resp["agent_name"] = *session.AgentName
	}
	if session.ProjectName != nil {
		resp["project_name"] = *session.ProjectName
	}
	if session.GitRemote != nil {
		resp["git_remote"] = *session.GitRemote
	}
	projects, err := d.Queries.ListProjectsByOrg(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list projects")
		return
	}
	list := make([]approveProjectJSON, 0, len(projects))
	var suggested *string
	for _, p := range projects {
		list = append(list, approveProjectJSON{ID: p.ID, Name: p.Name, GithubRepo: p.GithubRepo})
		if session.GitRemote != nil && p.GithubRepo != nil && strings.EqualFold(*p.GithubRepo, *session.GitRemote) {
			id := p.ID
			suggested = &id
		}
	}
	resp["projects"] = list
	resp["suggested_project_id"] = suggested
	if session.OrgID != nil && session.ProjectID != nil {
		resp["project_id"] = *session.ProjectID
		resp["facts"] = d.agentSessionFacts(r, session)
	}
	writeJSON(w, http.StatusOK, resp)
}

// AgentApprove completes a pending session for the signed-in user's org.
//
// POST /api/v1/agent/approve/{sessionID}
func (d *Dependencies) AgentApprove(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	var req struct {
		ProjectName       string  `json:"project_name"`
		ExistingProjectID *string `json:"existing_project_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	if err := decoder.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ExistingProjectID != nil {
		if _, err := uuid.Parse(*req.ExistingProjectID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "existing_project_id must be a UUID")
			return
		}
	}
	name := strings.TrimSpace(req.ProjectName)
	if name == "" && session.ProjectName != nil {
		name = *session.ProjectName
	}
	if name == "" {
		name = "My app"
	}
	if utf8.RuneCountInString(name) > 100 {
		writeJSONError(w, http.StatusBadRequest, "project_name must be 100 characters or less")
		return
	}
	agentKeyPub := ""
	if session.AgentKeyPub != nil {
		agentKeyPub = *session.AgentKeyPub
	}
	project, err := d.Queries.ApproveAgentSession(r.Context(), db.AgentApproveInput{
		SessionID: session.ID, OrgID: OrgIDFromCtx(r.Context()), UserID: UserIDFromCtx(r.Context()),
		ProjectName: name, ExistingProjectID: req.ExistingProjectID,
		SourcemapEndpoint: d.publicOrigin(r),
		SealKeys: func(bundle string) (string, error) {
			return auth.SealAgentKey(agentKeyPub, session.ID, bundle)
		},
	})
	switch {
	case errors.Is(err, db.ErrAgentSessionNotPending):
		writeJSONError(w, http.StatusConflict, "this setup session is no longer pending")
		return
	case errors.Is(err, db.ErrAgentProjectNotInOrg):
		writeJSONErrorCode(w, http.StatusUnprocessableEntity, "that project belongs to another organization", "project_not_in_org")
		return
	case err != nil:
		slog.Error("agent approve", "error", err, "session_id", session.ID)
		writeJSONError(w, http.StatusInternalServerError, "failed to approve")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "provisioned", "project_id": project.ID, "project_name": project.Name})
}

// AgentDeny marks the session failed so the agent stops waiting.
//
// POST /api/v1/agent/approve/{sessionID}/deny
func (d *Dependencies) AgentDeny(w http.ResponseWriter, r *http.Request) {
	session, ok := d.loadApproveSession(w, r)
	if !ok {
		return
	}
	if err := d.Queries.DenyAgentSession(r.Context(), session.ID); err != nil {
		if errors.Is(err, db.ErrAgentSessionNotPending) {
			writeJSONError(w, http.StatusConflict, "this setup session is no longer pending")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to deny")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "failed"})
}
