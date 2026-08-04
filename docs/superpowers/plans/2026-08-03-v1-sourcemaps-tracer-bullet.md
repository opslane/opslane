# V1 Source Maps Tracer Bullet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One browser stack trace resolves end to end: the Vite plugin uploads stamped source maps with a secret `opslane_sk_` key, ingestion stores them privately by debug ID, and the worker resolves the investigated event's frames to original source for the fix agent.

**Architecture:** Spec is `docs/plans/2026-08-03-v1-sourcemaps-simplification.md` (revision 5). Five landable stages: (1) migrations + upload route in the Go ingestion service, (2) `cmd/mint-key` manual minting, (3) plugin uploader + SDK 3.0.0, (4) worker debug-ID resolution + `resolution_status`, (5) build-mode E2E harness + acceptance test. No batches, no key-management UI, no map read path, and NO onboarding/CLI changes (separate later track).

**Tech Stack:** Go 1.24 (chi, pgx, minio-go), Node 22 + strict TypeScript ESM, Vitest (colocated `__tests__`), Vite plugin API, Playwright-style browser E2E in `test-e2e/`.

## Global Constraints

- Server code (`packages/ingestion`, `packages/worker`, `cli`) is AGPL-3.0-only; `packages/sdk` and `shared` are MIT. No new npm/Go dependencies (the uploader uses Node's global `fetch`).
- TypeScript: ESM, strict, `unknown` + narrowing, never `any`.
- Migrations: append-only, idempotent (`IF NOT EXISTS` / `DROP ... IF EXISTS`). Next free numbers: `030`, `031` (`029_drop_environment_api_keys.sql` exists; `028` is already a two-file collision — do not add to it).
- The `POST /api/v1/events` wire contract is append-only; nothing in this plan touches it.
- Key redaction, `X-API-Key` auth, and the scope middleware from S1 are reused, never reimplemented.
- Debug ID format everywhere: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
- Server-side map cap: 32 MiB of wire bytes (`http.MaxBytesReader`). `content_sha256` is ALWAYS `debugid.Compute(...).ContentSHA256` (canonical RFC 8785 hash), never a raw-byte hash.
- Env var names: `OPSLANE_SOURCEMAP_KEY` (the sk), `OPSLANE_ENDPOINT` (ingestion origin) — resolved by the Vite plugin from `process.env` first, then the project's Vite env files via `loadEnv(config.mode, config.root, 'OPSLANE_')` so a key in the gitignored `.env.local` works for local builds. Non-`VITE_`-prefixed vars never reach browser code.
- Verification per package: `(cd packages/ingestion && go build ./... && go test ./...)`, `pnpm --filter @opslane/sdk build|test`, `pnpm --filter @opslane/worker build|test`. (No CLI changes in this plan.)

---

### Task 1: Migration 030 — `sourcemap_files`, tombstone trigger

**Files:**
- Create: `packages/ingestion/db/migrations/030_sourcemap_files.sql`

**Interfaces:**
- Produces: table `sourcemap_files(project_id UUID, debug_id TEXT, content_sha256 TEXT, has_sources_content BOOLEAN, size_bytes BIGINT, object_key TEXT, created_at TIMESTAMPTZ)` PK `(project_id, debug_id)`; table `sourcemap_tombstones(project_id UUID, storage_prefix TEXT, deleted_at TIMESTAMPTZ)`; trigger `projects_sourcemap_tombstone` (BEFORE DELETE ON projects). Tasks 3, 8, 9 read/write `sourcemap_files`.
- Note: the legacy `source_maps` table is NOT dropped in this slice at all — the worker stops querying it in Task 8, and a follow-up migration in the NEXT release drops it (expand/contract; dropping alongside the worker change would break an old worker against a migrated database).

- [ ] **Step 1: Write the migration**

```sql
-- 030_sourcemap_files.sql
-- Debug-ID-keyed source maps (v1 single-map upload; supersedes the frozen
-- batch tables per docs/plans/2026-08-03-v1-sourcemaps-simplification.md).
CREATE TABLE IF NOT EXISTS sourcemap_files (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  debug_id TEXT NOT NULL CHECK (
    debug_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  has_sources_content BOOLEAN NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  object_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, debug_id)
);

-- No FK: a tombstone must survive the project row it describes. It records
-- which object-storage prefixes hold orphaned customer source until the
-- (deferred) sweeper runs. Written by trigger so manual SQL deletes are
-- covered too — there is no project DELETE endpoint in v1.
CREATE TABLE IF NOT EXISTS sourcemap_tombstones (
  project_id UUID NOT NULL,
  storage_prefix TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id)
);

CREATE OR REPLACE FUNCTION write_sourcemap_tombstone() RETURNS trigger AS $$
BEGIN
  INSERT INTO sourcemap_tombstones (project_id, storage_prefix)
  VALUES (OLD.id, 'sourcemaps/' || OLD.id || '/')
  ON CONFLICT (project_id) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_sourcemap_tombstone ON projects;
CREATE TRIGGER projects_sourcemap_tombstone
  BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION write_sourcemap_tombstone();
```

- [ ] **Step 2: Verify idempotency on a disposable database**

Run (uses a throwaway DB, never retained data):
```bash
docker run -d --name pg-mig-test -e POSTGRES_PASSWORD=t -e POSTGRES_DB=opslane -p 55432:5432 postgres:16
sleep 3
for i in 1 2; do
  for f in packages/ingestion/db/migrations/*.sql; do
    PGPASSWORD=t psql -h localhost -p 55432 -U postgres -d opslane -v ON_ERROR_STOP=1 -f "$f"
  done
done
PGPASSWORD=t psql -h localhost -p 55432 -U postgres -d opslane -c \
  "INSERT INTO orgs (name) VALUES ('t') RETURNING id" 
# take the org id, then:
# INSERT INTO projects (org_id, name) VALUES ('<org>', 'p1') RETURNING id;
# DELETE FROM projects WHERE id = '<project>';
# SELECT * FROM sourcemap_tombstones;  -- expect one row with prefix sourcemaps/<project>/
docker rm -f pg-mig-test
```
Expected: both passes apply cleanly; tombstone row appears after the manual DELETE.

- [ ] **Step 3: Commit**

```bash
git add packages/ingestion/db/migrations/030_sourcemap_files.sql
git commit -m "feat(ingestion): sourcemap_files table and project tombstone trigger"
```

---

### Task 2: Relax `sourcesContent` to optional in both debug-ID validators

**Files:**
- Modify: `packages/ingestion/debugid/debugid.go` (validateSourceMap, `Result`)
- Modify: `packages/sdk/src/build/debug-id.ts:271-284` (the sourcesContent block)
- Test: `packages/ingestion/debugid/debugid_test.go`, the existing colocated test for `debug-id.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `debugid.Result{DebugID, ContentSHA256 string, HasSourcesContent bool}` — Task 3's handler reads `HasSourcesContent`. TS `computeDebugId` accepts maps without `sourcesContent` (parity so the plugin can stamp `sourcemapExcludeSources` builds).
- Contract note: this amends frozen §6 validity rules explicitly (Task 10 records it). The hash algorithm and golden vectors in `test-fixtures/debug-id/vectors.json` are unaffected — a map WITH sourcesContent hashes identically before and after.

- [ ] **Step 1: Write failing Go tests**

Append to `packages/ingestion/db/../debugid/debugid_test.go`:
```go
func TestComputeWithoutSourcesContent(t *testing.T) {
	input := []byte(`{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA"}`)
	result, err := Compute(input)
	if err != nil {
		t.Fatalf("expected acceptance without sourcesContent, got %v", err)
	}
	if result.HasSourcesContent {
		t.Fatal("HasSourcesContent must be false when the field is absent")
	}
}

func TestComputeSourcesContentPresent(t *testing.T) {
	input := []byte(`{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"names":[],"mappings":"AAAA"}`)
	result, err := Compute(input)
	if err != nil {
		t.Fatalf("expected acceptance, got %v", err)
	}
	if !result.HasSourcesContent {
		t.Fatal("HasSourcesContent must be true when the field is present")
	}
}

func TestComputeSourcesContentLengthMismatchStillRejected(t *testing.T) {
	input := []byte(`{"version":3,"sources":["a.ts","b.ts"],"sourcesContent":["x"],"names":[],"mappings":"AAAA"}`)
	if _, err := Compute(input); err == nil {
		t.Fatal("expected sources_content_mismatch rejection")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./debugid/ -run TestComputeWithout -v`
Expected: FAIL (`bad_field_type` rejection today, and `HasSourcesContent` does not compile until Result changes).

- [ ] **Step 3: Implement the Go change**

In `debugid.go`, change `Result` and `validateSourceMap`:
```go
// Result contains the 128-bit debug ID and the full content digest.
type Result struct {
	DebugID           string
	ContentSHA256     string
	HasSourcesContent bool
}
```
In `Compute`, after `validateSourceMap(root)` succeeds and before `delete(root, "debugId")`, capture presence:
```go
	_, hasSourcesContent := root["sourcesContent"]
```
Set `HasSourcesContent: hasSourcesContent` on the single success `Result{...}` return only; error paths keep returning the zero `Result{}`. In `validateSourceMap`, replace the sourcesContent block:
```go
	if raw, ok := root["sourcesContent"]; ok {
		sourcesContent, err := stringArray(raw)
		if err != nil {
			return reject("bad_field_type")
		}
		if len(sources) != len(sourcesContent) {
			return reject("sources_content_mismatch")
		}
	}
```

- [ ] **Step 4: Run Go tests including golden vectors**

Run: `cd packages/ingestion && go test ./debugid/ -v`
Expected: PASS, including the existing vector tests.

- [ ] **Step 5: Mirror in TypeScript with a failing test first**

Find the existing test file for `debug-id.ts` (`ls packages/sdk/src/build/__tests__/ packages/sdk/**/__tests__/ | grep -i debug`). Add:
```ts
it('accepts a map without sourcesContent', async () => {
  const map = JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' });
  const result = await computeDebugId(new TextEncoder().encode(map));
  expect(result.debugId).toMatch(/^[0-9a-f]{8}-/);
});

it('still rejects a sources/sourcesContent length mismatch', async () => {
  const map = JSON.stringify({ version: 3, sources: ['a.ts', 'b.ts'], sourcesContent: ['x'], names: [], mappings: 'AAAA' });
  await expect(computeDebugId(new TextEncoder().encode(map))).rejects.toThrow();
});
```
Run `pnpm --filter @opslane/sdk test -- debug-id` → first test FAILS. Then in `packages/sdk/src/build/debug-id.ts` (lines ~271-284) make the block conditional on the member being present, exactly parallel to Go:
```ts
  const sourcesContent = getMember(value, 'sourcesContent');
  if (sourcesContent !== undefined) {
    if (
      !isArray(sourcesContent) ||
      !sourcesContent.values.every((entry) => typeof entry === 'string')
    ) {
      throw rejection('bad_field_type');
    }
    if (sources.values.length !== sourcesContent.values.length) {
      throw rejection('sources_content_mismatch');
    }
  }
```
(Keep the file's actual helper names — `getMember`/`isArray`/rejection style — as found; the shape above shows the required semantics: absent = accepted, present-but-wrong = rejected.)

- [ ] **Step 5b: Add a shared golden vector for the new shape**

Add a case WITHOUT `sourcesContent` to the vector GENERATOR `test-fixtures/debug-id/build-vectors.mjs` (adding only to the generated `vectors.json` would be silently deleted on regeneration), regenerate `vectors.json` with it, and confirm both suites consume the new entry. This pins the newly accepted shape so the two implementations cannot drift on it.

- [ ] **Step 6: Run both suites and the shared vectors**

Run: `pnpm --filter @opslane/sdk test` and `cd packages/ingestion && go test ./debugid/`
Expected: PASS, vectors unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/ingestion/debugid/ packages/sdk/src/build/ test-fixtures/debug-id/
git commit -m "feat(debugid): sourcesContent is optional; expose HasSourcesContent"
```

---

### Task 3: DB layer for source-map rows

**Files:**
- Create: `packages/ingestion/db/sourcemaps.go`
- Test: `packages/ingestion/db/sourcemaps_test.go` (integration-gated like `onboard_provision_integration_test.go` — copy its DB-availability guard)

**Interfaces:**
- Produces:
```go
type SourceMapFile struct {
	ProjectID         string
	DebugID           string
	ContentSHA256     string
	HasSourcesContent bool
	SizeBytes         int64
	ObjectKey         string
}
// UpsertSourceMapFile inserts the row, or returns the existing row for this
// (project, debug ID). inserted=false means a row already existed (idempotent
// retry or a lost race) — the caller compares ContentSHA256.
func (q *Queries) UpsertSourceMapFile(ctx context.Context, f SourceMapFile) (stored SourceMapFile, inserted bool, err error)
// GetSourceMapFile reads one row; found=false (no error) when absent.
func (q *Queries) GetSourceMapFile(ctx context.Context, projectID, debugID string) (SourceMapFile, bool, error)
```
- Consumes: Task 1's table.

- [ ] **Step 1: Write the failing integration test**

```go
func TestUpsertSourceMapFileIdempotentAndConflicting(t *testing.T) {
	q := testQueries(t) // same helper/guard the other db integration tests use
	projectID := createTestProject(t, q)

	f := SourceMapFile{
		ProjectID: projectID,
		DebugID:   "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		ContentSHA256: "1111111111111111111111111111111111111111111111111111111111111111",
		HasSourcesContent: true, SizeBytes: 10, ObjectKey: "sourcemaps/x/y",
	}
	_, inserted, err := q.UpsertSourceMapFile(context.Background(), f)
	if err != nil || !inserted {
		t.Fatalf("first insert: inserted=%v err=%v", inserted, err)
	}
	stored, inserted, err := q.UpsertSourceMapFile(context.Background(), f)
	if err != nil || inserted {
		t.Fatalf("second insert must be a no-op: inserted=%v err=%v", inserted, err)
	}
	if stored.ContentSHA256 != f.ContentSHA256 {
		t.Fatal("stored row must be returned on conflict")
	}
	// Same debug ID in a second project is a separate row.
	projectB := createTestProject(t, q)
	fB := f
	fB.ProjectID = projectB
	if _, inserted, err = q.UpsertSourceMapFile(context.Background(), fB); err != nil || !inserted {
		t.Fatalf("second project must insert independently: %v", err)
	}
}
```
(If no `testQueries`/`createTestProject` helpers exist, use the exact setup pattern from `onboard_provision_integration_test.go` — same env-var gate, same org/project seeding SQL.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./db/ -run TestUpsertSourceMapFile -v` (with the integration DB env set the way the existing integration tests document)
Expected: FAIL — `UpsertSourceMapFile` undefined.

- [ ] **Step 3: Implement**

```go
package db

import "context"

type SourceMapFile struct {
	ProjectID         string
	DebugID           string
	ContentSHA256     string
	HasSourcesContent bool
	SizeBytes         int64
	ObjectKey         string
}

func (q *Queries) UpsertSourceMapFile(ctx context.Context, f SourceMapFile) (SourceMapFile, bool, error) {
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO sourcemap_files
		  (project_id, debug_id, content_sha256, has_sources_content, size_bytes, object_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (project_id, debug_id) DO NOTHING`,
		f.ProjectID, f.DebugID, f.ContentSHA256, f.HasSourcesContent, f.SizeBytes, f.ObjectKey,
	)
	if err != nil {
		return SourceMapFile{}, false, err
	}
	if tag.RowsAffected() == 1 {
		return f, true, nil
	}
	var stored SourceMapFile
	err = q.pool.QueryRow(ctx, `
		SELECT project_id, debug_id, content_sha256, has_sources_content, size_bytes, object_key
		FROM sourcemap_files WHERE project_id = $1 AND debug_id = $2`,
		f.ProjectID, f.DebugID,
	).Scan(&stored.ProjectID, &stored.DebugID, &stored.ContentSHA256,
		&stored.HasSourcesContent, &stored.SizeBytes, &stored.ObjectKey)
	return stored, false, err
}

func (q *Queries) GetSourceMapFile(ctx context.Context, projectID, debugID string) (SourceMapFile, bool, error) {
	var stored SourceMapFile
	err := q.pool.QueryRow(ctx, `
		SELECT project_id, debug_id, content_sha256, has_sources_content, size_bytes, object_key
		FROM sourcemap_files WHERE project_id = $1 AND debug_id = $2`,
		projectID, debugID,
	).Scan(&stored.ProjectID, &stored.DebugID, &stored.ContentSHA256,
		&stored.HasSourcesContent, &stored.SizeBytes, &stored.ObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceMapFile{}, false, nil
	}
	if err != nil {
		return SourceMapFile{}, false, err
	}
	return stored, true, nil
}
```
(Add `"errors"` and `"github.com/jackc/pgx/v5"` to the imports.)

- [ ] **Step 4: Run tests, then commit**

Run: `cd packages/ingestion && go build ./... && go test ./db/ -run TestUpsertSourceMapFile -v`
Expected: PASS.
```bash
git add packages/ingestion/db/sourcemaps.go packages/ingestion/db/sourcemaps_test.go
git commit -m "feat(ingestion): sourcemap_files upsert with conflict read-back"
```

---

### Task 4: The upload route

**Files:**
- Create: `packages/ingestion/handler/sourcemap_upload.go`
- Modify: `packages/ingestion/minio/client.go` — add the sentinel and mapping:
```go
// ErrObjectNotFound reports a StatObject/GetObject miss; callers check with
// errors.Is so fakes can return the same sentinel.
var ErrObjectNotFound = errors.New("object not found")
```
  and in `StatObject`, map the SDK error: `if minio.ToErrorResponse(err).Code == "NoSuchKey" { return 0, fmt.Errorf("%w: %s", ErrObjectNotFound, objectKey) }`. Unit-test the mapping in `packages/ingestion/minio/client_test.go` (construct a `minio.ErrorResponse{Code: "NoSuchKey"}`). The handler imports this package as `minioPkg` (matching `handler/auth.go`'s existing alias). The map-backed test fake's StatObject returns `minioPkg.ErrObjectNotFound` for absent keys — that IS the not-found contract.
- Modify: `packages/ingestion/handler/routes.go` (register route)
- Modify: `packages/ingestion/handler/route_matrix_test.go` (it currently asserts `/sourcemaps` paths 404; the PUT route now exists)
- Test: `packages/ingestion/handler/sourcemap_upload_test.go`

**Interfaces:**
- Consumes: `deps.ProjectKey(db.ScopeSourcemaps)` (existing middleware — emits 401 `invalid_api_key` / 403 `insufficient_scope`), `debugid.Compute` (Task 2), `q.UpsertSourceMapFile` (Task 3), `deps.MinIO` (`*minio.Client`: `PutObject(ctx, key, data, contentType) error`, `StatObject(ctx, key) (int64, error)`), `rateLimitByProject` + `newRateLimiter` (`ingest_limits.go`), `writeJSONErrorCode`.
- Produces: `PUT /api/v1/sourcemaps/{debugID}` with responses: `201 {"status":"created"}`, `200 {"status":"exists"}`, `400 invalid_source_map` / `invalid_debug_id`, `409 debug_id_mismatch` / `debug_id_conflict`, `413 payload_too_large`, `415 unsupported_media_type` (any `Content-Encoding` header — §7.2's no-encoding rule kept), `503 storage_unavailable`. Task 7's uploader and Task 9's E2E call this. Also produces the `Dependencies.SourcemapStore objectStore` test seam.

- [ ] **Step 1: Write failing handler tests**

Follow the existing handler-test bootstrap in this package (the route-matrix / ingest tests show how a test `Dependencies` and router are built). Cover, using a seeded sk and pk:

```go
// Table-driven; abbreviated here to the assertions that matter.
// 1. pk on the route -> 403 insufficient_scope (middleware, but this is the
//    first sk route, so it needs a live test).
// 2. Valid sk + valid map whose computed ID == URL ID -> 201; row exists;
//    object exists at sourcemaps/{projectID}/{debugID}/{contentSha256}.
// 3. Same PUT again -> 200, no duplicate row.
// 4. Valid map under a URL ID that does not match -> 409 debug_id_mismatch.
// 5. Body "not json" -> 400 invalid_source_map.
// 6. Invalid single-segment IDs ("zzz", uppercase hex, wrong length) -> 400
//    invalid_debug_id. (Multi-segment traversal like ../../etc never reaches
//    the handler — chi treats slashes as segment boundaries and 404s — so the
//    defense-in-depth regex is exercised via single-segment garbage.)
// 7. Map without sourcesContent -> 201 and has_sources_content=false in the row.
// 8. Both SourcemapStore and MinIO nil -> 503 storage_unavailable.
// 9. Any Content-Encoding header (e.g. gzip) -> 415 unsupported_media_type.
// 10. Rate limiting: construct sourcemapRateLimit with a tiny limiter
//     (newRateLimiter(1)), fire two requests -> second is 429 with body code
//     "rate_limited" AND a Retry-After header. This bespoke wrapper is a
//     contract surface; it needs its own server-side test.
```
For object storage in tests: set `Dependencies.SourcemapStore` (Step 3's seam) to a map-backed fake for the unit tests; keep one integration test against real MinIO gated like the DB integration tests.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/ingestion && go test ./handler/ -run TestSourceMapUpload -v`
Expected: FAIL — handler undefined, route 404.

- [ ] **Step 3: Implement the handler**

```go
package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/debugid"
)

var sourcemapsLimiter = newRateLimiter(60) // bounds a leaked sk to ~1.9 GiB/min; a 248-map build takes ~4 min

// sourcemapRateLimit mirrors rateLimitByProject but emits the frozen
// contract's 429 shape: code "rate_limited" plus a Retry-After header.
func sourcemapRateLimit(limiter *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := ProjectIDFromCtx(r.Context())
			if projectID != "" && !limiter.allow(projectID) {
				w.Header().Set("Retry-After", "60")
				writeJSONErrorCode(w, http.StatusTooManyRequests, "too many uploads", "rate_limited")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
// (Match rateLimitByProject's actual context/allow mechanics in
// ingest_limits.go — reuse its helpers rather than reimplementing them.)

const maxSourceMapBytes = 32 << 20

var debugIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// objectStore is the slice of the MinIO client this handler needs. The
// concrete *minio.Client satisfies it. Dependencies gains ONE new optional
// field, `SourcemapStore objectStore`, used only by this handler; when nil it
// falls back to d.MinIO. Tests set SourcemapStore to a map-backed fake;
// NewHealthChecker and replay.go keep the concrete d.MinIO untouched.
type objectStore interface {
	PutObject(ctx context.Context, objectKey string, data []byte, contentType string) error
	StatObject(ctx context.Context, objectKey string) (int64, error)
}

func (d *Dependencies) sourcemapStore() objectStore {
	if d.SourcemapStore != nil {
		return d.SourcemapStore
	}
	if d.MinIO != nil {
		return d.MinIO
	}
	return nil
}

// UploadSourceMap stores one immutable source map keyed by (project, debug ID).
//
// PUT /api/v1/sourcemaps/{debugID}
func (d *Dependencies) UploadSourceMap(w http.ResponseWriter, r *http.Request) {
	projectID := ProjectIDFromCtx(r.Context()) // same accessor IngestEvent uses (handler/auth.go)
	if r.Header.Get("Content-Encoding") != "" {
		// The frozen contract keeps §7.2's rule: no Content-Encoding in v1.
		writeJSONErrorCode(w, http.StatusUnsupportedMediaType,
			"Content-Encoding is not supported; send identity-encoded bytes", "unsupported_media_type")
		return
	}
	urlID := chi.URLParam(r, "debugID")
	if !debugIDPattern.MatchString(urlID) {
		writeJSONErrorCode(w, http.StatusBadRequest, "debug ID is not in canonical form", "invalid_debug_id")
		return
	}
	store := d.sourcemapStore()
	if store == nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "object storage unavailable", "storage_unavailable")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSourceMapBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSONErrorCode(w, http.StatusRequestEntityTooLarge,
				"source map exceeds the 32 MiB limit", "payload_too_large")
			return
		}
		writeJSONErrorCode(w, http.StatusBadRequest, "could not read request body", "invalid_request")
		return
	}

	computed, err := debugid.Compute(body)
	if err != nil {
		writeJSONErrorCode(w, http.StatusBadRequest,
			"body is not a fingerprintable source map", "invalid_source_map")
		return
	}
	if computed.DebugID != urlID {
		writeJSONErrorCode(w, http.StatusConflict,
			"map content does not produce the debug ID in the URL", "debug_id_mismatch")
		return
	}

	// Digest-addressed: concurrent conflicting first uploads write DIFFERENT
	// objects, so overwrite of the accepted artifact is structurally impossible;
	// the losing insert's object stays orphaned and unreferenced.
	objectKey := fmt.Sprintf("sourcemaps/%s/%s/%s", projectID, urlID, computed.ContentSHA256)
	row := db.SourceMapFile{
		ProjectID:         projectID,
		DebugID:           urlID,
		ContentSHA256:     computed.ContentSHA256,
		HasSourcesContent: computed.HasSourcesContent,
		SizeBytes:         int64(len(body)),
		ObjectKey:         objectKey,
	}

	// Row first: a conflicting upload must never overwrite the accepted
	// object, so the digest comparison happens before any object write.
	existing, found, err := d.Queries.GetSourceMapFile(r.Context(), projectID, urlID)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
		return
	}
	if found {
		if existing.ContentSHA256 != computed.ContentSHA256 {
			// Only reachable by a canonical-content conflict under one debug
			// ID (attack or hash collision, given the recompute above).
			writeJSONErrorCode(w, http.StatusConflict,
				"a different map is already stored under this debug ID", "debug_id_conflict")
			return
		}
		// Idempotent retry. Heal a historical crash between object write and
		// row commit — only on a stat FAILURE (object missing): raw wire
		// bytes of identical canonical content may legitimately differ in
		// length across clients, so a size comparison would re-put forever.
		if _, statErr := store.StatObject(r.Context(), existing.ObjectKey); statErr != nil {
			// Heal only a MISSING object (crash between put and insert).
			// Any other stat failure is storage trouble — do not mask it
			// with a 200. The wrapper's StatObject converts the SDK's
			// NoSuchKey into the exported sentinel minio.ErrObjectNotFound
			// (new, see below), so callers and fakes share one semantics:
			// errors.Is(err, minioPkg.ErrObjectNotFound).
			if !errors.Is(statErr, minioPkg.ErrObjectNotFound) {
				writeJSONErrorCode(w, http.StatusServiceUnavailable, "object storage unavailable", "storage_unavailable")
				return
			}
			if putErr := store.PutObject(r.Context(), existing.ObjectKey, body, "application/json"); putErr != nil {
				writeJSONErrorCode(w, http.StatusServiceUnavailable, "object storage unavailable", "storage_unavailable")
				return
			}
		}
		writeJSONStatus(w, http.StatusOK, "exists")
		return
	}

	// New map: object before row, so a crash leaves an orphan object (healed
	// above on retry), never a row pointing at nothing.
	if err := store.PutObject(r.Context(), objectKey, body, "application/json"); err != nil {
		writeJSONErrorCode(w, http.StatusServiceUnavailable, "object storage unavailable", "storage_unavailable")
		return
	}
	stored, inserted, err := d.Queries.UpsertSourceMapFile(r.Context(), row)
	if err != nil {
		writeJSONErrorCode(w, http.StatusInternalServerError, "internal error", "internal_error")
		return
	}
	if !inserted && stored.ContentSHA256 != computed.ContentSHA256 {
		writeJSONErrorCode(w, http.StatusConflict,
			"a different map is already stored under this debug ID", "debug_id_conflict")
		return
	}
	if inserted {
		writeJSONStatus(w, http.StatusCreated, "created")
		return
	}
	writeJSONStatus(w, http.StatusOK, "exists") // lost an identical-content race
}
```
Add the tiny helper if none exists: `func writeJSONStatus(w http.ResponseWriter, code int, status string)` writing `{"status": "<status>"}`. Add the `SourcemapStore objectStore` field to `Dependencies` (in the file where `Dependencies` is defined) with a comment that it is a test seam defaulting to `MinIO`.

Register in `routes.go` right after the ingest-key block (line ~94):
```go
		// Source-map upload (authenticated by sourcemaps-scoped secret key).
		// NOT the shared rateLimitByProject: the frozen contract requires the
		// 429 body to carry code "rate_limited" and a Retry-After header, which
		// the shared helper does not emit. sourcemapRateLimit (defined in
		// sourcemap_upload.go) wraps the same limiter with
		// writeJSONErrorCode(w, 429, "too many uploads", "rate_limited") and
		// w.Header().Set("Retry-After", "60").
		sourcemapKey := deps.ProjectKey(db.ScopeSourcemaps)
		r.With(sourcemapKey, sourcemapRateLimit(sourcemapsLimiter)).Put("/sourcemaps/{debugID}", deps.UploadSourceMap)
```

- [ ] **Step 3b: Document the route (drift checker)**

Add the `PUT /api/v1/sourcemaps/{debugID}` row to `docs/reference/http-routes.md` in this task's commit — `scripts/check-docs-drift.mjs` fails the repo gate for any registered-but-undocumented route, so without this line Task 4 is not independently landable.

- [ ] **Step 4: Fix the route matrix**

In `route_matrix_test.go`, the entries asserting `/api/v1/sourcemaps...` returns 404: keep 404 for `POST /api/v1/sourcemaps` (the legacy route stays dead) and for any GET; change/add `PUT /api/v1/sourcemaps/{id}` expectations: no key → 401, pk → 403, sk → not-404.

- [ ] **Step 5: Run and commit**

Run: `cd packages/ingestion && go build ./... && go test ./handler/ ./db/ ./debugid/`
Expected: PASS.
```bash
git add packages/ingestion/handler/ docs/reference/http-routes.md
git commit -m "feat(ingestion): sk-scoped PUT /api/v1/sourcemaps/{debugID} with server-side recompute"
```

---

### Task 5: `cmd/mint-key` — manual sk minting

**Files:**
- Create: `packages/ingestion/cmd/mint-key/main.go`

**Interfaces:**
- Consumes: `db.CreateProjectKey(ctx, projectID, db.ScopeSourcemaps, label, nil)` — existing and already covered by tests; this command is a thin, untested-logic-free wrapper around it.
- Produces: `go run ./cmd/mint-key -project <uuid> [-label <text>]` printing the raw `opslane_sk_` once plus the documented revocation SQL. This is the ENTIRE v1 key lifecycle; no onboarding or CLI changes anywhere in this plan (maintainer decision 2026-08-03 — the onboarding integration is a separate later track).

- [ ] **Step 1: Implement**

```go
// Command mint-key mints a sourcemaps-scoped project key and prints it once.
// v1 has no key-management API; this command plus the printed revocation SQL
// is the whole lifecycle until the onboarding track ships.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func main() {
	projectID := flag.String("project", "", "project UUID")
	label := flag.String("label", "ci source maps", "key label")
	flag.Parse()
	if *projectID == "" {
		fmt.Fprintln(os.Stderr, "usage: mint-key -project <uuid> [-label <text>]")
		os.Exit(2)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(2)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer pool.Close()

	queries := db.New(pool)
	minted, err := queries.CreateProjectKey(ctx, *projectID, db.ScopeSourcemaps, *label, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mint:", err)
		os.Exit(1)
	}

	fmt.Println("Source-map upload key (shown once — not retrievable later):")
	fmt.Println("  " + minted.Raw)
	fmt.Println()
	fmt.Println("Set OPSLANE_SOURCEMAP_KEY to this value in CI, and/or in the")
	fmt.Println("repo's gitignored .env.local for local production builds.")
	fmt.Println()
	fmt.Println("Key ID (for exact revocation): " + minted.KeyID)
	fmt.Println("To revoke exactly this key (frozen §3.2: one exact key, never a blanket revoke):")
	fmt.Printf("  UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '%s';\n", minted.KeyID)
}
```
Adjust two details against the real code before committing: the constructor name for `Queries` (grep `func New(` in `packages/ingestion/db/` — use whatever `main.go` uses to build its `Queries`), and the env var name ingestion's `main.go` reads for the DSN (use the same one, whatever it is called).

- [ ] **Step 2: Smoke it against a disposable database**

```bash
cd packages/ingestion && go build ./...
# Using the Task 1 disposable postgres with migrations applied and one project row:
DATABASE_URL=postgres://postgres:t@localhost:55432/opslane go run ./cmd/mint-key -project <uuid>
```
Expected: prints one `opslane_sk_...`; `ParseProjectKey` accepts it (scope sourcemaps); the printed revocation SQL, run via psql, makes `LookupProjectKey` reject the key.

- [ ] **Step 3: Commit**

```bash
git add packages/ingestion/cmd/mint-key/
git commit -m "feat(ingestion): mint-key command for manual sourcemap-key minting"
```

---

### Task 6: (removed)

Onboarding/CLI sk integration was cut from this slice by maintainer decision (2026-08-03). The settled design for that future track (mint in `ProvisionOnboardSession` only, flag-gated `--rotate-sourcemap-key`, `.env.local` delivery, guarded CLI sinks incl. the run log) is recorded in the spec's "Deferred: onboarding track" section — do not implement any of it here.

---

### Task 7: Plugin uploads what it stamped; SDK 3.0.0

**Files:**
- Create: `packages/sdk/vite-plugin/upload.ts`
- Modify: `packages/sdk/vite-plugin/index.ts`
- Create: `.changeset/sourcemap-upload-v3.md`
- Test: `packages/sdk/vite-plugin/__tests__/upload.test.ts` (and extend the existing plugin test file if one exists — check `packages/sdk/vite-plugin/` and `packages/sdk/src/build/__tests__/`)

**Interfaces:**
- Consumes: Task 4's route contract (PUT, `X-API-Key`, 200/201 = success).
- Produces:
```ts
export interface UploadEntry { debugId: string; mapSource: string; fileName: string }
export interface UploadOutcome { uploaded: number; failed: { fileName: string; reason: string }[] }
export async function uploadSourceMaps(
  entries: UploadEntry[],
  opts: { endpoint: string; key: string; fetchImpl?: typeof fetch },
): Promise<UploadOutcome>
```
- Env contract: uploads run only when `OPSLANE_SOURCEMAP_KEY` AND `OPSLANE_ENDPOINT` are both set. A key not matching `/^opslane_sk_/` is refused with a warning (a pk in CI would 403 anyway; fail fast and clearly). Build never fails because of upload problems.

- [ ] **Step 1: Write failing uploader tests**

`upload.test.ts` with an in-process `node:http` server:
```ts
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { uploadSourceMaps } from '../upload.js';

function testServer(handler: (url: string, body: string, respond: (code: number) => void) => void) {
  // start server on port 0, collect body, call handler; return { endpoint, close, seen: {url, headers}[] }
}

describe('uploadSourceMaps', () => {
  it('PUTs each map to /api/v1/sourcemaps/{debugId} with the key header', async () => {
    // assert method PUT, path suffix, X-API-Key header, content-type application/json,
    // body equals mapSource; 201 -> uploaded: 1, failed: []
  });
  it('treats 200 as success (idempotent retry)', async () => {});
  it('collects failures without throwing', async () => {
    // server returns 403 -> failed[0].reason includes '403'; uploaded counts the rest
  });
  it('survives a network error', async () => {
    // endpoint pointing at a closed port -> failed entry, no throw (after one retry)
  });
  it('paces on 429 and retries the same file', async () => {
    // server returns 429 with Retry-After: 0 twice, then 201 -> uploaded: 1,
    // three requests observed for that debugId, no failure recorded
  });
  it('skips entries over the 32 MiB server cap with a named failure', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opslane/sdk test -- upload`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `upload.ts`**

```ts
export interface UploadEntry { debugId: string; mapSource: string; fileName: string }
export interface UploadOutcome { uploaded: number; failed: { fileName: string; reason: string }[] }

const CONCURRENCY = 4;

export async function uploadSourceMaps(
  entries: UploadEntry[],
  opts: { endpoint: string; key: string; fetchImpl?: typeof fetch },
): Promise<UploadOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.endpoint.replace(/\/+$/, '');
  const outcome: UploadOutcome = { uploaded: 0, failed: [] };
  const queue = [...entries];

  const MAX_MAP_BYTES = 32 * 1024 * 1024;
  const RETRY_AFTER_DEFAULT_S = 30;
  const RETRY_AFTER_CAP_S = 120;
  const MAX_ATTEMPTS = 8; // enough for a 248-map build behind a 60/min limiter

  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

  async function putOnce(entry: UploadEntry): Promise<{ ok: boolean; retryAfterS?: number; reason?: string }> {
    try {
      const response = await fetchImpl(`${base}/api/v1/sourcemaps/${entry.debugId}`, {
        method: 'PUT',
        headers: { 'X-API-Key': opts.key, 'Content-Type': 'application/json' },
        body: entry.mapSource,
      });
      if (response.status === 200 || response.status === 201) return { ok: true };
      if (response.status === 429) {
        const parsed = Number(response.headers.get('Retry-After'));
        // parsed >= 0: a 0 means retry immediately (also lets tests avoid
        // real 30 s sleeps); absent/garbage falls back to the default.
        const retryAfterS = Math.min(
          Number.isFinite(parsed) && parsed >= 0 ? parsed : RETRY_AFTER_DEFAULT_S,
          RETRY_AFTER_CAP_S,
        );
        return { ok: false, retryAfterS };
      }
      return { ok: false, reason: `HTTP ${response.status}` };
    } catch (error: unknown) {
      // One transparent retry on network error, then report.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function worker(): Promise<void> {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      // Server cap applies to FINAL stamped wire bytes; skip early with a name.
      if (new TextEncoder().encode(entry.mapSource).byteLength > MAX_MAP_BYTES) {
        outcome.failed.push({ fileName: entry.fileName, reason: 'over 32 MiB server limit' });
        continue;
      }
      let lastReason = 'unknown';
      let done = false;
      let networkRetried = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt += 1) {
        const result = await putOnce(entry);
        if (result.ok) { outcome.uploaded += 1; done = true; break; }
        if (result.retryAfterS !== undefined) {
          // Rate limited: pace to the server's window and try again.
          lastReason = 'HTTP 429';
          await sleep(result.retryAfterS * 1000);
          continue;
        }
        lastReason = result.reason ?? 'unknown';
        if (!lastReason.startsWith('HTTP') && !networkRetried) {
          networkRetried = true;
          attempt -= 1; // single free retry for a transient network error
          continue;
        }
        break; // non-429 HTTP error or repeated network failure: report it
      }
      if (!done) outcome.failed.push({ fileName: entry.fileName, reason: lastReason });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return outcome;
}
```

- [ ] **Step 4: Wire into the plugin**

In `index.ts`:
1. Alongside `stampedIds`, add `const uploadPayloads = new Map<string, UploadEntry>();` (keyed by map fileName). Clear it in `buildStart`.
2. Record/overwrite the payload at every point a final map is settled — there are THREE, and they do not share a `stamped` variable:
   - Chunk path (after `mapAsset.source = stamped.mapSource`):
```ts
          uploadPayloads.set(mapKey, {
            debugId: stamped.debugId, mapSource: stamped.mapSource, fileName: mapKey,
          });
```
   - `restampEmittedAsset` rebuild path (also has a `stamped` object): same line with that path's map key variable.
   - `restampEmittedAsset` "already consistent" path (`index.ts:313-323`): no `stamped` exists. Place this INSIDE the try block, next to the existing `settle(debugId)` call (where `debugId` is in scope), using that path's in-scope map key variable (`mapKey`) and decoding the asset bytes (`mapAsset.source` may be `Uint8Array`):
```ts
          uploadPayloads.set(mapKey, {
            debugId,
            mapSource: typeof mapAsset.source === 'string'
              ? mapAsset.source
              : new TextDecoder().decode(mapAsset.source),
            fileName: mapKey,
          });
```
(Overwriting on restamp keeps the final bytes; payload capture is therefore correct by the end of the post-order `generateBundle` handler, after `discardRetiredMaps`.)
3. Warn once in `configResolved` when `maxMapBytes > DEFAULT_MAX_MAP_BYTES`:
```ts
      if (maxMapBytes > DEFAULT_MAX_MAP_BYTES) {
        warnOnce(
          'OPSLANE_VITE_MAP_OVER_SERVER_LIMIT',
          `maxMapBytes=${formatBytes(maxMapBytes)} exceeds the server upload limit of ${formatBytes(DEFAULT_MAX_MAP_BYTES)}; larger maps will stamp but fail to upload.`,
        );
      }
```
4. Make `closeBundle` async and upload before the summary lines:
```ts
    async closeBundle() {
      reportRestoredMaps();

      // process.env (CI) wins; fall back to the project's Vite env files
      // (.env.local etc.) captured in configResolved via
      // `fileEnv = loadEnv(config.mode, config.root, 'OPSLANE_')` — import
      // loadEnv from 'vite' and store fileEnv beside projectRoot. This lets a
      // key pasted into the gitignored .env.local drive local builds; non-
      // VITE_-prefixed vars never reach browser code.
      const key = process.env['OPSLANE_SOURCEMAP_KEY'] ?? fileEnv['OPSLANE_SOURCEMAP_KEY'];
      const endpoint = process.env['OPSLANE_ENDPOINT'] ?? fileEnv['OPSLANE_ENDPOINT'];
      if (key) {
        if (!endpoint) {
          warnOnce('OPSLANE_VITE_UPLOAD_NO_ENDPOINT',
            'OPSLANE_SOURCEMAP_KEY is set but OPSLANE_ENDPOINT is not; skipping source-map upload.');
        } else if (!key.startsWith('opslane_sk_')) {
          warnOnce('OPSLANE_VITE_UPLOAD_WRONG_KEY',
            'OPSLANE_SOURCEMAP_KEY is not an opslane_sk_ secret key; skipping source-map upload.');
        } else {
          // Disk-read + re-verify whenever maps SHIP (covers both the
          // sourcemaps:'keep' option AND a project's explicitly configured
          // maps, which also stay on disk — mapsWillShip() is the existing
          // authority on that). In-memory bytes only when maps never reach
          // disk.
          const entries = mapsWillShip()
            ? await collectVerifiedFromDisk()   // re-verifies at upload time
            : [...uploadPayloads.values()];
          const outcome = await uploadSourceMaps(entries, { endpoint, key });
          if (outcome.failed.length > 0 && logLevel !== 'silent') {
            console.error(
              `[opslane] OPSLANE_VITE_UPLOAD_FAILED: ${outcome.failed.length} source map(s) failed to upload; stack traces for these chunks will stay minified.` +
              (keepSourceMaps ? ' The listed .map files are still in your build output — do not deploy them.' : '') +
              `\n  ${outcome.failed.map((f) => `${f.fileName}: ${f.reason}`).join('\n  ')}`,
            );
          }
          if (logLevel !== 'silent') {
            console.warn(`[opslane] Uploaded ${outcome.uploaded}/${entries.length} source maps.`);
          }
        }
      }
      // ...existing summary lines unchanged...
    },
```
with the keep-mode collector (uploads only disk-verified bytes so an upload can never carry a debug ID the shipped JS no longer matches):
```ts
  const collectVerifiedFromDisk = async (): Promise<UploadEntry[]> => {
    const readFileSync = nodeFs()?.readFileSync;
    if (!writtenDir || !readFileSync) return [];
    const entries: UploadEntry[] = [];
    for (const [fileName, debugId] of stampedIds) {
      if (stats.verifyFailed.some((failure) => failure.startsWith(fileName.replace(/\.map$/, '')))) continue;
      try {
        const bytes = readFileSync(`${writtenDir}/${fileName}`);
        // Re-verify AT UPLOAD TIME: another plugin's writeBundle may have
        // mutated the file after our writeBundle verification pass. A
        // mismatched map must never be uploaded under this debug ID.
        const { debugId: currentId } = await computeDebugId(bytes);
        if (currentId !== debugId) {
          warnOnce('OPSLANE_VITE_UPLOAD_STALE_MAP',
            `${fileName} changed on disk after verification; skipping its upload.`);
          continue;
        }
        entries.push({
          debugId,
          mapSource: new TextDecoder().decode(bytes),
          fileName,
        });
      } catch {
        // Verified earlier but gone now: another plugin removed it; skip.
      }
    }
    return entries;
  };
```
5. Add a plugin-level test (extend the existing plugin test harness if present; otherwise a new test that runs `vite.build()` on a tiny in-memory fixture): with `OPSLANE_SOURCEMAP_KEY`/`OPSLANE_ENDPOINT` pointed at the Step-1 test server, a build uploads exactly the stamped maps; with the env absent, no requests are made; a 500-ing server does NOT fail the build.

- [ ] **Step 5: Version bump**

The repo already has pending changesets for `@opslane/sdk` — `.changeset/scoped-project-keys.md` (major) and `.changeset/debug-id-vite-plugin.md` — so versioning must go THROUGH the Changesets workflow, not around it. A direct manifest edit to 3.0.0 that leaves those pending would make the next `changeset version` run produce 4.0.0. Steps:

1. Add a `"./build/debug-id"` entry to the package `exports` map (pointing at the built `dist` path, mirroring the existing subpath entries) — Task 8's worker imports `computeDebugId` through it.
2. Add the corresponding entry to the SDK's Vite library build inputs (`packages/sdk/vite.config.ts` entry list) — the exports entry alone does not make `dist/build/debug-id.js` exist.
3. Run the package's own packaging check (`pnpm --filter @opslane/sdk run check:package`, or whatever script name the package defines) to prove the new subpath resolves from the built output.
4. Add ONE new changeset for this work (`.changeset/sourcemap-upload-v3.md`, `'@opslane/sdk': major`). Multiple pending majors do not stack: one `changeset version` run consumes all pending changesets and applies the highest bump once, 2.0.1 → 3.0.0. Verify with `pnpm changeset status` and, on a scratch branch, a dry `pnpm changeset version` confirming the manifest lands on 3.0.0 — then discard the scratch branch; the real version bump happens in the repo's Version Packages release PR, per existing process.
5. Note the consequence honestly: the S6a codemod's installed-version gate un-inerts only when 3.0.0 is RELEASED, not when this task merges. The E2E is unaffected (it uses the workspace source/dist, not the published version).
6. The commit includes `packages/sdk/package.json` (exports only, version untouched), `packages/sdk/vite.config.ts`, `pnpm-lock.yaml`, and the new changeset.

Changeset text:
```md
The Vite plugin uploads stamped source maps to Opslane when OPSLANE_SOURCEMAP_KEY and OPSLANE_ENDPOINT are set. Maps without sourcesContent are now accepted by debug-ID fingerprinting.
```
(3.0.0 is required: the S6a codemod gates on `OPSLANE_VITE_PLUGIN_MIN_VERSION = '3.0.0'` in `cli/src/codemods/vite-contract.ts:48`.)

- [ ] **Step 6: Run, then commit**

Run: `pnpm --filter @opslane/sdk build && pnpm --filter @opslane/sdk test`
Expected: PASS.
```bash
git add packages/sdk/vite-plugin/ packages/sdk/package.json packages/sdk/vite.config.ts pnpm-lock.yaml .changeset/
git commit -m "feat(sdk): Vite plugin uploads stamped source maps with the sk"
```

---

### Task 8: Worker resolves by debug ID; migration 031

**Files:**
- Create: `packages/worker/src/resolve-stack.ts`
- Create: `packages/ingestion/db/migrations/031_resolution_status.sql`
- Modify: `packages/worker/src/source-map.ts` (add `isParseableMap`)
- Modify: `packages/worker/src/db.ts` (event query + new queries; delete `getSourceMaps`/`SourceMapEntry`)
- Modify: `packages/worker/src/index.ts` (both resolution blocks, ~lines 362-386 and ~693-763)
- Modify: `packages/worker/src/__tests__/db-queries.test.ts` and `packages/worker/src/__tests__/index.test.ts` — they import and exercise `getSourceMaps` (db-queries.test.ts:13,377; index.test.ts:262) and their typed event fixtures lack `debug_meta` (index.test.ts:133). Delete the `getSourceMaps` tests, add tests for `getSourceMapRows`, and add `debug_meta: null` (or a populated value) to every event fixture so the package still compiles.
- Modify: `packages/worker/package.json` (add the `@opslane/sdk` workspace dependency for `computeDebugId` — internal reuse, not a new third-party dependency; MIT into AGPL is fine)
- Modify: `packages/ingestion/db/queries.go` (delete the caller-less `InsertSourceMap`, ~line 1447)
- Test: `packages/worker/src/__tests__/resolve-stack.test.ts` (follow the package's existing test placement)

**Interfaces:**
- Consumes: `parseStackFrames`/`resolveFrame` from `./source-map.js` (unchanged); `sourcemap_files` rows; `fetchObject(objectKey, minioConfig)` from `./minio-client.js`; `error_events.debug_meta` (JSONB, always `{"images":[...]}`, images are `{type:'sourcemap', code_file, debug_id}`).
- Produces:
```ts
export type ResolutionStatus =
  | 'resolved' | 'partial' | 'no_debug_ids'
  | 'map_not_found' | 'invalid_map' | 'resolution_failed';
export interface StackResolution { status: ResolutionStatus; frames: ResolvedFrame[] | null; envelope: ResolvedStackEnvelope | null }
// resolve-stack builds the envelope from each matched frame (generated pos +
// debug_id) plus resolveFrame's original pos; ResolvedStackEnvelope is
// defined in db.ts (above) and imported here.
export interface ResolveDeps {
  getMapRows(projectId: string, debugIds: string[]): Promise<{ debug_id: string; object_key: string; content_sha256: string }[]>;
  fetchMap(objectKey: string): Promise<string | null>;
}
export async function resolveEventStack(
  input: { stackTraceRaw: string; debugMeta: string | null; projectId: string },
  deps: ResolveDeps,
): Promise<StackResolution>
```
Join rule (frozen by the spec): a frame resolves against the image whose `code_file` EXACTLY equals the frame's file URL. No basename fallback.
Status rules: no valid images → `no_debug_ids`; images but zero matched frames → `no_debug_ids`; matched frames but zero map rows found → `map_not_found`; every fetched map unparseable → `invalid_map`; all matched frames resolved → `resolved`; some resolved → `partial`; matched frames + maps but nothing resolved, or an unexpected throw → `resolution_failed`.

- [ ] **Step 1: Write failing tests, one per status**

```ts
import { describe, expect, it } from 'vitest';
import { resolveEventStack } from '../resolve-stack.js';

const STACK = `Error: boom
    at fn (http://app.example/assets/index-abc.js:1:100)
    at http://app.example/assets/vendor-def.js:1:50`;

const META = JSON.stringify({ images: [
  { type: 'sourcemap', code_file: 'http://app.example/assets/index-abc.js', debug_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
]});

// A real minimal map that resolves 1:100 — generate once with magic numbers:
const MAP = JSON.stringify({ version: 3, sources: ['src/App.vue'], sourcesContent: ['line1\nline2\nline3'], names: [], mappings: /* a mapping covering line 1 col 100 — use @jridgewell/gen-mapping in a beforeAll to build it */ '' });

it('no_debug_ids when images are empty', async () => {
  const r = await resolveEventStack(
    { stackTraceRaw: STACK, debugMeta: '{"images":[]}', projectId: 'p' },
    { getMapRows: async () => [], fetchMap: async () => '' });
  expect(r.status).toBe('no_debug_ids');
});
it('no_debug_ids when no frame file matches any code_file exactly', ...);
it('map_not_found when matched debug IDs have no rows', ...);
it('invalid_map when every fetched map fails to parse', ...);
it('resolved when the single matched frame resolves', ...); // asserts frames[0].originalFile === 'src/App.vue'
it('partial when one matched frame resolves and another matched frame has no row', ...);
it('resolution_failed when fetchMap throws', ...);
it('never matches by basename', async () => {
  // frame file http://other.example/assets/index-abc.js vs code_file above -> no match
});
it('converts 1-based browser columns to 0-based before mapping', async () => {
  // fixture map has a segment starting at generated column N (0-based);
  // a frame with column N+1 (1-based) must resolve to that segment's original position
});
```
(For the map fixture: commit a real map emitted once by an actual `vite build` of a two-line module — store it at `packages/worker/src/__tests__/fixtures/resolved.js.map` with a comment recording the source position it maps. Do NOT add `@jridgewell/gen-mapping`: it is not in the worker's dependency tree and this plan adds no dependencies.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @opslane/worker test -- resolve-stack`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `resolve-stack.ts`**

First add a small probe to `source-map.ts` so `invalid_map` means what it says (a map `TraceMap` cannot construct), not merely "valid JSON":
```ts
/** True when the content constructs a TraceMap — i.e. it is a usable map. */
export function isParseableMap(sourceMapContent: string): boolean {
  try {
    new TraceMap(JSON.parse(sourceMapContent) as ConstructorParameters<typeof TraceMap>[0]);
    return true;
  } catch {
    return false;
  }
}
```

```ts
import { computeDebugId } from '@opslane/sdk/build/debug-id';
import { isParseableMap, parseStackFrames, resolveFrame, type ResolvedFrame, type StackFrame } from './source-map.js';
import type { ResolvedStackEnvelope } from './db.js';

const MAX_FRAMES = 10;

interface DebugImage { type: string; code_file: string; debug_id: string }

function parseImages(debugMeta: string | null): DebugImage[] {
  if (!debugMeta) return [];
  try {
    const parsed = JSON.parse(debugMeta) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const images = (parsed as { images?: unknown }).images;
    if (!Array.isArray(images)) return [];
    return images.filter((image): image is DebugImage =>
      typeof image === 'object' && image !== null
      && (image as DebugImage).type === 'sourcemap'
      && typeof (image as DebugImage).code_file === 'string'
      && typeof (image as DebugImage).debug_id === 'string');
  } catch {
    return [];
  }
}

export async function resolveEventStack(
  input: { stackTraceRaw: string; debugMeta: string | null; projectId: string },
  deps: ResolveDeps,
): Promise<StackResolution> {
  try {
    const images = parseImages(input.debugMeta);
    if (images.length === 0) return { status: 'no_debug_ids', frames: null, envelope: null };

    const byCodeFile = new Map(images.map((image) => [image.code_file, image.debug_id]));
    const matched = parseStackFrames(input.stackTraceRaw)
      .map((frame) => ({ frame, debugId: byCodeFile.get(frame.file) }))
      .filter((entry): entry is { frame: StackFrame; debugId: string } => entry.debugId !== undefined)
      .slice(0, MAX_FRAMES);
    if (matched.length === 0) return { status: 'no_debug_ids', frames: null, envelope: null };

    const rows = await deps.getMapRows(input.projectId, [...new Set(matched.map((m) => m.debugId))]);
    if (rows.length === 0) return { status: 'map_not_found', frames: null, envelope: null };
    const rowByDebugId = new Map(rows.map((row) => [row.debug_id, row]));

    const mapCache = new Map<string, string | null>();
    let sawValidMap = false;
    let fetchedAny = false;
    const resolved: ResolvedFrame[] = [];
    let unresolved = 0;
    const envFrames: ResolvedStackEnvelope['frames'] = [];
    for (const { frame, debugId } of matched) {
      const row = rowByDebugId.get(debugId);
      if (!row) { unresolved += 1; continue; }
      let mapContent = mapCache.get(row.object_key);
      if (mapContent === undefined) {
        mapContent = await deps.fetchMap(row.object_key);
        if (mapContent !== null) {
          fetchedAny = true;
          // Fetch-time integrity (spec rev 5): a digest mismatch means the
          // object does not match what the upload accepted — unusable.
          // computeDebugId THROWS on malformed content; that throw must mark
          // THIS map invalid, not abort the whole resolver into
          // resolution_failed (which would make invalid_map unreachable).
          try {
            const { contentSha256 } = await computeDebugId(
              new TextEncoder().encode(mapContent));
            if (contentSha256 !== row.content_sha256) mapContent = null;
          } catch {
            mapContent = null; // fetched but malformed → counts toward invalid_map
          }
        }
        mapCache.set(row.object_key, mapContent);
      }
      if (mapContent === null) { unresolved += 1; continue; }
      // Browser stack columns are 1-based; trace-mapping expects 0-based.
      // The old dead code passed them through unadjusted (off-by-one).
      const result = resolveFrame(
        { ...frame, column: Math.max(0, frame.column - 1) }, mapContent);
      if (result) {
        sawValidMap = true;
        resolved.push(result);
        envFrames.push({
          original_file: result.originalFile,
          original_line: result.originalLine,
          original_column: result.originalColumn,
          source_snippet: result.sourceSnippet,
          generated_file: frame.file,
          generated_line: frame.line,
          generated_column: frame.column,
          debug_id: debugId,
        });
      } else {
        // Distinguish an unusable map from an unmapped position.
        if (isParseableMap(mapContent)) sawValidMap = true;
        unresolved += 1;
      }
    }

    const envelope: ResolvedStackEnvelope | null =
      envFrames.length > 0 ? { version: 1, frames: envFrames } : null;
    if (resolved.length === matched.length) return { status: 'resolved', frames: resolved, envelope };
    if (resolved.length > 0) return { status: 'partial', frames: resolved, envelope };
    // invalid_map ONLY when at least one map was actually fetched and every
    // fetched map failed the parse/digest probe. Missing storage config /
    // fetch nulls are resolution_failed — never invalid_map.
    if (fetchedAny && !sawValidMap) return { status: 'invalid_map', frames: null, envelope: null };
    return { status: 'resolution_failed', frames: null, envelope: null };
  } catch {
    return { status: 'resolution_failed', frames: null, envelope: null };
  }
}
```

- [ ] **Step 4: Migration 031**

`packages/ingestion/db/migrations/031_resolution_status.sql`:
```sql
-- Source-map resolution outcome, written by the worker at investigation time.
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS resolution_status TEXT
  CHECK (resolution_status IN
    ('resolved','partial','no_debug_ids','map_not_found','invalid_map','resolution_failed'));

-- NOTE: the legacy release-keyed source_maps table is deliberately NOT
-- dropped here. Dropping it in the same release as the worker change would
-- break an old worker running against a migrated database (migrations apply
-- before service restarts). It is dead code with no writer; a follow-up
-- migration in the NEXT release drops it once no deployed worker references
-- it (expand/contract, per the repo's N-1 compatibility practice).
```
Verify idempotency with the Task 1 disposable-DB procedure. In the same commit, delete the caller-less `InsertSourceMap` function from `packages/ingestion/db/queries.go` (~line 1447) — `go build ./...` still passing proves it had no callers. (Deleting Go code is safe while the table remains; the reverse is not.)

- [ ] **Step 5: Wire the worker**

`db.ts`:
- `getErrorEvent` select list: add `debug_meta::text AS debug_meta`; add `debug_meta: string | null;` to `ErrorEventData`.
- Delete `getSourceMaps` and `SourceMapEntry`. Add:
```ts
export async function getSourceMapRows(
  projectId: string, debugIds: string[],
): Promise<{ debug_id: string; object_key: string; content_sha256: string }[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ debug_id: string; object_key: string; content_sha256: string }>(
    `SELECT debug_id, object_key, content_sha256 FROM sourcemap_files
     WHERE project_id = $1 AND debug_id = ANY($2)`,
    [projectId, debugIds],
  );
  return rows;
}

export async function setEventResolution(
  eventId: string, projectId: string,
  status: string, envelope: ResolvedStackEnvelope | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE error_events SET resolution_status = $3, stack_trace_resolved = $4
     WHERE id = $1 AND project_id = $2`,
    [eventId, projectId, status, envelope === null ? null : JSON.stringify(envelope)],
  );
}

// The pinned v1 shape for stack_trace_resolved (spec rev 5): snake_case,
// generated position and debug ID included so frames are auditable.
export interface ResolvedStackEnvelope {
  version: 1;
  frames: {
    original_file: string; original_line: number; original_column: number;
    source_snippet: string | null;
    generated_file: string; generated_line: number; generated_column: number;
    debug_id: string;
  }[];
}
```
`index.ts`, BOTH call sites (investigate ~362-386, fix ~693-763): delete the `event?.release ? db.getSourceMaps(...)` fetch and the basename-matching loop. In the INVESTIGATE path, move the replacement block **above the ANTHROPIC_API_KEY check (~line 307) and above the repo clone** — resolution depends only on Postgres and MinIO, and relocating it means a keyless or clone-failing worker still persists the resolution outcome (the E2E relies on this: no LLM key needed to assert `resolution_status`). Replace with:
```ts
    let resolvedStack: ResolvedFrame[] | null = null;
    if (platform === 'javascript' && event) {
      const minioConfig = getMinIOConfig();
      const resolution = await resolveEventStack(
        { stackTraceRaw: event.stack_trace_raw, debugMeta: event.debug_meta, projectId: job.projectId },
        {
          getMapRows: db.getSourceMapRows,
          fetchMap: async (objectKey) => {
            if (!minioConfig) return null as unknown as string; // typed as string; see note
            return (await fetchObject(objectKey, minioConfig)).toString('utf-8');
          },
        },
      );
      resolvedStack = resolution.frames;
      await db.setEventResolution(event.id, job.projectId, resolution.status, resolution.envelope);
    }
```
(Clean the `minioConfig` null case properly: make `ResolveDeps.fetchMap` return `Promise<string | null>` and treat `null` as unresolved — adjust `resolve-stack.ts` accordingly rather than casting.) The `resolvedStackTrace: resolvedStack ?? event?.stack_trace_resolved ?? null` lines downstream stay as they are.

- [ ] **Step 6: Run everything, then commit**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test && (cd packages/ingestion && go test ./...)`
Expected: PASS (worker compiles with `getSourceMaps` gone; grep confirms no `release`-gated resolution remains: `grep -rn "getSourceMaps\|event?.release" packages/worker/src` → no hits in resolution paths).
```bash
git add packages/worker/src/ packages/worker/package.json pnpm-lock.yaml packages/ingestion/db/migrations/031_resolution_status.sql packages/ingestion/db/queries.go
git commit -m "feat(worker): resolve stacks by debug ID and persist resolution_status"
```

---### Task 9: Build-mode E2E harness and the acceptance test

**Files:**
- Create: `test-e2e/build-helpers.ts`
- Create: `test-e2e/sourcemap-resolution.test.ts`
- Modify: `test-fixtures/vue-app/src/main.ts` (env-controlled release)
- Modify: `scripts/seed-e2e.sql` (seed sks and a second project)

**Interfaces:**
- Consumes: everything above, running against the local compose stack the existing `test-e2e` suite targets (same env/config as `error-to-pr.test.ts` — reuse its DB client and polling helpers, and `browser-smoke.test.ts`'s browser launch).
- Produces: `startBuiltFixture(opts): Promise<{ url: string; outDir: string; close(): Promise<void> }>`.

- [ ] **Step 1: Make the fixture's release env-controlled**

In `test-fixtures/vue-app/src/main.ts` replace the `release:` line:
```ts
const release = import.meta.env['VITE_OPSLANE_RELEASE'] ?? 'e2e-fixture-v1';

init({
  endpoint: import.meta.env['VITE_OPSLANE_ENDPOINT'] ?? 'http://localhost:8082',
  apiKey: import.meta.env['VITE_OPSLANE_API_KEY']
    ?? 'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
  ...(release ? { release } : {}),
  environment: import.meta.env['VITE_OPSLANE_ENVIRONMENT'] ?? 'development',
  reporting: { enabled: import.meta.env['VITE_OPSLANE_REPORTING'] !== 'false' },
  replay: { enabled: true },
});
```
(`VITE_OPSLANE_RELEASE=''` at build time now omits release entirely; default behavior unchanged. The dev harness regex-replaces the whole `init({...})` block, so it is unaffected.)
Run the existing dev-mode smoke to prove no regression: `pnpm test:e2e -- browser-smoke` (or this repo's equivalent script — check `package.json` scripts).

- [ ] **Step 2: Seed sks and a second project**

Append to `scripts/seed-e2e.sql` (pattern-match the existing seeded pk; the file documents the raw key in a comment):
```sql
-- Secret source-map keys for E2E. Raw values (never stored, listed here for tests):
--   project 1: opslane_sk_nbxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA
--   project 2: opslane_sk_ncxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETBBBBBBBBBBBBBBBBBBBBBBBBB
-- secret_hash literals are sha256 of the secret component; regenerate with:
--   printf %s 'E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA' | sha256sum
INSERT INTO project_api_keys (key_id, project_id, scope, token_prefix, secret_hash, label)
SELECT 'nbxw6ytboi3damrrgi3tknzxgq', p.id, 'sourcemaps', 'opslane_sk',
       '<paste the sha256sum hex output here>',
       'e2e sourcemaps'
FROM projects p WHERE p.name = '<the existing seeded project name>'
ON CONFLICT (key_id) DO NOTHING;
-- Repeat: second project (INSERT the project + its production environment the
-- way the first is seeded in this file, then its pk and sk).
```
Constraints to respect: `key_id ~ '^[a-z2-7]{26}$'` (the ids above are 26 chars of base32 alphabet — verify with `echo -n <id> | wc -c`), secret is 43 base64url chars. Inline literal hashes rather than `pgcrypto digest()` so the seed needs no extension privileges. `ON CONFLICT (key_id) DO NOTHING` keeps the seed idempotent.

- [ ] **Step 3: Write the build harness**

`test-e2e/build-helpers.ts`:
```ts
/**
 * Build-mode harness: `vite build` + `vite preview` for a fixture, with SDK
 * aliased to source and config injected via VITE_* env at build time. The
 * dev-server harness (browser-helpers.ts) cannot exercise the plugin: it is
 * apply:'build'.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SDK_SRC = resolve(__dirname, '../packages/sdk/src');

export async function startBuiltFixture(opts: {
  fixtureDir: string;
  apiKey: string;
  ingestionUrl: string;
  sourcemapKey?: string;
  release?: string; // undefined -> VITE_OPSLANE_RELEASE='' -> omitted
}): Promise<{ url: string; outDir: string; close(): Promise<void> }> {
  const { build, preview } = await import('vite');
  const outDir = mkdtempSync(join(tmpdir(), 'opslane-built-fixture-'));
  // Env hygiene: EVERY relevant variable is saved and then explicitly set or
  // DELETED — never left ambient. Without this, a negative-path build (no
  // sourcemapKey passed) would still upload if the parent process happens to
  // carry OPSLANE_SOURCEMAP_KEY.
  const MANAGED = [
    'VITE_OPSLANE_ENDPOINT', 'VITE_OPSLANE_API_KEY', 'VITE_OPSLANE_RELEASE',
    'OPSLANE_ENDPOINT', 'OPSLANE_SOURCEMAP_KEY',
  ] as const;
  const saved = new Map(MANAGED.map((k) => [k, process.env[k]]));
  const env: Record<string, string | undefined> = {
    VITE_OPSLANE_ENDPOINT: opts.ingestionUrl,
    VITE_OPSLANE_API_KEY: opts.apiKey,
    VITE_OPSLANE_RELEASE: opts.release ?? '',
    OPSLANE_ENDPOINT: opts.ingestionUrl,
    OPSLANE_SOURCEMAP_KEY: opts.sourcemapKey, // undefined => cleared below
  };
  for (const k of MANAGED) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  // process.env is process-global: builds through this helper must not run
  // concurrently. The E2E file sets vitest to run these tests sequentially
  // (describe.sequential / fileParallelism: false for this file), and each
  // build gets its own cacheDir (same reason as the dev harness).
  const cacheDir = mkdtempSync(join(tmpdir(), 'opslane-built-cache-'));
  try {
    await build({
      root: opts.fixtureDir,
      logLevel: 'error',
      cacheDir,
      resolve: {
        alias: [
          { find: '@opslane/sdk/react', replacement: resolve(SDK_SRC, 'react.tsx') },
          { find: '@opslane/sdk/_replay', replacement: resolve(SDK_SRC, 'replay.ts') },
          { find: '@opslane/sdk', replacement: resolve(SDK_SRC, 'index.ts') },
        ],
      },
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  }
  const server = await preview({
    root: opts.fixtureDir,
    build: { outDir },
    preview: { port: 0 },
  });
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    outDir,
    close: async () => {
      await new Promise<void>((done) => server.httpServer.close(() => done()));
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
```
(The fixture's own `vite.config.ts` is picked up from `root`, so the real plugin — including its worker-build registration — runs.)

- [ ] **Step 4: Write the acceptance test**

`test-e2e/sourcemap-resolution.test.ts`, using the DB client + polling helpers from `error-to-pr.test.ts` and the browser launch from `browser-smoke.test.ts`:
```ts
// Constants: SK_A / SK_B / PK_A / PK_B / PROJECT_A / PROJECT_B from
// seed-e2e.sql comments. All polls are scoped to events CREATED BY THIS RUN:
// record `const startedAt = new Date()` before acting and filter
// `created_at > startedAt` (the seed uses fixed project IDs and reruns leave
// old rows — an unscoped poll can pass on stale data).
//
// beforeAll: scoped cleanup so RERUNS are repeatable — delete this suite's
// own residue only (test-owned seed projects, disposable E2E database):
//   DELETE FROM sourcemap_files WHERE project_id IN (PROJECT_A, PROJECT_B);
// Without this, the "rows created by this build" and B's initial
// map_not_found assertions fail on the second run.

describe('source maps resolve end to end', () => {
  it('uploads maps at build time and the investigated event resolves', async () => {
    const startedAt = new Date();
    const preRows = await db.query(
      `SELECT count(*)::int AS n FROM sourcemap_files WHERE project_id = $1`, [PROJECT_A]);
    const fixture = await startBuiltFixture({
      fixtureDir: resolve(__dirname, '../test-fixtures/vue-app'),
      apiKey: PK_A, ingestionUrl: INGESTION_URL, sourcemapKey: SK_A,
      // release intentionally omitted
    });
    // (2) positive upload signal — rows added BY THIS BUILD — + clean output
    const rows = await db.query(
      `SELECT debug_id FROM sourcemap_files WHERE project_id = $1 AND created_at > $2`,
      [PROJECT_A, startedAt]);
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(preRows.rows[0].n + rows.rowCount).toBeGreaterThanOrEqual(rows.rowCount);
    const files = readdirSync(fixture.outDir, { recursive: true }) as string[];
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const js of files.filter((f) => /\.(js|mjs)$/.test(f))) {
      expect(readFileSync(join(fixture.outDir, js), 'utf8')).not.toContain('sourceMappingURL=');
    }
    // (3) throw one error in the built app: open fixture.url in the browser
    //     harness, click the fixture's throw-error control (same interaction
    //     browser-smoke uses), wait for the event POST to succeed.
    // (4) poll for THE event this run created. No ANTHROPIC_API_KEY needed —
    //     resolution runs before the worker's LLM-key check (Task 8); the job
    //     may then terminalize missing_llm_key, which is fine.
    const event = await pollFor(async () => {
      const r = await db.query(
        `SELECT resolution_status, stack_trace_resolved FROM error_events
         WHERE project_id = $1 AND created_at > $2 AND resolution_status IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`, [PROJECT_A, startedAt]);
      return r.rows[0];
    }, INVESTIGATION_TIMEOUT_MS);
    expect(event.resolution_status).toBe('resolved');
    // Pinned envelope assertions (spec: original file, line, and snippet):
    const envelope = event.stack_trace_resolved as {
      version: number;
      frames: { original_file: string; original_line: number; source_snippet: string | null }[];
    };
    expect(envelope.version).toBe(1);
    expect(envelope.frames.length).toBeGreaterThan(0);
    expect(envelope.frames[0].original_file).toMatch(/^src\//);
    expect(envelope.frames[0].original_line).toBeGreaterThan(0);
    expect(envelope.frames[0].source_snippet).toBeTruthy();
    await fixture.close();
  });

  it('enforces the key and privacy floor', async () => {
    // pk cannot upload:
    const denied = await fetch(`${INGESTION_URL}/api/v1/sourcemaps/${SOME_DEBUG_ID}`, {
      method: 'PUT', headers: { 'X-API-Key': PK_A }, body: VALID_MAP });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('insufficient_scope');
    // sk cannot send events:
    const eventDenied = await fetch(`${INGESTION_URL}/api/v1/events`, {
      method: 'POST', headers: { 'X-API-Key': SK_A, 'Content-Type': 'application/json' },
      body: '{}' });
    expect(eventDenied.status).toBe(403);
    // no read path:
    const r = await fetch(`${INGESTION_URL}/api/v1/sourcemaps/${SOME_DEBUG_ID}`, { method: 'GET' });
    expect([404, 405]).toContain(r.status);
  });

  it('isolates projects: same debug_meta, different project, discriminating outcome', async () => {
    // DISCRIMINATING isolation: A HOLDS the map, B carries the same
    // debug_meta but has NOT uploaded -> B must get map_not_found (proving B
    // cannot see A's object); after B uploads, B's next event resolves.
    const startedAt = new Date();
    // KNOWN_MAP: minimal valid map built inline; KNOWN_DEBUG_ID computed with
    // computeDebugId imported relatively (see note below).
    // 0. Upload KNOWN_MAP to project A first — the whole point:
    const seedA = await fetch(`${INGESTION_URL}/api/v1/sourcemaps/${KNOWN_DEBUG_ID}`, {
      method: 'PUT', headers: { 'X-API-Key': SK_A }, body: KNOWN_MAP });
    expect([200, 201]).toContain(seedA.status);
    // 1. Post a crafted event with B's pk carrying debug_meta for KNOWN_DEBUG_ID
    //    (wire contract: debug_meta.images = [{type:'sourcemap', code_file, debug_id}]
    //    and a stack whose frame file === code_file).
    await postEvent(PK_B, craftedEventWithDebugMeta(KNOWN_DEBUG_ID));
    const before = await pollFor(() => resolutionOf(PROJECT_B, startedAt), INVESTIGATION_TIMEOUT_MS);
    expect(before.resolution_status).toBe('map_not_found');
    // 2. Upload the map with B's sk, send the same event again -> resolves.
    const put = await fetch(`${INGESTION_URL}/api/v1/sourcemaps/${KNOWN_DEBUG_ID}`, {
      method: 'PUT', headers: { 'X-API-Key': SK_B }, body: KNOWN_MAP });
    expect([200, 201]).toContain(put.status);
    const secondStart = new Date();
    await postEvent(PK_B, craftedEventWithDebugMeta(KNOWN_DEBUG_ID));
    const after = await pollFor(() => resolutionOf(PROJECT_B, secondStart), INVESTIGATION_TIMEOUT_MS);
    expect(after.resolution_status).toBe('resolved');
    // At-rest check: B's row exists and its object_key is under B's prefix.
    const row = await db.query(
      `SELECT object_key FROM sourcemap_files WHERE project_id = $1 AND debug_id = $2`,
      [PROJECT_B, KNOWN_DEBUG_ID]);
    expect(row.rows[0].object_key).toContain(`sourcemaps/${PROJECT_B}/`);
  });
});
```
Caveat for the crafted-event helper: grouping may fold repeated identical
events into one group — vary the error message per post so each creates a
fresh investigated group, or trigger re-investigation per the repo's job
model (check how error-to-pr.test.ts forces distinct groups).
(`KNOWN_DEBUG_ID`/`KNOWN_MAP`: build the map inline in the test — a minimal valid map string — and compute its debug ID with `computeDebugId` imported RELATIVELY, the way the harness already reaches into SDK source: `import { computeDebugId } from '../packages/sdk/src/build/debug-id.js';`. `@opslane/sdk` is not a test-e2e dependency and exports no `./build` subpath, so a package import will not resolve.)

- [ ] **Step 5: Run the full live smoke**

Per root AGENTS.md: apply migrations, run `scripts/seed-e2e.sql`, rebuild ingestion and worker images, **run `pnpm --filter @opslane/sdk build`** (the fixture's `vite.config.ts` resolves `@opslane/sdk/vite-plugin` through the workspace link to `dist/vite-plugin.js` — a stale dist silently tests the old plugin; note this in a comment in `build-helpers.ts`), start compose, then run the new test file. Expected: both tests PASS; the first proves acceptance criteria 1-4 of the spec, the second criterion 5.

- [ ] **Step 6: Commit**

```bash
git add test-e2e/ test-fixtures/vue-app/src/main.ts scripts/seed-e2e.sql
git commit -m "test(e2e): build-mode fixture harness; source maps resolve end to end"
```

---

### Task 10: Contract amendment and docs

**Files:**
- Modify: `docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` (amendment header)
- Modify: `docs/reference/http-routes.md` — REQUIRED: `scripts/check-docs-drift.mjs` fails `pnpm test` for any registered-but-undocumented route, so the new PUT route must be added here. NOTE FOR TASK 4: because of this checker, Task 4 must ALSO add this one route line in its own commit or Task 4 is not independently landable; this task then only reconciles.
- Modify: `docs/guides/source-maps.md` — full de-legacy pass, not just the banner: the guide still documents the old POST/release-keyed workflow (lines ~54, ~250). Document env vars (`OPSLANE_SOURCEMAP_KEY` via process.env or `.env.local`/loadEnv), mint-key, exact-key SQL revocation, AND the manual purge command for deleted projects (`mc rm -r --force <bucket>/sourcemaps/<projectID>/`, guided by the `sourcemap_tombstones` row).
- Modify: `packages/sdk/README.md` (~line 67), `docs/install.md` (~line 37), `docs/reference/sdk-options.md` (~line 39) — each still advertises source-map upload as unavailable; update all three.
- Modify: `docs/plans/2026-08-03-v1-sourcemaps-simplification.md` (status: implemented)

**Interfaces:** none — documentation only, but required by the repo guardrail ("change contracts explicitly, never silently").

- [ ] **Step 1: Add the amendment section**

At the top of the S0 contract doc, immediately under the frozen banner:
```md
## Amendment — 2026-08-03 (v1 tracer bullet)

Implemented by docs/plans/2026-08-03-v1-sourcemaps-simplification.md. The
following sections are superseded for v1; everything not listed stays frozen.

| Section | Status |
| --- | --- |
| §3 key CRUD endpoints (3.4–3.7) | Superseded for v1: keys are minted by `cmd/mint-key`; revocation is the documented SQL statement. Key management returns with the onboarding track. |
| §3.2 lifecycle invariants | Unchanged in v1 (mint-key creates without revoking; revocation is a separate explicit SQL action). The onboarding track's flag-gated rotation will amend this later. |
| Onboarding "sk never touches disk" posture | Relaxed to "sk never enters a tracked file or the bundle": operator-managed gitignored `.env.local` is acceptable; the plugin reads it via `loadEnv`. |
| §5 "SDK release 2.1.0" | The debug_meta SDK release shipped as 2.x; the uploading plugin ships as 3.0.0. |
| §6 map-validity rules | `sourcesContent` is optional (stored as `has_sources_content`). Hash algorithm and golden vectors unchanged. |
| §6 100 MiB per-file limit | 32 MiB wire bytes. |
| §7 batch protocol | Superseded by single-map `PUT /api/v1/sourcemaps/{debugID}` (identity encoding only, as §7.2 already required). §7's cluster-wide byte budgets → one process-local 60/min per-project limiter (single-replica deployment). |
| §10 resolution persistence | `resolution_status` + `stack_trace_resolved` only; frame counters, `resolution_problem`, and consistency CHECKs dropped for v1. |
| §12 deletion loop | Tombstone trigger + documented manual purge command; automatic sweeper deferred. |
| §8 batch tables | Superseded by `sourcemap_files` + `sourcemap_tombstones` (migration 030). |
| §9 verify endpoint, §11 status endpoint | Dropped for v1. |
```

- [ ] **Step 2: Update the guides**

`docs/guides/source-maps.md`: replace the "Source-map upload is unavailable in this release" banner with the working flow (env vars `OPSLANE_SOURCEMAP_KEY` + `OPSLANE_ENDPOINT`, what the plugin uploads and when, custody behavior per `sourcemaps: 'remove'|'keep'`, the warning codes added in Task 7, minting via `go run ./cmd/mint-key` and revocation via the documented SQL). Update the capability table row for resolve-by-debug-ID from "follow-up slice" to shipped.

- [ ] **Step 3: Verify the full repository gate and commit**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
(cd packages/ingestion && go build ./... && go test ./...)
docker compose config --quiet
git add docs/
git commit -m "docs: amend S0 contract for the v1 single-map upload; update source-map guides"
```

- [ ] **Step 4: No issue cleanup**

Maintainer decision (2026-08-03): the old S-series issues are all being closed by the maintainer; this slice is standalone new work. Do not comment on, close, or re-label any existing GitHub issue.

---

## Self-Review Notes

- Spec coverage (rev 5): §1 manual mint → Task 5; §2 route → Tasks 1-4; §3 plugin (incl. loadEnv pickup) → Task 7; §4 worker → Task 8; §5 E2E → Task 9; contract amendment → Task 10. Deletion floor (tombstone) → Task 1. Legacy `source_maps` drop deferred to a follow-up release (expand/contract); Task 8 only stops the worker querying it. Task 6 intentionally removed (onboarding track).
- Type consistency: `debugid.Result.HasSourcesContent` (Task 2) → handler (Task 4); `UpsertSourceMapFile` signature identical in Tasks 3/4; `UploadEntry` identical in Task 7's two files; `ResolveDeps.fetchMap` returns `Promise<string | null>` after the Step-5 cleanup note in Task 8 — implementer must apply that to both the module and its tests.
- Known judgment calls the implementer may hit: exact helper names in `debug-id.ts` (Task 2 Step 5) and the handler test bootstrap (Task 4 Step 1) are follow-the-existing-pattern instructions, not inventions; the fixture's throw-error control name comes from `browser-smoke.test.ts`.
