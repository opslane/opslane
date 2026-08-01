package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestUnknownAPIPathReturnsJSON404(t *testing.T) {
	response := routeHygieneRequest(t, http.MethodPost, "/api/v1/sourcemaps")
	assertJSONError(t, response, http.StatusNotFound, "not_found")
}

func TestUnknownAPIVersionReturnsJSON404(t *testing.T) {
	dashboardDir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(dashboardDir, "index.html"), []byte("<html>dashboard</html>"), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DASHBOARD_DIR", dashboardDir)

	response := routeHygieneRequest(t, http.MethodPost, "/api/v2/anything")
	assertJSONError(t, response, http.StatusNotFound, "not_found")
}

func TestWrongMethodReturnsJSON405(t *testing.T) {
	response := routeHygieneRequest(t, http.MethodGet, "/api/v1/events")
	assertJSONError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
}

func TestRateLimitByProjectReturnsCodedError(t *testing.T) {
	middleware := handler.RateLimitByProjectForTest(1)
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	limited := middleware(next)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/events", nil)
	request = request.WithContext(
		handler.WithProjectIDForTest(request.Context(), "project-rate-limit-code"),
	)
	first := httptest.NewRecorder()
	limited.ServeHTTP(first, request)
	if first.Code != http.StatusNoContent {
		t.Fatalf("first request status = %d, want %d", first.Code, http.StatusNoContent)
	}

	second := httptest.NewRecorder()
	limited.ServeHTTP(second, request)
	assertJSONError(t, second, http.StatusTooManyRequests, "rate_limited")
}

func routeHygieneRequest(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	response := httptest.NewRecorder()
	handler.NewRouter(&handler.Dependencies{}).ServeHTTP(response, request)
	return response
}

func assertJSONError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, status, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != code {
		t.Errorf("code = %q, want %q", body.Code, code)
	}
}
