package handler

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// AgentGitHubInstallURL mints the GitHub App install link for an agent
// session's organization.
func (d *Dependencies) AgentGitHubInstallURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
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
	if time.Now().After(session.ExpiresAt) || session.Status == "expired" || session.Status == "failed" {
		writeJSONErrorCode(w, http.StatusGone, "this setup session has ended; ask the agent to run setup again", "session_ended")
		return
	}
	if session.OrgID == nil {
		writeJSONErrorCode(w, http.StatusConflict, "approve the setup first", "session_not_provisioned")
		return
	}
	if *session.OrgID != OrgIDFromCtx(r.Context()) {
		writeJSONErrorCode(w, http.StatusForbidden, "this setup belongs to another organization", "foreign_org")
		return
	}
	if d.GitHubAppSlug == "" {
		writeJSONErrorCode(w, http.StatusBadRequest, "this Opslane has no GitHub App; connect a repository from Settings with a token", "github_app_not_configured")
		return
	}
	installURL, err := d.startGitHubInstall(w, r, *session.OrgID)
	if err != nil {
		slog.Error("start agent GitHub install failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"install_url": installURL})
}
