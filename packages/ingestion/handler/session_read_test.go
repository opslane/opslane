package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/compress"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

var sessionReadSecret = []byte("session-read-test-secret-at-least-32-bytes")

func dashboardToken(t *testing.T, orgID string) string {
	t.Helper()
	token, err := auth.SignAccessToken(sessionReadSecret, "session-read-user", orgID, "reader@example.test")
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return token
}

func dashboardRequest(t *testing.T, router http.Handler, token, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

func seedReadableSession(t *testing.T, q *db.Queries, projectID, envID, sessionID string, startedAt time.Time) {
	t.Helper()
	if err := q.InsertSession(context.Background(), sessionID, projectID, envID, nil, startedAt, "https://app.example.test/session"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
}

func seedHandlerChunk(t *testing.T, q *db.Queries, sessionID, projectID string, seq int, scrubbed bool, decodedSize int64) string {
	t.Helper()
	ctx := context.Background()
	key := fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
	if err := q.ReserveChunkSeq(ctx, sessionID, projectID, seq, key, true); err != nil {
		t.Fatalf("reserve chunk: %v", err)
	}
	if err := q.CommitChunk(ctx, sessionID, projectID, seq, 123); err != nil {
		t.Fatalf("commit chunk: %v", err)
	}
	if scrubbed {
		first, last := int64(1000+seq*100), int64(1050+seq*100)
		if err := q.MarkChunkScrubbed(ctx, sessionID, projectID, seq, &first, &last, decodedSize); err != nil {
			t.Fatalf("mark scrubbed: %v", err)
		}
	}
	return key
}

func TestSessionRead_ListAndDetailRoutes(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	_, otherProjectID, _, _ := seedTenant(t, deps.Queries)
	deps.JWTSecret = sessionReadSecret
	token := dashboardToken(t, orgID)
	router := handler.NewRouterWithPool(deps, pool)

	userID, err := deps.Queries.UpsertEndUser(context.Background(), projectID, "user-1", "acme", "user@acme.test", "Acme")
	if err != nil {
		t.Fatalf("upsert end user: %v", err)
	}
	started := time.Now().UTC().Add(-time.Hour)
	listIDs := []string{
		fmt.Sprintf("sess_handler_%d_0", time.Now().UnixNano()),
		fmt.Sprintf("sess_handler_%d_1", time.Now().UnixNano()),
	}
	for i := 0; i < 2; i++ {
		sessionID := listIDs[i]
		endUser := (*string)(nil)
		if i == 0 {
			endUser = &userID
		}
		if err := deps.Queries.InsertSession(context.Background(), sessionID, projectID, envID, endUser, started.Add(time.Duration(i)*time.Minute), "https://app.example.test"); err != nil {
			t.Fatalf("insert session: %v", err)
		}
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE sessions SET sdk_release = '@opslane/sdk@1.4.2' WHERE id = $1`, listIDs[0]); err != nil {
		t.Fatalf("seed sdk release: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO friction_signals (
			session_id, project_id, environment_id, rule_version, signal_type,
			fingerprint, page_url_normalized, occurred_at, occurrence_count,
			adjudication_status
		) VALUES ($1, $2, $3, 1, 'rage_click', 'handler-rage', '/', now(), 4, 'accepted')`,
		listIDs[0], projectID, envID,
	); err != nil {
		t.Fatalf("seed friction signal: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO friction_signals (
			session_id, project_id, environment_id, rule_version, signal_type,
			fingerprint, page_url_normalized, occurred_at, occurrence_count,
			adjudication_status
		) VALUES ($1, $2, $3, 2, 'dead_click', 'handler-pending', '/', now(), 1, 'pending')`,
		listIDs[0], projectID, envID,
	); err != nil {
		t.Fatalf("seed pending friction signal: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO session_analysis (
			session_id, project_id, environment_id, session_started_at, coverage,
			activity_class, failed_request_4xx_count, successful_write_count, rule_version
		) VALUES ($1, $2, $3, $4, 'complete', 'active', 2, 1, 2)`,
		listIDs[0], projectID, envID, started,
	); err != nil {
		t.Fatalf("seed session analysis: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO error_events (
			project_id, environment_id, timestamp, error_type, error_message,
			stack_trace_raw, session_id
		) VALUES ($2, $3, now(), 'TypeError', 'boom', 'at handler test', $1)`,
		listIDs[0], projectID, envID,
	); err != nil {
		t.Fatalf("seed error event: %v", err)
	}
	seedHandlerChunk(t, deps.Queries, listIDs[0], projectID, 0, true, 2048)
	seedHandlerChunk(t, deps.Queries, listIDs[0], projectID, 1, false, 0)

	var logOutput bytes.Buffer
	originalLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logOutput, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })

	first := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions?search=user%40acme.test&has_signals=true&limit=1")
	if first.Code != http.StatusOK {
		t.Fatalf("list returned %d: %s", first.Code, first.Body.String())
	}
	var list struct {
		Sessions              []map[string]any `json:"sessions"`
		Next                  *string          `json:"next_cursor"`
		HasIdentifiedSessions bool             `json:"has_identified_sessions"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Sessions) != 1 || list.Sessions[0]["id"] != listIDs[0] {
		t.Fatalf("filtered sessions = %+v", list.Sessions)
	}
	if !list.HasIdentifiedSessions {
		t.Fatal("has_identified_sessions = false, want project-level true")
	}
	if list.Sessions[0]["playable_chunk_count"] != float64(1) || list.Sessions[0]["chunk_count"] != float64(2) {
		t.Fatalf("chunk counts = %+v", list.Sessions[0])
	}
	if list.Sessions[0]["sdk_release"] != "@opslane/sdk@1.4.2" ||
		list.Sessions[0]["error_count"] != float64(1) ||
		list.Sessions[0]["rage_click_count"] != float64(4) ||
		list.Sessions[0]["dead_click_count"] != float64(0) ||
		list.Sessions[0]["form_abandon_count"] != float64(0) ||
		list.Sessions[0]["coverage"] != "complete" ||
		list.Sessions[0]["activity_class"] != "active" ||
		list.Sessions[0]["failed_request_count"] != float64(2) ||
		list.Sessions[0]["successful_write_count"] != float64(1) ||
		list.Sessions[0]["unverified_signal_count"] != float64(1) {
		t.Fatalf("summary fields = %+v", list.Sessions[0])
	}
	if _, ok := list.Sessions[0]["end_user"].(map[string]any); !ok {
		t.Fatalf("end_user shape = %#v", list.Sessions[0]["end_user"])
	}
	if logs := logOutput.String(); !strings.Contains(logs, "session list query completed") ||
		!strings.Contains(logs, "duration_ms=") || !strings.Contains(logs, "project_id="+projectID) {
		t.Fatalf("list query duration log = %q", logs)
	}
	filterValues := url.Values{
		"end_user_id": {userID},
		"from":        {started.Add(-time.Minute).Format(time.RFC3339)},
		"to":          {started.Add(time.Minute).Format(time.RFC3339)},
	}
	filtered := dashboardRequest(t, router, token,
		"/api/v1/projects/"+projectID+"/sessions?"+filterValues.Encode())
	if filtered.Code != http.StatusOK || !strings.Contains(filtered.Body.String(), listIDs[0]) || strings.Contains(filtered.Body.String(), listIDs[1]) {
		t.Fatalf("user/time filters returned %d: %s", filtered.Code, filtered.Body.String())
	}

	allFirst := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions?limit=1")
	var page struct {
		Next *string `json:"next_cursor"`
	}
	if err := json.Unmarshal(allFirst.Body.Bytes(), &page); err != nil || page.Next == nil {
		t.Fatalf("first cursor page = %s err=%v", allFirst.Body.String(), err)
	}
	second := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions?limit=1&cursor="+url.QueryEscape(*page.Next))
	if second.Code != http.StatusOK || strings.Contains(second.Body.String(), `"next_cursor"`) {
		t.Fatalf("terminal cursor page returned %d: %s", second.Code, second.Body.String())
	}
	malformed := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions?cursor=nope")
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed cursor returned %d", malformed.Code)
	}
	badHasSignals := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions?has_signals=maybe")
	if badHasSignals.Code != http.StatusBadRequest {
		t.Fatalf("invalid has_signals returned %d", badHasSignals.Code)
	}
	wrongProject := dashboardRequest(t, router, token, "/api/v1/projects/"+otherProjectID+"/sessions")
	if wrongProject.Code != http.StatusForbidden {
		t.Fatalf("wrong project returned %d", wrongProject.Code)
	}
	unanalyzed := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions/"+listIDs[1])
	var unanalyzedJSON map[string]any
	if err := json.Unmarshal(unanalyzed.Body.Bytes(), &unanalyzedJSON); err != nil || unanalyzedJSON["coverage"] != nil {
		t.Fatalf("unanalyzed coverage = %#v err=%v", unanalyzedJSON["coverage"], err)
	}

	detail := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions/"+listIDs[0])
	if detail.Code != http.StatusOK {
		t.Fatalf("detail returned %d: %s", detail.Code, detail.Body.String())
	}
	var detailJSON map[string]any
	if err := json.Unmarshal(detail.Body.Bytes(), &detailJSON); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detailJSON["sdk_release"] != "@opslane/sdk@1.4.2" ||
		detailJSON["error_count"] != float64(1) ||
		detailJSON["rage_click_count"] != float64(4) {
		t.Fatalf("detail summary fields = %+v", detailJSON)
	}
	chunks, ok := detailJSON["chunks"].([]any)
	if !ok || len(chunks) != 1 {
		t.Fatalf("detail chunks = %#v", detailJSON["chunks"])
	}
	chunk := chunks[0].(map[string]any)
	if _, exposed := chunk["object_key"]; exposed || chunk["decoded_size_bytes"] != float64(2048) {
		t.Fatalf("chunk manifest leaked or lost metadata: %+v", chunk)
	}
	missing := dashboardRequest(t, router, token, "/api/v1/projects/"+projectID+"/sessions/sess_missing_0001")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing detail returned %d", missing.Code)
	}
}

func TestSessionRead_ListValidatesAndScopesEnvironmentFilter(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, productionID, _ := seedTenant(t, deps.Queries)
	deps.JWTSecret = sessionReadSecret
	token := dashboardToken(t, orgID)
	router := handler.NewRouterWithPool(deps, pool)
	ctx := context.Background()

	staging, err := deps.Queries.CreateEnvironment(ctx, projectID, "staging")
	if err != nil {
		t.Fatalf("create staging environment: %v", err)
	}
	sibling, err := deps.Queries.CreateProject(ctx, orgID, "sibling-project", nil)
	if err != nil {
		t.Fatalf("create sibling project: %v", err)
	}
	siblingEnv, err := deps.Queries.CreateEnvironment(ctx, sibling.ID, "production")
	if err != nil {
		t.Fatalf("create sibling environment: %v", err)
	}

	started := time.Now().UTC().Add(-time.Hour)
	productionSession := fmt.Sprintf("sess_env_prod_%d", time.Now().UnixNano())
	stagingSession := fmt.Sprintf("sess_env_stage_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, productionID, productionSession, started)
	seedReadableSession(t, deps.Queries, projectID, staging.ID, stagingSession, started.Add(time.Minute))

	filtered := dashboardRequest(t, router, token,
		"/api/v1/projects/"+projectID+"/sessions?environment_id="+productionID)
	if filtered.Code != http.StatusOK || !strings.Contains(filtered.Body.String(), productionSession) || strings.Contains(filtered.Body.String(), stagingSession) {
		t.Fatalf("environment filter returned %d: %s", filtered.Code, filtered.Body.String())
	}

	badUUID := dashboardRequest(t, router, token,
		"/api/v1/projects/"+projectID+"/sessions?environment_id=not-a-uuid")
	if badUUID.Code != http.StatusBadRequest {
		t.Fatalf("bad environment UUID returned %d: %s", badUUID.Code, badUUID.Body.String())
	}

	crossProject := dashboardRequest(t, router, token,
		"/api/v1/projects/"+projectID+"/sessions?environment_id="+siblingEnv.ID)
	if crossProject.Code != http.StatusNotFound {
		t.Fatalf("cross-project environment returned %d: %s", crossProject.Code, crossProject.Body.String())
	}
}

func storageRouter(t *testing.T) (*handler.Dependencies, *pgxpool.Pool, *minioPkg.Client, http.Handler, string, string, string) {
	t.Helper()
	deps, pool := testDepsWithStorage(t)
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	deps.JWTSecret = sessionReadSecret
	return deps, pool, deps.MinIO, handler.NewRouterWithPool(deps, pool), dashboardToken(t, orgID), projectID, envID
}

func TestSessionRead_ChunkIsBoundedFailClosedAndRedacted(t *testing.T) {
	t.Setenv("INTERNAL_READ_TOKEN", "test-internal-token")
	deps, pool, storage, router, token, projectID, envID := storageRouter(t)
	ctx := context.Background()

	tests := []struct {
		name       string
		seq        int
		body       []byte
		scrubbed   bool
		wantStatus int
	}{
		{name: "redacted readable chunk", seq: 0, body: gzipBytes(t, []byte(`{"events":[{"type":5,"data":{"authorization":"Bearer sk_live_CHUNKSECRET"}}]}`)), scrubbed: true, wantStatus: http.StatusOK},
		{name: "unscrubbed", seq: 1, body: gzipBytes(t, []byte(`{"events":[]}`)), scrubbed: false, wantStatus: http.StatusNotFound},
		{name: "gzip bomb", seq: 2, body: mustDeflate(t, bytes.Repeat([]byte("A"), (20<<20)+1)), scrubbed: true, wantStatus: http.StatusRequestEntityTooLarge},
		{name: "corrupt gzip", seq: 3, body: []byte("not-gzip"), scrubbed: true, wantStatus: http.StatusInternalServerError},
		{name: "compressed object over upload cap", seq: 4, body: bytes.Repeat([]byte("x"), (5<<20)+1), scrubbed: true, wantStatus: http.StatusRequestEntityTooLarge},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sessionID := fmt.Sprintf("sess_chunk_%d_%02d", time.Now().UnixNano(), tt.seq)
			seedReadableSession(t, deps.Queries, projectID, envID, sessionID, time.Now())
			key := seedHandlerChunk(t, deps.Queries, sessionID, projectID, tt.seq, tt.scrubbed, int64(len(tt.body)))
			t.Cleanup(func() { _ = storage.RemoveObject(context.Background(), key) })
			if err := storage.PutObject(ctx, key, tt.body, "application/gzip"); err != nil {
				t.Fatalf("put object: %v", err)
			}
			response := dashboardRequest(t, router, token,
				fmt.Sprintf("/api/v1/projects/%s/sessions/%s/chunks/%d", projectID, sessionID, tt.seq))
			if response.Code != tt.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), tt.wantStatus)
			}
			if tt.wantStatus == http.StatusOK {
				if strings.Contains(response.Body.String(), "sk_live_CHUNKSECRET") {
					t.Fatal("secret survived redact-on-read")
				}
				if response.Header().Get("Cache-Control") != "private, max-age=3600" {
					t.Fatalf("cache header = %q", response.Header().Get("Cache-Control"))
				}
				internalReq := httptest.NewRequest(http.MethodGet,
					fmt.Sprintf("/internal/v1/projects/%s/sessions/%s/chunks/%d", projectID, sessionID, tt.seq), nil)
				internalReq.Header.Set("X-Internal-Token", "test-internal-token")
				internalResponse := httptest.NewRecorder()
				router.ServeHTTP(internalResponse, internalReq)
				if internalResponse.Code != http.StatusOK || internalResponse.Body.String() != response.Body.String() {
					t.Fatalf("internal response = %d/%s, dashboard = %d/%s",
						internalResponse.Code, internalResponse.Body.String(), response.Code, response.Body.String())
				}
			}
		})
	}

	deletingID := fmt.Sprintf("sess_deleting_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, deletingID, time.Now())
	key := seedHandlerChunk(t, deps.Queries, deletingID, projectID, 0, true, 100)
	t.Cleanup(func() { _ = storage.RemoveObject(context.Background(), key) })
	if err := storage.PutObject(ctx, key, gzipBytes(t, []byte(`{"events":[]}`)), "application/gzip"); err != nil {
		t.Fatalf("put deleting object: %v", err)
	}
	if _, err := deps.Queries.ListPlayableChunks(ctx, projectID, deletingID); err != nil {
		t.Fatalf("preflight manifest: %v", err)
	}
	if _, err := deps.Queries.GetSessionSummary(ctx, projectID, deletingID); err != nil {
		t.Fatalf("preflight summary: %v", err)
	}
	if _, err := deps.Queries.GetPlayableChunk(ctx, projectID, deletingID, 0); err != nil {
		t.Fatalf("preflight chunk: %v", err)
	}
	// Direct fixture state is intentional: MarkSessionDeleting only claims
	// sessions that satisfy the retention predicate.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET status='deleting' WHERE id=$1`, deletingID); err != nil {
		t.Fatalf("mark deleting fixture: %v", err)
	}
	response := dashboardRequest(t, router, token,
		fmt.Sprintf("/api/v1/projects/%s/sessions/%s/chunks/0", projectID, deletingID))
	if response.Code != http.StatusNotFound {
		t.Fatalf("deleting session chunk returned %d", response.Code)
	}
}

func mustDeflate(t *testing.T, body []byte) []byte {
	t.Helper()
	compressed, err := compress.Deflate(body)
	if err != nil {
		t.Fatalf("deflate: %v", err)
	}
	return compressed
}

func TestSessionRead_InternalTokenGuard(t *testing.T) {
	t.Setenv("INTERNAL_READ_TOKEN", "")
	disabled := handler.NewRouter(&handler.Dependencies{})
	response := httptest.NewRecorder()
	disabled.ServeHTTP(response, httptest.NewRequest(http.MethodGet,
		"/internal/v1/projects/p/sessions/s/chunks/0", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unset token returned %d", response.Code)
	}

	t.Setenv("INTERNAL_READ_TOKEN", "expected-token")
	guarded := handler.NewRouter(&handler.Dependencies{})
	for _, token := range []string{"", "wrong-token"} {
		req := httptest.NewRequest(http.MethodGet, "/internal/v1/projects/p/sessions/s/chunks/0", nil)
		req.Header.Set("X-Internal-Token", token)
		response = httptest.NewRecorder()
		guarded.ServeHTTP(response, req)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("token %q returned %d", token, response.Code)
		}
	}
}

func TestGetIncident_IncludesSessionPointerBeforeChunksAreReady(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, envID, _ := seedTenant(t, deps.Queries)
	deps.JWTSecret = sessionReadSecret
	sessionID := fmt.Sprintf("sess_pointer_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, envID, sessionID, time.Now())
	result, err := deps.Queries.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: envID, Fingerprint: "handler-pointer",
		Title: "pointer", ErrorType: "TypeError", ErrorMessage: "boom", StackTraceRaw: "at test", SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("ingest pointer event: %v", err)
	}
	router := handler.NewRouterWithPool(deps, pool)
	response := dashboardRequest(t, router, dashboardToken(t, orgID),
		fmt.Sprintf("/api/v1/projects/%s/incidents/%s", projectID, result.GroupID))
	if response.Code != http.StatusOK {
		t.Fatalf("incident returned %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Pointer *struct {
			SessionID string `json:"session_id"`
			ErrorAt   string `json:"error_at"`
		} `json:"session_pointer"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode incident: %v", err)
	}
	if body.Pointer == nil || body.Pointer.SessionID != sessionID {
		t.Fatalf("session pointer = %+v", body.Pointer)
	}
	if _, err := time.Parse(time.RFC3339, body.Pointer.ErrorAt); err != nil {
		t.Fatalf("error_at %q is not RFC3339: %v", body.Pointer.ErrorAt, err)
	}
}
