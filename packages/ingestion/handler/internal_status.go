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
	// error_groups keys are uuid columns; a malformed id would fail the cast
	// inside Postgres and surface as a 500 rather than a miss. Query with the
	// canonical form: uuid.Parse also accepts urn:uuid: and braced spellings,
	// which Postgres's cast does not.
	projectID, err := uuid.Parse(chi.URLParam(r, "projectID"))
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}
	incidentID, err := uuid.Parse(chi.URLParam(r, "incidentID"))
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	group, err := d.Queries.GetErrorGroup(r.Context(), projectID.String(), incidentID.String())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get incident")
		return
	}
	if group == nil {
		writeJSONError(w, http.StatusNotFound, "incident not found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	// Custom-header auth means shared caches don't apply the Authorization
	// heuristics; forbid caching so an edge rule can never serve a stale
	// status or bypass the token check for a cached URL.
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": group.Status})
}
