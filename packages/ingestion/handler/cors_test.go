package handler_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestCORS_SDKEndpointReflectsOrigin(t *testing.T) {
	deps := &handler.Dependencies{}
	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/v1/events", nil)
	req.Header.Set("Origin", "https://customer.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://customer.example.com" {
		t.Fatalf("expected reflected origin, got %q", got)
	}
}

func TestCORS_SessionEndpointReflectsOrigin(t *testing.T) {
	deps := &handler.Dependencies{}
	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/v1/sessions/init", nil)
	req.Header.Set("Origin", "https://customer.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://customer.example.com" {
		t.Fatalf("expected reflected origin, got %q", got)
	}
}

func TestCORS_DashboardEndpointRestricted(t *testing.T) {
	deps := &handler.Dependencies{}
	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/api/v1/projects", nil)
	req.Header.Set("Origin", "https://evil.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no Allow-Origin for evil origin on dashboard endpoint, got %q", got)
	}
}

func TestCORS_NonSDKLookalikesDoNotGetPermissivePolicy(t *testing.T) {
	deps := &handler.Dependencies{}
	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	for _, path := range []string{
		"/api/v1/eventsX",
		"/api/v1/sourcemaps",
		"/api/v1/ingest/ping",
	} {
		t.Run(path, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodOptions, srv.URL+path, nil)
			req.Header.Set("Origin", "https://evil.com")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
				t.Fatalf("unexpected permissive CORS for %s: %q", path, got)
			}
		})
	}
}
