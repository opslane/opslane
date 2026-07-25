package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postSessionInit(t *testing.T, deps *Dependencies, body string, withProject bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/sessions/init", strings.NewReader(body))
	if withProject {
		req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))
	}
	w := httptest.NewRecorder()
	deps.SessionInit(w, req)
	return w
}

func TestSessionInit_NoMinIOReturns503(t *testing.T) {
	deps := &Dependencies{}
	w := postSessionInit(t, deps, `{"session_id":"sess_abcdefgh","started_at":"2026-07-14T00:00:00Z"}`, true)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503 when object storage is unconfigured", w.Code)
	}
}

func TestSessionInit_MissingProjectContextReturns401(t *testing.T) {
	deps := &Dependencies{}
	w := postSessionInit(t, deps, `{"session_id":"sess_abcdefgh"}`, false)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 without project context", w.Code)
	}
}

func TestValidSessionID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"550e8400-e29b-41d4-a716-446655440000", true},
		{"sess_1752451200000_a1b2c3", true},
		{"abcdefgh", true},
		{"short", false},
		{strings.Repeat("a", 129), false},
		{"", false},
		{"has spaces here", false},
		{"path/traversal", false},
		{"../../etc/passwd", false},
		{"semi;colon", false},
		{"quote'inject", false},
	}
	for _, tc := range cases {
		if got := validSessionID(tc.id); got != tc.want {
			t.Errorf("validSessionID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestChunkObjectKey_IsDeterministicAndSorted(t *testing.T) {
	got := chunkObjectKey("proj-1", "sess_abc", 7)
	want := "sessions/proj-1/sess_abc/chunk-000007.json.gz"
	if got != want {
		t.Fatalf("chunkObjectKey = %q, want %q", got, want)
	}
	if !(chunkObjectKey("p", "s", 9) < chunkObjectKey("p", "s", 10)) {
		t.Fatal("chunk keys do not sort lexically by seq")
	}
}

// Storage is optional (main.go leaves Dependencies.MinIO nil when
// REPLAY_STORE_ENDPOINT is unset), so the nil guard must win before any
// request validation. The oversize-body 413 itself is asserted by the
// integration test of the same name.
func TestChunkUpload_NoMinIOReturns503(t *testing.T) {
	deps := &Dependencies{}
	req := httptest.NewRequest("POST", "/api/v1/sessions/sess_abcdefgh/chunks/0", strings.NewReader("not gzip"))
	req = req.WithContext(withProjectCtx(req.Context(), "proj-123"))
	w := httptest.NewRecorder()
	deps.ChunkUpload(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503 when object storage is unconfigured", w.Code)
	}
}
