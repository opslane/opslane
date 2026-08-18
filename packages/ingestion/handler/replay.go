package handler

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
)

type replayFailRequest struct {
	Reason string `json:"reason"`
}

// ReplayFail records that the browser could not upload a replay.
// POST /api/v1/replays/{replayID}/fail
func (d *Dependencies) ReplayFail(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}
	replayID := chi.URLParam(r, "replayID")
	if replayID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing replay id")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	var req replayFailRequest
	_ = json.Unmarshal(body, &req)
	if len(req.Reason) > 500 {
		req.Reason = req.Reason[:500]
	}
	if err := d.Queries.FailReplay(r.Context(), replayID, projectID, req.Reason); err != nil {
		slog.Error("fail replay", "error", err, "replay_id", replayID)
		writeJSONError(w, http.StatusInternalServerError, "failed to record replay failure")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "failed"})
}

const maxReplayBytes = 8 << 20 // 8 MiB hard cap on recording.json reads

// replayInitRequest is the JSON body for POST /api/v1/replays.
type replayInitRequest struct {
	SessionID    string  `json:"session_id"`
	ErrorEventID *string `json:"error_event_id"`
	ErrorGroupID *string `json:"error_group_id"`
	TriggerType  string  `json:"trigger_type"`
	PageURL      string  `json:"page_url"`
	StartedAt    string  `json:"started_at"`
	EndedAt      string  `json:"ended_at"`
}

// replayCompleteArtifact is a single artifact in the complete request.
type replayCompleteArtifact struct {
	Kind        string `json:"kind"`
	ContentType string `json:"content_type"`
	DataBase64  string `json:"data_base64"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

// replayCompleteRequest is the JSON body for POST /api/v1/replays/{replayID}/complete.
type replayCompleteRequest struct {
	Signals       json.RawMessage          `json:"signals"`
	Artifacts     []replayCompleteArtifact `json:"artifacts"`
	InlinePayload *string                  `json:"inline_payload,omitempty"`
	ContentType   string                   `json:"content_type,omitempty"`
	SizeBytes     int64                    `json:"size_bytes,omitempty"`
}

// ReplayInit handles POST /api/v1/replays — creates a replay and returns a presigned upload URL.
func (d *Dependencies) ReplayInit(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}

	// Limit request body to 1MB
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req replayInitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		status := http.StatusBadRequest
		if err.Error() == "http: request body too large" {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSONError(w, status, "invalid request body")
		return
	}

	if req.SessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "session_id is required")
		return
	}
	// Reject only a session that already belongs to another project. An absent
	// session is the legacy one-shot flow (older SDKs call replays/init without
	// a prior sessions/init), which must still succeed, so we cannot require the
	// session to already be owned by this project.
	ownerProjectID, err := d.Queries.SessionOwnerProject(r.Context(), req.SessionID)
	if err != nil {
		slog.Error("replay init session ownership check failed", "error", err, "session_id", req.SessionID)
		writeJSONError(w, http.StatusInternalServerError, "failed to verify session ownership")
		return
	}
	if ownerProjectID != "" && ownerProjectID != projectID {
		writeJSONError(w, http.StatusNotFound, "session not found")
		return
	}

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "replay storage not configured")
		return
	}

	if req.TriggerType == "" {
		req.TriggerType = "error"
	}

	if req.ErrorEventID != nil && *req.ErrorEventID != "" {
		gid, found, err := d.Queries.GroupIDForEvent(r.Context(), *req.ErrorEventID, projectID)
		if err != nil || !found {
			// Unknown or cross-tenant event: drop the link entirely.
			req.ErrorEventID = nil
		} else if gid != "" {
			req.ErrorGroupID = &gid
		}
		// A known event with no group yet is a captured observation awaiting
		// identity settlement: keep the event link, invent no group.
	}

	replayID := uuid.New().String()
	objectKey := fmt.Sprintf("replays/%s/%s/recording.json", projectID, replayID)
	pageURL := masking.RedactURL(req.PageURL)

	if err := d.Queries.InsertReplay(r.Context(), replayID, projectID, req.ErrorGroupID, req.ErrorEventID,
		req.SessionID, req.TriggerType, pageURL, req.StartedAt, req.EndedAt, objectKey); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create replay")
		return
	}

	// Generate presigned PUT URL (15 minute expiry)
	uploadURL, err := d.MinIO.PresignedPutURL(r.Context(), objectKey, 15*time.Minute)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to generate upload URL")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"replay_id":  replayID,
		"upload_url": uploadURL,
	})
}

// allowedArtifactContentTypes defines which content types are accepted for replay artifacts.
var allowedArtifactContentTypes = map[string]struct{}{
	"image/webp": {},
	"image/png":  {},
}

// ReplayComplete handles POST /api/v1/replays/{replayID}/complete — uploads artifacts and
// marks the replay as complete in a single transaction.
func (d *Dependencies) ReplayComplete(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context())
	if projectID == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing project context")
		return
	}

	replayID := chi.URLParam(r, "replayID")
	if replayID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing replay ID")
		return
	}

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "replay storage not configured")
		return
	}

	// Limit request body to 5MB
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)

	// Verify replay belongs to the authenticated project
	belongs, err := d.Queries.ReplayBelongsToProject(r.Context(), replayID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to verify replay ownership")
		return
	}
	if !belongs {
		writeJSONError(w, http.StatusNotFound, "replay not found")
		return
	}

	var req replayCompleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		status := http.StatusBadRequest
		if err.Error() == "http: request body too large" {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSONError(w, status, "invalid request body")
		return
	}

	// Validate max 2 artifacts
	if len(req.Artifacts) > 2 {
		writeJSONError(w, http.StatusBadRequest, "maximum 2 artifacts allowed")
		return
	}

	// Default signals to empty JSON object
	signals := "{}"
	if len(req.Signals) > 0 {
		signals = string(req.Signals)
	}

	// Fallback: if the browser couldn't PUT directly to MinIO (CORS), the SDK sends
	// the replay payload inline. Upload it to MinIO server-side.
	if req.InlinePayload != nil && *req.InlinePayload != "" {
		payloadBytes := []byte(*req.InlinePayload)

		// Guard: limit inline payload to 2MB
		if len(payloadBytes) > 2<<20 {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "inline_payload exceeds 2MB limit")
			return
		}

		// Guard: must be valid JSON before storing
		if !json.Valid(payloadBytes) {
			writeJSONError(w, http.StatusBadRequest, "inline_payload is not valid JSON")
			return
		}

		objectKey := fmt.Sprintf("replays/%s/%s/recording.json", projectID, replayID)
		ct := req.ContentType
		if ct == "" {
			ct = "application/json"
		}
		if err := d.MinIO.PutObject(r.Context(), objectKey, payloadBytes, ct); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to upload inline replay payload")
			return
		}
	}

	// Redact the stored recording before marking the replay complete. The normal
	// path is browser -> presigned MinIO PUT, so these bytes are only reachable
	// server-side at completion time.
	objectKey := fmt.Sprintf("replays/%s/%s/recording.json", projectID, replayID)
	size, err := d.MinIO.StatObject(r.Context(), objectKey)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "replay recording not found; upload it before completing")
		return
	}
	if size > maxReplayBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "replay recording exceeds size limit")
		return
	}
	raw, err := d.MinIO.GetObject(r.Context(), objectKey)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to read replay for redaction")
		return
	}
	cleaned := string(masking.RedactRecording(raw))
	if cleaned != string(raw) {
		if err := d.MinIO.PutObject(r.Context(), objectKey, []byte(cleaned), "application/json"); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to rewrite redacted replay")
			return
		}
	}

	// Process artifacts: validate, decode base64, upload to MinIO
	var dbArtifacts []db.ReplayArtifact
	for i, a := range req.Artifacts {
		if _, ok := allowedArtifactContentTypes[a.ContentType]; !ok {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("artifact[%d]: content_type must be image/webp or image/png", i))
			return
		}

		data, err := base64.StdEncoding.DecodeString(a.DataBase64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("artifact[%d]: invalid base64 data", i))
			return
		}

		artifactID := uuid.New().String()
		objectKey := fmt.Sprintf("replays/%s/%s/artifacts/%s", projectID, replayID, artifactID)

		if err := d.MinIO.PutObject(r.Context(), objectKey, data, a.ContentType); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to upload artifact")
			return
		}

		dbArtifacts = append(dbArtifacts, db.ReplayArtifact{
			ID:          artifactID,
			Kind:        a.Kind,
			ObjectKey:   objectKey,
			ContentType: a.ContentType,
			Width:       a.Width,
			Height:      a.Height,
		})
	}

	// Transactional: insert artifacts + update replay status
	if err := d.Queries.CompleteReplay(r.Context(), replayID, signals, dbArtifacts); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to complete replay")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "complete",
	})
}

// GetReplay handles GET /api/v1/projects/{projectID}/replays/{replayID}.
// It streams recording.json for an authenticated, project-scoped replay.
func (d *Dependencies) GetReplay(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	replayID := chi.URLParam(r, "replayID")

	if d.MinIO == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "replay storage not configured")
		return
	}

	key, err := d.Queries.GetReplayObjectKey(r.Context(), replayID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to look up replay")
		return
	}
	if key == "" {
		writeJSONError(w, http.StatusNotFound, "replay not found")
		return
	}

	size, err := d.MinIO.StatObject(r.Context(), key)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "replay not found")
		return
	}
	if size > maxReplayBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "replay recording exceeds size limit")
		return
	}

	data, err := d.MinIO.GetObject(r.Context(), key)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to fetch replay")
		return
	}

	// Defense in depth: the presigned upload URL stays valid for a window after
	// completion, so the stored object could have been overwritten with unredacted
	// bytes. Redact again at read time so the dashboard never receives secrets,
	// regardless of what is currently stored.
	data = masking.RedactRecording(data)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
