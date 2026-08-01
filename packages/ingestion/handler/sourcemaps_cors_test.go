package handler_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestSourcemapCORSUploadRoutesAreServerToServer(t *testing.T) {
	const dashboardOrigin = "https://dashboard.example.com"
	t.Setenv("DASHBOARD_ORIGIN", dashboardOrigin)
	router := handler.NewRouter(&handler.Dependencies{})

	paths := []string{
		"/api/v1/sourcemaps/batches",
		"/api/v1/sourcemaps/batches/batch-id/files/debug-id",
		"/api/v1/sourcemaps/batches/batch-id/complete",
	}
	origins := []string{dashboardOrigin, "https://customer.example.com"}
	for _, path := range paths {
		for _, origin := range origins {
			t.Run(path+" "+origin, func(t *testing.T) {
				response := sourcemapCORSRequest(router, path, origin)
				if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
					t.Errorf("Access-Control-Allow-Origin = %q, want empty", got)
				}
				if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "" {
					t.Errorf("Access-Control-Allow-Credentials = %q, want empty", got)
				}
			})
		}
	}
}

func TestSourcemapCORSVerifyUsesDashboardPolicy(t *testing.T) {
	const dashboardOrigin = "https://dashboard.example.com"
	t.Setenv("DASHBOARD_ORIGIN", dashboardOrigin)
	router := handler.NewRouter(&handler.Dependencies{})
	path := "/api/v1/projects/project-id/sourcemaps/verify"

	t.Run("configured dashboard origin", func(t *testing.T) {
		response := sourcemapCORSRequest(router, path, dashboardOrigin)
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != dashboardOrigin {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, dashboardOrigin)
		}
		if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Errorf("Access-Control-Allow-Credentials = %q, want true", got)
		}
	})

	t.Run("other origin", func(t *testing.T) {
		response := sourcemapCORSRequest(router, path, "https://customer.example.com")
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("Access-Control-Allow-Origin = %q, want empty", got)
		}
		if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "" {
			t.Errorf("Access-Control-Allow-Credentials = %q, want empty", got)
		}
	})
}

func TestSourcemapCORSLookalikeDoesNotGetPermissivePolicy(t *testing.T) {
	router := handler.NewRouter(&handler.Dependencies{})
	response := sourcemapCORSRequest(router, "/api/v1/sourcemapsX", "https://customer.example.com")
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestSourcemapCORSDashboardCatchAllIsGETOnly(t *testing.T) {
	dashboardDir := t.TempDir()
	const dashboard = "<html>dashboard</html>"
	if err := os.WriteFile(filepath.Join(dashboardDir, "index.html"), []byte(dashboard), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DASHBOARD_DIR", dashboardDir)
	router := handler.NewRouter(&handler.Dependencies{})

	getResponse := httptest.NewRecorder()
	router.ServeHTTP(getResponse, httptest.NewRequest(http.MethodGet, "/not-an-api-path", nil))
	if getResponse.Code != http.StatusOK || !strings.Contains(getResponse.Body.String(), dashboard) {
		t.Fatalf("GET catch-all status/body = %d/%q, want dashboard", getResponse.Code, getResponse.Body.String())
	}

	// chi does not fall back HEAD->GET, so HEAD must be registered explicitly.
	// Restricting the catch-all to read-only verbs must not break uptime
	// checks, CDNs, or link checkers, which use HEAD.
	for _, path := range []string{"/not-an-api-path", "/index.html", "/"} {
		wantResponse := httptest.NewRecorder()
		router.ServeHTTP(wantResponse, httptest.NewRequest(http.MethodGet, path, nil))
		headResponse := httptest.NewRecorder()
		router.ServeHTTP(headResponse, httptest.NewRequest(http.MethodHead, path, nil))
		if headResponse.Code != wantResponse.Code {
			t.Errorf("HEAD %s status = %d, want %d to match GET",
				path, headResponse.Code, wantResponse.Code)
		}
		if headResponse.Code == http.StatusMethodNotAllowed {
			t.Errorf("HEAD %s is not served at all", path)
		}
	}

	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete,
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, "/not-an-api-path", nil))
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s catch-all status = %d, want %d", method, response.Code, http.StatusMethodNotAllowed)
		}
		if strings.Contains(response.Body.String(), dashboard) {
			t.Errorf("%s catch-all returned dashboard: %q", method, response.Body.String())
		}
	}
}

func sourcemapCORSRequest(router http.Handler, path, origin string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodOptions, path, nil)
	request.Header.Set("Origin", origin)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
