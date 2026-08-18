package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/debugid"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

const maxSourceMapBytes = 32 << 20

var (
	sourcemapsLimiter = newRateLimiter(60)
	debugIDPattern    = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type objectStore interface {
	PutObject(ctx context.Context, objectKey string, data []byte, contentType string) error
	StatObject(ctx context.Context, objectKey string) (int64, error)
}

func (d *Dependencies) wakePendingStackResolutions(ctx context.Context, projectID, debugID string) error {
	_, err := d.Queries.WakePendingStackResolutions(ctx, projectID, debugID)
	return err
}

func (d *Dependencies) sourcemapStore() objectStore {
	if d.SourcemapStore != nil {
		return d.SourcemapStore
	}
	if d.MinIO != nil {
		return d.MinIO
	}
	return nil
}

// sourcemapRateLimit uses the source-map upload contract's stable response
// code and tells clients when to retry.
func sourcemapRateLimit(limiter *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := ProjectIDFromCtx(r.Context())
			if projectID == "" {
				writeJSONErrorCode(w, http.StatusUnauthorized, "missing project context", "invalid_api_key")
				return
			}
			if !limiter.allow(projectID) {
				w.Header().Set("Retry-After", "60")
				writeJSONErrorCode(w, http.StatusTooManyRequests, "too many uploads", "rate_limited")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// UploadSourceMap stores one immutable source map keyed by project and debug ID.
func (d *Dependencies) UploadSourceMap(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Content-Encoding") != "" {
		writeJSONErrorCode(w, http.StatusUnsupportedMediaType,
			"Content-Encoding is not supported; send identity-encoded bytes", "unsupported_media_type")
		return
	}

	urlID := chi.URLParam(r, "debugID")
	if !debugIDPattern.MatchString(urlID) {
		writeJSONErrorCode(w, http.StatusBadRequest,
			"debug ID is not in canonical form", "invalid_debug_id")
		return
	}
	store := d.sourcemapStore()
	if store == nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable,
			"object storage unavailable", "storage_unavailable")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSourceMapBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSONErrorCode(w, http.StatusRequestEntityTooLarge,
				"source map exceeds the 32 MiB limit", "payload_too_large")
			return
		}
		writeJSONErrorCode(w, http.StatusBadRequest,
			"could not read request body", "invalid_request")
		return
	}

	computed, err := debugid.Compute(body)
	if err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest,
			"body is not a fingerprintable source map", "invalid_source_map")
		return
	}
	if computed.DebugID != urlID {
		writeJSONErrorCode(w, http.StatusConflict,
			"map content does not produce the debug ID in the URL", "debug_id_mismatch")
		return
	}

	projectID := ProjectIDFromCtx(r.Context())
	objectKey := fmt.Sprintf("sourcemaps/%s/%s/%s", projectID, urlID, computed.ContentSHA256)
	row := db.SourceMapFile{
		ProjectID: projectID, DebugID: urlID,
		ContentSHA256:     computed.ContentSHA256,
		HasSourcesContent: computed.HasSourcesContent,
		SizeBytes:         int64(len(body)), ObjectKey: objectKey,
	}

	existing, found, err := d.Queries.GetSourceMapFile(r.Context(), projectID, urlID)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
		return
	}
	if found {
		if existing.ContentSHA256 != computed.ContentSHA256 {
			writeJSONErrorCode(w, http.StatusConflict,
				"a different map is already stored under this debug ID", "debug_id_conflict")
			return
		}
		if _, statErr := store.StatObject(r.Context(), existing.ObjectKey); statErr != nil {
			if !errors.Is(statErr, minioPkg.ErrObjectNotFound) {
				writeJSONErrorCode(w, http.StatusServiceUnavailable,
					"object storage unavailable", "storage_unavailable")
				return
			}
			if putErr := store.PutObject(r.Context(), existing.ObjectKey, body, "application/json"); putErr != nil {
				writeJSONErrorCode(w, http.StatusServiceUnavailable,
					"object storage unavailable", "storage_unavailable")
				return
			}
		}
		if err := d.wakePendingStackResolutions(r.Context(), projectID, urlID); err != nil {
			writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
			return
		}
		writeJSONStatus(w, http.StatusOK, "exists")
		return
	}

	if err := store.PutObject(r.Context(), objectKey, body, "application/json"); err != nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable,
			"object storage unavailable", "storage_unavailable")
		return
	}
	stored, inserted, err := d.Queries.UpsertSourceMapFile(r.Context(), row)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
		return
	}
	if !inserted && stored.ContentSHA256 != computed.ContentSHA256 {
		writeJSONErrorCode(w, http.StatusConflict,
			"a different map is already stored under this debug ID", "debug_id_conflict")
		return
	}
	if err := d.wakePendingStackResolutions(r.Context(), projectID, urlID); err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
		return
	}
	if inserted {
		writeJSONStatus(w, http.StatusCreated, "created")
		return
	}
	writeJSONStatus(w, http.StatusOK, "exists")
}

func writeJSONStatus(w http.ResponseWriter, statusCode int, status string) {
	writeJSON(w, statusCode, map[string]string{"status": status})
}
