package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestRateLimitByProject_BlocksOverLimit(t *testing.T) {
	mw := handler.RateLimitByProjectForTest(2)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := mw(next)

	call := func() int {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req = req.WithContext(handler.WithProjectIDForTest(req.Context(), "proj-1"))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if call() != http.StatusOK || call() != http.StatusOK {
		t.Fatal("first 2 requests should be allowed")
	}
	if got := call(); got != http.StatusTooManyRequests {
		t.Fatalf("3rd request should be 429, got %d", got)
	}
}

func TestRateLimitByProject_IsolatesProjects(t *testing.T) {
	mw := handler.RateLimitByProjectForTest(1)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := mw(next)

	call := func(project string) int {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req = req.WithContext(handler.WithProjectIDForTest(req.Context(), project))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if call("a") != http.StatusOK || call("b") != http.StatusOK {
		t.Fatal("each project gets its own budget")
	}
	if call("a") != http.StatusTooManyRequests {
		t.Fatal("project a should be limited on its 2nd call")
	}
}

func TestEnforceOrigin_EmptyAllowlistAllowsAll(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req.Header.Set("Origin", "https://anything.example.com")
	req = req.WithContext(handler.WithAllowedOriginsForTest(req.Context(), nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty allowlist must allow all, got %d", rec.Code)
	}
}

func TestEnforceOrigin_RejectsNonAllowlistedOrigin(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	allowed := []string{"https://app.example.com"}

	mk := func(origin string) *http.Request {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, mk("https://app.example.com"))
	if rec.Code != http.StatusOK {
		t.Fatalf("allowlisted origin must pass, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, mk("https://evil.com"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-allowlisted origin must be 403, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, mk(""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing origin with allowlist must be 403, got %d", rec.Code)
	}
}

func TestEnforceOriginAllowingServerSDK_HeaderlessRequestPasses(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)

	// Exactly what packages/sdk-python sends: no Origin, no Referer.
	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req = req.WithContext(handler.WithAllowedOriginsForTest(
		context.Background(), []string{"https://app.example.com"}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("server-side SDK must reach an allowlisted project, got %d", rec.Code)
	}
}

// http.Header.Get returns "" for BOTH an absent header and a present-but-empty
// one, so an emptiness check would let `Origin:` bypass the allowlist. The
// exemption must key on presence.
func TestEnforceOriginAllowingServerSDK_EmptyValuedHeadersAreNotHeaderless(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)
	allowed := []string{"https://app.example.com"}

	for _, header := range []string{"Origin", "Referer"} {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req.Header.Set(header, "") // present, empty
		req = req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("empty-valued %s must not be treated as header-less, got %d", header, rec.Code)
		}
	}
}

func TestEnforceOriginAllowingServerSDK_BrowserRequestsStillEnforced(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOriginAllowingServerSDK(next)
	allowed := []string{"https://app.example.com"}

	mk := func(key, value string) *http.Request {
		req := httptest.NewRequest("POST", "/api/v1/events", nil)
		req.Header.Set(key, value)
		return req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))
	}

	cases := []struct {
		name string
		req  *http.Request
		want int
	}{
		{"allowlisted origin", mk("Origin", "https://app.example.com"), http.StatusOK},
		{"foreign origin", mk("Origin", "https://evil.com"), http.StatusForbidden},
		{"allowlisted referer", mk("Referer", "https://app.example.com/checkout"), http.StatusOK},
		{"foreign referer", mk("Referer", "https://evil.com/x"), http.StatusForbidden},
		// A junk Referer must not be mistaken for a header-less server SDK:
		// the header is present, so the exemption does not apply and the
		// unusable origin falls through to the allowlist check.
		{"malformed referer", mk("Referer", "::not a url::"), http.StatusForbidden},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, tc.req)
		if rec.Code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
}

// The strict middleware must NOT gain the exemption: replay and session routes
// are browser-only, so a header-less caller has no business there.
func TestEnforceOrigin_HeaderlessStillRejected(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	req := httptest.NewRequest("POST", "/api/v1/sessions/init", nil)
	req = req.WithContext(handler.WithAllowedOriginsForTest(
		context.Background(), []string{"https://app.example.com"}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("browser-only routes must still reject header-less callers, got %d", rec.Code)
	}
}

func TestEnforceOrigin_MatchIsCaseInsensitive(t *testing.T) {
	deps := &handler.Dependencies{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := deps.EnforceOrigin(next)

	// Allowlist entry with mixed-case host must still match a lowercase browser Origin.
	allowed := []string{"https://App.Example.com"}
	req := httptest.NewRequest("POST", "/api/v1/events", nil)
	req.Header.Set("Origin", "https://app.example.com")
	req = req.WithContext(handler.WithAllowedOriginsForTest(context.Background(), allowed))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("case-insensitive origin must pass, got %d", rec.Code)
	}
}

// Router-level: a middleware unit test cannot catch the routes table wiring
// the wrong entry point, so drive the real router. Needs DATABASE_URL.
func TestRouter_OriginExemptionIsScopedToEvents(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
		projectID, []string{"https://app.example.com"}); err != nil {
		t.Fatalf("set allowlist: %v", err)
	}
	router := handler.NewRouter(deps)

	post := func(path, body string) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", rawKey)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	// /events: header-less server SDK is fully accepted, not merely un-403ed.
	// Asserting the exact 202 keeps an unrelated 400/401/500 from passing as a
	// working exemption.
	if code := post("/api/v1/events", `{"timestamp":"2026-07-20T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"scoped","stack":"Traceback (most recent call last):\nValueError: scoped"},"breadcrumbs":[],"context":{}}`); code != http.StatusAccepted {
		t.Fatalf("/events must accept a header-less server SDK with 202, got %d", code)
	}

	// ...and the exemption is an exemption, not a removal: a browser-shaped
	// request to the same route still meets the allowlist. Without this, a
	// route wired with no origin middleware at all would pass this test.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("/events must still 403 a foreign browser origin, got %d", rec.Code)
	}

	// Every browser-only route must still reject the same header-less caller.
	// These 403 from the middleware before the handler runs, so `{}` is a fine
	// body for all of them.
	browserOnly := []string{
		"/api/v1/replays/init",
		"/api/v1/replays/r1/complete",
		"/api/v1/replays/r1/fail",
		"/api/v1/sessions/init",
		"/api/v1/sessions/s1/chunks/0",
	}
	for _, path := range browserOnly {
		if code := post(path, `{}`); code != http.StatusForbidden {
			t.Errorf("%s must still 403 a header-less caller, got %d", path, code)
		}
	}
}
