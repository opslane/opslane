package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

type matrixCredential string

const (
	matrixNone      matrixCredential = "none"
	matrixPK        matrixCredential = "pk"
	matrixSK        matrixCredential = "sk"
	matrixRevoked   matrixCredential = "revoked"
	matrixMalformed matrixCredential = "malformed"
	matrixOtherPK   matrixCredential = "wrong-project-pk"
	matrixSession   matrixCredential = "session"
)

type matrixRoute struct {
	method    string
	pattern   string
	path      string
	body      string
	read      bool
	sourcemap bool
}

type matrixEnvironment struct {
	router    http.Handler
	projectID string
	keys      map[matrixCredential]string
	session   string
}

func newMatrixEnvironment(t *testing.T) *matrixEnvironment {
	t.Helper()
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "route-matrix")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	first, err := q.ProvisionProject(ctx, org.ID, "matrix-one", nil, "matrix-one")
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.ProvisionProject(ctx, org.ID, "matrix-two", nil, "matrix-two")
	if err != nil {
		t.Fatal(err)
	}
	pk, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeIngest, "pk", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	sk, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeSourcemaps, "sk", nil, "https://ingest.test")
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeIngest, "revoked", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`,
		revoked.KeyID); err != nil {
		t.Fatal(err)
	}
	other, err := q.CreateProjectKey(ctx, second.Project.ID, db.ScopeIngest, "other", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	deps := &handler.Dependencies{
		Queries:   q,
		JWTSecret: sessionReadSecret,
	}
	return &matrixEnvironment{
		router:    handler.NewRouter(deps),
		projectID: first.Project.ID,
		session:   dashboardToken(t, org.ID),
		keys: map[matrixCredential]string{
			matrixPK:        pk.Raw,
			matrixSK:        sk.Raw,
			matrixRevoked:   revoked.Raw,
			matrixMalformed: "not-a-key",
			matrixOtherPK:   other.Raw,
		},
	}
}

func (e *matrixEnvironment) call(
	t *testing.T,
	route matrixRoute,
	credential matrixCredential,
) (int, string) {
	t.Helper()
	req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
	req.Header.Set("Content-Type", "application/json")
	if credential == matrixSession {
		req.Header.Set("Authorization", "Bearer "+e.session)
	} else if key := e.keys[credential]; key != "" {
		req.Header.Set("X-API-Key", key)
	}
	response := httptest.NewRecorder()
	e.router.ServeHTTP(response, req)
	var payload struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(response.Body).Decode(&payload)
	return response.Code, payload.Code
}

// TestRouteMatrixDenyByDefault exercises every project-key route and the three
// reads that previously accepted a public key. For valid ingest keys, handler
// validation or infrastructure may return any non-auth status; the invariant
// here is that authentication passed. Every other credential is exact.
func TestRouteMatrixDenyByDefault(t *testing.T) {
	env := newMatrixEnvironment(t)

	routes := []matrixRoute{
		{http.MethodPost, "/api/v1/events", "/api/v1/events",
			`{"timestamp":"2026-07-30T00:00:00Z","error":{"type":"Error","message":"matrix","stack":"at x (a.js:1:1)"}}`, false, false},
		{http.MethodPost, "/api/v1/replays/init", "/api/v1/replays/init",
			`{"session_id":"matrix-replay","trigger_type":"manual"}`, false, false},
		{http.MethodPost, "/api/v1/replays/{replayID}/complete", "/api/v1/replays/00000000-0000-0000-0000-000000000000/complete", `{}`, false, false},
		{http.MethodPost, "/api/v1/replays/{replayID}/fail", "/api/v1/replays/00000000-0000-0000-0000-000000000000/fail", `{}`, false, false},
		{http.MethodPost, "/api/v1/sessions/init", "/api/v1/sessions/init",
			`{"session_id":"matrix-session"}`, false, false},
		{http.MethodPost, "/api/v1/sessions/{sessionID}/chunks/{seq}", "/api/v1/sessions/matrix-session/chunks/0", `{}`, false, false},
		{http.MethodPost, "/api/v1/ingest/ping", "/api/v1/ingest/ping", ``, false, false},
		{method: http.MethodPut, pattern: "/api/v1/sourcemaps/{debugID}",
			path: "/api/v1/sourcemaps/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			body: `{}`, sourcemap: true},
		{http.MethodGet, "/api/v1/projects/{projectID}/event-count", "/api/v1/projects/" + env.projectID + "/event-count", ``, true, false},
		{http.MethodGet, "/api/v1/projects/{projectID}/incidents", "/api/v1/projects/" + env.projectID + "/incidents", ``, true, false},
		{http.MethodGet, "/api/v1/projects/{projectID}/incidents/{incidentID}", "/api/v1/projects/" + env.projectID + "/incidents/00000000-0000-0000-0000-000000000000", ``, true, false},
	}

	credentials := []matrixCredential{
		matrixNone, matrixPK, matrixSK, matrixRevoked,
		matrixMalformed, matrixOtherPK, matrixSession,
	}
	for _, route := range routes {
		for _, credential := range credentials {
			t.Run(string(credential)+" "+route.pattern, func(t *testing.T) {
				status, code := env.call(t, route, credential)
				if route.read {
					if credential == matrixSession {
						if status == http.StatusUnauthorized || status == http.StatusForbidden {
							t.Fatalf("valid session was denied: status=%d code=%q", status, code)
						}
						return
					}
					if status != http.StatusUnauthorized {
						t.Fatalf("read accepted %s: status=%d", credential, status)
					}
					// Session auth keeps the established response for a truly
					// absent credential, but explicitly labels rejected project
					// key headers for clients that branch on the stable code.
					if credential != matrixNone && credential != matrixSession &&
						code != "invalid_api_key" {
						t.Fatalf("read rejection code=%q, want invalid_api_key", code)
					}
					return
				}

				if route.sourcemap {
					if credential == matrixSK {
						if status == http.StatusUnauthorized || status == http.StatusForbidden {
							t.Fatalf("valid source-map key failed authentication: status=%d code=%q", status, code)
						}
						return
					}
					if credential == matrixPK || credential == matrixOtherPK {
						if status != http.StatusForbidden || code != "insufficient_scope" {
							t.Fatalf("ingest key status/code=%d/%q, want 403/insufficient_scope", status, code)
						}
						return
					}
					if status != http.StatusUnauthorized || code != "invalid_api_key" {
						t.Fatalf("%s status/code=%d/%q, want 401/invalid_api_key", credential, status, code)
					}
					return
				}

				if credential == matrixPK || credential == matrixOtherPK {
					if status == http.StatusUnauthorized || status == http.StatusForbidden {
						t.Fatalf("valid ingest key failed authentication: status=%d code=%q", status, code)
					}
					return
				}
				if credential == matrixSK {
					if status != http.StatusForbidden || code != "insufficient_scope" {
						t.Fatalf("source-map key status/code=%d/%q, want 403/insufficient_scope", status, code)
					}
					return
				}
				if status != http.StatusUnauthorized || code != "invalid_api_key" {
					t.Fatalf("%s status/code=%d/%q, want 401/invalid_api_key", credential, status, code)
				}
			})
		}
	}
}

func TestRouteMatrixCoversEveryProjectKeyRoute(t *testing.T) {
	_, q, _ := authTestRouter(t)
	deps := &handler.Dependencies{Queries: q, JWTSecret: sessionReadSecret}
	router := handler.NewRouter(deps)

	got := map[string]bool{}
	if err := chi.Walk(router, func(
		method, route string,
		_ http.Handler,
		middlewares ...func(http.Handler) http.Handler,
	) error {
		for _, middleware := range middlewares {
			fn := runtime.FuncForPC(reflect.ValueOf(middleware).Pointer())
			if fn != nil && strings.Contains(fn.Name(), ".ProjectKey.") {
				got[method+" "+route] = true
				break
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	want := map[string]bool{
		"POST /api/v1/events":                            true,
		"POST /api/v1/replays/init":                      true,
		"POST /api/v1/replays/{replayID}/complete":       true,
		"POST /api/v1/replays/{replayID}/fail":           true,
		"POST /api/v1/sessions/init":                     true,
		"POST /api/v1/sessions/{sessionID}/chunks/{seq}": true,
		"POST /api/v1/ingest/ping":                       true,
		"PUT /api/v1/sourcemaps/{debugID}":               true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("project-key routes = %#v, want %#v", got, want)
	}
}

// handlerAuthenticatedRoutes carry no authenticator middleware because they
// authenticate inside the handler: the agent routes verify a poll token or a
// one-time setup token, and the webhook verifies a GitHub HMAC signature.
// Adding an entry here is a deliberate security decision, not a formality.
var handlerAuthenticatedRoutes = map[string]bool{
	"GET /api/v1/agent/poll/{sessionID}": true,
	"POST /api/v1/agent/setup":           true,
	"POST /api/v1/github/webhook":        true,
}

// TestEveryAPIRouteHasAnAuthenticator closes the gap the scope check cannot:
// TestRouteMatrixCoversEveryProjectKeyRoute pins which routes take a project
// key, but a new route registered with no middleware at all would satisfy it.
// This asserts the complement — every /api/v1 route either attaches an
// authenticator or is on the allowlist above.
//
// This reads chi internals (middleware are only exposed to chi.Walk from
// v5.3.1 onward), so re-read it on any chi bump: if Walk stops passing
// middleware, every route would look unauthenticated and this test would fail
// loudly rather than pass silently.
func TestEveryAPIRouteHasAnAuthenticator(t *testing.T) {
	_, q, _ := authTestRouter(t)
	deps := &handler.Dependencies{Queries: q, JWTSecret: sessionReadSecret}
	router := handler.NewRouter(deps)

	authenticators := []string{".ProjectKey.", "AuthenticateUserSession", "AuthenticateSession"}
	var unauthenticated []string
	walked := 0

	if err := chi.Walk(router, func(
		method, route string,
		_ http.Handler,
		middlewares ...func(http.Handler) http.Handler,
	) error {
		if !strings.HasPrefix(route, "/api/v1") {
			return nil
		}
		walked++
		key := method + " " + route
		if handlerAuthenticatedRoutes[key] {
			return nil
		}
		for _, middleware := range middlewares {
			fn := runtime.FuncForPC(reflect.ValueOf(middleware).Pointer())
			if fn == nil {
				continue
			}
			for _, marker := range authenticators {
				if strings.Contains(fn.Name(), marker) {
					return nil
				}
			}
		}
		unauthenticated = append(unauthenticated, key)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Guard against chi.Walk silently returning nothing, which would make the
	// assertion above vacuous.
	if walked < len(handlerAuthenticatedRoutes) {
		t.Fatalf("chi.Walk visited %d /api/v1 routes, expected at least %d",
			walked, len(handlerAuthenticatedRoutes))
	}
	if len(unauthenticated) > 0 {
		sort.Strings(unauthenticated)
		t.Fatalf("these /api/v1 routes attach no authenticator: %v\n"+
			"Attach ProjectKey or AuthenticateUserSession, or add the route to "+
			"handlerAuthenticatedRoutes with the reason it authenticates in the handler.",
			unauthenticated)
	}
}

func TestRemovedCredentialRoutesAreNotRegistered(t *testing.T) {
	env := newMatrixEnvironment(t)
	for _, route := range []matrixRoute{
		{method: http.MethodPost, path: "/api/v1/sourcemaps"},
		{method: http.MethodPost, path: "/api/v1/environments/00000000-0000-0000-0000-000000000000/api-keys"},
		{method: http.MethodGet, path: "/api/v1/projects/" + env.projectID + "/api-keys"},
	} {
		status, _ := env.call(t, route, matrixPK)
		if status != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", route.method, route.path, status)
		}
	}
}
