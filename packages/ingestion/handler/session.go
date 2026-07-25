package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

const (
	defaultChunkIntervalMs = 30_000
	maxChunkBytes          = 5 << 20
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func validSessionID(id string) bool {
	return sessionIDPattern.MatchString(id)
}

type sessionInitRequest struct {
	SessionID   string `json:"session_id"`
	StartedAt   string `json:"started_at"`
	PageURL     string `json:"page_url"`
	Environment string `json:"environment"`
	Release     string `json:"release"`
	SDK         *struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"sdk"`
	User *struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	} `json:"user"`
}

type sessionInitResponse struct {
	Recording       bool  `json:"recording"`
	ChunkIntervalMs int   `json:"chunk_interval_ms"`
	MaxChunkBytes   int64 `json:"max_chunk_bytes"`
}

// SessionInit registers a client-generated session and carries the recording
// kill switch. POST /api/v1/sessions/init
func (d *Dependencies) SessionInit(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil && d.Queries == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	environmentID := EnvironmentIDFromCtx(r.Context())
	if environmentID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		if err.Error() == "http: request body too large" {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	var req sessionInitRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if !validSessionID(req.SessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	hasSDKIdentity := req.SDK != nil && req.SDK.Name != "" && req.SDK.Version != ""
	// Preserve the cheap replay-only failure path used by deployments without
	// storage. Reporting requests continue so SDK identity can be registered.
	if d.MinIO == nil && !hasSDKIdentity {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}

	tombstoned, err := d.Queries.SessionIsTombstoned(r.Context(), req.SessionID)
	if err != nil {
		slog.Error("tombstone check failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if tombstoned {
		writeJSONError(w, http.StatusGone, "session has been deleted")
		return
	}
	ownerProjectID, err := d.Queries.SessionOwnerProject(r.Context(), req.SessionID)
	if err != nil {
		slog.Error("session owner check failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if ownerProjectID != "" && ownerProjectID != projectID {
		RecordSessionCrossProjectConflict()
		writeJSONError(w, http.StatusConflict, "session_id belongs to another project")
		return
	}
	enabled, err := d.Queries.ProjectRecordingEnabled(r.Context(), projectID)
	if err != nil {
		slog.Error("recording flag lookup failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if !enabled && !hasSDKIdentity {
		writeJSON(w, http.StatusOK, sessionInitResponse{Recording: false})
		return
	}

	resolvedEnvironmentID, fallbackReason, err := d.resolvePayloadEnvironment(
		r.Context(), projectID, environmentID, req.Environment,
	)
	if err != nil {
		slog.Error("environment resolution failed", "error", err, "project_id", projectID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if fallbackReason != "" {
		RecordEnvironmentOverrideFallback(fallbackReason)
		if shouldLogEnvironmentFallback(fallbackReason) {
			slog.Warn("session payload environment override fell back to key environment", "reason", fallbackReason, "project_id", projectID)
		}
	}
	environmentID = resolvedEnvironmentID

	startedAt := time.Now()
	if req.StartedAt != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, req.StartedAt); parseErr == nil && parsed.Before(startedAt) {
			startedAt = parsed
		}
	}

	var endUserID *string
	if req.User != nil && req.User.ID != "" {
		id, upsertErr := d.Queries.UpsertEndUser(r.Context(), projectID, req.User.ID,
			req.User.AccountID, req.User.Email, req.User.AccountName)
		if upsertErr != nil {
			slog.Warn("end user upsert failed", "error", upsertErr, "project_id", projectID)
		} else {
			endUserID = &id
		}
	}

	var sdkIdentity *db.SessionSDKIdentity
	if hasSDKIdentity {
		sdkIdentity = &db.SessionSDKIdentity{
			Name: req.SDK.Name, Version: req.SDK.Version, Release: req.Release,
		}
	}
	registration, err := d.Queries.RegisterSession(r.Context(), req.SessionID, projectID, environmentID,
		endUserID, startedAt, masking.RedactURL(req.PageURL), sdkIdentity)
	if err != nil {
		if errors.Is(err, db.ErrSessionTombstoned) {
			writeJSONError(w, http.StatusGone, "session has been deleted")
			return
		}
		if errors.Is(err, db.ErrSessionProjectConflict) {
			RecordSessionCrossProjectConflict()
			writeJSONError(w, http.StatusConflict, "session_id belongs to another project")
			return
		}
		slog.Error("insert session failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to register session")
		return
	}
	if registration.Diverged {
		RecordEnvironmentSessionDivergence()
	}
	if sdkIdentity != nil {
		if _, err := d.Queries.MarkAgentSessionsAppReporting(r.Context(), projectID); err != nil {
			slog.Error("advance onboarding reporting status failed", "error", err, "project_id", projectID)
			writeJSONError(w, http.StatusInternalServerError, "failed to register session")
			return
		}
	}

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	if !enabled {
		writeJSON(w, http.StatusOK, sessionInitResponse{Recording: false})
		return
	}

	writeJSON(w, http.StatusOK, sessionInitResponse{
		Recording:       true,
		ChunkIntervalMs: defaultChunkIntervalMs,
		MaxChunkBytes:   maxChunkBytes,
	})
}

func chunkObjectKey(projectID, sessionID string, seq int) string {
	return fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
}

// parseHasFullSnapshot reads the has_full_snapshot query parameter.
//
// Contract: "1" is true, "0" is false, absent is false, anything else is an
// error. A repeated parameter is an error rather than a silent first-value
// win: a proxy or SDK bug must not be able to quietly flip a chunk's
// playability flag, because the read path uses it to choose a starting chunk.
func parseHasFullSnapshot(query url.Values) (bool, error) {
	values, present := query["has_full_snapshot"]
	if !present {
		return false, nil
	}
	if len(values) != 1 {
		return false, fmt.Errorf("repeated has_full_snapshot")
	}
	switch values[0] {
	case "1":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("invalid has_full_snapshot %q", values[0])
	}
}

var gzipMagic = []byte{0x1f, 0x8b}

// ChunkUpload stores and commits one gzipped rrweb chunk in a single request.
// POST /api/v1/sessions/{sessionID}/chunks/{seq}
//
// The browser sends the bytes here rather than to object storage because
// Cloudflare R2 does not implement the S3 POST Object API (#194).
//
// The #48 ceiling lives here as a result. It used to be a content-length-range
// condition on a presigned POST policy, enforced by storage after the bytes had
// already left the browser; a public SDK key ships in customer bundles and is
// not secret, so without a ceiling it is a storage-flood primitive. Ingestion
// now sees every chunk, so http.MaxBytesReader below refuses an oversized body
// before a single byte reaches storage — a strictly stronger guarantee, and a
// portable one: content-length-range is only expressible on a POST policy, so
// the old form could never have worked on a backend without POST Object.
func (d *Dependencies) ChunkUpload(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "object storage not configured")
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	if !validSessionID(sessionID) {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id")
		return
	}
	seq, err := strconv.Atoi(chi.URLParam(r, "seq"))
	if err != nil || seq < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid seq")
		return
	}
	hasFullSnapshot, err := parseHasFullSnapshot(r.URL.Query())
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid has_full_snapshot")
		return
	}

	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChunkBytes))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "chunk too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	if len(payload) < 2 || !bytes.Equal(payload[:2], gzipMagic) {
		writeJSONError(w, http.StatusBadRequest, "body is not gzip")
		return
	}

	enabled, err := d.Queries.ProjectRecordingEnabled(r.Context(), projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if !enabled {
		writeJSONError(w, http.StatusForbidden, "recording disabled for this project")
		return
	}
	owned, err := d.Queries.SessionBelongsToProject(r.Context(), sessionID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if !owned {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}
	objectKey := chunkObjectKey(projectID, sessionID, seq)
	if err := d.Queries.ReserveChunkSeq(r.Context(), sessionID, projectID, seq, objectKey, hasFullSnapshot); err != nil {
		if errors.Is(err, db.ErrChunkSeqTaken) {
			writeJSONError(w, http.StatusConflict, "chunk seq already used")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	// Cleanup must outlive the request. r.Context() is already cancelled when
	// the browser disconnects mid-upload, which is precisely when these paths
	// run, so inheriting it makes every release and remove a silent no-op.
	//
	// Start each timeout when cleanup begins, not before the storage write:
	// PutObject has its own 30s deadline and may legitimately outlive a cleanup
	// timeout that was created eagerly.
	cleanupBase := context.WithoutCancel(r.Context())
	releaseReservation := func() error {
		cleanupCtx, cancelCleanup := context.WithTimeout(cleanupBase, 5*time.Second)
		defer cancelCleanup()
		return d.Queries.ReleaseChunkReservation(cleanupCtx, sessionID, projectID, seq)
	}
	removeObjectAndRelease := func() {
		// Preserve remove-then-release ordering so a retry cannot store the same
		// deterministic key and then have this request delete the retry's object.
		removeCtx, cancelRemove := context.WithTimeout(cleanupBase, 5*time.Second)
		removeErr := d.MinIO.RemoveObject(removeCtx, objectKey)
		cancelRemove()
		if removeErr != nil {
			// Retaining the reservation is fail-safe: the storage outcome is
			// ambiguous, so allowing a retry could race the same object key.
			slog.Error("chunk cleanup remove failed; reservation retained",
				"error", removeErr, "object_key", objectKey)
			return
		}
		if err := releaseReservation(); err != nil {
			slog.Error("chunk cleanup release failed", "error", err,
				"session_id", sessionID, "seq", seq)
		}
	}

	if !chunkBytesBudget.allow(projectID, int64(len(payload))) {
		if err := releaseReservation(); err != nil {
			slog.Error("chunk budget cleanup release failed", "error", err,
				"session_id", sessionID, "seq", seq)
		}
		writeJSONError(w, http.StatusTooManyRequests, "byte budget exceeded")
		return
	}
	putCtx, cancelPut := context.WithTimeout(r.Context(), 30*time.Second)
	putErr := d.MinIO.PutObject(putCtx, objectKey, payload, "application/gzip")
	cancelPut()
	if putErr != nil {
		slog.Error("chunk put failed", "error", putErr, "object_key", objectKey)
		// A failed PUT is ambiguous: storage may have accepted the object before
		// the response or request context was lost. Remove before releasing so a
		// retry cannot race an orphan at the deterministic key.
		removeObjectAndRelease()
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	if err := d.Queries.CommitChunk(r.Context(), sessionID, projectID, seq, int64(len(payload))); err != nil {
		slog.Error("chunk commit failed", "error", err, "session_id", sessionID, "seq", seq)
		removeObjectAndRelease()
		writeJSONError(w, http.StatusInternalServerError, "failed to store chunk")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "committed"})
}
