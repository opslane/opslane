package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

// ptrStr returns a pointer to a string literal (helper for *string params in tests).
func ptrStr(s string) *string { return &s }

// testDeps creates a Dependencies backed by a real Postgres pool.
// It requires DATABASE_URL to be set.
func testDeps(t *testing.T) (*handler.Dependencies, *pgxpool.Pool) {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	queries := db.New(pool)
	deps := &handler.Dependencies{Queries: queries, JWTSecret: sessionReadSecret}
	return deps, pool
}

// seedTenant creates org -> project -> environment -> API key and returns the raw key.
func seedTenant(t *testing.T, q *db.Queries) (orgID, projectID, envID, rawKey string) {
	t.Helper()
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "test-org-"+t.Name())
	if err != nil {
		t.Fatalf("create org: %v", err)
	}

	proj, err := q.CreateProject(ctx, org.ID, "test-project", ptrStr("owner/repo"))
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}

	key, err := q.CreateProjectKey(ctx, proj.ID, db.ScopeIngest, "test", nil)
	if err != nil {
		t.Fatalf("create api key: %v", err)
	}

	return org.ID, proj.ID, env.ID, key.Raw
}

func testMinIO(t *testing.T) *minioPkg.Client {
	t.Helper()
	ep := os.Getenv("MINIO_ENDPOINT")
	if ep == "" {
		t.Skip("MINIO_ENDPOINT not set; skipping replay test that needs object storage")
	}
	mc, err := minioPkg.New(ep, os.Getenv("MINIO_PUBLIC_ENDPOINT"),
		os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY"),
		os.Getenv("MINIO_BUCKET"), os.Getenv("MINIO_REGION"))
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return mc
}

func TestEnvironmentScopedKeyAuth_ValidKey(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	payload := `{
		"timestamp": "2026-02-20T00:00:00Z",
		"error": {"type": "TypeError", "message": "Cannot read property", "stack": "at foo.js:1\nat bar.js:2"},
		"breadcrumbs": [],
		"context": {"url": "https://example.com"},
		"sdk_version": "0.1.0"
	}`
	req, err := http.NewRequest("POST", srv.URL+"/api/v1/events", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("X-API-Key", rawKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("execute request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		var errBody map[string]string
		json.NewDecoder(resp.Body).Decode(&errBody)
		t.Fatalf("expected status 202, got %d: %v", resp.StatusCode, errBody)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["event_id"] == "" {
		t.Fatal("expected non-empty event_id in response")
	}
	if body["group_id"] == "" {
		t.Fatal("expected non-empty group_id in response")
	}
}

func TestIngestEvent_ResponseIncludesErrorGroupID(t *testing.T) {
	deps, _ := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	body := `{"timestamp":"2026-05-30T00:00:00Z","error":{"type":"TypeError","message":"x is not a function","stack":"at a (src/a.ts:1:1)"},"breadcrumbs":[],"context":{}}`
	req := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)

	w := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error_group_id"] == "" {
		t.Errorf("response missing error_group_id: %v", resp)
	}
	if resp["error_group_id"] != resp["group_id"] {
		t.Errorf("error_group_id (%q) must equal group_id (%q)", resp["error_group_id"], resp["group_id"])
	}
	if resp["event_id"] == "" {
		t.Errorf("response missing event_id: %v", resp)
	}
}

func postErrorPayload(t *testing.T, deps *handler.Dependencies, rawKey, body string) map[string]string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)
	recorder := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (%s)", recorder.Code, recorder.Body.String())
	}
	var response map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response
}

func TestIngest_PythonPlatformStored(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	body := `{
		"timestamp":"2026-07-18T00:00:00Z",
		"platform":"python",
		"runtime":{"name":"cpython","version":"3.12.1"},
		"error":{"type":"ValueError","message":"No row was found","stack":"Traceback (most recent call last):\n  File \"/app/api/routes/users.py\", line 42, in get_user\n    raise ValueError()\nValueError: No row was found"},
		"breadcrumbs":[],
		"context":null,
		"sdk_version":"0.1.0a2"
	}`
	response := postErrorPayload(t, deps, rawKey, body)

	var eventPlatform, groupPlatform, runtimeName, runtimeVersion string
	if err := pool.QueryRow(context.Background(), `
		SELECT e.platform, g.platform,
		       e.context->'runtime'->>'name', e.context->'runtime'->>'version'
		FROM error_events e
		JOIN error_groups g ON g.id = e.error_group_id
		WHERE e.id = $1`, response["event_id"]).
		Scan(&eventPlatform, &groupPlatform, &runtimeName, &runtimeVersion); err != nil {
		t.Fatalf("query stored platforms/runtime: %v", err)
	}
	if eventPlatform != "python" || groupPlatform != "python" {
		t.Fatalf("platforms = event:%q group:%q, want python/python", eventPlatform, groupPlatform)
	}
	if runtimeName != "cpython" || runtimeVersion != "3.12.1" {
		t.Fatalf("runtime = %q/%q, want cpython/3.12.1", runtimeName, runtimeVersion)
	}
}

func TestIngest_NoPlatformDefaultsToJavascript(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-18T00:00:00Z","error":{"type":"TypeError","message":"boom","stack":"at fn (/src/app.js:1:1)"},"breadcrumbs":[],"context":{},"sdk_version":"1.0.0"}`
	response := postErrorPayload(t, deps, rawKey, body)

	var eventPlatform, groupPlatform string
	if err := pool.QueryRow(context.Background(), `
		SELECT e.platform, g.platform
		FROM error_events e JOIN error_groups g ON g.id = e.error_group_id
		WHERE e.id = $1`, response["event_id"]).Scan(&eventPlatform, &groupPlatform); err != nil {
		t.Fatalf("query stored platforms: %v", err)
	}
	if eventPlatform != "javascript" || groupPlatform != "javascript" {
		t.Fatalf("platforms = event:%q group:%q, want javascript/javascript", eventPlatform, groupPlatform)
	}
}

func TestIngest_PlatformReadBackThroughGroupQueries(t *testing.T) {
	deps, _ := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	groups, err := deps.Queries.ListErrorGroups(context.Background(), projectID, nil)
	if err != nil {
		t.Fatalf("list groups: %v", err)
	}
	if len(groups) != 1 || groups[0].Platform == nil || *groups[0].Platform != "python" {
		t.Fatalf("ListErrorGroups platform = %+v, want python", groups)
	}
	group, err := deps.Queries.GetErrorGroup(context.Background(), projectID, response["group_id"])
	if err != nil {
		t.Fatalf("get group: %v", err)
	}
	if group.Platform == nil || *group.Platform != "python" {
		t.Fatalf("GetErrorGroup platform = %v, want python", group.Platform)
	}
}

func TestListErrorGroups_PlatformFilter(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, envID, rawKey := seedTenant(t, deps.Queries)
	postErrorPayload(t, deps, rawKey, `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"python-only","stack":"Traceback (most recent call last):\nValueError: python-only"},"breadcrumbs":[],"context":{}}`)
	postErrorPayload(t, deps, rawKey, `{"timestamp":"2026-07-19T00:00:01Z","platform":"javascript","error":{"type":"TypeError","message":"javascript-only","stack":"at fn (/src/app.js:1:1)"},"breadcrumbs":[],"context":{}}`)
	// Environment-scoped, matching real friction identity: this makes the
	// friction arm of the environment-scoped query actually participate, so a
	// platform filter has something to suppress.
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO error_groups (project_id, environment_id, fingerprint, title, first_seen, last_seen, kind, status)
		 VALUES ($1, $2, $3, 'friction-only', now(), now(), 'friction', 'insight')`,
		projectID, envID, "friction-"+t.Name()); err != nil {
		t.Fatalf("insert friction incident: %v", err)
	}

	python := "python"
	got, err := deps.Queries.ListErrorGroups(context.Background(), projectID, &db.ErrorGroupFilters{Platform: python})
	if err != nil {
		t.Fatalf("list python groups: %v", err)
	}
	if len(got) != 1 || got[0].Platform == nil || *got[0].Platform != python || got[0].Kind != "error" {
		t.Fatalf("platform-filtered groups = %+v, want one python error", got)
	}

	all, err := deps.Queries.ListErrorGroups(context.Background(), projectID, nil)
	if err != nil {
		t.Fatalf("list all groups: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("unfiltered groups = %+v, want python, javascript, and friction", all)
	}

	// Environment-scoped listing takes a different query (a rollup CTE with a
	// separate friction arm), so the platform filter must be asserted there too.
	scoped, err := deps.Queries.ListErrorGroups(context.Background(), projectID,
		&db.ErrorGroupFilters{Platform: python, EnvironmentID: &envID})
	if err != nil {
		t.Fatalf("list python groups in environment: %v", err)
	}
	if len(scoped) != 1 || scoped[0].Platform == nil || *scoped[0].Platform != python || scoped[0].Kind != "error" {
		t.Fatalf("environment+platform groups = %+v, want one python error", scoped)
	}

	// Unfiltered, the same environment must still surface the friction row —
	// otherwise the assertion above would pass even if the friction arm were
	// broken for every query rather than suppressed only by the platform filter.
	scopedAll, err := deps.Queries.ListErrorGroups(context.Background(), projectID,
		&db.ErrorGroupFilters{EnvironmentID: &envID})
	if err != nil {
		t.Fatalf("list all groups in environment: %v", err)
	}
	var scopedFriction int
	for _, group := range scopedAll {
		if group.Kind == "friction" {
			scopedFriction++
		}
	}
	if len(scopedAll) != 3 || scopedFriction != 1 {
		t.Fatalf("environment-scoped groups = %+v, want both errors and the friction row", scopedAll)
	}
}

func TestListIncidents_PlatformQueryParam(t *testing.T) {
	deps, _ := testDeps(t)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	postErrorPayload(t, deps, rawKey, `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"python-http","stack":"Traceback (most recent call last):\nValueError: python-http"},"breadcrumbs":[],"context":{}}`)
	postErrorPayload(t, deps, rawKey, `{"timestamp":"2026-07-19T00:00:01Z","platform":"javascript","error":{"type":"TypeError","message":"javascript-http","stack":"at fn (/src/http.js:1:1)"},"breadcrumbs":[],"context":{}}`)

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents?platform=python", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("platform-only request = %d (%s), want 200", response.Code, response.Body.String())
	}
	var incidents []struct {
		Platform *string `json:"platform"`
	}
	if err := json.NewDecoder(response.Body).Decode(&incidents); err != nil {
		t.Fatalf("decode incidents: %v", err)
	}
	if len(incidents) != 1 || incidents[0].Platform == nil || *incidents[0].Platform != "python" {
		t.Fatalf("platform-filtered response = %+v, want one python incident", incidents)
	}

	badReq := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents?platform=Not%20A%20Token", nil)
	badReq.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	badResponse := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(badResponse, badReq)
	if badResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid platform = %d (%s), want 400", badResponse.Code, badResponse.Body.String())
	}
}

func TestGetSampleEvent_TenantScopedRoundTrip(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","runtime":{"name":"cpython","version":"3.12.1"},"error":{"type":"ValueError","message":"No row was found","stack":"Traceback (most recent call last):\n  File \"/app/api/x.py\", line 1, in f\n    raise ValueError()\nValueError: No row was found"},"breadcrumbs":[{"type":"log","timestamp":"t","category":"app","level":"warning","message":"near expiry"}],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	ev, err := deps.Queries.GetSampleEvent(context.Background(), projectID, response["group_id"])
	if err != nil {
		t.Fatalf("get sample event: %v", err)
	}
	if ev.ErrorType != "ValueError" || ev.Platform != "python" ||
		!strings.HasPrefix(ev.StackTraceRaw, "Traceback") {
		t.Fatalf("unexpected sample event: %+v", ev)
	}
	_, otherProject, _, _ := seedTenant(t, deps.Queries)
	if _, err := deps.Queries.GetSampleEvent(context.Background(), otherProject, response["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-project sample event read must be pgx.ErrNoRows, got %v", err)
	}

	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'candidate', adjudication_status = NULL WHERE id = $1`,
		response["group_id"]); err != nil {
		t.Fatalf("hide group as ordinary candidate: %v", err)
	}
	if _, err := deps.Queries.GetSampleEvent(context.Background(), projectID, response["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("hidden candidate's sample event must be pgx.ErrNoRows, got %v", err)
	}

	// Same-project wrong-group pointer must also be invisible: a stale
	// sample_event_id must not serve another incident's evidence.
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'new', adjudication_status = NULL WHERE id = $1`,
		response["group_id"]); err != nil {
		t.Fatalf("restore group visibility: %v", err)
	}
	other := postErrorPayload(t, deps, rawKey,
		`{"timestamp":"2026-07-19T00:00:03Z","platform":"python","error":{"type":"KeyError","message":"different group","stack":"Traceback (most recent call last):\nKeyError: different group"},"breadcrumbs":[],"context":{}}`)
	if other["group_id"] == response["group_id"] {
		t.Fatal("wrong-group case needs a distinct group")
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET sample_event_id = $1 WHERE id = $2`,
		other["event_id"], response["group_id"]); err != nil {
		t.Fatalf("corrupt same-project sample pointer: %v", err)
	}
	if _, err := deps.Queries.GetSampleEvent(context.Background(), projectID, response["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("same-project wrong-group sample pointer must be pgx.ErrNoRows, got %v", err)
	}
}

func TestGetSampleEventEndpoint_SessionOnlyAndRedacted(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	deps.JWTSecret = []byte(authTestJWTSecret)
	router := handler.NewRouter(deps)
	body := `{"timestamp":"2026-07-19T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"endpoint sample","stack":"Traceback (most recent call last):\n  File \"/app/api/x.py\", line 1, in f\nValueError: endpoint sample"},"breadcrumbs":[{"type":"log","message":"near expiry"}],"context":{"request":{"method":"GET","path":"/users/1","remote_addr":"203.0.113.9","headers":{"Authorization":"Bearer client-secret","content-type":"application/json"}}}}`
	posted := postErrorPayload(t, deps, rawKey, body)

	// Simulate a historical row written before the expanded deny-list. Read-side
	// protection must redact the whole payload and remove sensitive header keys.
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_events
		 SET breadcrumbs = $2::jsonb, context = $3::jsonb,
		     error_message = $4, stack_trace_raw = $5
		 WHERE id = $1`, posted["event_id"],
		`[{"type":"http","message":"token ghp_historicalmessage","data":{"Proxy-Authorization":"historical-breadcrumb-secret","content-type":"application/json"}}]`,
		`{"request":{"method":"GET","path":"/users/1","remote_addr":"203.0.113.9","headers":{"Authorization":"Bearer historical-header-secret","content-type":"application/json","Private-Token":"historical-gitlab-secret"}},"nested":{"x-auth-token":"historical-context-secret"}}`,
		`connect to postgres://svc:histdbpassword@db.internal/app failed`,
		"Traceback (most recent call last):\n  File \"/app/api/x.py\", line 1, in f\n    token ghp_stacksecret123\nValueError: endpoint sample"); err != nil {
		t.Fatalf("seed historical secrets: %v", err)
	}

	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), "sample-user", orgID, "sample@example.com")
	if err != nil {
		t.Fatalf("sign session token: %v", err)
	}
	get := func(path string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	path := "/api/v1/projects/" + projectID + "/incidents/" + posted["group_id"] + "/sample-event"
	response := get(path, map[string]string{"Authorization": "Bearer " + token})
	if response.Code != http.StatusOK {
		t.Fatalf("sample-event response = %d (%s), want 200", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
	for _, leak := range []string{
		"historical-header-secret", "historical-breadcrumb-secret",
		"historical-context-secret", "ghp_historicalmessage",
		"historical-gitlab-secret", "histdbpassword", "ghp_stacksecret123",
	} {
		if strings.Contains(response.Body.String(), leak) {
			t.Errorf("sample-event leaked %q: %s", leak, response.Body.String())
		}
	}
	var sample struct {
		Error struct {
			Type  string `json:"type"`
			Stack string `json:"stack"`
		} `json:"error"`
		Breadcrumbs []map[string]any `json:"breadcrumbs"`
		Context     map[string]any   `json:"context"`
	}
	if err := json.NewDecoder(response.Body).Decode(&sample); err != nil {
		t.Fatalf("decode sample event: %v", err)
	}
	if sample.Error.Type != "ValueError" || !strings.HasPrefix(sample.Error.Stack, "Traceback") || len(sample.Breadcrumbs) != 1 {
		t.Fatalf("unexpected sample event: %+v", sample)
	}
	requestContext, ok := sample.Context["request"].(map[string]any)
	if !ok || requestContext["remote_addr"] != "203.0.113.9" {
		t.Fatalf("request context = %#v", sample.Context["request"])
	}
	headers, ok := requestContext["headers"].(map[string]any)
	if !ok || headers["content-type"] != "application/json" {
		t.Fatalf("filtered headers = %#v", requestContext["headers"])
	}
	if _, exists := headers["Authorization"]; exists {
		t.Fatalf("Authorization header survived: %#v", headers)
	}

	unknown := get("/api/v1/projects/"+projectID+"/incidents/"+uuid.NewString()+"/sample-event",
		map[string]string{"Authorization": "Bearer " + token})
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown incident = %d (%s), want 404", unknown.Code, unknown.Body.String())
	}
	sibling, err := deps.Queries.CreateProject(context.Background(), orgID, "sample-event-sibling", nil)
	if err != nil {
		t.Fatalf("create sibling project: %v", err)
	}
	crossProject := get("/api/v1/projects/"+sibling.ID+"/incidents/"+posted["group_id"]+"/sample-event",
		map[string]string{"Authorization": "Bearer " + token})
	if crossProject.Code != http.StatusNotFound {
		t.Fatalf("cross-project incident = %d (%s), want 404", crossProject.Code, crossProject.Body.String())
	}
	sdkResponse := get(path, map[string]string{"X-API-Key": rawKey})
	if sdkResponse.Code != http.StatusUnauthorized {
		t.Fatalf("SDK-key sample event = %d (%s), want 401", sdkResponse.Code, sdkResponse.Body.String())
	}

	// Lock the event-project join itself: sample_event_id has no same-project
	// constraint, so a corrupt pointer must not expose another tenant's event.
	_, _, _, otherRawKey := seedTenant(t, deps.Queries)
	otherEvent := postErrorPayload(t, deps, otherRawKey,
		`{"timestamp":"2026-07-19T00:00:02Z","platform":"python","error":{"type":"SecretError","message":"other tenant","stack":"Traceback\nSecretError: other tenant"},"breadcrumbs":[],"context":{"secret":"other-tenant-secret"}}`)
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET sample_event_id = $1 WHERE id = $2`,
		otherEvent["event_id"], posted["group_id"]); err != nil {
		t.Fatalf("corrupt cross-project sample pointer: %v", err)
	}
	if _, err := deps.Queries.GetSampleEvent(context.Background(), projectID, posted["group_id"]); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("corrupt cross-project sample pointer must be pgx.ErrNoRows, got %v", err)
	}
	corruptPointer := get(path, map[string]string{"Authorization": "Bearer " + token})
	if corruptPointer.Code != http.StatusNotFound {
		t.Fatalf("corrupt cross-project pointer = %d (%s), want 404", corruptPointer.Code, corruptPointer.Body.String())
	}
	if strings.Contains(corruptPointer.Body.String(), "other-tenant-secret") {
		t.Fatalf("corrupt cross-project pointer leaked another tenant: %s", corruptPointer.Body.String())
	}

	malformed := postErrorPayload(t, deps, rawKey,
		`{"timestamp":"2026-07-19T00:00:01Z","platform":"python","error":{"type":"RuntimeError","message":"malformed headers","stack":"Traceback\nRuntimeError: malformed headers"},"breadcrumbs":{},"context":{"request":{"headers":[["Authorization","array-secret"]]}}}`)
	malformedResponse := get("/api/v1/projects/"+projectID+"/incidents/"+malformed["group_id"]+"/sample-event",
		map[string]string{"Authorization": "Bearer " + token})
	if malformedResponse.Code != http.StatusOK {
		t.Fatalf("malformed sample = %d (%s), want 200", malformedResponse.Code, malformedResponse.Body.String())
	}
	if strings.Contains(malformedResponse.Body.String(), "array-secret") {
		t.Fatalf("malformed headers leaked: %s", malformedResponse.Body.String())
	}
	var malformedSample struct {
		Breadcrumbs []any          `json:"breadcrumbs"`
		Context     map[string]any `json:"context"`
	}
	if err := json.NewDecoder(malformedResponse.Body).Decode(&malformedSample); err != nil {
		t.Fatalf("decode malformed sample: %v", err)
	}
	if malformedSample.Breadcrumbs == nil {
		t.Fatal("non-array breadcrumbs must normalize to []")
	}
	if request, ok := malformedSample.Context["request"].(map[string]any); ok {
		if headers, exists := request["headers"]; exists {
			if headerMap, isMap := headers.(map[string]any); !isMap || len(headerMap) != 0 {
				t.Fatalf("malformed headers must be dropped or empty, got %#v", headers)
			}
		}
	}
}

func TestCrossStackEndUserTimeline(t *testing.T) {
	deps, _ := testDeps(t)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	postErrorPayload(t, deps, rawKey,
		`{"timestamp":"2026-07-19T00:00:00Z","error":{"type":"TypeError","message":"cross-stack javascript","stack":"at jsFrame (/src/app.js:1:1)"},"breadcrumbs":[],"context":{"user":{"id":"cross-stack-user"}}}`)
	postErrorPayload(t, deps, rawKey,
		`{"timestamp":"2026-07-19T00:00:01Z","platform":"python","error":{"type":"ValueError","message":"cross-stack python","stack":"Traceback (most recent call last):\nValueError: cross-stack python"},"breadcrumbs":[],"context":{"user":{"id":"cross-stack-user"}}}`)

	groups, err := deps.Queries.ListErrorGroups(context.Background(), projectID,
		&db.ErrorGroupFilters{EndUserID: "cross-stack-user"})
	if err != nil {
		t.Fatalf("list cross-stack groups: %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("cross-stack groups = %+v, want two", groups)
	}
	wantPlatforms := map[string]bool{"javascript": false, "python": false}
	for _, group := range groups {
		if group.Platform == nil {
			t.Fatalf("group missing platform: %+v", group)
		}
		if _, ok := wantPlatforms[*group.Platform]; !ok {
			t.Fatalf("unexpected platform %q", *group.Platform)
		}
		wantPlatforms[*group.Platform] = true
	}
	for platform, seen := range wantPlatforms {
		if !seen {
			t.Errorf("data-layer timeline missing %s group", platform)
		}
	}

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/"+projectID+"/incidents?end_user_id=cross-stack-user", nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("timeline response = %d (%s), want 200", response.Code, response.Body.String())
	}
	var incidents []struct {
		Platform string `json:"platform"`
	}
	if err := json.NewDecoder(response.Body).Decode(&incidents); err != nil {
		t.Fatalf("decode timeline: %v", err)
	}
	if len(incidents) != 2 {
		t.Fatalf("HTTP timeline = %+v, want two incidents", incidents)
	}
	httpPlatforms := map[string]bool{}
	for _, incident := range incidents {
		httpPlatforms[incident.Platform] = true
	}
	if !httpPlatforms["javascript"] || !httpPlatforms["python"] {
		t.Fatalf("HTTP timeline platforms = %+v, want javascript and python", httpPlatforms)
	}
}

func TestIngest_SamePythonErrorGroupsTogether(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)
	stack := "Traceback (most recent call last):\n  File \"%s/api/routes/users.py\", line 42, in get_user\n    raise ValueError()\nValueError: No row was found"
	body := func(root string) string {
		return `{"timestamp":"2026-07-18T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"No row was found","stack":` +
			strconv.Quote(fmt.Sprintf(stack, root)) + `},"breadcrumbs":[],"context":{},"sdk_version":"0.1.0a2"}`
	}
	first := postErrorPayload(t, deps, rawKey, body("/app"))
	second := postErrorPayload(t, deps, rawKey, body("/srv"))
	if first["group_id"] != second["group_id"] {
		t.Fatalf("deployment roots fragmented group: %q vs %q", first["group_id"], second["group_id"])
	}

	var groups, events, occurrences int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*), COALESCE(sum(occurrence_count), 0)
		FROM error_groups WHERE project_id = $1 AND platform = 'python'`, projectID).Scan(&groups, &occurrences); err != nil {
		t.Fatalf("query python groups: %v", err)
	}
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM error_events WHERE project_id = $1 AND platform = 'python'`, projectID).Scan(&events); err != nil {
		t.Fatalf("query python events: %v", err)
	}
	if groups != 1 || events != 2 || occurrences != 2 {
		t.Fatalf("groups/events/occurrences = %d/%d/%d, want 1/2/2", groups, events, occurrences)
	}
}

func TestIngest_InvalidPlatformTokensFallBackToJavascript(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	for _, invalid := range []string{
		"Python",
		strings.Repeat("a", 33),
		"bad token!",
	} {
		body := `{"timestamp":"2026-07-18T00:00:00Z","platform":` + strconv.Quote(invalid) +
			`,"error":{"type":"TypeError","message":"boom","stack":"at fn (/src/app.js:1:1)"},"breadcrumbs":[],"context":{},"sdk_version":"1.0.0"}`
		response := postErrorPayload(t, deps, rawKey, body)

		var eventPlatform, groupPlatform string
		if err := pool.QueryRow(context.Background(), `
			SELECT e.platform, g.platform
			FROM error_events e JOIN error_groups g ON g.id = e.error_group_id
			WHERE e.id = $1`, response["event_id"]).Scan(&eventPlatform, &groupPlatform); err != nil {
			t.Fatalf("query stored platforms for %q: %v", invalid, err)
		}
		if eventPlatform != "javascript" || groupPlatform != "javascript" {
			t.Fatalf("platform %q stored as event:%q group:%q, want javascript fallback", invalid, eventPlatform, groupPlatform)
		}
	}
}

func TestIngest_InvalidRuntimeShapeIsNotPersisted(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-18T00:00:00Z","platform":"python","runtime":{"name":"cpython","version":""},"error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	var hasRuntime bool
	if err := pool.QueryRow(context.Background(), `SELECT context ? 'runtime' FROM error_events WHERE id = $1`, response["event_id"]).Scan(&hasRuntime); err != nil {
		t.Fatalf("query runtime presence: %v", err)
	}
	if hasRuntime {
		t.Fatal("invalid runtime shape was persisted")
	}
}

func TestIngest_ContextRuntimeCannotBypassValidation(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-18T00:00:00Z","platform":"python","error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":{"runtime":{"arbitrary":["client","json"]}},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	var hasRuntime bool
	if err := pool.QueryRow(context.Background(), `SELECT context ? 'runtime' FROM error_events WHERE id = $1`, response["event_id"]).Scan(&hasRuntime); err != nil {
		t.Fatalf("query runtime presence: %v", err)
	}
	if hasRuntime {
		t.Fatal("context.runtime bypassed top-level runtime validation")
	}
}

func TestIngest_ValidRuntimeSurvivesNonObjectContext(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-18T00:00:00Z","platform":"python","runtime":{"name":"cpython","version":"3.12.1"},"error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":["not","an","object"],"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	var runtimeName, runtimeVersion string
	if err := pool.QueryRow(context.Background(), `
		SELECT context->'runtime'->>'name', context->'runtime'->>'version'
		FROM error_events WHERE id = $1`, response["event_id"]).Scan(&runtimeName, &runtimeVersion); err != nil {
		t.Fatalf("query stored runtime: %v", err)
	}
	if runtimeName != "cpython" || runtimeVersion != "3.12.1" {
		t.Fatalf("runtime = %q/%q, want cpython/3.12.1", runtimeName, runtimeVersion)
	}
}

func TestInsertErrorEventAndGroup_EmptyPlatformDefaultsToJavascript(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, envID, _ := seedTenant(t, deps.Queries)
	result, err := deps.Queries.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID:     projectID,
		EnvironmentID: envID,
		ErrorType:     "TypeError",
		ErrorMessage:  "direct insert",
		StackTraceRaw: "at fn (/src/app.js:1:1)",
		Fingerprint:   "direct-default-platform-" + uuid.NewString(),
		Title:         "TypeError: direct insert",
	})
	if err != nil {
		t.Fatalf("insert event and group: %v", err)
	}
	var eventPlatform, groupPlatform string
	if err := pool.QueryRow(context.Background(), `
		SELECT e.platform, g.platform
		FROM error_events e JOIN error_groups g ON g.id = e.error_group_id
		WHERE e.id = $1`, result.EventID).Scan(&eventPlatform, &groupPlatform); err != nil {
		t.Fatalf("query stored platforms: %v", err)
	}
	if eventPlatform != "javascript" || groupPlatform != "javascript" {
		t.Fatalf("platforms = event:%q group:%q, want javascript/javascript", eventPlatform, groupPlatform)
	}
}

func TestIngest_RuntimeMergedBeforeContextRedaction(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)
	body := `{"timestamp":"2026-07-18T00:00:00Z","platform":"python","runtime":{"name":"sk_live_secretvalue","version":"3.12.1"},"error":{"type":"ValueError","message":"boom","stack":"Traceback (most recent call last):\ngarbage"},"breadcrumbs":[],"context":{},"sdk_version":"0.1.0a2"}`
	response := postErrorPayload(t, deps, rawKey, body)

	var runtimeName string
	if err := pool.QueryRow(context.Background(), `SELECT context->'runtime'->>'name' FROM error_events WHERE id = $1`, response["event_id"]).Scan(&runtimeName); err != nil {
		t.Fatalf("query runtime name: %v", err)
	}
	if runtimeName != "[REDACTED]" {
		t.Fatalf("runtime name = %q, want redacted", runtimeName)
	}
}

func TestIngestStacklessEvent_AcceptedAndDefaultsType(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)

	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	// Cross-origin "Script error." with empty type and empty stack — the exact
	// shape that was being 400'd before the stack-optional change.
	payload := `{
		"timestamp": "2026-02-20T00:00:00Z",
		"error": {"type": "", "message": "Script error.", "stack": ""},
		"breadcrumbs": [],
		"context": {"url": "https://example.com"},
		"sdk_version": "0.2.0"
	}`
	req, err := http.NewRequest("POST", srv.URL+"/api/v1/events", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("X-API-Key", rawKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("execute request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		var errBody map[string]string
		json.NewDecoder(resp.Body).Decode(&errBody)
		t.Fatalf("expected status 202 for stackless event, got %d: %v", resp.StatusCode, errBody)
	}

	// Empty type must be defaulted to "Error" before the DB insert (guards the
	// ordering bug — defaulting after fingerprinting would fragment groups).
	var errorType string
	err = pool.QueryRow(context.Background(),
		`SELECT error_type FROM error_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
		projectID).Scan(&errorType)
	if err != nil {
		t.Fatalf("query group: %v", err)
	}
	if errorType != "Error" {
		t.Errorf("expected defaulted error_type %q, got %q", "Error", errorType)
	}
}

func TestEnvironmentScopedKeyAuth_RevokedKey(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	// Revoke the key directly via SQL (no helper exists yet)
	ctx := context.Background()
	parsed, err := db.ParseProjectKey(rawKey)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE project_api_keys SET revoked_at = now() WHERE key_id = $1`, parsed.KeyID)
	if err != nil {
		t.Fatalf("revoke key: %v", err)
	}

	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, err := http.NewRequest("POST", srv.URL+"/api/v1/events", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("X-API-Key", rawKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("execute request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["error"] == "" {
		t.Fatal("expected non-empty error message in response")
	}
}

func TestEnvironmentScopedKeyAuth_MissingKey(t *testing.T) {
	deps, _ := testDeps(t)

	router := handler.NewRouter(deps)
	srv := httptest.NewServer(router)
	defer srv.Close()

	req, err := http.NewRequest("POST", srv.URL+"/api/v1/events", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	// Deliberately omitting X-API-Key header
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("execute request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["error"] == "" {
		t.Fatal("expected non-empty error message in response")
	}
}

func TestReplayInit_DerivesGroupFromErrorEventID(t *testing.T) {
	deps, pool := testDeps(t)
	deps.MinIO = testMinIO(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)

	body := `{"timestamp":"2026-05-30T00:00:00Z","error":{"type":"TypeError","message":"boom","stack":"at a (src/a.ts:1:1)"},"breadcrumbs":[],"context":{},"session_id":"sess-1"}`
	er := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	er.Header.Set("X-API-Key", rawKey)
	ew := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(ew, er)
	if ew.Code != http.StatusAccepted {
		t.Fatalf("event ingest: %d (%s)", ew.Code, ew.Body.String())
	}
	var ev map[string]string
	if err := json.NewDecoder(ew.Body).Decode(&ev); err != nil {
		t.Fatalf("decode event response: %v", err)
	}

	initBody := `{"session_id":"sess-1","error_event_id":"` + ev["event_id"] + `","trigger_type":"error"}`
	rr := httptest.NewRequest("POST", "/api/v1/replays/init", strings.NewReader(initBody))
	rr.Header.Set("X-API-Key", rawKey)
	rw := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(rw, rr)
	if rw.Code != http.StatusCreated {
		t.Fatalf("replay init: expected 201, got %d (%s)", rw.Code, rw.Body.String())
	}
	var init map[string]string
	if err := json.NewDecoder(rw.Body).Decode(&init); err != nil {
		t.Fatalf("decode replay init: %v", err)
	}

	var gotEvent, gotGroup *string
	if err := pool.QueryRow(context.Background(),
		`SELECT error_event_id, error_group_id FROM session_replays WHERE id = $1 AND project_id = $2`,
		init["replay_id"], projectID).Scan(&gotEvent, &gotGroup); err != nil {
		t.Fatalf("query replay row: %v", err)
	}
	if gotEvent == nil || *gotEvent != ev["event_id"] {
		t.Errorf("error_event_id not persisted: got %v want %s", gotEvent, ev["event_id"])
	}
	if gotGroup == nil || *gotGroup != ev["error_group_id"] {
		t.Errorf("error_group_id not derived: got %v want %s", gotGroup, ev["error_group_id"])
	}
}

func TestReplayInit_DropsCrossTenantErrorEventID(t *testing.T) {
	deps, pool := testDeps(t)
	deps.MinIO = testMinIO(t)
	_, _, _, keyA := seedTenant(t, deps.Queries)
	_, _, _, keyB := seedTenant(t, deps.Queries)

	body := `{"error":{"type":"E","message":"m","stack":"at a (src/a.ts:1:1)"},"breadcrumbs":[],"context":{},"session_id":"sA"}`
	er := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	er.Header.Set("X-API-Key", keyA)
	ew := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(ew, er)
	if ew.Code != http.StatusAccepted {
		t.Fatalf("event ingest: %d (%s)", ew.Code, ew.Body.String())
	}
	var ev map[string]string
	if err := json.NewDecoder(ew.Body).Decode(&ev); err != nil {
		t.Fatalf("decode event response: %v", err)
	}

	initBody := `{"session_id":"sB","error_event_id":"` + ev["event_id"] + `","trigger_type":"error"}`
	rr := httptest.NewRequest("POST", "/api/v1/replays/init", strings.NewReader(initBody))
	rr.Header.Set("X-API-Key", keyB)
	rw := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(rw, rr)
	if rw.Code != http.StatusCreated {
		t.Fatalf("replay init: expected 201, got %d (%s)", rw.Code, rw.Body.String())
	}
	var init map[string]string
	if err := json.NewDecoder(rw.Body).Decode(&init); err != nil {
		t.Fatalf("decode replay init: %v", err)
	}

	var gotEvent *string
	if err := pool.QueryRow(context.Background(),
		`SELECT error_event_id FROM session_replays WHERE id = $1`,
		init["replay_id"]).Scan(&gotEvent); err != nil {
		t.Fatalf("query replay row: %v", err)
	}
	if gotEvent != nil {
		t.Errorf("cross-tenant error_event_id should be dropped, got %v", *gotEvent)
	}
}

func TestGetIncident_IncludesReplayID(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)

	body := `{"timestamp":"2026-05-30T00:00:00Z","error":{"type":"TypeError","message":"boom","stack":"at a (src/a.ts:1:1)"},"breadcrumbs":[],"context":{},"session_id":"sess-X"}`
	ew := httptest.NewRecorder()
	er := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	er.Header.Set("X-API-Key", rawKey)
	handler.NewRouter(deps).ServeHTTP(ew, er)
	if ew.Code != http.StatusAccepted {
		t.Fatalf("event ingest: %d (%s)", ew.Code, ew.Body.String())
	}
	var ev map[string]string
	if err := json.NewDecoder(ew.Body).Decode(&ev); err != nil {
		t.Fatalf("decode event response: %v", err)
	}
	groupID := ev["error_group_id"]

	replayID := uuid.New().String()
	if err := deps.Queries.InsertReplay(context.Background(), replayID, projectID, &groupID, nil,
		"sess-X", "error", "https://app.example.com", "", "", "replays/"+projectID+"/"+replayID+"/recording.json"); err != nil {
		t.Fatalf("insert replay: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE session_replays SET status='complete' WHERE id=$1`, replayID); err != nil {
		t.Fatalf("mark complete: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
	req.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	handler.NewRouter(deps).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get incident: %d (%s)", w.Code, w.Body.String())
	}
	var inc map[string]any
	if err := json.NewDecoder(w.Body).Decode(&inc); err != nil {
		t.Fatalf("decode incident: %v", err)
	}
	if inc["replay_id"] != replayID {
		t.Errorf("expected replay_id %q, got %v", replayID, inc["replay_id"])
	}
}

func TestIncidentEvidence_IsDetailOnly(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, _, rawKey := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	body := `{"timestamp":"2026-07-17T00:00:00Z","error":{"type":"TypeError","message":"evidence detail","stack":"at a (src/a.ts:1:1)"},"breadcrumbs":[],"context":{}}`
	ingest := httptest.NewRecorder()
	ingestRequest := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	ingestRequest.Header.Set("Content-Type", "application/json")
	ingestRequest.Header.Set("X-API-Key", rawKey)
	handler.NewRouter(deps).ServeHTTP(ingest, ingestRequest)
	if ingest.Code != http.StatusAccepted {
		t.Fatalf("event ingest: %d (%s)", ingest.Code, ingest.Body.String())
	}
	var event map[string]string
	if err := json.NewDecoder(ingest.Body).Decode(&event); err != nil {
		t.Fatalf("decode event response: %v", err)
	}
	groupID := event["error_group_id"]
	diff := "diff --git a/src/a.ts b/src/a.ts"
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups
		 SET verification_evidence = '{"version":1,"tier":"E0","checks":[]}'::jsonb,
		     candidate_diff = $2
		 WHERE id = $1`, groupID, diff); err != nil {
		t.Fatalf("seed evidence: %v", err)
	}

	list := httptest.NewRecorder()
	listRequest := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/incidents", nil)
	listRequest.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	handler.NewRouter(deps).ServeHTTP(list, listRequest)
	if list.Code != http.StatusOK {
		t.Fatalf("list incidents: %d (%s)", list.Code, list.Body.String())
	}
	var incidents []map[string]any
	if err := json.NewDecoder(list.Body).Decode(&incidents); err != nil {
		t.Fatalf("decode incident list: %v", err)
	}
	found := false
	for _, incident := range incidents {
		if incident["id"] != groupID {
			continue
		}
		found = true
		if _, ok := incident["verification_evidence"]; ok {
			t.Fatalf("list item unexpectedly includes verification_evidence: %#v", incident)
		}
		if _, ok := incident["candidate_diff"]; ok {
			t.Fatalf("list item unexpectedly includes candidate_diff: %#v", incident)
		}
	}
	if !found {
		t.Fatalf("incident %q missing from list response", groupID)
	}

	detail := httptest.NewRecorder()
	detailRequest := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
	detailRequest.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	handler.NewRouter(deps).ServeHTTP(detail, detailRequest)
	if detail.Code != http.StatusOK {
		t.Fatalf("get incident: %d (%s)", detail.Code, detail.Body.String())
	}
	var incident map[string]any
	if err := json.NewDecoder(detail.Body).Decode(&incident); err != nil {
		t.Fatalf("decode incident detail: %v", err)
	}
	evidence, ok := incident["verification_evidence"].(map[string]any)
	if !ok || evidence["tier"] != "E0" {
		t.Fatalf("detail verification_evidence = %#v, want tier E0", incident["verification_evidence"])
	}
	if incident["candidate_diff"] != diff {
		t.Fatalf("detail candidate_diff = %#v, want %q", incident["candidate_diff"], diff)
	}
}

func TestIngest_RedactsBreadcrumbsAndContextBeforePersist(t *testing.T) {
	deps, pool := testDeps(t)
	_, projectID, _, rawKey := seedTenant(t, deps.Queries)

	// jwtMsgLeak is a bare JWT planted in a breadcrumb's free-text "message" field
	// (outside "data"). RedactBreadcrumbs only scrubs "data", so this exercises the
	// RedactBody layer applied over the whole serialized breadcrumb array.
	jwtMsgLeak := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	body := `{"timestamp":"2026-05-30T00:00:00Z",
	  "error":{"type":"E","message":"m","stack":"at a (src/a.ts:1:1)"},
	  "breadcrumbs":[
	    {"type":"http","data":{"url":"https://api/cb?access_token=ghp_qleak3","Authorization":"Bearer ghp_leak1"}},
	    {"type":"console","category":"log","message":"user token ghp_msgleak4 jwt ` + jwtMsgLeak + `","data":{}}
	  ],
	  "context":{"note":"key sk_live_leak2","url":"https://u:pw@h/x","user":{"id":"u1","email":"a@b.com"}},
	  "session_id":"s1"}`
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	r.Header.Set("X-API-Key", rawKey)
	handler.NewRouter(deps).ServeHTTP(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("ingest: %d (%s)", w.Code, w.Body.String())
	}

	var bc, ctx string
	if err := pool.QueryRow(context.Background(),
		`SELECT breadcrumbs::text, context::text FROM error_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`,
		projectID).Scan(&bc, &ctx); err != nil {
		t.Fatalf("query event: %v", err)
	}
	for _, leak := range []string{"ghp_leak1", "ghp_qleak3", "sk_live_leak2", "u:pw@h", "ghp_msgleak4", jwtMsgLeak} {
		if strings.Contains(bc, leak) || strings.Contains(ctx, leak) {
			t.Errorf("secret %q persisted: bc=%s ctx=%s", leak, bc, ctx)
		}
	}
	if !strings.Contains(ctx, "a@b.com") {
		t.Errorf("redaction clobbered end-user email: %s", ctx)
	}
}

// Issue #27: the client-supplied event timestamp must be persisted as
// error_events.timestamp instead of server arrival time.
func TestIngestEvent_PersistsClientTimestamp(t *testing.T) {
	deps, pool := testDeps(t)
	_, _, _, rawKey := seedTenant(t, deps.Queries)

	clientTime := time.Now().UTC().Add(-90 * time.Second).Truncate(time.Millisecond)
	body := `{"timestamp":"` + clientTime.Format(time.RFC3339Nano) +
		`","error":{"type":"TypeError","message":"stale event","stack":"at a (src/a.ts:1:1)"}}`
	req := httptest.NewRequest("POST", "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", rawKey)

	w := httptest.NewRecorder()
	handler.NewRouter(deps).ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	var stored time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT "timestamp" FROM error_events WHERE id = $1`, resp["event_id"],
	).Scan(&stored); err != nil {
		t.Fatalf("query event: %v", err)
	}
	if !stored.Equal(clientTime) {
		t.Errorf("error_events.timestamp = %v, want client time %v", stored, clientTime)
	}
}
