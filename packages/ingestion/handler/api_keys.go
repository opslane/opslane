package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type apiKeyJSON struct {
	KeyID      string     `json:"key_id"`
	Label      string     `json:"label"`
	Scope      string     `json:"scope"`
	CreatedBy  *string    `json:"created_by"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	Status     string     `json:"status"`
	Redacted   string     `json:"redacted"`
}

func presentAPIKey(key db.APIKeyRecord) apiKeyJSON {
	status := "active"
	if key.RevokedAt != nil {
		status = "revoked"
	}
	return apiKeyJSON{
		KeyID:      key.KeyID,
		Label:      key.Label,
		Scope:      key.Scope,
		CreatedBy:  key.CreatedBy,
		CreatedAt:  key.CreatedAt,
		LastUsedAt: key.LastUsedAt,
		ExpiresAt:  key.ExpiresAt,
		RevokedAt:  key.RevokedAt,
		Status:     status,
		Redacted:   "opslane_ak_" + key.KeyID + "_…",
	}
}

func (d *Dependencies) CreateAPIKey(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	var input struct {
		Label     string     `json:"label"`
		ExpiresAt *time.Time `json:"expires_at"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Label = strings.TrimSpace(input.Label)
	if input.Label == "" || utf8.RuneCountInString(input.Label) > 100 {
		writeJSONError(w, http.StatusBadRequest, "label must be between 1 and 100 characters")
		return
	}

	minted, record, err := d.Queries.CreateAPIKey(r.Context(), OrgIDFromCtx(r.Context()),
		projectID, input.Label, UserIDFromCtx(r.Context()), input.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "project not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create API key")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		KeyID     string     `json:"key_id"`
		Token     string     `json:"token"`
		Label     string     `json:"label"`
		Scope     string     `json:"scope"`
		ExpiresAt *time.Time `json:"expires_at"`
	}{minted.KeyID, minted.Raw, record.Label, record.Scope, record.ExpiresAt})
}

func (d *Dependencies) ListAPIKeys(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	keys, err := d.Queries.ListAPIKeys(r.Context(), OrgIDFromCtx(r.Context()), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list API keys")
		return
	}
	result := make([]apiKeyJSON, 0, len(keys))
	for _, key := range keys {
		result = append(result, presentAPIKey(key))
	}
	writeJSON(w, http.StatusOK, result)
}

func (d *Dependencies) RevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	revoked, err := d.Queries.RevokeAPIKey(r.Context(), OrgIDFromCtx(r.Context()), projectID,
		chi.URLParam(r, "keyID"), UserIDFromCtx(r.Context()))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to revoke API key")
		return
	}
	if !revoked {
		writeJSONError(w, http.StatusNotFound, "API key not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
