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
	matrixOtherSK   matrixCredential = "wrong-project-sk"
	matrixSession   matrixCredential = "session"
)

type matrixPrincipal string

const (
	matrixIngestPrincipal    matrixPrincipal = "ingest"
	matrixSourcemapPrincipal matrixPrincipal = "sourcemaps"
	matrixSessionPrincipal   matrixPrincipal = "session"
)

type matrixRoute struct {
	method    string
	pattern   string
	path      string
	body      string
	principal matrixPrincipal
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
	pk, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeIngest, "pk", nil)
	if err != nil {
		t.Fatal(err)
	}
	sk, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeSourcemaps, "sk", nil)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := q.CreateProjectKey(ctx, first.Project.ID, db.ScopeIngest, "revoked", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`,
		revoked.KeyID); err != nil {
		t.Fatal(err)
	}
	other, err := q.CreateProjectKey(ctx, second.Project.ID, db.ScopeIngest, "other", nil)
	if err != nil {
		t.Fatal(err)
	}
	otherSK, err := q.CreateProjectKey(ctx, second.Project.ID, db.ScopeSourcemaps, "other-sk", nil)
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
			matrixOtherSK:   otherSK.Raw,
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

func matrixRoutes(projectID string) []matrixRoute {
	return []matrixRoute{
		{
			method: http.MethodPost, pattern: "/api/v1/events", path: "/api/v1/events",
			body:      `{"timestamp":"2026-07-30T00:00:00Z","error":{"type":"Error","message":"matrix","stack":"at x (a.js:1:1)"}}`,
			principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/replays/init", path: "/api/v1/replays/init",
			body: `{"session_id":"matrix-replay","trigger_type":"manual"}`, principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/replays/{replayID}/complete",
			path: "/api/v1/replays/00000000-0000-0000-0000-000000000000/complete",
			body: `{}`, principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/replays/{replayID}/fail",
			path: "/api/v1/replays/00000000-0000-0000-0000-000000000000/fail",
			body: `{}`, principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/sessions/init", path: "/api/v1/sessions/init",
			body: `{"session_id":"matrix-session"}`, principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/sessions/{sessionID}/chunks/{seq}",
			path: "/api/v1/sessions/matrix-session/chunks/0", body: `{}`, principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/ingest/ping", path: "/api/v1/ingest/ping",
			principal: matrixIngestPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/sourcemaps/batches", path: "/api/v1/sourcemaps/batches",
			body: `{}`, principal: matrixSourcemapPrincipal,
		},
		{
			method: http.MethodPut, pattern: "/api/v1/sourcemaps/batches/{batchID}/files/{debugID}",
			path: "/api/v1/sourcemaps/batches/00000000-0000-0000-0000-000000000000/files/00000000-0000-0000-0000-000000000000",
			body: `{}`, principal: matrixSourcemapPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/sourcemaps/batches/{batchID}/complete",
			path: "/api/v1/sourcemaps/batches/00000000-0000-0000-0000-000000000000/complete",
			body: `{}`, principal: matrixSourcemapPrincipal,
		},
		{
			method: http.MethodGet, pattern: "/api/v1/projects/{projectID}/event-count",
			path: "/api/v1/projects/" + projectID + "/event-count", principal: matrixSessionPrincipal,
		},
		{
			method: http.MethodGet, pattern: "/api/v1/projects/{projectID}/incidents",
			path: "/api/v1/projects/" + projectID + "/incidents", principal: matrixSessionPrincipal,
		},
		{
			method: http.MethodGet, pattern: "/api/v1/projects/{projectID}/incidents/{incidentID}",
			path:      "/api/v1/projects/" + projectID + "/incidents/00000000-0000-0000-0000-000000000000",
			principal: matrixSessionPrincipal,
		},
		{
			method: http.MethodPost, pattern: "/api/v1/projects/{projectID}/sourcemaps/verify",
			path: "/api/v1/projects/" + projectID + "/sourcemaps/verify",
			body: `{}`, principal: matrixSessionPrincipal,
		},
	}
}

// TestRouteMatrixDenyByDefault exercises the ingest-key routes, the source-map
// family, and representative dashboard reads. Once the expected principal
// authenticates, handler validation or infrastructure may return any non-auth
// status; every rejected credential is exact.
func TestRouteMatrixDenyByDefault(t *testing.T) {
	env := newMatrixEnvironment(t)

	credentials := []matrixCredential{
		matrixNone, matrixPK, matrixSK, matrixRevoked,
		matrixMalformed, matrixOtherPK, matrixOtherSK, matrixSession,
	}
	for _, route := range matrixRoutes(env.projectID) {
		for _, credential := range credentials {
			t.Run(string(credential)+" "+route.pattern, func(t *testing.T) {
				status, code := env.call(t, route, credential)
				if route.principal == matrixSessionPrincipal {
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

				var validKey, wrongScope bool
				switch route.principal {
				case matrixIngestPrincipal:
					validKey = credential == matrixPK || credential == matrixOtherPK
					wrongScope = credential == matrixSK || credential == matrixOtherSK
				case matrixSourcemapPrincipal:
					validKey = credential == matrixSK || credential == matrixOtherSK
					wrongScope = credential == matrixPK || credential == matrixOtherPK
				default:
					t.Fatalf("unsupported route principal %q", route.principal)
				}
				if validKey {
					if status == http.StatusUnauthorized || status == http.StatusForbidden {
						t.Fatalf("valid %s key failed authentication: status=%d code=%q",
							route.principal, status, code)
					}
					return
				}
				if wrongScope {
					if status != http.StatusForbidden || code != "insufficient_scope" {
						t.Fatalf("wrong-scope key status/code=%d/%q, want 403/insufficient_scope", status, code)
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

func isSourceMapMatrixRoute(pattern string) bool {
	return strings.HasPrefix(pattern, "/api/v1/sourcemaps") ||
		strings.HasSuffix(pattern, "/sourcemaps/verify")
}

func TestRouteMatrixCoversEverySourceMapRoute(t *testing.T) {
	_, q, _ := authTestRouter(t)
	deps := &handler.Dependencies{Queries: q, JWTSecret: sessionReadSecret}
	router := handler.NewRouter(deps)

	got := map[string]bool{}
	if err := chi.Walk(router, func(
		method, route string,
		_ http.Handler,
		middlewares ...func(http.Handler) http.Handler,
	) error {
		if isSourceMapMatrixRoute(route) {
			got[method+" "+route] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	want := map[string]bool{}
	for _, route := range matrixRoutes("matrix-project") {
		if isSourceMapMatrixRoute(route.pattern) {
			want[route.method+" "+route.pattern] = true
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("source-map routes = %#v, want %#v", got, want)
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

// TestEveryAPIRouteHasAnAuthenticator closes the gap the route matrix cannot:
// a new route registered with no middleware at all would otherwise escape the
// credential-polarity assertions. Every /api/v1 route must either attach an
// authenticator or appear on the allowlist above.
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
