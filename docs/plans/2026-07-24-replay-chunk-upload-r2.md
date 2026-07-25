# Replay Chunk Upload on Cloudflare R2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make session-replay chunk upload work on Cloudflare R2 by replacing the three-call presigned-POST handshake with a single authenticated upload to ingestion.

**Architecture:** The browser currently asks ingestion for a signed form, POSTs the recording directly to object storage, then tells ingestion it finished. R2 does not implement the S3 POST Object API and rejects step two with `501 NotImplemented`, so no replay chunk has ever stored in production. The fix deletes that handshake. The browser POSTs the gzipped recording to ingestion, which validates it, writes it to storage server-side with a known-size PUT, and commits the row — all in one request. An endpoint that does exactly this already exists (`ChunkInline`, used for the tail flush when a tab closes) and already works on R2; this change generalises it from a 64KiB special case into the only chunk upload path.

**Tech Stack:** Go 1.24 (chi, pgx, minio-go v7.2.1), TypeScript browser SDK, Vitest, Postgres, MinIO locally / Cloudflare R2 in production, changesets for npm publishing.

---

## Background you need before starting

**You do not need to understand session replay to do this work.** Here is the whole domain in five sentences. The browser SDK records what a user sees using rrweb, buffers about 30 seconds of it, gzips it, and uploads it as a numbered "chunk". Ingestion stores each chunk in S3-compatible object storage and records a row in `session_chunks`. A background scrubber later reads each chunk back, redacts secrets, and writes it back — until that happens the chunk is fail-closed and nothing may serve it. The dashboard reads scrubbed chunks back to play the session. Chunks are capped at 5MiB each and 512MiB per project per minute.

**Three terms used throughout:**

- **Presigned POST policy** — a signed form that lets a browser upload straight to object storage without credentials. R2 does not support it. This is the thing being deleted.
- **Reservation** — a `session_chunks` row created before the bytes arrive, with `size_bytes` NULL. It claims the sequence number so two uploads cannot collide. `size_bytes` becoming non-NULL means "really stored".
- **Byte budget** — `chunkBytesBudget` in `handler/ingest_limits.go`, a per-project 512MiB/minute allowance. Note it is a *mutating reservation*, not a check: calling it twice charges twice.

**The single most important rule in this plan:** `ChunkInline` at `packages/ingestion/handler/session.go:380-464` is the reference implementation. Follow it. An earlier revision of this plan invented two clever deviations from it — streaming instead of buffering, and a two-phase byte-budget charge — and both were bugs. When in doubt, do what `ChunkInline` already does.

## Local environment (set this up first — tests silently skip without it)

The database and storage tests call `t.Skip` when `DATABASE_URL` or `REPLAY_STORE_ENDPOINT` are unset. **They print `ok` while running nothing.** A green local run without these is not evidence.

```bash
docker compose up -d postgres minio
docker compose run --rm minio-setup
docker compose run --rm migrate
```

Then export these for every Go test command in this plan:

```bash
export DATABASE_URL='postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable'
export REPLAY_STORE_ENDPOINT='http://localhost:9012'
export REPLAY_STORE_PUBLIC_ENDPOINT='http://localhost:9012'
export REPLAY_STORE_ACCESS_KEY='minio'
export REPLAY_STORE_SECRET_KEY='minio12345'
export REPLAY_STORE_BUCKET='opslane-replays'
export REPLAY_STORE_REGION='us-east-1'
```

CI runs `go test ./... -v | scripts/check-go-skips.mjs` and fails on any unexpected skip, so a test that skips locally will fail the build later.

## Task ordering

Tasks are ordered so the tree stays green after every commit. The new endpoint is added first and lives alongside the old routes; consumers move over one at a time; the old routes are deleted only once nothing calls them.

| # | Task | Package |
|---|---|---|
| 1 | New chunk upload route accepting up to 5MiB | ingestion |
| 2 | Oversize rejection (CRITICAL regression test) | ingestion |
| 3 | `has_full_snapshot` query parameter contract | ingestion |
| 4 | Detached-context cleanup | ingestion |
| 5 | SDK: one request, three-state result | sdk |
| 6 | SDK: callers handle all three states | sdk |
| 7 | Real-browser contract test | sdk |
| 8 | E2E contract and helpers | test-e2e |
| 9 | Delete the handshake handlers and routes | ingestion |
| 10 | Delete `PresignedPostPolicy` | ingestion |
| 11 | Correct stale comments | ingestion |
| 12 | Update documentation | docs |
| 13 | Changeset and release | release |
| 14 | Full verification gate and R2 smoke | all |

---

## Task 1: New chunk upload route accepting up to 5MiB

Rename `ChunkInline` to `ChunkUpload`, register it at a new path, and raise its body cap from 64KiB to the real chunk maximum. The 64KiB limit was never a property of this endpoint — it exists because the tail flush uses `fetch(..., {keepalive: true})`, and browsers cap keepalive request bodies at 64KiB. Periodic chunks are not sent from a closing page and are not subject to it.

The old `/inline` path stays registered for now so nothing breaks mid-branch.

**Files:**
- Modify: `packages/ingestion/handler/session.go:378-464` (rename handler, raise cap)
- Modify: `packages/ingestion/handler/routes.go:93` (add the new route)
- Test: `packages/ingestion/handler/session_integration_test.go`

**Step 1: Write the failing test**

Add to `packages/ingestion/handler/session_integration_test.go`:

```go
func TestChunkUpload_AcceptsBodyLargerThanTheOldInlineCap(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	// Incompressible payload so the gzipped body really exceeds 64KiB, the old
	// keepalive-imposed inline ceiling. A compressible one would slip under it
	// and the test would pass without proving anything.
	raw := make([]byte, 512<<10)
	for i := range raw {
		raw[i] = byte(i * 7919 % 251)
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
```

Add this helper next to `postInlineChunk` (`session_integration_test.go:166`):

```go
// postChunk posts a gzip body to the single-call chunk upload route. query is
// appended verbatim (e.g. "?has_full_snapshot=1") so tests can exercise the
// query contract, including malformed values.
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
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload_AcceptsBodyLargerThanTheOldInlineCap -v
```

Expected: FAIL with `upload returned 404, want 200`. The route does not exist yet.

If you see `--- SKIP`, your environment variables are not exported. Go back to the setup section.

**Step 3: Rename the handler and raise the cap**

In `packages/ingestion/handler/session.go`, change the doc comment and signature at line 378-380 from:

```go
// ChunkInline stores and commits a keepalive-sized final gzip chunk in one
// request. POST /api/v1/sessions/{sessionID}/chunks/{seq}/inline
func (d *Dependencies) ChunkInline(w http.ResponseWriter, r *http.Request) {
```

to:

```go
// ChunkUpload stores and commits one gzipped rrweb chunk in a single request.
// POST /api/v1/sessions/{sessionID}/chunks/{seq}
//
// The browser sends the bytes here rather than to object storage because
// Cloudflare R2 does not implement the S3 POST Object API (#194). Ingestion
// therefore sees every chunk, which is what lets the #48 size ceiling be
// enforced by http.MaxBytesReader below — before a single byte reaches
// storage, rather than by a storage-side policy after the bytes have already
// left the browser.
func (d *Dependencies) ChunkUpload(w http.ResponseWriter, r *http.Request) {
```

At line 401, change the cap:

```go
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChunkBytes))
```

And replace the fragile string comparison below it with a typed check:

```go
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "chunk too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
```

`errors` is already imported in this file.

**Two invariants in this handler that you must not "improve".** Both were violated by an
earlier draft of this design and both are silent failures — nothing crashes, the tests
still pass, and the damage only shows up in production.

*Keep the known-size `PutObject`.* The handler buffers the body and calls
`d.MinIO.PutObject(ctx, key, payload, "application/gzip")`, which takes `[]byte` and
therefore a known length. Do **not** add a streaming variant that passes size `-1`.
`minio-go` v7.2.1 routes an unknown size to `putObjectMultipartStreamNoLength`
(`api-put-object.go:376,383`) and sizes the part buffer from a 5TiB assumption — its own
comment at `api-put-object-common.go:72` reads *"This results in ~537MiB part sizes"*,
allocated at `api-put-object-streaming.go:342`. Streaming a 5MiB chunk would cost ~537MiB
per concurrent request to avoid buffering 5MiB. It would also make every chunk a multipart
upload, and `RemoveObject` (`minio/client.go:170`) cannot abort an incomplete one.

*Call `chunkBytesBudget.allow` exactly once, with the real buffered length.* It is a
mutating reservation, not a predicate — `auth_handlers.go:91` ("allow **reserves** n
bytes"), `:112` (`b.used[key] += n`). A pre-check followed by a real charge double-bills
every project. `Content-Length` is not a usable pre-check either: it is absent under
chunked transfer encoding and forgeable by any caller. Buffering first makes the question
disappear, which is what `ChunkInline` already does at `session.go:442`. Task 9 adds a
grep that enforces the single call site.

**Step 4: Register the new route**

In `packages/ingestion/handler/routes.go`, replace line 93:

```go
		r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}/inline", deps.ChunkInline)
```

with both paths pointing at the renamed handler:

```go
		r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}", deps.ChunkUpload)
		// Transitional: published SDK 1.0.0 posts the tail flush here. Deleted in Task 9.
		r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}/inline", deps.ChunkUpload)
```

Chi prefers a static path segment over a wildcard, so `/chunks/upload-url` still routes to `ChunkUploadURL` and is not swallowed by `/chunks/{seq}`. The existing `TestChunkUploadURL_*` tests prove this stays true until Task 9 deletes them.

**Step 5: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload -v
```

Expected: PASS.

**Step 6: Run the full ingestion suite**

```bash
cd packages/ingestion && go build ./... && go test ./...
```

Expected: PASS. `TestChunkInline_RejectsOversizeBody` still passes because 64KiB+1 is under the new 5MiB cap and gets rejected for not being gzip instead — it will be rewritten in Task 2.

**Step 7: Commit**

```bash
git add packages/ingestion/handler/session.go packages/ingestion/handler/routes.go packages/ingestion/handler/session_integration_test.go
git commit -m "feat(ingestion): accept full-size replay chunks on a single upload route"
```

---

## Task 2: Oversize rejection (CRITICAL regression test)

This is the most important test in the change. Issue #48 exists because a public SDK key ships in customer bundles and is not secret, so anyone can call these endpoints. The old design expressed the ceiling as `content-length-range` on the storage policy, and storage enforced it. That guarantee now lives in application code, and it must be proven, not assumed.

**Files:**
- Modify: `packages/ingestion/handler/session_integration_test.go:23,318-326`

**Step 1: Write the failing test**

Replace the constant at `session_integration_test.go:23`:

```go
const maxChunkBytesForTest = 5 << 20
```

Replace `TestChunkInline_RejectsOversizeBody` (line 318) entirely:

```go
// The #48 ceiling: a public SDK key must not be usable as a storage-flood
// primitive. Storage used to enforce this via a content-length-range policy
// condition; ingestion enforces it now, so it needs a test that proves both
// halves — the request is refused AND nothing was persisted.
func TestChunkUpload_RejectsOversizeBodyAndStoresNothing(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	projectID, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	oversize := make([]byte, maxChunkBytesForTest+1)
	oversize[0], oversize[1] = 0x1f, 0x8b // valid gzip magic, so size is the only reason to reject

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
```

Add the key helper near the other helpers. It mirrors `chunkObjectKey` in `session.go:219`, which is unexported, so the format string exists in exactly these two places:

```go
// Mirrors handler.chunkObjectKey (session.go:219), which is unexported.
func chunkObjectKeyForTest(projectID, sessionID string, seq int) string {
	return fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
}
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload_RejectsOversizeBodyAndStoresNothing -v
```

Expected: FAIL. Task 1 made the handler read the body *before* reserving, so the 413 should already work — but the "nothing persisted" assertions are what this test is for. If it passes immediately, read the handler and confirm the ordering is genuinely `read → reject → reserve`, then keep the test as the guard.

**Step 3: Verify the handler order**

In `ChunkUpload`, confirm the body read and gzip check happen **before** `ReserveChunkSeq`. This is already the order `ChunkInline` uses. Do not reorder it.

**Step 4: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ingestion/handler/session_integration_test.go
git commit -m "test(ingestion): prove the #48 size ceiling rejects and persists nothing"
```

---

## Task 3: `has_full_snapshot` query parameter contract

Every chunk opens with a full rrweb snapshot so it is independently playable — `has_full_snapshot` records whether that is true, and the read path uses it to pick a starting chunk. It used to travel in the JSON body of `upload-url`. The body is now raw gzip, and the server cannot read the flag from the payload's `meta` because that would mean decompressing a chunk that has not been scrubbed yet. So it moves to a query parameter.

`ChunkInline` hardcodes `false` (`session.go:434`), which is right for a tail continuation and wrong as a general default.

**Files:**
- Modify: `packages/ingestion/handler/session.go` (add parser, use it)
- Test: `packages/ingestion/handler/session_integration_test.go`

**Step 1: Write the failing test**

```go
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
				`SELECT has_full_snapshot FROM session_chunks WHERE session_id=$1 AND seq=0`, sid).Scan(&got); err != nil {
				t.Fatalf("read flag: %v", err)
			}
			if got != tc.wantFlag {
				t.Fatalf("has_full_snapshot = %v, want %v", got, tc.wantFlag)
			}
		})
	}
	_ = deps
}
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload_HasFullSnapshotQueryContract -v
```

Expected: FAIL on `explicit true` — `has_full_snapshot = false, want true`. The handler still hardcodes `false`.

**Step 3: Add the parser**

Add to `packages/ingestion/handler/session.go`, near `chunkObjectKey`:

```go
// parseHasFullSnapshot reads the has_full_snapshot query parameter.
//
// Contract: "1" is true, "0" is false, absent is false, anything else is an
// error. A repeated parameter is an error rather than a silent first-value
// win: a proxy or SDK bug must not be able to quietly flip a chunk's
// playability flag, because the read path uses it to choose a starting chunk.
func parseHasFullSnapshot(query url.Values) (bool, error) {
	values, present := query["has_full_snapshot"]
	if !present {
		return false, nil
	}
	if len(values) != 1 {
		return false, fmt.Errorf("repeated has_full_snapshot")
	}
	switch values[0] {
	case "1":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("invalid has_full_snapshot %q", values[0])
	}
}
```

Add `"net/url"` to the import block.

**Step 4: Use it in the handler**

In `ChunkUpload`, immediately after the seq is parsed, add:

```go
	hasFullSnapshot, err := parseHasFullSnapshot(r.URL.Query())
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid has_full_snapshot")
		return
	}
```

Then at line 434, replace the hardcoded `false`:

```go
	if err := d.Queries.ReserveChunkSeq(r.Context(), sessionID, projectID, seq, objectKey, hasFullSnapshot); err != nil {
```

Careful: `err` is already declared in this scope. Use `:=` only where Go allows it, or declare `hasFullSnapshot` separately — the compiler will tell you.

**Step 5: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload -v
```

Expected: PASS, all five subtests.

**Step 6: Commit**

```bash
git add packages/ingestion/handler/session.go packages/ingestion/handler/session_integration_test.go
git commit -m "feat(ingestion): define the has_full_snapshot query contract for chunk upload"
```

---

## Task 4: Detached-context cleanup

When a storage write or commit fails, the handler releases the reservation and removes the object. Both calls pass `r.Context()` — which is **already cancelled** if the browser disconnected, which is exactly when these failures happen. The cleanup therefore silently does nothing and leaves an orphaned reservation.

This is a pre-existing bug in `ChunkInline`, not one this change introduces. It matters much more now: 5MiB bodies over mobile connections disconnect far more often than 64KiB ones did.

The ordering also matters. Object keys are deterministic, so a retry can store the same key. If cleanup released the reservation first, the retry could reserve and store, and then the original request's `RemoveObject` would delete the retry's object. Remove the object first, then release. `session.go:456-457` already gets this right — preserve it.

**Files:**
- Modify: `packages/ingestion/handler/session.go:446-464`

**Step 1: Write the failing test**

```go
// Cleanup runs on paths where the client has usually gone away, so it must not
// inherit the request context. With r.Context() already cancelled, a release
// is a silent no-op and the reservation is orphaned forever.
func TestChunkUpload_CleansUpAfterClientDisconnect(t *testing.T) {
	deps, pool := testDepsWithStorage(t)
	_, _, apiKey := seedTenantWithKey(t, pool)
	router := newTestRouter(t, deps, pool)
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	initSession(t, router, apiKey, sid)

	// Drive the handler with an already-cancelled request context, which is
	// what a disconnected browser looks like from inside the handler.
	payload := gzipBytes(t, []byte(`{"events":[{"type":2}]}`))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("POST",
		fmt.Sprintf("/api/v1/sessions/%s/chunks/0", sid), bytes.NewReader(payload)).WithContext(ctx)
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/gzip")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Whatever the status, no half-finished reservation may survive: either the
	// chunk committed, or the row is gone.
	var rows int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session_chunks WHERE session_id=$1 AND seq=0 AND size_bytes IS NULL`, sid,
	).Scan(&rows); err != nil {
		t.Fatalf("count orphans: %v", err)
	}
	if rows != 0 {
		t.Fatalf("disconnect left %d orphaned reservations, want 0", rows)
	}
	_ = deps
}
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload_CleansUpAfterClientDisconnect -v
```

Expected: FAIL with `disconnect left 1 orphaned reservations, want 0`.

**Step 3: Detach the cleanup context**

In `ChunkUpload`, immediately before the byte-budget check, add:

```go
	// Cleanup must outlive the request. r.Context() is already cancelled when
	// the browser disconnects mid-upload, which is precisely when these paths
	// run, so inheriting it makes every release and remove a silent no-op.
	cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancelCleanup()
```

Then replace `r.Context()` with `cleanupCtx` in every cleanup call in this handler — the `ReleaseChunkReservation` calls and the `RemoveObject` call. Leave the *success* path (`CommitChunk`) and the storage `PutObject` on the request context: those should stop if the client is gone.

Preserve the existing remove-then-release order at `session.go:456-457`.

**Step 4: Run the test to verify it passes**

```bash
cd packages/ingestion && go test ./handler -run TestChunkUpload -v
```

Expected: PASS.

**Step 5: Run the full ingestion suite**

```bash
cd packages/ingestion && go build ./... && go test ./...
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/ingestion/handler/session.go packages/ingestion/handler/session_integration_test.go
git commit -m "fix(ingestion): run chunk cleanup on a context the client cannot cancel"
```

---

## Task 5: SDK — one request, three-state result

`uploadChunk` currently runs three sequential requests. Collapse it to one. `flushInline` becomes the same call with `keepalive: true`.

**The subtle part:** `uploadChunk` returns `boolean | 'stop'`, where `'stop'` means the server said recording is off (403) or the session is gone (410) and capture must halt. `flushInline` returns plain `boolean`. Merging them without care produces a bug, because `'stop'` is truthy — see Task 6.

**Files:**
- Modify: `packages/sdk/src/chunk-upload.ts`
- Test: `packages/sdk/src/__tests__/chunk-upload.test.ts`

**Step 1: Write the failing test**

Replace the whole `describe('uploadChunk', ...)` and `describe('flushInline', ...)` blocks in `packages/sdk/src/__tests__/chunk-upload.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetChunkUploadState, flushInline, uploadChunk } from '../chunk-upload';
import { loadConfig, resetConfig } from '../config';

const ENDPOINT = 'https://ingest.example.com';

describe('uploadChunk', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends exactly one request carrying the gzip body', async () => {
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/0?has_full_snapshot=1`);
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': 'test-key' },
    });
    expect((options.body as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it('omits the query flag when there is no full snapshot', async () => {
    await uploadChunk('sess_abc', 1, [{ type: 3, timestamp: 1 }] as never, false);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/1?has_full_snapshot=0`);
  });

  it('reports stop on 403 and 410', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
    _resetChunkUploadState();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 });
    expect(await uploadChunk('sess_abc', 1, [{ type: 2, timestamp: 1 }] as never, true)).toBe('stop');
  });

  it('never throws and skips empty chunks', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(uploadChunk('sess_abc', 0, [{ type: 2, timestamp: 1 }] as never, true)).resolves.toBe(false);
    fetchMock.mockClear();
    expect(await uploadChunk('sess_abc', 0, [] as never, true)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flushInline', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConfig();
    _resetChunkUploadState();
    loadConfig({ apiKey: 'test-key', endpoint: ENDPOINT });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends one keepalive request to the same route', async () => {
    expect(await flushInline('sess_abc', 3, [{ type: 2, timestamp: 1 }] as never)).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/api/v1/sessions/sess_abc/chunks/3?has_full_snapshot=0`);
    expect(options).toMatchObject({ keepalive: true, headers: { 'Content-Type': 'application/gzip' } });
  });

  // Browsers cap keepalive request bodies at 64KiB. Over that the send would be
  // refused by the browser itself, so the caller must fall back to a normal
  // request. This is the ONLY reason the 64KiB number exists.
  it('drops an over-budget tail and never throws', async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => ({
      type: 3, timestamp: i, data: { text: `unique-${i}-${'x'.repeat(20)}` },
    }));
    expect(await flushInline('sess_abc', 4, huge as never)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error('page gone'));
    await expect(flushInline('sess_abc', 5, [{ type: 2, timestamp: 1 }] as never)).resolves.toBe(false);
  });

  // 'stop' is truthy. A tail flush that gets 403 must propagate the signal, not
  // report success, or capture keeps running after the server said to halt.
  it('propagates stop from the tail path', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await flushInline('sess_abc', 6, [{ type: 2, timestamp: 1 }] as never)).toBe('stop');
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/sdk test -- chunk-upload
```

Expected: FAIL — `expected 3 calls, received 1` on the first test and a type error on the last (`flushInline` returns `boolean`).

**Step 3: Rewrite the uploader**

Replace lines 28-110 of `packages/sdk/src/chunk-upload.ts` with:

```ts
/**
 * One request per chunk. Ingestion validates the bytes, writes them to object
 * storage server-side, and commits the row. There is no presigned-URL
 * handshake: Cloudflare R2 does not implement the S3 POST Object API (#194).
 */
async function sendChunk(
  sessionID: string,
  seq: number,
  compressed: Uint8Array,
  hasFullSnapshot: boolean,
  keepalive: boolean,
): Promise<UploadResult> {
  const config = getConfig();
  const flag = hasFullSnapshot ? '1' : '0';
  const response = await sdkFetch(
    `${config.endpoint}/api/v1/sessions/${encodeURIComponent(sessionID)}/chunks/${seq}?has_full_snapshot=${flag}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': config.apiKey },
      body: compressed as Uint8Array<ArrayBuffer>,
      keepalive,
    },
  );
  if (response.status === 403 || response.status === 410) {
    stopped = true;
    return 'stop';
  }
  return response.ok;
}

export async function uploadChunk(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
  hasFullSnapshot: boolean,
): Promise<UploadResult> {
  if (stopped || events.length === 0) return false;
  try {
    const compressed = await gzip(buildBody(events, hasFullSnapshot));
    if (!compressed) return false;
    return await sendChunk(sessionID, seq, compressed, hasFullSnapshot, false);
  } catch {
    return false;
  }
}

/**
 * The page-is-closing path. keepalive lets the request outlive the document,
 * but browsers cap keepalive bodies at 64KiB — that limit belongs to keepalive,
 * not to the endpoint, which accepts full-size chunks. Over budget, the caller
 * falls back to uploadChunk.
 */
export async function flushInline(
  sessionID: string,
  seq: number,
  events: eventWithTime[],
): Promise<UploadResult> {
  if (stopped || events.length === 0 || seq < 0) return false;
  try {
    const compressed = await gzip(buildBody(events, false));
    if (!compressed || compressed.byteLength > INLINE_BUDGET_BYTES) return false;
    return await sendChunk(sessionID, seq, compressed, false, true);
  } catch {
    return false;
  }
}
```

**Step 4: Run the test to verify it passes**

```bash
pnpm --filter @opslane/sdk test -- chunk-upload
```

Expected: PASS.

**Step 5: Build to catch type errors in callers**

```bash
pnpm --filter @opslane/sdk build
```

Expected: this may FAIL in `replay.ts` because `flushInline` now returns `UploadResult`. That is the point — Task 6 fixes it. If it passes, `replay.ts` is silently treating `'stop'` as success, which is the bug.

**Step 6: Commit**

```bash
git add packages/sdk/src/chunk-upload.ts packages/sdk/src/__tests__/chunk-upload.test.ts
git commit -m "feat(sdk): upload each replay chunk in a single authenticated request"
```

---

## Task 6: SDK — callers handle all three states

`replay.ts:311` does `.then((landed) => { if (!landed) void shipChunk(...) })`. Now that `flushInline` can return `'stop'`, and `'stop'` is truthy, a 403 on the tail path would take neither branch: capture would not stop, and no fallback would fire. Every caller must handle all three states explicitly.

**Files:**
- Modify: `packages/sdk/src/replay.ts:137-140,311-316`
- Test: `packages/sdk/src/__tests__/replay.test.ts`

**Step 1: Write the failing test**

Add to `packages/sdk/src/__tests__/replay.test.ts`, matching the file's existing setup style:

```ts
it('stops capture when the tail flush is told to stop', async () => {
  // 403 means recording was disabled server-side. 'stop' is truthy, so a naive
  // `if (!landed)` check would neither stop capture nor fall back — the tail
  // would silently look like a success.
  fetchMock.mockResolvedValue({ ok: false, status: 403 });

  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

  // A stopped recorder issues no further chunk requests.
  const callsAfterStop = fetchMock.mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @opslane/sdk test -- replay
```

Expected: FAIL — a second request fires because capture never stopped.

**Step 3: Handle all three states**

In `packages/sdk/src/replay.ts`, replace the `flushInline` call at line 311-316:

```ts
  void flushInline(tailSessionID, tailSeq, tail).then((result) => {
    // Three states, all load-bearing:
    //   'stop'  server said recording is off or the session is gone
    //   false   keepalive could not carry it (usually gzip over 64KiB)
    //   true    landed
    if (result === 'stop') {
      stopReplayCapture();
      return;
    }
    if (!result) void shipChunk(tailSessionID, tailSeq, tail);
  });
```

Confirm `shipChunk` (line 137) already handles `'stop'` — it does:

```ts
async function shipChunk(sessionID: string, seq: number, events: eventWithTime[]): Promise<void> {
  const result = await uploadChunk(sessionID, seq, events, true);
  if (result === 'stop') stopReplayCapture();
}
```

Leave it as-is.

**Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @opslane/sdk test
pnpm --filter @opslane/sdk build
```

Expected: both PASS.

**Step 5: Commit**

```bash
git add packages/sdk/src/replay.ts packages/sdk/src/__tests__/replay.test.ts
git commit -m "fix(sdk): stop capture when a tail flush returns stop"
```

---

## Task 7: Real-browser contract test

`packages/sdk/src/__tests__/replay-browser.test.ts` runs a real browser against a mock ingestion server. Its mock currently implements the three-call handshake: a `/chunks/upload-url` route returning `{upload_url, form_data}`, and a separate `/chunk-upload` endpoint whose body is parsed with `extractMultipartFile`.

**Rewriting this to the single call is the automated regression test issue #194 asks for.** A real browser driving the real code path is stronger evidence than a stub S3 backend that rejects POST, because the presigned-POST call is being deleted outright — it cannot regress, whereas the shape of what the SDK sends can.

**Files:**
- Modify: `packages/sdk/src/__tests__/replay-browser.test.ts:85-100`

**Step 1: Replace the mock handshake with a single route**

Delete the `/chunks/upload-url` handler and the `/chunk-upload` handler. Replace with one route matching the real path, capturing the raw gzip body directly:

```ts
        // Single-call chunk upload (#194). The body IS the gzip — no multipart,
        // no presigned form. If this ever needs a second request again, the
        // browser-to-R2 bug is back.
        const chunkMatch = /^\/api\/v1\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(url.split('?')[0] ?? '');
        if (chunkMatch && req.method === 'POST') {
          capturedChunkQuery = url.includes('?') ? url.slice(url.indexOf('?')) : '';
          try {
            capturedChunk = JSON.parse(gunzipSync(rawBody).toString('utf8')) as typeof capturedChunk;
          } catch {
            capturedChunk = null;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
             .end(JSON.stringify({ status: 'committed' }));
          return;
        }
```

Declare `capturedChunkQuery` alongside the existing `capturedChunk`, and delete the now-unused `extractMultipartFile` helper and `chunkPolicyBody` variable.

**Step 2: Assert the single-call shape**

Update the assertions in that test to check what now matters:

```ts
    expect(capturedChunk?.events?.length).toBeGreaterThan(0);
    expect(capturedChunkQuery).toMatch(/has_full_snapshot=[01]/);
```

**Step 3: Run the browser contract test**

```bash
pnpm --filter @opslane/sdk test -- replay-browser
```

Expected: PASS. If it skips, the real-browser harness is not installed — `packages/sdk/AGENTS.md` requires these to execute rather than skip when replay behaviour changes. Fix the harness before continuing; a skip here is not a pass.

**Step 4: Run the whole SDK suite and check the package**

```bash
pnpm --filter @opslane/sdk build
pnpm --filter @opslane/sdk test
pnpm --filter @opslane/sdk check:package
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add packages/sdk/src/__tests__/replay-browser.test.ts
git commit -m "test(sdk): drive a real browser through the single-call chunk upload"
```

---

## Task 8: E2E contract and helpers

Two files walk the handshake explicitly and must move to the single call. After this task nothing in the repo uses the old routes, which is what makes Task 9 safe.

**Files:**
- Modify: `test-e2e/replay-contract.test.ts:88-110`
- Modify: `test-e2e/helpers.ts:606-635`

**Step 1: Replace the handshake in the helper**

In `test-e2e/helpers.ts`, replace the `upload-url` → storage POST → `commit` sequence (lines 606-635) with one request:

```ts
  const upload = await fetch(
    `${ingestionUrl}/api/v1/sessions/${sessionId}/chunks/${seq}?has_full_snapshot=1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-API-Key': apiKey },
      body: compressed,
    },
  );
  if (!upload.ok) throw new Error(`chunk upload failed: ${upload.status} ${await upload.text()}`);
```

**Step 2: Replace the handshake in the contract test**

In `test-e2e/replay-contract.test.ts`, replace lines 88-110 the same way. Keep everything around it — the session init, the error ingest, the pointer assertions, and the scrubbed read path are all still exactly what this test is for.

**Step 3: Run the E2E suite**

The root `pnpm test` deliberately excludes this package, so run it explicitly:

```bash
pnpm --filter @opslane/test-e2e test
```

Expected: PASS. Requires the compose stack from the setup section, plus a running ingestion built from this branch:

```bash
docker compose up -d --build ingestion
```

**Step 4: Commit**

```bash
git add test-e2e/replay-contract.test.ts test-e2e/helpers.ts
git commit -m "test(e2e): exercise the single-call chunk upload contract"
```

---

## Task 9: Delete the handshake handlers and routes

Nothing calls these now. Delete them.

**Files:**
- Modify: `packages/ingestion/handler/session.go:222-374` (delete two handlers and two types)
- Modify: `packages/ingestion/handler/session.go:24,26` (delete two constants)
- Modify: `packages/ingestion/handler/routes.go:91-92,94` (delete three route registrations)
- Modify: `packages/ingestion/handler/session_integration_test.go` (delete obsolete tests and helpers)
- Modify: `packages/ingestion/handler/session_test.go:77-85`
- Modify: `packages/ingestion/handler/ingest_limits_test.go:263-265`

**Step 1: Delete the handlers**

Remove from `packages/ingestion/handler/session.go`:
- `chunkUploadURLRequest` and `chunkUploadURLResponse` (lines 222-233)
- `ChunkUploadURL` (lines 235-322)
- `ChunkCommit` (lines 324-374)
- the `maxInlineChunkBytes` constant (line 24)
- the `chunkUploadPolicyTTL` constant and its comment (lines 25-26)

**Step 2: Delete the routes**

Remove from `packages/ingestion/handler/routes.go`:
- line 91, the `upload-url` route
- line 92, the `commit` route
- the transitional `/inline` route added in Task 1

Leaving only:

```go
		r.With(deps.AuthenticateSDK, deps.EnforceOrigin, rateLimitByProject(chunksLimiter)).Post("/sessions/{sessionID}/chunks/{seq}", deps.ChunkUpload)
```

**Step 3: Delete the obsolete tests**

From `session_integration_test.go`, delete `TestChunkUploadURL_DuplicateSeqReturns409`, `TestChunkUploadURL_RejectsOversizeDeclaration`, `TestChunkUploadURL_UnknownSessionReturns404`, `TestChunkUploadURL_CrossTenantReturns404`, `TestChunkUploadURL_RecordingDisabledReturns403`, `TestChunkCommit_MissingObjectReturns409`, `TestChunkCommit_RecordsServerObservedSize`, `TestChunkCommit_IsIdempotent`, `TestChunkInline_StoresAndCommitsInOneCall`, `TestChunkInline_RejectsNonGzipBody`, and the `requestUploadURL` / `postInlineChunk` helpers.

**Do not simply delete their assertions.** Port each one to the new endpoint — this is Task 9's real work:

```go
func TestChunkUpload_DuplicateSeqReturns409(t *testing.T) { /* port from TestChunkUploadURL_DuplicateSeqReturns409 */ }
func TestChunkUpload_UnknownSessionReturns404(t *testing.T) { /* ... */ }
func TestChunkUpload_CrossTenantReturns404(t *testing.T) { /* ... */ }
func TestChunkUpload_RecordingDisabledReturns403(t *testing.T) { /* ... */ }
func TestChunkUpload_RejectsNonGzipBody(t *testing.T) { /* ... */ }
func TestChunkUpload_MissingAPIKeyReturns401(t *testing.T) { /* new */ }
func TestChunkUpload_OriginNotAllowlistedReturns403(t *testing.T) { /* new */ }
func TestChunkUpload_StoresAndCommitsInOneCall(t *testing.T) { /* port from TestChunkInline_StoresAndCommitsInOneCall */ }
func TestChunkUpload_IsIdempotentOnRetry(t *testing.T) { /* port from TestChunkCommit_IsIdempotent */ }
```

Update `session_test.go:77` (`TestChunkUploadURL_NoMinIOReturns503`) to hit the new route, and `ingest_limits_test.go:263-265`, which enumerates all three chunk routes, down to the one remaining route.

**Step 4: Verify nothing references the deleted symbols**

```bash
cd packages/ingestion && go build ./...
grep -rn "ChunkUploadURL\|ChunkCommit\|ChunkInline\|maxInlineChunkBytes\|chunkUploadPolicyTTL" --include='*.go' .
```

Expected: build PASSES, grep returns nothing.

**Step 4b: Enforce the single byte-budget charge**

`chunkBytesBudget.allow` currently appears twice in `session.go` — once in
`ChunkUploadURL`, once in `ChunkInline`. Deleting the former must leave exactly one:

```bash
grep -c "chunkBytesBudget.allow" packages/ingestion/handler/session.go
```

Expected: `1`.

Any other number means either a handler was missed, or somebody reintroduced the
pre-check-then-charge pattern that double-bills every project's 512MiB/minute allowance.
The budget primitive itself is already covered by `handler/byte_budget_test.go`; this
guard is about the call site, which is where the bug would live.

Also confirm no streaming variant crept in:

```bash
grep -rn "PutObjectStream\|PutObject(.*-1\|putObjectMultipartStreamNoLength" --include='*.go' packages/ingestion
```

Expected: no matches.

**Step 5: Run the full suite with the skip gate**

```bash
cd packages/ingestion && go test ./... -v 2>&1 | node ../../scripts/check-go-skips.mjs
```

Expected: PASS with no unexpected skips.

**Step 6: Commit**

```bash
git add packages/ingestion/handler/
git commit -m "refactor(ingestion): delete the presigned chunk upload handshake"
```

---

## Task 10: Delete `PresignedPostPolicy`

This function builds the presigned POST form that R2 rejects. Deleting it makes reintroducing the bug a compile error, which is stronger than any test.

Its doc comment is currently the best written explanation of the #48 guarantee in the codebase, and every sentence of it becomes wrong. Move the reasoning to where enforcement actually happens.

**Files:**
- Modify: `packages/ingestion/minio/client.go:118-164`
- Modify: `packages/ingestion/minio/client_test.go:34-111`
- Modify: `packages/ingestion/handler/session.go` (relocate the rationale)

**Step 1: Delete the function and its tests**

Remove `PresignedPostPolicy` (`client.go:118-164`), `TestPresignedPostPolicy_WithinCapSucceeds` (`client_test.go:64`), `TestPresignedPostPolicy_OverCapRejectedByStorage` (`client_test.go:89`), and the `postForm` helper (`client_test.go:34`). Remove any imports left unused (`mime/multipart`, `net/http`, `strings` may all become unused in the test file).

**Step 2: Relocate the rationale**

Extend the `ChunkUpload` doc comment written in Task 1 to carry the surviving reasoning:

```go
// ChunkUpload stores and commits one gzipped rrweb chunk in a single request.
// POST /api/v1/sessions/{sessionID}/chunks/{seq}
//
// The browser sends the bytes here rather than to object storage because
// Cloudflare R2 does not implement the S3 POST Object API (#194).
//
// The #48 ceiling lives here as a result. It used to be a content-length-range
// condition on a presigned POST policy, enforced by storage after the bytes had
// already left the browser; a public SDK key ships in customer bundles and is
// not secret, so without a ceiling it is a storage-flood primitive. Ingestion
// now sees every chunk, so http.MaxBytesReader below refuses an oversized body
// before a single byte reaches storage — a strictly stronger guarantee, and a
// portable one: content-length-range is only expressible on a POST policy, so
// the old form could never have worked on a backend without POST Object.
```

**Step 3: Verify**

```bash
cd packages/ingestion && go build ./... && go test ./...
grep -rn "PresignedPostPolicy\|NewPostPolicy\|SetContentLengthRange" --include='*.go' .
```

Expected: build and tests PASS, grep returns nothing.

**Step 4: Commit**

```bash
git add packages/ingestion/minio/
git add packages/ingestion/handler/session.go
git commit -m "refactor(ingestion): delete the presigned POST policy R2 cannot serve"
```

---

## Task 11: Correct stale comments

Four places explain the scrubber's 30-second grace in terms of replayable POST policies. That mechanism no longer exists, so the comments now describe a system that is not there. Stale comments are worse than none — they actively mislead.

**Do not change the 30-second value.** Shortening it is now safe, but it is a privacy-timing change and must not share a commit with a delivery-path rewrite. It is already recorded in `TODOS.md`.

**Do not write "nothing is presigned anymore."** `ReplayInit` at `handler/replay.go:155` still issues a presigned PUT.

**Files:**
- Modify: `packages/ingestion/main.go:206-210`
- Modify: `packages/ingestion/scrubber/scrubber.go:34`
- Modify: `packages/ingestion/scrubber/interval_test.go:9`
- Modify: `packages/ingestion/handler/ingest_limits.go:18-23`

**Step 1: Rewrite the scrub-grace comments**

Each of the three scrubber comments should say the same true thing in its own context. For `main.go:206-210`:

```go
		// Only the tick rate is tunable. The 30s eligibility grace in
		// ClaimUnscrubbedChunks is retained but no longer load-bearing: chunk
		// uploads are no longer presigned (#194), so there is no replayable
		// upload that could swap raw bytes under an already-scrubbed row. It
		// now only bounds how long a raw chunk sits unredacted; shortening it
		// is a separate privacy-timing decision.
```

**Step 2: Correct the rate-limiter comment**

`ingest_limits.go:18-23` says "each chunk costs 2 ingestion requests (upload-url + commit)" and sizes `chunksLimiter` at 6000/min on that basis. It is one request per chunk now. Update the reasoning; leave the limit as headroom:

```go
	// Always-on recording: every session uploads a chunk every ~30s, and each
	// chunk now costs 1 ingestion request (#194 collapsed the upload-url +
	// storage POST + commit handshake into a single call). 6000/min therefore
	// supports ~3000 concurrent sessions per replica; the byte budget below is
	// the real ceiling.
```

**Step 3: Verify**

```bash
cd packages/ingestion && go build ./... && go test ./...
grep -rn "presigned\|POST polic" --include='*.go' packages/ingestion | grep -v replay.go
```

Expected: build and tests PASS. The grep should return only comments that are now accurate — `replay.go` is excluded because its presigned PUT genuinely remains.

**Step 4: Commit**

```bash
git add packages/ingestion/main.go packages/ingestion/scrubber/ packages/ingestion/handler/ingest_limits.go
git commit -m "docs(ingestion): correct comments describing the deleted presign path"
```

---

## Task 12: Update documentation

Code comments are not enough. These files describe the deleted routes to readers outside the codebase.

**Files:**
- Modify: `docs/reference/http-routes.md:44-45`
- Modify: `docs/guides/replay-privacy.md`
- Modify: `docs/architecture/trust.md`
- Modify: `packages/ingestion/db/migrations/002_sessions.sql:53-54,65` (comments only)
- Modify: `packages/ingestion/db/sessions.go:181-182`

**Step 1: Replace the route table rows**

In `docs/reference/http-routes.md`, replace the two rows at lines 44-45 with one:

```markdown
| POST | `/api/v1/sessions/{sessionID}/chunks/{seq}` | yes | Store and commit one gzipped replay chunk (max 5MiB) |
```

**Step 2: Update the privacy guide and trust doc**

`docs/guides/replay-privacy.md` describes the upload path to customers. `docs/architecture/trust.md` documents the trust boundary, which genuinely moves in this change: replay bytes now transit ingestion instead of going browser-to-storage. Update both to describe what the system does now.

**Step 3: Correct the DB comments**

`002_sessions.sql:53-54` says `size_bytes` is "NULL until the commit call Stats the object" — there is no commit call. Line 65 explains tombstones with "Presigned URLs outlive the rows they were issued for", which no longer applies to chunks (it still applies to `ReplayInit`, so keep the tombstone table and say why accurately). `db/sessions.go:181-182` says `ReserveChunkSeq` "claims (session, seq) before a presigned URL is issued".

These are comments inside an already-applied migration. **Do not alter any SQL statement** — `002_sessions.sql` is applied history. Comment text only.

**Step 4: Annotate the historical plan docs**

`docs/plans/2026-07-15-browser-smoke-lane.md:19` and `docs/plans/2026-07-21-keyless-smoke-ci-speedup.md` describe the old flow. These are historical records of decisions — add a one-line superseded note rather than rewriting them.

**Step 5: Verify**

```bash
grep -rn "upload-url\|chunks/.*commit\|presigned POST" docs/ | grep -v "2026-07-24-replay-chunk-upload-r2"
```

Expected: only the historical plan docs, each carrying a superseded note.

**Step 6: Commit**

```bash
git add docs/ packages/ingestion/db/
git commit -m "docs: describe the single-call replay chunk upload"
```

---

## Task 13: Changeset and release

This is a breaking change to a published package. `@opslane/sdk@1.0.0` is on npm and is the `latest` tag, which means `npm install @opslane/sdk` currently gives people the version that cannot record against R2.

Changesets is the sole publishing authority (`.github/workflows/release-npm.yml:3`). **Do not hand-edit `packages/sdk/package.json`** — a previous hand-edit is why it reads `1.1.0` while npm's only version is `1.0.0`.

**Files:**
- Create: `.changeset/replay-chunk-upload-r2.md`

**Step 1: Write the changeset**

```markdown
---
'@opslane/sdk': major
---

Replay chunks now upload in a single authenticated request to ingestion instead of a presigned-URL handshake with object storage.

**Breaking:** the SDK no longer calls `POST /api/v1/sessions/{id}/chunks/upload-url` or `POST /api/v1/sessions/{id}/chunks/{seq}/commit`. It posts the gzipped chunk directly to `POST /api/v1/sessions/{id}/chunks/{seq}`. Upgrade ingestion before, or at the same time as, the SDK.

This fixes replay recording on Cloudflare R2, which does not implement the S3 POST Object API and rejected every chunk upload with `501 NotImplemented` (#194). It also cuts chunk uploads from three network round trips to one.
```

**Step 2: Verify changesets picks it up**

```bash
pnpm changeset status
```

Expected: `@opslane/sdk` listed with a `major` bump to `2.0.0`.

**Step 3: Commit**

```bash
git add .changeset/replay-chunk-upload-r2.md
git commit -m "chore: add a major changeset for the replay chunk upload change"
```

**Step 4: Post-merge release steps (not part of this branch)**

Record these for whoever merges — they happen after the Version Packages PR lands:

1. Merge the Version Packages PR so `2.0.0` publishes and `latest` moves to it.
2. `npm deprecate @opslane/sdk@1.0.0 "Replay chunk upload fails on Cloudflare R2 (#194). Upgrade to 2.x."` — deprecate, not unpublish: reversible, warns on install, breaks nobody who pinned.
3. Bump `@opslane/sdk` in the Forge dogfood app and redeploy it. It installed from npm, so it does not pick up a `workspace:*` build.

---

## Task 14: Full verification gate and R2 smoke

**Step 1: Run the full repository gate**

Exactly as `AGENTS.md` specifies:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
```

Expected: all PASS.

**Step 2: Run the E2E suite, which root `pnpm test` excludes**

```bash
docker compose up -d --build ingestion worker
pnpm --filter @opslane/test-e2e test
```

Expected: PASS.

**Step 3: Live pipeline smoke against MinIO**

`AGENTS.md` requires a live smoke for pipeline changes:

```bash
docker compose run --rm migrate
psql "$DATABASE_URL" -f scripts/seed-e2e.sql
docker compose up -d --build ingestion worker
```

Then load `test-fixtures/vue-app`, let it record past one chunk interval, trigger an error, and confirm the chunk reaches `uploaded` and then `scrubbed`:

```bash
psql "$DATABASE_URL" -c "SELECT seq, size_bytes, uploaded_at, scrubbed_at FROM session_chunks ORDER BY created_at DESC LIMIT 5;"
```

Expected: rows with non-NULL `size_bytes`, `uploaded_at`, and eventually `scrubbed_at`.

**Step 4: Manual smoke against real Cloudflare R2 — REQUIRED, gates the merge**

**Do not skip this.** Every automated test above runs against MinIO, and MinIO supporting a feature R2 does not is the exact reason this bug reached production. The issue's reproduction proved a simple PUT returns 200 on R2; it did not prove a multi-megabyte chunk written by this code path does.

Point a local ingestion at a real R2 bucket:

```bash
export REPLAY_STORE_ENDPOINT='https://<account>.r2.cloudflarestorage.com'
export REPLAY_STORE_PUBLIC_ENDPOINT=''
export REPLAY_STORE_ACCESS_KEY='<r2 access key>'
export REPLAY_STORE_SECRET_KEY='<r2 secret key>'
export REPLAY_STORE_BUCKET='<r2 bucket>'
export REPLAY_STORE_REGION='auto'
```

Then:

1. Start ingestion against that configuration.
2. Load a browser fixture and record a session long enough to produce a chunk over 1MB.
3. Confirm the upload returns 200 — not 501, not 400.
4. Confirm the object exists in the R2 bucket at `sessions/<project>/<session>/chunk-000000.json.gz`.
5. Confirm the scrubber redacts it and the dashboard plays it back.

Record the result in the PR description. "I watched it work" is the acceptance criterion; "this should work" is not.

**Step 5: Confirm the acceptance criteria from issue #194**

- [ ] With `REPLAY_STORE_ENDPOINT` pointed at R2, a browser replay session uploads chunks and playback works end to end — Step 4
- [ ] The #48 size ceiling still holds — `TestChunkUpload_RejectsOversizeBodyAndStoresNothing`, Task 2
- [ ] A test exercises the R2-shaped path so this cannot regress silently — `replay-browser.test.ts` drives a real browser through the single call, and `PresignedPostPolicy` is deleted so reintroduction is a compile error, Tasks 7 and 10
- [ ] MinIO/S3 paths still work — Steps 1-3

**Step 6: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "fix(replay): upload chunks in one request so recording works on R2"
```

---

## Reference

- Design review and rejected alternatives: `~/.gstack/projects/opslane-opslane-oss/abhishekray-replay-chunk-upload-r2-eng-review-plan-20260724-191814.md`
- Issue: https://github.com/opslane/opslane-oss/issues/194
- Follow-ups already recorded in `TODOS.md`: shorten the scrub grace, settle `ReplayInit`'s presigned PUT, add HTTP server timeouts
