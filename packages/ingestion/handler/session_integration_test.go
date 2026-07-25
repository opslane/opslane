package handler_test

import (
	"bytes"
	"compress/gzip"
	"context"
	cryptorand "crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

const maxChunkBytesForTest = 5 << 20

func storageEnv(primary, legacy string) string {
	if value := os.Getenv(primary); value != "" {
		return value
	}
	return os.Getenv(legacy)
}

func testDepsWithStorage(t *testing.T) (*handler.Dependencies, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	endpoint := storageEnv("REPLAY_STORE_ENDPOINT", "MINIO_ENDPOINT")
	if dsn == "" || endpoint == "" {
		t.Skip("DATABASE_URL / REPLAY_STORE_ENDPOINT not set; skipping session integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	mc, err := minioPkg.New(
		endpoint,
		storageEnv("REPLAY_STORE_PUBLIC_ENDPOINT", "MINIO_PUBLIC_ENDPOINT"),
		storageEnv("REPLAY_STORE_ACCESS_KEY", "MINIO_ACCESS_KEY"),
		storageEnv("REPLAY_STORE_SECRET_KEY", "MINIO_SECRET_KEY"),
		storageEnv("REPLAY_STORE_BUCKET", "MINIO_BUCKET"),
		storageEnv("REPLAY_STORE_REGION", "MINIO_REGION"),
	)
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return &handler.Dependencies{Queries: db.New(pool), MinIO: mc}, pool
}

func seedTenantWithKey(t *testing.T, pool *pgxpool.Pool) (projectID, envID, apiKey string) {
	t.Helper()
	_, projectID, envID, apiKey = seedTenant(t, db.New(pool))
	return projectID, envID, apiKey
}

func newTestRouter(t *testing.T, deps *handler.Dependencies, pool *pgxpool.Pool) http.Handler {
	t.Helper()
	return handler.NewRouterWithPool(deps, pool)
}

func initSession(t *testing.T, router http.Handler, apiKey, sessionID string) {
	t.Helper()
	body := fmt.Sprintf(`{"session_id":%q,"started_at":%q,"page_url":"https://app.example.com/"}`,
		sessionID, time.Now().UTC().Format(time.RFC3339))
	req := httptest.NewRequest("POST", "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("session init returned %d: %s", w.Code, w.Body.String())
	}
}

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// postChunk posts a gzip body to the single-call chunk upload route. query is
// appended verbatim (for example, "?has_full_snapshot=1") so tests can exercise
// the query contract, including malformed values.
func postChunk(t *testing.T, router http.Handler, apiKey, sessionID string, seq int, payload []byte, query string) int {
	t.Helper()
	req := httptest.NewRequest("POST",
		fmt.Sprintf("/api/v1/sessions/%s/chunks/%d%s", sessionID, seq, query), bytes.NewReader(payload))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/gzip")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

// Mirrors handler.chunkObjectKey, which is unexported.
func chunkObjectKeyForTest(projectID, sessionID string, seq int) string {
	return fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
}

func TestChunkUpload_DuplicateSeqReturns409(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusOK {
		t.Fatalf("first upload returned %d, want 200", code)
	}
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusConflict {
		t.Fatalf("duplicate seq returned %d, want 409", code)
	}
}

// The #48 ceiling: a public SDK key must not be usable as a storage-flood
// primitive. Storage used to enforce this via a content-length-range policy
// condition; ingestion enforces it now, so this proves both halves — the
// request is refused and nothing is persisted.
func TestChunkUpload_RejectsOversizeBodyAndStoresNothing(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	oversize := make([]byte, maxChunkBytesForTest+1)
	oversize[0], oversize[1] = 0x1f, 0x8b
	if code := postChunk(t, router, apiKey, sid, 0, oversize, ""); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize body returned %d, want 413", code)
	}

	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session_chunks WHERE session_id=$1 AND seq=0`, sid).Scan(&rows); err != nil {
		t.Fatalf("count reservations: %v", err)
	}
	if rows != 0 {
		t.Fatalf("oversize upload left %d reservation rows, want 0", rows)
	}
	if _, err := deps.MinIO.StatObject(context.Background(), chunkObjectKeyForTest(projectID, sid, 0)); err == nil {
		t.Fatal("oversize upload wrote an object to storage, want none")
	}
}

func TestChunkUpload_UnknownSessionReturns404(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	code := postChunk(t, router, apiKey, "sess_neverregistered", 0, payload, "")
	if code != http.StatusNotFound {
		t.Fatalf("unknown session returned %d, want 404", code)
	}
}

func TestChunkUpload_CrossTenantReturns404(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKeyA := seedTenantWithKey(t, pool)
	_, _, apiKeyB := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKeyA, sid)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	code := postChunk(t, router, apiKeyB, sid, 0, payload, "")
	if code != http.StatusNotFound {
		t.Fatalf("cross-tenant upload returned %d, want 404", code)
	}
}

func TestChunkUpload_StoresAndCommitsInOneCall(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))
	if code := postChunk(t, router, apiKey, sid, 0, payload, "?has_full_snapshot=1"); code != http.StatusOK {
		t.Fatalf("upload returned %d, want 200", code)
	}

	var size int64
	var uploadedAt, scrubbedAt *time.Time
	var hasFullSnapshot bool
	if err := pool.QueryRow(context.Background(),
		`SELECT size_bytes, uploaded_at, scrubbed_at, has_full_snapshot
		   FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&size, &uploadedAt, &scrubbedAt, &hasFullSnapshot); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if size != int64(len(payload)) || uploadedAt == nil || scrubbedAt != nil || !hasFullSnapshot {
		t.Fatalf("chunk = size %d, uploaded %v, scrubbed %v, full snapshot %v",
			size, uploadedAt, scrubbedAt, hasFullSnapshot)
	}
}

func TestChunkUpload_IsIdempotentOnRetry(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusOK {
		t.Fatalf("first upload returned %d, want 200", code)
	}
	// A retry is rejected because the sequence is already committed, but it
	// must not duplicate the session rollup.
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusConflict {
		t.Fatalf("retry returned %d, want 409", code)
	}

	var chunkCount int
	var bytesStored int64
	if err := pool.QueryRow(context.Background(),
		`SELECT chunk_count, bytes_stored FROM sessions WHERE id=$1`, sid,
	).Scan(&chunkCount, &bytesStored); err != nil {
		t.Fatalf("read session: %v", err)
	}
	if chunkCount != 1 || bytesStored != int64(len(payload)) {
		t.Fatalf("double commit rollup = count %d, bytes %d", chunkCount, bytesStored)
	}
}

func TestChunkUpload_AcceptsBodyLargerThanTheOldInlineCap(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	raw := make([]byte, 512<<10)
	if _, err := cryptorand.Read(raw); err != nil {
		t.Fatalf("random payload: %v", err)
	}
	payload := gzipBytes(t, raw)
	if len(payload) <= 64<<10 {
		t.Fatalf("test payload gzipped to %d bytes, need > 64KiB to be meaningful", len(payload))
	}
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusOK {
		t.Fatalf("upload returned %d, want 200", code)
	}

	var size int64
	var uploadedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT size_bytes, uploaded_at FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&size, &uploadedAt); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	if size != int64(len(payload)) || uploadedAt == nil {
		t.Fatalf("chunk = size %d (want %d), uploaded %v", size, len(payload), uploadedAt)
	}
}

func TestChunkUpload_HasFullSnapshotQueryContract(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)

	cases := []struct {
		name     string
		query    string
		wantCode int
		wantFlag bool
	}{
		{"explicit true", "?has_full_snapshot=1", http.StatusOK, true},
		{"explicit false", "?has_full_snapshot=0", http.StatusOK, false},
		{"absent defaults to false", "", http.StatusOK, false},
		{"malformed is rejected", "?has_full_snapshot=yes", http.StatusBadRequest, false},
		{"repeated is rejected", "?has_full_snapshot=1&has_full_snapshot=0", http.StatusBadRequest, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
			initSession(t, router, apiKey, sid)
			payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))
			if code := postChunk(t, router, apiKey, sid, 0, payload, tc.query); code != tc.wantCode {
				t.Fatalf("returned %d, want %d", code, tc.wantCode)
			}
			if tc.wantCode != http.StatusOK {
				return
			}
			var got bool
			if err := pool.QueryRow(context.Background(),
				`SELECT has_full_snapshot FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
			).Scan(&got); err != nil {
				t.Fatalf("read flag: %v", err)
			}
			if got != tc.wantFlag {
				t.Fatalf("has_full_snapshot = %v, want %v", got, tc.wantFlag)
			}
		})
	}
}

// Cleanup runs after the client has gone away, so it must not inherit the
// request context. The fake S3 endpoint blocks the PUT until this test cancels
// the browser request, ensuring cancellation happens after the reservation is
// created instead of being rejected earlier by authentication or a DB lookup.
func TestChunkUpload_CleansUpAfterClientDisconnect(t *testing.T) {
	deps, pool := testDeps(t)
	putStarted := make(chan struct{}, 1)
	deleteCalled := make(chan struct{}, 1)
	releasePUT := make(chan struct{})
	defer close(releasePUT)
	fakeS3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			select {
			case putStarted <- struct{}{}:
			default:
			}
			<-releasePUT
		case http.MethodDelete:
			select {
			case deleteCalled <- struct{}{}:
			default:
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fakeS3.Close)

	var err error
	deps.MinIO, err = minioPkg.New(fakeS3.URL, "", "test-key", "test-secret", "test-bucket", "us-east-1")
	if err != nil {
		t.Fatalf("fake storage client: %v", err)
	}
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost,
		fmt.Sprintf("/api/v1/sessions/%s/chunks/0", sid), bytes.NewReader(payload)).WithContext(ctx)
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/gzip")
	rec := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() {
		router.ServeHTTP(rec, req)
		close(requestDone)
	}()

	select {
	case <-putStarted:
		cancel()
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("upload never reached storage")
	}
	select {
	case <-requestDone:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled upload did not return")
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("cancelled upload returned %d, want 500", rec.Code)
	}
	select {
	case <-deleteCalled:
	default:
		t.Fatal("cancelled upload did not remove the ambiguous storage object")
	}

	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session_chunks WHERE session_id=$1 AND seq=0 AND size_bytes IS NULL`, sid,
	).Scan(&rows); err != nil {
		t.Fatalf("count orphans: %v", err)
	}
	if rows != 0 {
		t.Fatalf("disconnect left %d orphaned reservations, want 0", rows)
	}
}

func TestChunkUpload_RemovesAmbiguousPutBeforeReleasingReservation(t *testing.T) {
	deps, pool := testDeps(t)
	var objectPresent atomic.Bool
	var deleteCalls atomic.Int32
	fakeS3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			if _, err := io.Copy(io.Discard, r.Body); err != nil {
				t.Errorf("read fake PUT: %v", err)
			}
			// Simulate storage accepting the bytes but losing the success
			// response. PutObject reports an error even though an object exists.
			objectPresent.Store(true)
			w.WriteHeader(http.StatusInternalServerError)
		case http.MethodDelete:
			deleteCalls.Add(1)
			objectPresent.Store(false)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fakeS3.Close)

	var err error
	deps.MinIO, err = minioPkg.New(fakeS3.URL, "", "test-key", "test-secret", "test-bucket", "us-east-1")
	if err != nil {
		t.Fatalf("fake storage client: %v", err)
	}
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))

	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusInternalServerError {
		t.Fatalf("ambiguous PUT returned %d, want 500", code)
	}
	if objectPresent.Load() {
		t.Fatal("ambiguous PUT object survived cleanup")
	}
	if deleteCalls.Load() != 1 {
		t.Fatalf("cleanup DELETE calls = %d, want 1", deleteCalls.Load())
	}
	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session_chunks WHERE session_id=$1 AND seq=0`, sid,
	).Scan(&rows); err != nil {
		t.Fatalf("count reservations: %v", err)
	}
	if rows != 0 {
		t.Fatalf("successful cleanup left %d reservation rows, want 0", rows)
	}
}

func TestChunkUpload_RetainsReservationWhenAmbiguousPutCannotBeRemoved(t *testing.T) {
	deps, pool := testDeps(t)
	var deleteCalls atomic.Int32
	fakeS3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusInternalServerError)
		case http.MethodDelete:
			deleteCalls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fakeS3.Close)

	var err error
	deps.MinIO, err = minioPkg.New(fakeS3.URL, "", "test-key", "test-secret", "test-bucket", "us-east-1")
	if err != nil {
		t.Fatalf("fake storage client: %v", err)
	}
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))

	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusInternalServerError {
		t.Fatalf("uncleanable PUT returned %d, want 500", code)
	}
	if deleteCalls.Load() == 0 {
		t.Fatal("cleanup DELETE was not attempted")
	}
	var pendingRows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session_chunks
		  WHERE session_id=$1 AND seq=0 AND size_bytes IS NULL`, sid,
	).Scan(&pendingRows); err != nil {
		t.Fatalf("count retained reservation: %v", err)
	}
	if pendingRows != 1 {
		t.Fatalf("uncleanable PUT left %d pending reservations, want 1", pendingRows)
	}
}

func TestChunkUpload_RejectsNonGzipBody(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if code := postChunk(t, router, apiKey, sid, 0, []byte("this is not gzip at all"), ""); code != http.StatusBadRequest {
		t.Fatalf("non-gzip body returned %d, want 400", code)
	}
}

func TestChunkUpload_MissingAPIKeyReturns401(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	router := newTestRouter(t, deps, pool)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	if code := postChunk(t, router, "", "sess_neverregistered", 0, payload, ""); code != http.StatusUnauthorized {
		t.Fatalf("missing API key returned %d, want 401", code)
	}
}

func TestChunkUpload_OriginNotAllowlistedReturns403(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET allowed_origins = $2 WHERE id = $1`,
		projectID, []string{"https://app.example.com"}); err != nil {
		t.Fatalf("set allowlist: %v", err)
	}
	router := newTestRouter(t, deps, pool)
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/sessions/sess_neverregistered/chunks/0", bytes.NewReader(payload))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/gzip")
	req.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign origin returned %d, want 403", w.Code)
	}
}

func TestSessionInit_RecordingDisabledWithoutSDKDoesNotCreateSession(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("disable recording: %v", err)
	}
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	body := fmt.Sprintf(`{"session_id":%q,"started_at":%q}`, sid, time.Now().UTC().Format(time.RFC3339))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"recording":false`) {
		t.Fatalf("disabled init returned %d: %s", w.Code, w.Body.String())
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1`, sid).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("disabled legacy init created %d sessions, want 0", count)
	}
}

func TestSessionInit_PersistsSDKIdentityBeforeReplayGates(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	q := db.New(pool)
	ctx := context.Background()

	for _, status := range []string{"provisioned", "key_ok"} {
		agentSession, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
			RepoURL:       "sdk-identity/" + status + fmt.Sprint(time.Now().UnixNano()),
			PollTokenHash: "poll-" + status, AgentKeyPub: "pub-" + status,
		})
		if err != nil {
			t.Fatalf("create %s agent session: %v", status, err)
		}
		if _, err := pool.Exec(ctx,
			`UPDATE agent_sessions SET project_id = $2, status = $3 WHERE id = $1`,
			agentSession.ID, projectID, status); err != nil {
			t.Fatalf("seed %s agent session: %v", status, err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, agentSession.ID) })
	}

	post := func(router http.Handler, sessionID, version, release string) *httptest.ResponseRecorder {
		t.Helper()
		body := fmt.Sprintf(
			`{"session_id":%q,"started_at":%q,"environment":"development","release":%q,"sdk":{"name":"@opslane/sdk","version":%q}}`,
			sessionID, time.Now().UTC().Format(time.RFC3339), release, version,
		)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
		req.Header.Set("X-API-Key", apiKey)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	assertIdentity := func(sessionID, version, release string) {
		t.Helper()
		var name, gotVersion, gotRelease *string
		if err := pool.QueryRow(ctx,
			`SELECT sdk_name, sdk_version, sdk_release FROM sessions WHERE id = $1`, sessionID,
		).Scan(&name, &gotVersion, &gotRelease); err != nil {
			t.Fatalf("read SDK identity for %s: %v", sessionID, err)
		}
		if name == nil || *name != "@opslane/sdk" || gotVersion == nil || *gotVersion != version || gotRelease == nil || *gotRelease != release {
			t.Fatalf("SDK identity = (%v, %v, %v), want (@opslane/sdk, %s, %s)", name, gotVersion, gotRelease, version, release)
		}
	}

	router := newTestRouter(t, deps, pool)
	normalID := fmt.Sprintf("sess_sdk_normal_%d", time.Now().UnixNano())
	if w := post(router, normalID, "1.2.3", "abc123"); w.Code != http.StatusOK {
		t.Fatalf("normal SDK init returned %d: %s", w.Code, w.Body.String())
	}
	assertIdentity(normalID, "1.2.3", "abc123")
	// RegisterSession remains first-write-wins on retry.
	if w := post(router, normalID, "9.9.9", "changed"); w.Code != http.StatusOK {
		t.Fatalf("retried SDK init returned %d: %s", w.Code, w.Body.String())
	}
	assertIdentity(normalID, "1.2.3", "abc123")

	rows, err := pool.Query(ctx,
		`SELECT status FROM agent_sessions WHERE project_id = $1 ORDER BY status`, projectID)
	if err != nil {
		t.Fatalf("read reporting lifecycle: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "app_reporting" {
			t.Fatalf("agent session status = %q, want app_reporting", status)
		}
	}

	if _, err := pool.Exec(ctx, `UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("disable recording: %v", err)
	}
	disabledID := fmt.Sprintf("sess_sdk_disabled_%d", time.Now().UnixNano())
	if w := post(router, disabledID, "1.2.4", "disabled"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"recording":false`) {
		t.Fatalf("recording-disabled SDK init returned %d: %s", w.Code, w.Body.String())
	}
	assertIdentity(disabledID, "1.2.4", "disabled")

	if _, err := pool.Exec(ctx, `UPDATE projects SET recording_enabled = TRUE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("enable recording: %v", err)
	}
	deps.MinIO = nil
	noStorageID := fmt.Sprintf("sess_sdk_no_storage_%d", time.Now().UnixNano())
	if w := post(router, noStorageID, "1.2.5", "no-storage"); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("no-storage SDK init returned %d: %s", w.Code, w.Body.String())
	}
	assertIdentity(noStorageID, "1.2.5", "no-storage")
}

func TestSessionInit_TombstoneReturns410(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO session_tombstones (session_id, project_id) VALUES ($1, $2)`, sid, projectID); err != nil {
		t.Fatalf("seed tombstone: %v", err)
	}
	router := newTestRouter(t, deps, pool)
	body := fmt.Sprintf(`{"session_id":%q}`, sid)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/init", strings.NewReader(body))
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusGone {
		t.Fatalf("tombstoned init returned %d: %s, want 410", w.Code, w.Body.String())
	}
}

func TestChunkUpload_RecordingDisabledReturns403(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)
	if _, err := pool.Exec(context.Background(),
		`UPDATE projects SET recording_enabled = FALSE WHERE id = $1`, projectID); err != nil {
		t.Fatalf("disable recording: %v", err)
	}
	payload := gzipBytes(t, []byte(`{"events":[]}`))
	if code := postChunk(t, router, apiKey, sid, 0, payload, ""); code != http.StatusForbidden {
		t.Fatalf("upload while disabled returned %d, want 403", code)
	}
}
