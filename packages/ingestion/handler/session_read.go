package handler

import (
	"bytes"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/compress"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

const maxChunkInflateBytes = 20 << 20

type sessionEndUserJSON struct {
	ID                string  `json:"id"`
	ExternalUserID    *string `json:"external_user_id,omitempty"`
	Email             *string `json:"email,omitempty"`
	ExternalAccountID *string `json:"external_account_id,omitempty"`
	AccountName       *string `json:"account_name,omitempty"`
}

type sessionJSON struct {
	ID                    string              `json:"id"`
	StartedAt             string              `json:"started_at"`
	LastChunkAt           *string             `json:"last_chunk_at,omitempty"`
	Status                string              `json:"status"`
	ChunkCount            int                 `json:"chunk_count"`
	PlayableChunkCount    int                 `json:"playable_chunk_count"`
	BytesStored           int64               `json:"bytes_stored"`
	PageURL               *string             `json:"page_url,omitempty"`
	SDKRelease            *string             `json:"sdk_release,omitempty"`
	ErrorCount            int                 `json:"error_count"`
	RageClickCount        int                 `json:"rage_click_count"`
	DeadClickCount        int                 `json:"dead_click_count"`
	FormAbandonCount      int                 `json:"form_abandon_count"`
	Coverage              *string             `json:"coverage"`
	ActivityClass         *string             `json:"activity_class"`
	FailedRequestCount    int                 `json:"failed_request_count"`
	SuccessfulWriteCount  int                 `json:"successful_write_count"`
	UnverifiedSignalCount int                 `json:"unverified_signal_count"`
	EndUser               *sessionEndUserJSON `json:"end_user,omitempty"`
}

type sessionChunkJSON struct {
	Seq              int    `json:"seq"`
	SizeBytes        *int64 `json:"size_bytes,omitempty"`
	DecodedSizeBytes *int64 `json:"decoded_size_bytes,omitempty"`
	HasFullSnapshot  bool   `json:"has_full_snapshot"`
	FirstEventMs     *int64 `json:"first_event_ms,omitempty"`
	LastEventMs      *int64 `json:"last_event_ms,omitempty"`
}

type sessionListJSON struct {
	Sessions              []sessionJSON `json:"sessions"`
	NextCursor            *string       `json:"next_cursor,omitempty"`
	HasIdentifiedSessions bool          `json:"has_identified_sessions"`
}

type sessionDetailJSON struct {
	sessionJSON
	Chunks []sessionChunkJSON `json:"chunks"`
}

func toSessionJSON(session db.SessionSummary) sessionJSON {
	result := sessionJSON{
		ID:                    session.ID,
		StartedAt:             session.StartedAt.Format(time.RFC3339Nano),
		Status:                session.Status,
		ChunkCount:            session.ChunkCount,
		PlayableChunkCount:    session.PlayableChunkCount,
		BytesStored:           session.BytesStored,
		PageURL:               session.PageURL,
		SDKRelease:            session.SDKRelease,
		ErrorCount:            session.ErrorCount,
		RageClickCount:        session.RageClickCount,
		DeadClickCount:        session.DeadClickCount,
		FormAbandonCount:      session.FormAbandonCount,
		Coverage:              session.Coverage,
		ActivityClass:         session.ActivityClass,
		FailedRequestCount:    session.FailedRequestCount,
		SuccessfulWriteCount:  session.SuccessfulWriteCount,
		UnverifiedSignalCount: session.UnverifiedSignalCount,
	}
	if session.LastChunkAt != nil {
		formatted := session.LastChunkAt.Format(time.RFC3339Nano)
		result.LastChunkAt = &formatted
	}
	if session.EndUserID != nil {
		result.EndUser = &sessionEndUserJSON{
			ID:                *session.EndUserID,
			ExternalUserID:    session.ExternalUserID,
			Email:             session.EndUserEmail,
			ExternalAccountID: session.ExternalAccountID,
			AccountName:       session.AccountName,
		}
	}
	return result
}

func toSessionChunkJSON(chunk db.SessionChunk) sessionChunkJSON {
	return sessionChunkJSON{
		Seq: chunk.Seq, SizeBytes: chunk.SizeBytes, DecodedSizeBytes: chunk.DecodedSizeBytes,
		HasFullSnapshot: chunk.HasFullSnapshot, FirstEventMs: chunk.FirstEventMs, LastEventMs: chunk.LastEventMs,
	}
}

func parseSessionCursor(value string) (*db.SessionCursor, error) {
	if value == "" {
		return nil, nil
	}
	separator := strings.IndexByte(value, ',')
	if separator <= 0 || separator == len(value)-1 {
		return nil, errors.New("malformed cursor")
	}
	startedAt, err := time.Parse(time.RFC3339Nano, value[:separator])
	if err != nil {
		return nil, errors.New("malformed cursor")
	}
	return &db.SessionCursor{StartedAt: startedAt, ID: value[separator+1:]}, nil
}

func formatSessionCursor(cursor *db.SessionCursor) *string {
	if cursor == nil {
		return nil
	}
	value := cursor.StartedAt.Format(time.RFC3339Nano) + "," + cursor.ID
	return &value
}

func parseOptionalRFC3339(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

// ListSessionsEndpoint handles the dashboard's keyset-paginated session index.
func (d *Dependencies) ListSessionsEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	query := r.URL.Query()
	environmentID := query.Get("environment_id")
	if environmentID != "" {
		if _, err := uuid.Parse(environmentID); err != nil {
			writeJSONError(w, http.StatusBadRequest, "environment_id must be a valid UUID")
			return
		}
		environmentProjectID, err := d.Queries.VerifyEnvironmentAccess(r.Context(), OrgIDFromCtx(r.Context()), environmentID)
		if err != nil {
			slog.Error("verify session environment failed", "error", err, "project_id", projectID, "environment_id", environmentID)
			writeJSONError(w, http.StatusInternalServerError, "failed to verify environment")
			return
		}
		if environmentProjectID != projectID {
			writeJSONError(w, http.StatusNotFound, "environment not found")
			return
		}
	}
	from, err := parseOptionalRFC3339(query.Get("from"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid from timestamp")
		return
	}
	to, err := parseOptionalRFC3339(query.Get("to"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid to timestamp")
		return
	}
	cursor, err := parseSessionCursor(query.Get("cursor"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid cursor")
		return
	}
	limit := 50
	if rawLimit := query.Get("limit"); rawLimit != "" {
		parsed, parseErr := strconv.Atoi(rawLimit)
		if parseErr != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = max(1, min(200, parsed))
	}
	hasSignals := false
	if rawHasSignals := query.Get("has_signals"); rawHasSignals != "" {
		parsed, parseErr := strconv.ParseBool(rawHasSignals)
		if parseErr != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid has_signals")
			return
		}
		hasSignals = parsed
	}

	queryStartedAt := time.Now()
	sessions, next, err := d.Queries.ListSessions(r.Context(), projectID, db.SessionFilters{
		EndUserID: query.Get("end_user_id"), AccountID: query.Get("account_id"), EnvironmentID: environmentID,
		Search: strings.TrimSpace(query.Get("search")), HasSignals: hasSignals, From: from, To: to,
	}, cursor, limit)
	queryDuration := time.Since(queryStartedAt)
	if err != nil {
		slog.Error("list sessions failed", "error", err, "project_id", projectID,
			"duration_ms", queryDuration.Milliseconds(), "has_signals", hasSignals)
		writeJSONError(w, http.StatusInternalServerError, "failed to list sessions")
		return
	}
	slog.Info("session list query completed", "project_id", projectID,
		"duration_ms", queryDuration.Milliseconds(), "has_signals", hasSignals, "result_count", len(sessions))
	hasIdentifiedSessions, err := d.Queries.HasIdentifiedSessions(r.Context(), projectID)
	if err != nil {
		slog.Error("check identified sessions failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to list sessions")
		return
	}
	result := make([]sessionJSON, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, toSessionJSON(session))
	}
	writeJSON(w, http.StatusOK, sessionListJSON{
		Sessions: result, NextCursor: formatSessionCursor(next), HasIdentifiedSessions: hasIdentifiedSessions,
	})
}

// GetSessionEndpoint returns session metadata plus its scrubbed-only manifest.
func (d *Dependencies) GetSessionEndpoint(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	session, err := d.Queries.GetSessionSummary(r.Context(), projectID, sessionID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get session")
		return
	}
	if session == nil {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	chunks, err := d.Queries.ListPlayableChunks(r.Context(), projectID, sessionID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to list session chunks")
		return
	}
	manifest := make([]sessionChunkJSON, 0, len(chunks))
	for _, chunk := range chunks {
		manifest = append(manifest, toSessionChunkJSON(chunk))
	}
	writeJSON(w, http.StatusOK, sessionDetailJSON{sessionJSON: toSessionJSON(*session), Chunks: manifest})
}

// GetSessionChunk is the dashboard-authenticated wrapper around the shared
// fail-closed chunk read implementation.
func (d *Dependencies) GetSessionChunk(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	d.serveChunk(w, r, projectID)
}

// serveChunk returns decoded JSON only after the database scrub gate, bounded
// storage reads, bounded inflation, and defense-in-depth redaction.
func (d *Dependencies) serveChunk(w http.ResponseWriter, r *http.Request, projectID string) {
	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "session storage not configured")
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid seq")
		return
	}
	chunk, err := d.Queries.GetPlayableChunk(r.Context(), projectID, chi.URLParam(r, "sessionID"), seq)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to look up chunk")
		return
	}
	if chunk == nil {
		writeJSONError(w, http.StatusNotFound, "chunk not found")
		return
	}

	size, err := d.MinIO.StatObject(r.Context(), chunk.ObjectKey)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "chunk not found")
		return
	}
	if size > maxChunkBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "chunk exceeds size limit")
		return
	}
	raw, err := d.MinIO.GetObject(r.Context(), chunk.ObjectKey)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to fetch chunk")
		return
	}
	plain, err := compress.InflateLimited(bytes.NewReader(raw), maxChunkInflateBytes)
	if errors.Is(err, compress.ErrTooLarge) {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "chunk exceeds size limit")
		return
	}
	if err != nil {
		slog.Error("chunk gunzip failed", "object_key", chunk.ObjectKey, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "chunk unreadable")
		return
	}
	plain = masking.RedactRecording(plain)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(plain)
}

// RequireInternalToken disables internal reads when no deployment token is
// configured and compares configured tokens without data-dependent content
// comparisons.
func RequireInternalToken(next http.Handler) http.Handler {
	token := os.Getenv("INTERNAL_READ_TOKEN")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "internal reads not configured")
			return
		}
		got := r.Header.Get("X-Internal-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}
