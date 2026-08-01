package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/debugid"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

type sourceMapHandlerFixture struct {
	deps      *handler.Dependencies
	pool      *pgxpool.Pool
	storage   *minioPkg.Client
	router    http.Handler
	orgID     string
	projectID string
	key       string
	raw       []byte
	debugID   string
}

func newSourceMapHandlerFixture(t *testing.T) *sourceMapHandlerFixture {
	t.Helper()
	deps, pool := testDeps(t)
	storage := testMinIO(t)
	deps.MinIO = storage
	deps.JWTSecret = sessionReadSecret
	ctx := context.Background()
	org, err := deps.Queries.CreateOrg(ctx, "sourcemap-handler-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	project, err := deps.Queries.CreateProject(ctx, org.ID, "sourcemap-handler", nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := deps.Queries.CreateProjectKey(ctx, project.ID, db.ScopeSourcemaps, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA;A","sourcesContent":["private fixture source"]}`)
	fingerprint, err := debugid.Compute(raw)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &sourceMapHandlerFixture{
		deps: deps, pool: pool, storage: storage, router: handler.NewRouter(deps),
		orgID: org.ID, projectID: project.ID, key: key.Raw,
		raw: raw, debugID: fingerprint.DebugID,
	}
	t.Cleanup(func() {
		_ = storage.RemovePrefix(context.Background(), "sourcemaps/v1/projects/"+project.ID+"/")
		_, _ = pool.Exec(context.Background(), `DELETE FROM sourcemap_batch_files WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sourcemap_files WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sourcemap_batches WHERE project_id = $1`, project.ID)
		cleanupTenantHandler(t, pool, org.ID)
	})
	return fixture
}

func (f *sourceMapHandlerFixture) request(
	t *testing.T, method, path string, body []byte, secret bool,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if secret {
		req.Header.Set("X-API-Key", f.key)
	}
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, req)
	return response
}

func (f *sourceMapHandlerFixture) createBatch(
	t *testing.T, idempotencyKey string, files []map[string]any,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{"files": files})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sourcemaps/batches", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", f.key)
	req.Header.Set("Idempotency-Key", idempotencyKey)
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, req)
	return response
}

func (f *sourceMapHandlerFixture) createDefaultBatch(t *testing.T) string {
	t.Helper()
	response := f.createBatch(t, uuid.NewString(), []map[string]any{{
		"debug_id": f.debugID, "code_file": "assets/a.js", "size_bytes": len(f.raw),
	}})
	if response.Code != http.StatusCreated {
		t.Fatalf("create batch status = %d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		BatchID string `json:"batch_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.BatchID
}

func (f *sourceMapHandlerFixture) upload(
	t *testing.T, batchID, debugID string, raw []byte,
) *httptest.ResponseRecorder {
	t.Helper()
	return f.request(t, http.MethodPut,
		"/api/v1/sourcemaps/batches/"+batchID+"/files/"+debugID, raw, true)
}

func (f *sourceMapHandlerFixture) complete(t *testing.T, batchID string) *httptest.ResponseRecorder {
	t.Helper()
	return f.request(t, http.MethodPost,
		"/api/v1/sourcemaps/batches/"+batchID+"/complete", []byte(`{}`), true)
}

func responseCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode error response: %v body=%s", err, response.Body.String())
	}
	return body.Code
}

func TestCreateBatchNewAndIdempotentRetry(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	key := uuid.NewString()
	files := []map[string]any{{
		"debug_id": f.debugID, "code_file": "assets/a.js", "size_bytes": len(f.raw),
	}}
	first := f.createBatch(t, key, files)
	if first.Code != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	var created map[string]any
	if err := json.NewDecoder(first.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"batch_id", "status", "expected_files", "expected_bytes", "expires_at"} {
		if _, ok := created[field]; !ok {
			t.Errorf("create response missing %q: %v", field, created)
		}
	}
	retry := f.createBatch(t, key, files)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var reused map[string]any
	if err := json.NewDecoder(retry.Body).Decode(&reused); err != nil {
		t.Fatal(err)
	}
	if reused["batch_id"] != created["batch_id"] {
		t.Fatalf("retry batch_id=%v want %v", reused["batch_id"], created["batch_id"])
	}

	conflictFiles := []map[string]any{{
		"debug_id": f.debugID, "code_file": "assets/other.js", "size_bytes": len(f.raw),
	}}
	conflict := f.createBatch(t, key, conflictFiles)
	if conflict.Code != http.StatusConflict || responseCode(t, conflict) != "idempotency_conflict" {
		t.Fatalf("conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}
}

func TestCreateBatchValidation(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	tooMany := make([]map[string]any, 501)
	for i := range tooMany {
		tooMany[i] = map[string]any{
			"debug_id": uuid.NewString(), "code_file": fmt.Sprintf("assets/%d.js", i), "size_bytes": 1,
		}
	}
	tests := []struct {
		name   string
		key    string
		files  []map[string]any
		status int
		code   string
	}{
		{"missing idempotency", "", []map[string]any{{"debug_id": f.debugID, "code_file": "a.js", "size_bytes": 1}}, 400, "invalid_request"},
		{"zero files", uuid.NewString(), nil, 400, "invalid_manifest"},
		{"too many files", uuid.NewString(), tooMany, 413, "too_many_files"},
		{"duplicate debug IDs", uuid.NewString(), []map[string]any{
			{"debug_id": f.debugID, "code_file": "a.js", "size_bytes": 1},
			{"debug_id": f.debugID, "code_file": "b.js", "size_bytes": 1},
		}, 400, "duplicate_debug_id"},
		{"file too large", uuid.NewString(), []map[string]any{{
			"debug_id": f.debugID, "code_file": "a.js", "size_bytes": (100 << 20) + 1,
		}}, 413, "file_too_large"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := f.createBatch(t, test.key, test.files)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			if got := responseCode(t, response); got != test.code {
				t.Fatalf("code=%q want=%q", got, test.code)
			}
		})
	}
}

func TestPutFirstUploadAndIdenticalRetry(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	first := f.upload(t, batchID, f.debugID, f.raw)
	if first.Code != http.StatusCreated || !strings.Contains(first.Body.String(), `"status":"stored"`) {
		t.Fatalf("first upload status=%d body=%s", first.Code, first.Body.String())
	}
	retry := f.upload(t, batchID, f.debugID, f.raw)
	if retry.Code != http.StatusOK || !strings.Contains(retry.Body.String(), `"status":"already_present"`) {
		t.Fatalf("retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var rows int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sourcemap_batch_files WHERE batch_id = $1 AND state = 'staged'`,
		batchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("staged rows=%d want 1", rows)
	}
}

func TestPutValidationOrderingAndMediaTypes(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	path := "/api/v1/sourcemaps/batches/" + batchID + "/files/" + f.debugID

	t.Run("missing content length", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(f.raw))
		req.ContentLength = -1
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", f.key)
		response := httptest.NewRecorder()
		f.router.ServeHTTP(response, req)
		if response.Code != http.StatusLengthRequired || responseCode(t, response) != "length_required" {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	t.Run("content length mismatch", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(f.raw))
		req.ContentLength = int64(len(f.raw) - 1)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", f.key)
		response := httptest.NewRecorder()
		f.router.ServeHTTP(response, req)
		if response.Code != http.StatusConflict || responseCode(t, response) != "size_mismatch" {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	})
	for _, test := range []struct {
		name, contentType, encoding string
	}{
		{"wrong content type", "text/plain", ""},
		{"content encoding", "application/json", "gzip"},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(f.raw))
			req.Header.Set("Content-Type", test.contentType)
			req.Header.Set("Content-Encoding", test.encoding)
			req.Header.Set("X-API-Key", f.key)
			response := httptest.NewRecorder()
			f.router.ServeHTTP(response, req)
			if response.Code != http.StatusUnsupportedMediaType ||
				responseCode(t, response) != "unsupported_media_type" {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestPutWrongDebugIDAndMalformedMap(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	otherID := uuid.NewString()
	response := f.createBatch(t, uuid.NewString(), []map[string]any{{
		"debug_id": otherID, "code_file": "assets/a.js", "size_bytes": len(f.raw),
	}})
	if response.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var created struct {
		BatchID string `json:"batch_id"`
	}
	_ = json.NewDecoder(response.Body).Decode(&created)
	wrong := f.upload(t, created.BatchID, otherID, f.raw)
	if wrong.Code != http.StatusConflict || responseCode(t, wrong) != "debug_id_mismatch" {
		t.Fatalf("wrong ID status=%d body=%s", wrong.Code, wrong.Body.String())
	}

	malformed := []byte(`{"version":3,"version":3,"sources":[],"names":[],"mappings":"","sourcesContent":[]}`)
	malformedResponse := f.createBatch(t, uuid.NewString(), []map[string]any{{
		"debug_id": f.debugID, "code_file": "assets/a.js", "size_bytes": len(malformed),
	}})
	var malformedBatch struct {
		BatchID string `json:"batch_id"`
	}
	_ = json.NewDecoder(malformedResponse.Body).Decode(&malformedBatch)
	put := f.upload(t, malformedBatch.BatchID, f.debugID, malformed)
	if put.Code != http.StatusBadRequest || responseCode(t, put) != "invalid_source_map" {
		t.Fatalf("malformed status=%d body=%s", put.Code, put.Body.String())
	}
}

func TestCompleteAndVerifyKnownAndUnmappedPositions(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	if response := f.upload(t, batchID, f.debugID, f.raw); response.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", response.Code, response.Body.String())
	}
	first := f.complete(t, batchID)
	if first.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", first.Code, first.Body.String())
	}
	if !strings.Contains(first.Body.String(), `"status":"complete"`) ||
		!strings.Contains(first.Body.String(), `"completed_at"`) {
		t.Fatalf("completion receipt=%s", first.Body.String())
	}
	repeat := f.complete(t, batchID)
	if repeat.Code != http.StatusOK || repeat.Body.String() != first.Body.String() {
		t.Fatalf("repeat status=%d body=%s want=%s", repeat.Code, repeat.Body.String(), first.Body.String())
	}

	verify := func(line, column int) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"batch_id": batchID, "debug_id": f.debugID,
			"generated_line": line, "generated_column": column,
		})
		req := httptest.NewRequest(http.MethodPost,
			"/api/v1/projects/"+f.projectID+"/sourcemaps/verify", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+dashboardToken(t, f.orgID))
		response := httptest.NewRecorder()
		f.router.ServeHTTP(response, req)
		return response
	}
	resolved := verify(1, 0)
	if resolved.Code != http.StatusOK {
		t.Fatalf("verify status=%d body=%s", resolved.Code, resolved.Body.String())
	}
	if !strings.Contains(resolved.Body.String(), `"file":"src/a.ts"`) ||
		!strings.Contains(resolved.Body.String(), `"name":null`) {
		t.Fatalf("verify response=%s", resolved.Body.String())
	}
	if strings.Contains(resolved.Body.String(), "private fixture source") ||
		strings.Contains(resolved.Body.String(), `"mappings"`) {
		t.Fatalf("verify leaked source-map content: %s", resolved.Body.String())
	}
	unmapped := verify(2, 0)
	if unmapped.Code != http.StatusUnprocessableEntity || responseCode(t, unmapped) != "position_not_mapped" {
		t.Fatalf("unmapped status=%d body=%s", unmapped.Code, unmapped.Body.String())
	}
	invalid := verify(0, 0)
	if invalid.Code != http.StatusBadRequest || responseCode(t, invalid) != "invalid_request" {
		t.Fatalf("invalid status=%d body=%s", invalid.Code, invalid.Body.String())
	}
}

func TestCompleteIncomplete(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	response := f.complete(t, batchID)
	if response.Code != http.StatusConflict || responseCode(t, response) != "batch_incomplete" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "assets/") {
		t.Fatalf("incomplete response leaked paths: %s", response.Body.String())
	}
}
