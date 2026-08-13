package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GetIncidentStatusInternal returns only the lifecycle status of one incident.
// The deployment smoke test holds the internal read token but no user session,
// and the status string is what it needs to confirm the worker finished. The
// full incident (title, stack, diff, evidence) stays behind session auth.
func (d *Dependencies) GetIncidentStatusInternal(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	incidentID := chi.URLParam(r, "incidentID")
	// error_groups keys are uuid columns; a malformed id would fail the cast
	// inside Postgres and surface as a 500 rather than a miss.
	if _, err := uuid.Parse(projectID); err != nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}
	if _, err := uuid.Parse(incidentID); err != nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	group, err := d.Queries.GetErrorGroup(r.Context(), projectID, incidentID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get incident")
		return
	}
	if group == nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": group.Status})
}
