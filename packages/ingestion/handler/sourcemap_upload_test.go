package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/debugid"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

type memorySourceMapStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	statErr error
	putErr  error
}

func newMemorySourceMapStore() *memorySourceMapStore {
	return &memorySourceMapStore{objects: make(map[string][]byte)}
}

func (s *memorySourceMapStore) PutObject(_ context.Context, key string, data []byte, _ string) error {
	if s.putErr != nil {
		return s.putErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = append([]byte(nil), data...)
	return nil
}

func (s *memorySourceMapStore) StatObject(_ context.Context, key string) (int64, error) {
	if s.statErr != nil {
		return 0, s.statErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.objects[key]
	if !ok {
		return 0, minioPkg.ErrObjectNotFound
	}
	return int64(len(data)), nil
}

func setupSourceMapUpload(t *testing.T) (http.Handler, *db.Queries, string, string, string, *memorySourceMapStore) {
	t.Helper()
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "source-map-upload")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	project, err := q.ProvisionProject(ctx, org.ID, "source-map-upload", nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	pk, err := q.CreateProjectKey(ctx, project.Project.ID, db.ScopeIngest, "pk", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	sk, err := q.CreateProjectKey(ctx, project.Project.ID, db.ScopeSourcemaps, "sk", nil, "https://ingest.test")
	if err != nil {
		t.Fatal(err)
	}
	store := newMemorySourceMapStore()
	router := handler.NewRouter(&handler.Dependencies{Queries: q, SourcemapStore: store})
	return router, q, project.Project.ID, pk.Raw, sk.Raw, store
}

func uploadRequest(router http.Handler, key, debugID, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPut, "/api/v1/sourcemaps/"+debugID, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("X-API-Key", key)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func responseCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body.Code
}

func TestSourceMapUploadCreatesAndRetriesIdempotently(t *testing.T) {
	router, q, projectID, _, sk, store := setupSourceMapUpload(t)
	mapSource := `{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA"}`
	computed, err := debugid.Compute([]byte(mapSource))
	if err != nil {
		t.Fatal(err)
	}

	created := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("first upload = %d %s, want 201", created.Code, created.Body.String())
	}
	stored, found, err := q.GetSourceMapFile(context.Background(), projectID, computed.DebugID)
	if err != nil || !found {
		t.Fatalf("stored row: found=%v err=%v", found, err)
	}
	if stored.HasSourcesContent {
		t.Fatal("map without sourcesContent stored has_sources_content=true")
	}
	if _, ok := store.objects[stored.ObjectKey]; !ok {
		t.Fatalf("object %q was not stored", stored.ObjectKey)
	}

	retry := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry = %d %s, want 200", retry.Code, retry.Body.String())
	}

	delete(store.objects, stored.ObjectKey)
	healed := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if healed.Code != http.StatusOK {
		t.Fatalf("healing retry = %d %s, want 200", healed.Code, healed.Body.String())
	}
	if _, ok := store.objects[stored.ObjectKey]; !ok {
		t.Fatal("retry did not restore the missing object")
	}
}

func TestSourceMapUploadWakesPendingStackResolution(t *testing.T) {
	router, q, projectID, _, sk, _ := setupSourceMapUpload(t)
	mapSource := `{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA"}`
	computed, err := debugid.Compute([]byte(mapSource))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	var environmentID string
	if err := q.Pool().QueryRow(ctx,
		`SELECT default_environment_id FROM projects WHERE id=$1`, projectID,
	).Scan(&environmentID); err != nil {
		t.Fatal(err)
	}
	receipt, err := q.CaptureError(ctx, db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: environmentID,
		ErrorType: "TypeError", ErrorMessage: "late map", Platform: "javascript",
		StackTraceRaw: "at f (https://app.test/a.js:1:1)",
		DebugMeta:     `{"images":[{"type":"sourcemap","code_file":"https://app.test/a.js","debug_id":"` + computed.DebugID + `"}]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Pool().Exec(ctx,
		`UPDATE error_group_jobs
		    SET status='claimed', worker_id='resolver-1', claimed_at=now(),
		        lease_expires_at=now()+interval '5 minutes'
		  WHERE project_id=$1 AND event_id=$2 AND job_type='stack_resolve'`,
		projectID, receipt.EventID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO error_event_resolutions
		   (project_id, event_id, status, resolver_version)
		 VALUES ($1,$2,'pending',2)`,
		projectID, receipt.EventID,
	); err != nil {
		t.Fatal(err)
	}

	response := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s, want 201", response.Code, response.Body.String())
	}

	var pending int
	if err := q.Pool().QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND event_id=$2 AND job_type='stack_resolve' AND status='pending'`,
		projectID, receipt.EventID,
	).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Errorf("pending resolver jobs = %d, want 1", pending)
	}
}

func TestSourceMapUploadAuthAndValidation(t *testing.T) {
	router, _, _, pk, sk, _ := setupSourceMapUpload(t)
	mapSource := `{"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}`
	computed, err := debugid.Compute([]byte(mapSource))
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name, key, id, body string
		headers             map[string]string
		status              int
		code                string
	}{
		{"public key denied", pk, computed.DebugID, mapSource, nil, 403, "insufficient_scope"},
		{"missing key denied", "", computed.DebugID, mapSource, nil, 401, "invalid_api_key"},
		{"invalid id", sk, "ZZZ", mapSource, nil, 400, "invalid_debug_id"},
		{"invalid map", sk, computed.DebugID, "not json", nil, 400, "invalid_source_map"},
		{"id mismatch", sk, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", mapSource, nil, 409, "debug_id_mismatch"},
		{"content encoding", sk, computed.DebugID, mapSource, map[string]string{"Content-Encoding": "gzip"}, 415, "unsupported_media_type"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := uploadRequest(router, test.key, test.id, test.body, test.headers)
			if response.Code != test.status || responseCode(t, response) != test.code {
				t.Fatalf("response = %d/%q %s, want %d/%q",
					response.Code, responseCode(t, response), response.Body.String(), test.status, test.code)
			}
		})
	}
}

func TestSourceMapUploadWithoutStorageIsUnavailable(t *testing.T) {
	_, q, _, _, sk, _ := setupSourceMapUpload(t)
	router := handler.NewRouter(&handler.Dependencies{Queries: q})
	response := uploadRequest(router, sk, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", `{}`, nil)
	if response.Code != http.StatusServiceUnavailable || responseCode(t, response) != "storage_unavailable" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestSourceMapUploadRejectsConflictingStoredDigest(t *testing.T) {
	router, q, projectID, _, sk, _ := setupSourceMapUpload(t)
	mapSource := `{"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}`
	computed, err := debugid.Compute([]byte(mapSource))
	if err != nil {
		t.Fatal(err)
	}
	_, inserted, err := q.UpsertSourceMapFile(context.Background(), db.SourceMapFile{
		ProjectID: projectID, DebugID: computed.DebugID,
		ContentSHA256: strings.Repeat("0", 64), HasSourcesContent: true,
		SizeBytes: 1, ObjectKey: "sourcemaps/conflicting",
	})
	if err != nil || !inserted {
		t.Fatalf("seed conflict: inserted=%v err=%v", inserted, err)
	}
	response := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if response.Code != http.StatusConflict || responseCode(t, response) != "debug_id_conflict" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestSourceMapUploadReturnsStorageFailureOnStatError(t *testing.T) {
	router, _, _, _, sk, store := setupSourceMapUpload(t)
	mapSource := `{"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}`
	computed, err := debugid.Compute([]byte(mapSource))
	if err != nil {
		t.Fatal(err)
	}
	if response := uploadRequest(router, sk, computed.DebugID, mapSource, nil); response.Code != http.StatusCreated {
		t.Fatalf("seed upload = %d %s", response.Code, response.Body.String())
	}
	store.statErr = errors.New("storage offline")
	response := uploadRequest(router, sk, computed.DebugID, mapSource, nil)
	if response.Code != http.StatusServiceUnavailable || responseCode(t, response) != "storage_unavailable" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestSourceMapUploadRejectsOversizedWireBody(t *testing.T) {
	router, _, _, _, sk, _ := setupSourceMapUpload(t)
	response := uploadRequest(
		router,
		sk,
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		strings.Repeat("x", (32<<20)+1),
		nil,
	)
	if response.Code != http.StatusRequestEntityTooLarge || responseCode(t, response) != "payload_too_large" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestSourceMapUploadRateLimitContract(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := handler.SourcemapRateLimitForTest(1)(next)
	call := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/sourcemaps/id", nil)
		req = req.WithContext(handler.WithProjectIDForTest(req.Context(), "project"))
		response := httptest.NewRecorder()
		h.ServeHTTP(response, req)
		return response
	}
	if first := call(); first.Code != http.StatusNoContent {
		t.Fatalf("first response = %d", first.Code)
	}
	second := call()
	if second.Code != http.StatusTooManyRequests || responseCode(t, second) != "rate_limited" {
		t.Fatalf("second response = %d %s", second.Code, second.Body.String())
	}
	if second.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", second.Header().Get("Retry-After"))
	}
}
