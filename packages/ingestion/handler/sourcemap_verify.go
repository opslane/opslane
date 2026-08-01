package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/sourcemapping"
)

type verifySourceMapRequest struct {
	BatchID         string `json:"batch_id"`
	DebugID         string `json:"debug_id"`
	GeneratedLine   int64  `json:"generated_line"`
	GeneratedColumn int64  `json:"generated_column"`
}

type verifySourceMapResponse struct {
	Status    string `json:"status"`
	DebugID   string `json:"debug_id"`
	Generated struct {
		Line   int `json:"line"`
		Column int `json:"column"`
	} `json:"generated"`
	Original struct {
		File   string  `json:"file"`
		Line   int     `json:"line"`
		Column int     `json:"column"`
		Name   *string `json:"name"`
	} `json:"original"`
}

// VerifySourceMap resolves exactly one generated position without exposing map
// bytes, source text, mappings, or object-storage paths.
func (d *Dependencies) VerifySourceMap(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}
	userID := UserIDFromCtx(r.Context())
	if !sourcemapVerifyLimiter.allow(userID + ":" + projectID) {
		slog.Info("sourcemap.verify",
			"user_id", userID, "project_id", projectID, "result", "rate_limited")
		writeJSONErrorCode(w, http.StatusTooManyRequests, "rate limit exceeded", "rate_limited")
		return
	}

	rawRequest, tooLarge, readErr := readBoundedBody(w, r, 64<<10)
	var request verifySourceMapRequest
	if !isJSONContentType(r.Header.Get("Content-Type")) ||
		readErr != nil || tooLarge || json.Unmarshal(rawRequest, &request) != nil {
		d.auditSourceMapVerify(userID, projectID, request, "invalid_request")
		writeJSONErrorCode(w, http.StatusBadRequest, "request must be valid application/json", "invalid_request")
		return
	}
	if _, err := uuid.Parse(request.BatchID); err != nil {
		d.auditSourceMapVerify(userID, projectID, request, "invalid_request")
		writeJSONErrorCode(w, http.StatusBadRequest, "batch_id must be a UUID", "invalid_request")
		return
	}
	parsedDebugID, err := uuid.Parse(request.DebugID)
	if err != nil {
		d.auditSourceMapVerify(userID, projectID, request, "invalid_request")
		writeJSONErrorCode(w, http.StatusBadRequest, "debug_id must use UUID text syntax", "invalid_request")
		return
	}
	request.DebugID = strings.ToLower(parsedDebugID.String())
	if request.GeneratedLine < 1 || request.GeneratedLine > int64(^uint32(0)>>1) ||
		request.GeneratedColumn < 0 || request.GeneratedColumn > int64(^uint32(0)>>1) {
		d.auditSourceMapVerify(userID, projectID, request, "invalid_request")
		writeJSONErrorCode(w, http.StatusBadRequest, "generated position is outside the signed 32-bit range", "invalid_request")
		return
	}
	if d.MinIO == nil {
		d.auditSourceMapVerify(userID, projectID, request, "storage_unavailable")
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}

	resolvable, err := d.Queries.GetResolvableMap(
		r.Context(), projectID, request.BatchID, request.DebugID,
	)
	if err != nil {
		code := sourceMapErrorCode(err)
		d.auditSourceMapVerify(userID, projectID, request, code)
		writeSourceMapDBError(w, err)
		return
	}
	raw, err := d.MinIO.GetObjectBounded(r.Context(), resolvable.ObjectKey, resolvable.CanonicalSize)
	if err != nil || int64(len(raw)) != resolvable.CanonicalSize {
		d.auditSourceMapVerify(userID, projectID, request, "storage_unavailable")
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage unavailable", "storage_unavailable")
		return
	}
	digest := sha256.Sum256(raw)
	if !bytes.Equal(digest[:], resolvable.ContentSHA256) {
		d.auditSourceMapVerify(userID, projectID, request, "storage_unavailable")
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "source map storage integrity check failed", "storage_unavailable")
		return
	}
	sourceMap, err := sourcemapping.Parse(raw)
	if err != nil {
		d.auditSourceMapVerify(userID, projectID, request, "invalid_source_map")
		writeJSONErrorCode(w, http.StatusUnprocessableEntity, "stored source map is invalid", "invalid_source_map")
		return
	}
	position, ok := sourceMap.Lookup(int(request.GeneratedLine), int(request.GeneratedColumn))
	if !ok {
		d.auditSourceMapVerify(userID, projectID, request, "position_not_mapped")
		writeJSONErrorCode(w, http.StatusUnprocessableEntity, "generated position is not mapped", "position_not_mapped")
		return
	}

	var response verifySourceMapResponse
	response.Status = "resolved"
	response.DebugID = request.DebugID
	response.Generated.Line = int(request.GeneratedLine)
	response.Generated.Column = int(request.GeneratedColumn)
	response.Original.File = position.Source
	response.Original.Line = position.Line
	response.Original.Column = position.Column
	response.Original.Name = position.Name
	d.auditSourceMapVerify(userID, projectID, request, "resolved")
	writeJSON(w, http.StatusOK, response)
}

func (d *Dependencies) auditSourceMapVerify(
	userID, projectID string, request verifySourceMapRequest, result string,
) {
	slog.Info("sourcemap.verify",
		"user_id", userID, "project_id", projectID, "batch_id", request.BatchID,
		"debug_id", request.DebugID, "generated_line", request.GeneratedLine,
		"generated_column", request.GeneratedColumn, "result", result)
}

func sourceMapErrorCode(err error) string {
	switch {
	case errors.Is(err, db.ErrBatchNotFound):
		return "batch_not_found"
	case errors.Is(err, db.ErrMapNotFound):
		return "map_not_found"
	default:
		return "internal_error"
	}
}
