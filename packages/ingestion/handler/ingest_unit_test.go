package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Test helpers for context injection (unexported context keys).
func withProjectID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxProjectID, id)
}

func withEnvironmentID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxEnvironmentID, id)
}

func TestIngestErrorEvent_RejectsOversizedBody(t *testing.T) {
	deps := &Dependencies{} // no DB needed for body size check
	big := make([]byte, 1<<20+1)
	req := httptest.NewRequest("POST", "/api/v1/events", bytes.NewReader(big))
	ctx := withProjectID(req.Context(), "proj-123")
	ctx = withEnvironmentID(ctx, "env-456")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	deps.IngestErrorEvent(w, req)

	if w.Code != http.StatusRequestEntityTooLarge && w.Code != http.StatusBadRequest {
		t.Errorf("expected 413 or 400, got %d", w.Code)
	}
}

func TestIngestErrorEvent_RejectsEmptyMessage(t *testing.T) {
	// message is the one required error field. type and stack are optional, but
	// a payload with no message is real garbage and must still be rejected.
	deps := &Dependencies{}
	body := map[string]interface{}{
		"timestamp": "2026-02-20T00:00:00Z",
		"error":     map[string]string{"type": "TypeError", "stack": "at foo.js:1"}, // no message
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/v1/events", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	ctx := withProjectID(req.Context(), "proj-123")
	ctx = withEnvironmentID(ctx, "env-456")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	deps.IngestErrorEvent(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty message, got %d", w.Code)
	}
}

func TestIngestErrorEvent_AcceptsStacklessEvent(t *testing.T) {
	// A real browser error with no stack (for example, a non-Error promise
	// rejection) must NOT be rejected. With no DB configured,
	// passing validation surfaces as 500 (database unavailable) — which proves
	// the request got past the required-field gate instead of being 400'd.
	deps := &Dependencies{}
	body := map[string]interface{}{
		"timestamp": "2026-02-20T00:00:00Z",
		"error":     map[string]string{"type": "Error", "message": "Promise rejected without a reason", "stack": ""},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/v1/events", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	ctx := withProjectID(req.Context(), "proj-123")
	ctx = withEnvironmentID(ctx, "env-456")
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	deps.IngestErrorEvent(w, req)

	if w.Code == http.StatusBadRequest {
		t.Errorf("stackless event must not be rejected with 400")
	}
	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 (no DB) after passing validation, got %d", w.Code)
	}
}

func TestIngestErrorEvent_RejectsMissingTenantContext(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("POST", "/api/v1/events", bytes.NewReader([]byte("{}")))
	w := httptest.NewRecorder()
	deps.IngestErrorEvent(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing tenant context, got %d", w.Code)
	}
}
