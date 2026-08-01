package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gowebpki/jcs"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/debugid"
)

const (
	maxSourceMapManifestBytes = 256 << 10
	maxSourceMapFileBytes     = 100 << 20
	maxSourceMapBatchBytes    = 1 << 30
	maxSourceMapFiles         = 500
	defaultCompletionWait     = 5 * time.Second
)

var commitSHARe = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

type createSourceMapBatchRequest struct {
	CommitSHA *string                 `json:"commit_sha"`
	Release   *string                 `json:"release"`
	Probe     bool                    `json:"probe"`
	Files     []sourceMapManifestFile `json:"files"`
}

type sourceMapManifestFile struct {
	DebugID  string `json:"debug_id"`
	CodeFile string `json:"code_file"`
	Size     int64  `json:"size_bytes"`
}

type sourceMapBatchResponse struct {
	BatchID      string    `json:"batch_id"`
	Status       string    `json:"status"`
	Expected     int       `json:"expected_files"`
	ExpectedSize int64     `json:"expected_bytes"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type sourceMapCompletionResponse struct {
	BatchID     string     `json:"batch_id"`
	Status      string     `json:"status"`
	FileCount   int        `json:"file_count"`
	ByteCount   int64      `json:"byte_count"`
	CommitSHA   *string    `json:"commit_sha"`
	Release     *string    `json:"release"`
	Probe       bool       `json:"probe"`
	CompletedAt *time.Time `json:"completed_at"`
}

// CreateSourceMapBatch declares the immutable manifest for one source-map upload.
func (d *Dependencies) CreateSourceMapBatch(w http.ResponseWriter, r *http.Request) {
	if d.MinIO == nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if _, err := uuid.Parse(idempotencyKey); err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "Idempotency-Key must be a UUID", "invalid_request")
		return
	}
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		writeJSONErrorCode(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json", "unsupported_media_type")
		return
	}

	raw, tooLarge, err := readBoundedBody(w, r, maxSourceMapManifestBytes)
	if err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "request body must be valid JSON", "invalid_json")
		return
	}
	if tooLarge {
		writeJSONErrorCode(w, http.StatusRequestEntityTooLarge, "manifest exceeds 256 KiB", "manifest_too_large")
		return
	}
	if !utf8.Valid(raw) {
		writeJSONErrorCode(w, http.StatusBadRequest, "manifest must be valid UTF-8", "invalid_manifest")
		return
	}

	var request createSourceMapBatchRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "request body must be valid JSON", "invalid_json")
		return
	}
	if len(request.Files) == 0 {
		writeJSONErrorCode(w, http.StatusBadRequest, "files must contain at least one entry", "invalid_manifest")
		return
	}
	if len(request.Files) > maxSourceMapFiles {
		writeJSONErrorCode(w, http.StatusRequestEntityTooLarge, "files must contain at most 500 entries", "too_many_files")
		return
	}
	if request.CommitSHA != nil && !commitSHARe.MatchString(*request.CommitSHA) {
		writeJSONErrorCode(w, http.StatusBadRequest, "commit_sha must be 40 or 64 lowercase hexadecimal characters", "invalid_manifest")
		return
	}
	if request.Release != nil && len([]byte(*request.Release)) > 200 {
		writeJSONErrorCode(w, http.StatusBadRequest, "release must be at most 200 UTF-8 bytes", "invalid_manifest")
		return
	}

	seen := make(map[string]struct{}, len(request.Files))
	files := make([]db.ManifestFile, 0, len(request.Files))
	var expectedBytes int64
	for i := range request.Files {
		file := &request.Files[i]
		parsed, err := uuid.Parse(file.DebugID)
		if err != nil {
			writeJSONErrorCode(w, http.StatusBadRequest,
				fmt.Sprintf("files[%d].debug_id must use UUID text syntax", i), "invalid_manifest")
			return
		}
		file.DebugID = strings.ToLower(parsed.String())
		if _, duplicate := seen[file.DebugID]; duplicate {
			writeJSONErrorCode(w, http.StatusBadRequest, "files contains a duplicate debug_id", "duplicate_debug_id")
			return
		}
		seen[file.DebugID] = struct{}{}
		if file.CodeFile == "" || len([]byte(file.CodeFile)) > 4096 || containsControlCharacter(file.CodeFile) {
			writeJSONErrorCode(w, http.StatusBadRequest,
				fmt.Sprintf("files[%d].code_file must be 1-4096 UTF-8 bytes with no control characters", i),
				"invalid_manifest")
			return
		}
		if file.Size <= 0 {
			writeJSONErrorCode(w, http.StatusBadRequest,
				fmt.Sprintf("files[%d].size_bytes must be positive", i), "invalid_manifest")
			return
		}
		if file.Size > maxSourceMapFileBytes {
			writeJSONErrorCode(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("files[%d].size_bytes exceeds 100 MiB", i), "file_too_large")
			return
		}
		if expectedBytes > maxSourceMapBatchBytes-file.Size {
			writeJSONErrorCode(w, http.StatusRequestEntityTooLarge,
				"sum of files[].size_bytes exceeds 1 GiB", "batch_too_large")
			return
		}
		expectedBytes += file.Size
		files = append(files, db.ManifestFile{
			DebugID:  file.DebugID,
			CodeFile: file.CodeFile,
			RawSize:  file.Size,
		})
	}
	sort.Slice(request.Files, func(i, j int) bool {
		return request.Files[i].DebugID < request.Files[j].DebugID
	})
	normalized, err := json.Marshal(request)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "failed to normalize manifest", "internal_error")
		return
	}
	canonical, err := jcs.Transform(normalized)
	if err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "manifest could not be canonicalized", "invalid_manifest")
		return
	}
	manifestDigest := sha256.Sum256(canonical)

	batch, reused, err := d.Queries.CreateSourceMapBatch(
		r.Context(), ProjectIDFromCtx(r.Context()), KeyDBIDFromCtx(r.Context()),
		idempotencyKey, manifestDigest[:], request.CommitSHA, request.Release, request.Probe, files,
	)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	status := http.StatusCreated
	if reused {
		status = http.StatusOK
	}
	writeJSON(w, status, sourceMapBatchResponse{
		BatchID:      batch.ID,
		Status:       batch.Status,
		Expected:     batch.ExpectedFileCount,
		ExpectedSize: batch.ExpectedBytes,
		ExpiresAt:    batch.ExpiresAt,
	})
}

// UploadSourceMapFile validates, fingerprints, and stages one declared map.
func (d *Dependencies) UploadSourceMapFile(w http.ResponseWriter, r *http.Request) {
	if d.MinIO == nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}
	projectID := ProjectIDFromCtx(r.Context())
	batchID := chi.URLParam(r, "batchID")
	if _, err := uuid.Parse(batchID); err != nil {
		writeSourceMapDBError(w, db.ErrBatchNotFound)
		return
	}

	batch, err := d.Queries.GetSourceMapBatch(r.Context(), projectID, batchID)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	parsedDebugID, err := uuid.Parse(chi.URLParam(r, "debugID"))
	if err != nil {
		writeSourceMapDBError(w, db.ErrDebugIDNotDeclared)
		return
	}
	debugID := strings.ToLower(parsedDebugID.String())
	declared, state, err := d.Queries.GetDeclaredFile(r.Context(), projectID, batchID, debugID)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	if batch.Status == "pending" && !batch.ExpiresAt.After(d.sourceMapTime()) {
		writeSourceMapDBError(w, db.ErrBatchExpired)
		return
	}
	if r.ContentLength < 0 {
		writeJSONErrorCode(w, http.StatusLengthRequired, "Content-Length is required", "length_required")
		return
	}
	if r.ContentLength != declared.RawSize {
		writeJSONErrorCode(w, http.StatusConflict, "Content-Length does not match the manifest", "size_mismatch")
		return
	}
	if r.Header.Get("Content-Encoding") != "" || !isJSONContentType(r.Header.Get("Content-Type")) {
		writeJSONErrorCode(w, http.StatusUnsupportedMediaType, "source maps must be unencoded application/json", "unsupported_media_type")
		return
	}

	raw, tooLarge, err := readBoundedBody(w, r, declared.RawSize)
	if err != nil || tooLarge || int64(len(raw)) != declared.RawSize {
		writeJSONErrorCode(w, http.StatusConflict, "request body size does not match the manifest", "size_mismatch")
		return
	}
	result, err := debugid.Compute(raw)
	if err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "source map is invalid", "invalid_source_map")
		return
	}
	contentDigest, err := hex.DecodeString(result.ContentSHA256)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "failed to fingerprint source map", "internal_error")
		return
	}

	if batch.Status == "complete" {
		resolvable, lookupErr := d.Queries.GetResolvableMap(r.Context(), projectID, batchID, declared.DebugID)
		if lookupErr != nil && !errors.Is(lookupErr, db.ErrMapNotFound) {
			writeSourceMapDBError(w, lookupErr)
			return
		}
		if lookupErr == nil && bytes.Equal(resolvable.ContentSHA256, contentDigest) &&
			resolvable.CanonicalSize == result.CanonicalSize {
			writeJSON(w, http.StatusOK, map[string]any{
				"batch_id": batchID, "debug_id": declared.DebugID,
				"status": "already_present", "received_bytes": declared.RawSize,
			})
			return
		}
		writeSourceMapDBError(w, db.ErrBatchComplete)
		return
	}
	if result.DebugID != debugID {
		writeJSONErrorCode(w, http.StatusConflict, "source map debug ID does not match the path", "debug_id_mismatch")
		return
	}

	rawDigest := sha256.Sum256(raw)
	stagingKey := fmt.Sprintf("sourcemaps/v1/projects/%s/batches/%s/%s.map", projectID, batchID, debugID)
	staged := db.StagedFile{
		DebugID:       debugID,
		StagingKey:    stagingKey,
		RawSize:       int64(len(raw)),
		CanonicalSize: result.CanonicalSize,
		RawSHA256:     rawDigest[:],
		ContentSHA256: contentDigest,
	}
	linked, err := d.Queries.LinkExistingArtifact(r.Context(), projectID, batchID, staged)
	if err != nil {
		if errors.Is(err, db.ErrBatchComplete) {
			d.writeCompletedUploadResult(
				w, r, projectID, batchID, declared.DebugID,
				contentDigest, result.CanonicalSize, declared.RawSize,
			)
			return
		}
		writeSourceMapDBError(w, err)
		return
	}
	if linked {
		writeJSON(w, http.StatusOK, map[string]any{
			"batch_id": batchID, "debug_id": debugID,
			"status": "already_present", "received_bytes": int64(len(raw)),
		})
		return
	}
	if state == "staged" {
		created, err := d.Queries.StageBatchFile(r.Context(), projectID, batchID, staged)
		if err != nil {
			if errors.Is(err, db.ErrBatchComplete) {
				d.writeCompletedUploadResult(
					w, r, projectID, batchID, declared.DebugID,
					contentDigest, result.CanonicalSize, declared.RawSize,
				)
				return
			}
			writeSourceMapDBError(w, err)
			return
		}
		if !created {
			writeJSON(w, http.StatusOK, map[string]any{
				"batch_id": batchID, "debug_id": debugID,
				"status": "already_present", "received_bytes": int64(len(raw)),
			})
			return
		}
	}
	if err := d.MinIO.PutObject(r.Context(), stagingKey, result.Canonical, "application/json"); err != nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}
	created, err := d.Queries.StageBatchFile(r.Context(), projectID, batchID, staged)
	if err != nil {
		if errors.Is(err, db.ErrBatchComplete) {
			d.writeCompletedUploadResult(
				w, r, projectID, batchID, declared.DebugID,
				contentDigest, result.CanonicalSize, declared.RawSize,
			)
			return
		}
		writeSourceMapDBError(w, err)
		return
	}
	status := http.StatusCreated
	value := "stored"
	if !created {
		status = http.StatusOK
		value = "already_present"
	}
	writeJSON(w, status, map[string]any{
		"batch_id": batchID, "debug_id": debugID,
		"status": value, "received_bytes": int64(len(raw)),
	})
}

func (d *Dependencies) writeCompletedUploadResult(
	w http.ResponseWriter,
	r *http.Request,
	projectID, batchID, declaredDebugID string,
	contentDigest []byte,
	canonicalSize, rawSize int64,
) {
	resolvable, err := d.Queries.GetResolvableMap(
		r.Context(), projectID, batchID, declaredDebugID,
	)
	if err == nil &&
		bytes.Equal(resolvable.ContentSHA256, contentDigest) &&
		resolvable.CanonicalSize == canonicalSize {
		writeJSON(w, http.StatusOK, map[string]any{
			"batch_id": batchID, "debug_id": declaredDebugID,
			"status": "already_present", "received_bytes": rawSize,
		})
		return
	}
	if err != nil && !errors.Is(err, db.ErrMapNotFound) {
		writeSourceMapDBError(w, err)
		return
	}
	writeSourceMapDBError(w, db.ErrBatchComplete)
}

// CompleteSourceMapBatch promotes staged maps and atomically activates the batch.
func (d *Dependencies) CompleteSourceMapBatch(w http.ResponseWriter, r *http.Request) {
	if d.MinIO == nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		writeJSONErrorCode(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json", "unsupported_media_type")
		return
	}
	raw, tooLarge, err := readBoundedBody(w, r, 64<<10)
	if err != nil || tooLarge {
		writeJSONErrorCode(w, http.StatusBadRequest, "request body must be a JSON object", "invalid_request")
		return
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		writeJSONErrorCode(w, http.StatusBadRequest, "request body must be a JSON object", "invalid_request")
		return
	}

	projectID := ProjectIDFromCtx(r.Context())
	batchID := chi.URLParam(r, "batchID")
	if _, err := uuid.Parse(batchID); err != nil {
		writeSourceMapDBError(w, db.ErrBatchNotFound)
		return
	}
	batch, err := d.Queries.GetSourceMapBatch(r.Context(), projectID, batchID)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	if batch.Status == "complete" {
		writeJSON(w, http.StatusOK, completionReceipt(batch))
		return
	}
	if batch.Status == "pending" && !batch.ExpiresAt.After(d.sourceMapTime()) {
		writeSourceMapDBError(w, db.ErrBatchExpired)
		return
	}
	if batch.ReceivedFileCount != batch.ExpectedFileCount || batch.ReceivedBytes != batch.ExpectedBytes {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "source map batch is incomplete", "code": "batch_incomplete",
			"expected_files": batch.ExpectedFileCount, "received_files": batch.ReceivedFileCount,
		})
		return
	}

	claim, err := d.Queries.ClaimBatchCompletion(r.Context(), projectID, batchID)
	if errors.Is(err, db.ErrBatchComplete) {
		completed, getErr := d.Queries.GetSourceMapBatch(r.Context(), projectID, batchID)
		if getErr == nil && completed.Status == "complete" {
			writeJSON(w, http.StatusOK, completionReceipt(completed))
			return
		}
		if getErr != nil {
			writeSourceMapDBError(w, getErr)
			return
		}
	}
	if errors.Is(err, db.ErrCompletionInProgress) {
		d.waitForSourceMapCompletion(w, r, projectID, batchID)
		return
	}
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	staged, err := d.Queries.ListStagedFiles(r.Context(), projectID, batchID)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	for _, file := range staged {
		dst := fmt.Sprintf("sourcemaps/v1/projects/%s/maps/%s.map",
			projectID, hex.EncodeToString(file.ContentSHA256))
		if err := d.copySourceMap(r.Context(), file.StagingKey, dst); err != nil {
			writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
			return
		}
	}
	changed, err := d.Queries.ActivateBatch(r.Context(), projectID, batchID, claim.ClaimedAt, staged)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	if changed == 0 {
		d.waitForSourceMapCompletion(w, r, projectID, batchID)
		return
	}
	batch, err = d.Queries.GetSourceMapBatch(r.Context(), projectID, batchID)
	if err != nil {
		writeSourceMapDBError(w, err)
		return
	}
	for _, file := range staged {
		_ = d.MinIO.RemoveObject(context.Background(), file.StagingKey)
	}
	writeJSON(w, http.StatusOK, completionReceipt(batch))
}

func (d *Dependencies) waitForSourceMapCompletion(
	w http.ResponseWriter, r *http.Request, projectID, batchID string,
) {
	wait := d.completionWait
	if wait == 0 {
		wait = defaultCompletionWait
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			w.Header().Set("Retry-After", "2")
			writeSourceMapDBError(w, db.ErrCompletionInProgress)
			return
		case <-ticker.C:
			batch, err := d.Queries.GetSourceMapBatch(r.Context(), projectID, batchID)
			if err == nil && batch.Status == "complete" {
				writeJSON(w, http.StatusOK, completionReceipt(batch))
				return
			}
		}
	}
}

func completionReceipt(batch db.SourceMapBatch) sourceMapCompletionResponse {
	return sourceMapCompletionResponse{
		BatchID: batch.ID, Status: batch.Status,
		FileCount: batch.ExpectedFileCount, ByteCount: batch.ExpectedBytes,
		CommitSHA: batch.CommitSHA, Release: batch.Release, Probe: batch.Probe,
		CompletedAt: batch.CompletedAt,
	}
}

func (d *Dependencies) sourceMapTime() time.Time {
	if d.sourcemapNow != nil {
		return d.sourcemapNow()
	}
	return time.Now()
}

func (d *Dependencies) copySourceMap(ctx context.Context, src, dst string) error {
	if d.sourcemapCopier != nil {
		return d.sourcemapCopier(ctx, src, dst)
	}
	return d.MinIO.CopyObject(ctx, src, dst)
}

func isJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}

func readBoundedBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool, error) {
	reader := http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(reader)
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return nil, true, nil
	}
	return data, false, err
}

func containsControlCharacter(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func writeSourceMapDBError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, db.ErrBatchNotFound):
		writeJSONErrorCode(w, http.StatusNotFound, "source map batch not found", "batch_not_found")
	case errors.Is(err, db.ErrBatchExpired):
		writeJSONErrorCode(w, http.StatusGone, "source map batch expired", "batch_expired")
	case errors.Is(err, db.ErrBatchComplete):
		writeJSONErrorCode(w, http.StatusConflict, "source map batch is already complete", "batch_already_complete")
	case errors.Is(err, db.ErrBatchIncomplete):
		writeJSONErrorCode(w, http.StatusConflict, "source map batch is incomplete", "batch_incomplete")
	case errors.Is(err, db.ErrDebugIDNotDeclared):
		writeJSONErrorCode(w, http.StatusConflict, "debug ID was not declared in this batch", "debug_id_not_declared")
	case errors.Is(err, db.ErrDebugIDConflict):
		writeJSONErrorCode(w, http.StatusConflict, "debug ID has different source map content", "debug_id_conflict")
	case errors.Is(err, db.ErrIdempotencyConflict):
		writeJSONErrorCode(w, http.StatusConflict, "Idempotency-Key was reused with a different manifest", "idempotency_conflict")
	case errors.Is(err, db.ErrCompletionInProgress):
		writeJSONErrorCode(w, http.StatusConflict, "source map batch completion is in progress", "batch_completion_in_progress")
	case errors.Is(err, db.ErrMapNotFound):
		writeJSONErrorCode(w, http.StatusNotFound, "source map is not resolvable", "map_not_found")
	default:
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
	}
}
