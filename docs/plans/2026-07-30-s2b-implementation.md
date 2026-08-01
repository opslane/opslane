# S2b source-map upload and verify: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** One source map, uploaded by a write-only `opslane_sk_`, stored privately per project, and resolvable for one generated position by a signed-in user.

**Architecture:** Three secret-key routes (declare a batch, PUT each file, complete) plus one session-authenticated verify route, all in `packages/ingestion`. Fingerprinting reuses `packages/ingestion/debugid` from #224. Position lookup uses a new hand-written VLQ decoder, because the obvious Go library fabricates mappings. A map becomes readable at exactly one moment: the activation transaction at the end of `complete`.

**Tech Stack:** Go 1.25, chi v5, pgx v5, PostgreSQL 16, MinIO/S3, `github.com/gowebpki/jcs`.

**Design doc:** [`docs/design/2026-07-30-s2b-sourcemap-upload-verify-design.md`](../design/2026-07-30-s2b-sourcemap-upload-verify-design.md)
**Frozen contract:** [`docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md`](../design/2026-07-29-keys-sourcemaps-s0-contracts.md)

Everything marked **verified** below was executed against a throwaway `postgres:16` or read out of the vendored dependency. Everything else is instruction.

**Run every command from the repository root.** Commands that need to be
elsewhere are wrapped in a subshell, `(cd packages/ingestion && ...)`, so your
shell comes back to the root. That matters because the `git add` paths in every
commit step are root-relative. If you drop the parentheses, the next `git add
packages/...` fails with "did not match any files".

---

## Task 0: Get onto the right base

`packages/ingestion/debugid` lives on the #224 branch and **does not exist on `main`**. Task 2 modifies it, and Tasks 7 and 9 import it. If you skip this, Task 2 fails with "no such package" and you will not know why.

**Step 1: Confirm where you are**

```bash
cd <your worktree>
git branch --show-current
ls packages/ingestion/debugid/debugid.go 2>/dev/null && echo "debugid PRESENT" || echo "debugid MISSING"
```

**Step 2: If MISSING, rebase onto the #224 branch**

```bash
git fetch origin
git rebase origin/abhishekray07/s2a-carry-debug-ids-from-vite-builds-into-error
ls packages/ingestion/debugid/debugid.go && echo "debugid PRESENT"
```

**Step 3: Verify the four facts this plan depends on**

```bash
# 1. The base already contains S1, so project_api_keys exists. Expect: ok
git merge-base --is-ancestor 69a60c2 HEAD && echo "S1 present"
# 2. Result is still {DebugID, ContentSHA256}. Expect exactly two fields.
sed -n '/^type Result struct/,/^}/p' packages/ingestion/debugid/debugid.go
# 3. The unique constraint is still missing, so Task 1 is still needed. Expect: 0
grep -c "UNIQUE (id, project_id)" packages/ingestion/db/migrations/028_project_api_keys.sql
# 4. debugid_test.go is an internal test package. Expect: package debugid
head -1 packages/ingestion/debugid/debugid_test.go
```

If fact 2 has changed, stop and re-read Task 2 before writing anything: the branch is active.

The base carries two files numbered `028`. That is untidy and harmless. The runner sorts lexically and both apply. Do not renumber.

---

## Task 0.5: Test harness

Do **not** use port 5434. That database is shared across worktrees and these tests create and delete projects.

**The env-var trap, verified.** Three different readers want three different things:

| Reader | Reads | If unset |
|---|---|---|
| `db/testhelper_test.go:11`, `handler/auth_middleware_test.go:32` | `DATABASE_URL` | **falls back to the shared 5434 database** |
| `handler/session_integration_test.go:26` | `REPLAY_STORE_*`, falls back to `MINIO_*` | skips |
| `handler/error_event_test.go:80` | `MINIO_*` directly | skips |
| `minio/client_test.go:15` | `REPLAY_STORE_ENDPOINT` **only** | **skips silently** |
| `main.go:43` | `REPLAY_STORE_*` **only** | server starts with `MinIO == nil`, every source-map route returns `503` |

So you must export **both** naming families. Exporting only `MINIO_*` makes Task 4's test silently pass without running and makes Task 12's live run return `503` for every upload.

**The endpoint must be a URL.** `minio.New` does `url.Parse(endpoint)` and uses `u.Host` (`minio/client.go:29-35`). `localhost:9099` parses with scheme `localhost` and an empty host, so the client is built against `""`. Use `http://localhost:9099`.

```bash
docker run -d --name s2b-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=opslane \
  -e POSTGRES_DB=opslane -p 5499:5432 postgres:16
docker run -d --name s2b-minio -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin -p 9099:9000 minio/minio server /data

# Create the bucket. Nothing in Go calls MakeBucket; compose relies on a separate
# minio-setup service. Both mc commands MUST run in one container: `mc alias set`
# writes to that container's filesystem, which disappears when it exits.
until docker run --rm --network host --entrypoint sh minio/mc -c \
  'mc alias set s2b http://localhost:9099 minioadmin minioadmin' >/dev/null 2>&1; do sleep 1; done
docker run --rm --network host --entrypoint sh minio/mc -c \
  'mc alias set s2b http://localhost:9099 minioadmin minioadmin && mc mb -p s2b/opslane-test'

# Both mc commands verified working on Docker Desktop 24.0.2. If `--network host`
# does not reach the host on your Docker version, drop it and use
# http://host.docker.internal:9099 instead; also verified.

export DATABASE_URL="postgres://opslane:dev@localhost:5499/opslane?sslmode=disable"

# Canonical names: main.go and minio/client_test.go read only these.
export REPLAY_STORE_ENDPOINT="http://localhost:9099"
export REPLAY_STORE_ACCESS_KEY=minioadmin
export REPLAY_STORE_SECRET_KEY=minioadmin
export REPLAY_STORE_BUCKET=opslane-test

# Legacy mirror: error_event_test.go reads only these.
export MINIO_ENDPOINT="$REPLAY_STORE_ENDPOINT"
export MINIO_ACCESS_KEY="$REPLAY_STORE_ACCESS_KEY"
export MINIO_SECRET_KEY="$REPLAY_STORE_SECRET_KEY"
export MINIO_BUCKET="$REPLAY_STORE_BUCKET"
```

**Prove the harness before writing code.** A skipped test looks like a passing test.

```bash
cd packages/ingestion
go test ./minio -v 2>&1 | grep -E "SKIP|PASS|FAIL" | head
```

Expected: `PASS`, no `SKIP`. If you see `SKIP`, `REPLAY_STORE_ENDPOINT` is not exported in this shell.

**Put `psql` on PATH first, or every migration command in this plan will lie to you.**

`scripts/run-migrations.sh:14` calls bare `psql`. On a Mac with libpq installed via Homebrew, `psql` is **not** on PATH by default, and `scripts/check-migration-reapply.sh` does not fail when the runner cannot find it. Verified: without PATH set, the CI gate prints

```
[reapply-check] first application (fresh DB path)
./scripts/run-migrations.sh: line 14: psql: command not found
```

and **exits 0**. It looks like it passed. It applied nothing.

```bash
command -v psql || export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql --version   # expect: psql (PostgreSQL) 17.x or similar
```

Go's `db/migrations_test.go:34` has a `findPsql` fallback that checks
`/opt/homebrew/opt/libpq/bin` and `/usr/local/opt/libpq/bin`, so `go test ./db`
works without this. The shell scripts have no such fallback.

Apply migrations:

```bash
cd packages/ingestion && MIGRATION_DIR=db/migrations ../../scripts/run-migrations.sh
```

Then confirm the gate really runs. Verified good output on the current tree:

```
[reapply-check] seeding representative rows at every lifecycle status
INSERT 0 7
[reapply-check] replaying ALL migrations on the seeded database
[reapply-check] PASS — migrations replay cleanly with data present
```

If you do not see the `PASS` line, the gate did not run.

**Two facts about migrations.** There is no ledger: `scripts/run-migrations.sh` replays every `.sql` on every boot, sorted lexically, and CI enforces replay via `scripts/check-migration-reapply.sh`. Every statement must be safe to run twice. Numbering is convention only, so a gap is harmless.

---

## Task 0.75: Make the upload key's database ID reachable

`sourcemap_batches.upload_key_db_id` is `UUID NOT NULL` with a foreign key to
`project_api_keys(id, project_id)`. Nothing in the request path can supply it
today. Verified: `db.ProjectKeyLookup` (`db/project_keys.go:59`) carries
`KeyID, ProjectID, OrgID, Scope, AllowedOrigins, AllowPayloadEnvironment` and
**no row id**, and `handler/auth.go:21-31` defines no `ctxKeyDBID`. Without this
task, `CreateSourceMapBatch` cannot be called and Task 7 stalls.

**Files:** `db/project_keys.go`, `handler/auth.go`, `handler/project_keys.go`

**Step 1: Failing test.** In `handler/project_keys_test.go`, assert a
sourcemaps-scope request sees a non-empty `handler.KeyDBIDFromCtx(ctx)` equal to
the `id` column of the minted key.

**Step 2: Implement.**

- Add `ID string` to `ProjectKeyLookup` and select `id` in the lookup query.
- Add `ctxKeyDBID` to the `contextKey` block in `handler/auth.go` and an accessor:

```go
// KeyDBIDFromCtx returns the project_api_keys.id of the authenticated key.
// Source-map batches record it so an upload can be attributed to one credential.
func KeyDBIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeyDBID).(string)
	return v
}
```

- Set it in `ProjectKey` alongside the other context values.

**Step 3: Run, commit.**

```bash
(cd packages/ingestion && go test ./db ./handler -run 'TestProjectKey|TestLookupProjectKey' -v)
git commit -am "feat(ingestion): expose the authenticated key's database id"
```

---

## Task 1: Unblock the migration

**Files:** Create `packages/ingestion/db/migrations/031_sourcemap_batches.sql`, `packages/ingestion/db/sourcemaps_schema_test.go`

**Step 1: Prove the problem (verified)**

```bash
docker exec -i s2b-pg psql -U opslane -d opslane <<'SQL'
BEGIN;
CREATE TABLE fk_probe (a UUID, b UUID,
  FOREIGN KEY (a, b) REFERENCES project_api_keys(id, project_id));
ROLLBACK;
SQL
```

Verified output:

```
ERROR:  there is no unique constraint matching given keys for referenced table "project_api_keys"
ROLLBACK
```

**Step 2: Write the constraint fix as add-only**

The obvious `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT` **fails on replay**. Verified: on the second application, once `sourcemap_batches` exists and depends on the unique index, the drop errors with

```
ERROR:  cannot drop constraint project_api_keys_id_project_key on table project_api_keys
        because other objects depend on it
DETAIL:  constraint sourcemap_batches_upload_key_db_id_project_id_fkey ... depends on index ...
```

which fails `scripts/check-migration-reapply.sh`. Add only when absent. Verified to replay cleanly:

```sql
-- S2b: source-map batches, files, and manifest rows.
-- The runner replays every migration on every boot, so every statement must be
-- idempotent. Add-only, never drop: a later foreign key depends on this index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_api_keys_id_project_key'
      AND conrelid = 'project_api_keys'::regclass
  ) THEN
    ALTER TABLE project_api_keys
      ADD CONSTRAINT project_api_keys_id_project_key UNIQUE (id, project_id);
  END IF;
END $$;
```

**Step 3: Run it twice before writing anything else**

```bash
docker exec -i s2b-pg psql -U opslane -d opslane -q -v ON_ERROR_STOP=1 < packages/ingestion/db/migrations/031_sourcemap_batches.sql && echo "apply 1 ok"
docker exec -i s2b-pg psql -U opslane -d opslane -q -v ON_ERROR_STOP=1 < packages/ingestion/db/migrations/031_sourcemap_batches.sql && echo "apply 2 ok"
```

Both must print ok. Repeat this check after every addition below.

**Step 4: Add the three tables**

Copy `sourcemap_batches`, `sourcemap_files`, and `sourcemap_batch_files` from contract section 8.1 **verbatim**, changing `CREATE TABLE` to `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX` to `CREATE INDEX IF NOT EXISTS`. Include all four indexes. Do **not** include `sourcemap_project_tombstones` or `idx_project_api_keys_last_rejected`; those are #229 and #230.

**This whole recipe was executed before being written down.** The DO block above, plus section 8.1 with exactly those three substitutions and those three objects removed, was applied to a fresh `postgres:16` carrying migrations `001` through `029`. Result: apply 1 clean, apply 2 clean (no output), and afterwards

```
sourcemap_batch_files
sourcemap_batches
sourcemap_files
trg_sourcemap_file_identity_immutable
```

So "copy it verbatim" is a claim that has been tested, not an assumption. If your version errors, you deviated from the substitutions.

Re-run Step 3.

**Step 5: Add the immutability trigger**

The repo has no triggers today. A bare `CREATE TRIGGER` fails on the second boot; PostgreSQL 16 supports the replace form.

```sql
CREATE OR REPLACE FUNCTION prevent_sourcemap_file_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.debug_id, NEW.content_sha256,
         NEW.size_bytes, NEW.object_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.debug_id, OLD.content_sha256,
         OLD.size_bytes, OLD.object_key, OLD.created_at)
  THEN
    RAISE EXCEPTION 'source map artifact identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_sourcemap_file_identity_immutable
BEFORE UPDATE ON sourcemap_files
FOR EACH ROW EXECUTE FUNCTION prevent_sourcemap_file_identity_update();
```

Re-run Step 3, then the real CI gate:

```bash
MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/check-migration-reapply.sh
```

**Step 6: Write the schema tests, run them, watch them pass**

`packages/ingestion/db/sourcemaps_schema_test.go`, package `db_test`, using `testPool(t)` from `testhelper_test.go`:

- `TestSourceMapFileIdentityImmutable`: insert a `sourcemap_files` row, `UPDATE` its `debug_id`, assert the error string contains `identity is immutable`.
- `TestDebugIDRawBitsRoundTripBothColumns`: insert `158399f3-1dad-1386-35b2-98c34317d52e` into `sourcemap_batch_files.debug_id` **and** `sourcemap_files.debug_id`, read both back with `::text`, assert exact string equality. Contract section 6.2 names this value because its bits do not encode an RFC UUID variant. #224 covers only its own column.

```bash
cd packages/ingestion && go test ./db -run 'TestSourceMapFileIdentityImmutable|TestDebugIDRawBits' -v
```

Expected: two PASS, no SKIP.

**Step 7: Commit**

```bash
git add packages/ingestion/db/migrations/031_sourcemap_batches.sql \
        packages/ingestion/db/sourcemaps_schema_test.go
git commit -m "feat(ingestion): add source-map batch schema and unblock the composite FK"
```

---

## Task 2: Return canonical bytes from `debugid.Compute`

**Files:** Modify `packages/ingestion/debugid/debugid.go`, `debugid_test.go`, `go.mod`

**What is actually there.** `debugid_test.go` is `package debugid` (internal), so tests call `Compute(...)`, **not** `debugid.Compute(...)`. `TestCompute` loads `test-fixtures/debug-id/vectors.json`, which holds **15 cases**: 4 with `outcome: "ok"` and 11 rejections. Every ok case already carries a `canonical_b64` field that the current `vector` struct does not decode. You are wiring up data that already exists.

**Step 1: Write the failing assertion**

Add one field to the existing `vector` struct:

```go
	CanonicalB64 string `json:"canonical_b64"`
```

and inside the `outcome == "ok"` branch of `TestCompute`, before the `return`:

```go
			wantCanonical, err := base64.StdEncoding.DecodeString(test.CanonicalB64)
			if err != nil {
				t.Fatalf("decode canonical_b64: %v", err)
			}
			if !bytes.Equal(result.Canonical, wantCanonical) {
				t.Errorf("Canonical =\n%q\nwant\n%q", result.Canonical, wantCanonical)
			}
			if result.CanonicalSize != int64(len(wantCanonical)) {
				t.Errorf("CanonicalSize = %d, want %d", result.CanonicalSize, len(wantCanonical))
			}
```

Add `"bytes"` to the imports.

**Step 2: Run it, watch it fail**

```bash
cd packages/ingestion && go test ./debugid -run TestCompute
```

Expected: compile error, `result.Canonical` undefined.

**Step 3: Implement**

Add to `Result`:

```go
	Canonical     []byte
	CanonicalSize int64
```

In `Compute`, after `canonical, err := jcs.Transform(reduced)`:

```go
	if int64(len(canonical)) > maxCanonicalBytes {
		return Result{}, reject("too_large")
	}
```

with `const maxCanonicalBytes = 104857600` near the top, and populate both fields in the returned `Result`.

**Step 4: Add the cap test.** Nothing in the fixture exercises the 100 MiB
guard. Add `TestComputeRejectsOversizeCanonical`: build a map whose canonical
form exceeds `maxCanonicalBytes` (a `sources`/`sourcesContent` pair of many
large strings is the cheapest way), assert `Compute` returns an `*Error` with
reason `too_large`. Mark it `testing.Short()`-skippable; it allocates.

**Step 5: Run it, watch it pass**

```bash
(cd packages/ingestion && go test ./debugid -run TestCompute -v 2>&1 | tail -25)
```

Expected: 15 fixture subtests PASS plus the cap test.

**Step 6: Promote the dependency and commit**

```bash
cd packages/ingestion && go mod tidy && go build ./... && go test ./debugid
git add packages/ingestion/debugid packages/ingestion/go.mod packages/ingestion/go.sum
git commit -m "feat(debugid): return canonical bytes and enforce the 100 MiB canonical cap"
```

---

## Task 3: The VLQ decoder

Do not use `github.com/go-sourcemap/sourcemap`. Measured: it returns `ok=true` with a fabricated `sources[0]` for segments the spec marks unmapped.

**Files:** Create `packages/ingestion/sourcemapping/decode.go`, `decode_test.go`, `testdata/parity.json`

**Step 1: Write the fixture first, so the test has something to read**

`testdata/parity.json`. Generate every `expect` by running the same map through `@jridgewell/trace-mapping`, which the worker already uses:

```bash
cd packages/worker && node -e '
const {TraceMap, originalPositionFor} = require("@jridgewell/trace-mapping");
const m = new TraceMap({version:3,sources:["src/a.ts","src/b.ts"],names:[],
  mappings:"AAAA;A",sourcesContent:["const x = 1;\n","const y = 2;\n"]});
for (const q of [[1,0],[2,0],[2,3]])
  console.log(q, JSON.stringify(originalPositionFor(m,{line:q[0],column:q[1]})));'
```

Verified output, run from `packages/worker`:

```
[ 1, 0 ] {"source":"src/a.ts","line":1,"column":0,"name":null}
[ 2, 0 ] {"source":null,"line":null,"column":null,"name":null}
[ 2, 3 ] {"source":null,"line":null,"column":null,"name":null}
```

The two `null` rows are the whole reason this package exists: `go-sourcemap` answers `src/a.ts:1:0` for both. A `source: null` becomes `"expect": null` in the fixture and `ok=false` from `Lookup`.

Shape:

```json
{"cases":[{"name":"unmapped 1-field segment","map":{...},
  "queries":[{"line":1,"column":0,"expect":{"source":"src/a.ts","line":1,"column":0,"name":null}},
             {"line":2,"column":0,"expect":null}]}]}
```

Cover: a 4-field segment; a 5-field segment with a name; the 1-field unmapped segment; a column inside a span (resolves to the span start); a column before the first segment; a line past the end; a map with `sourceRoot` present (the golden vectors include one, and the decoder must ignore it rather than choke).

**Step 2: Write the test that reads the fixture**

`decode_test.go` must actually consume `testdata/parity.json` in a table-driven loop. A fixture no test reads is dead weight.

```go
func TestParityWithTraceMapping(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "parity.json"))
	if err != nil { t.Fatal(err) }
	var f struct{ Cases []struct {
		Name string `json:"name"`
		Map  json.RawMessage `json:"map"`
		Queries []struct {
			Line, Column int
			Expect *struct{ Source string; Line, Column int; Name *string }
		} `json:"queries"`
	} `json:"cases"` }
	if err := json.Unmarshal(data, &f); err != nil { t.Fatal(err) }
	if len(f.Cases) == 0 { t.Fatal("parity.json has no cases") }
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			m, err := Parse(c.Map)
			if err != nil { t.Fatal(err) }
			for _, q := range c.Queries {
				got, ok := m.Lookup(q.Line, q.Column)
				if q.Expect == nil {
					if ok { t.Errorf("(%d,%d) resolved to %+v, want unmapped", q.Line, q.Column, got) }
					continue
				}
				if !ok { t.Fatalf("(%d,%d) unmapped, want %+v", q.Line, q.Column, *q.Expect) }
				if got.Source != q.Expect.Source || got.Line != q.Expect.Line || got.Column != q.Expect.Column {
					t.Errorf("(%d,%d) = %+v, want %+v", q.Line, q.Column, got, *q.Expect)
				}
			}
		})
	}
}
```

**Step 3: Run it, watch it fail**

```bash
cd packages/ingestion && go test ./sourcemapping
```

Expected: package does not exist.

**Step 4: Implement, with the edge rules written down**

```go
// Package sourcemapping decodes source-map v3 mappings and answers generated to
// original position queries.
//
// Written rather than vendored: github.com/go-sourcemap/sourcemap defaults a
// missing source index to 0 and reports success, so a spec-unmapped segment
// resolves to a fabricated position in sources[0]. For an endpoint whose job is
// proving resolution is correct, a confident wrong answer is worse than an error.
//
// This package never retains sourcesContent. Nothing here can leak source text.
package sourcemapping

type Position struct {
	Source string
	Line   int    // 1-based
	Column int    // 0-based
	Name   *string // nil when the segment carries no name index
}

`Name` is `*string`, not `string`. A 4-field segment has no name at all, while a
5-field segment can legitimately point at a name-table entry that is the empty
string. Task 9 must serialize the first as JSON `null`, and a plain `string`
cannot tell them apart. The parity fixture asserts `Name` too, not just position.
```

`Parse(raw []byte) (*Map, error)` reads only `version`, `sources`, `names`, `mappings`. Reject `version != 3` and any map containing `sections`. Ignore `sourceRoot`, `file`, and `sourcesContent` without error.

Decode rules, all of which need a test:

| Case | Behavior |
|---|---|
| Segment with 1 field | unmapped; `Lookup` returns `ok=false` |
| Segment with 2 or 3 fields | **reject the map** at `Parse` time as malformed; the spec allows only 1, 4, or 5 |
| Segment with 4 fields | mapped, no name |
| Segment with 5 fields | mapped, with name |
| VLQ that overflows int32 | `Parse` error |
| Truncated or non-base64 VLQ char | `Parse` error |
| Source or name index out of range | `Parse` error, so `Lookup` never indexes out of bounds |
| Generated columns out of order within a line | sort ascending at parse time; do not assume input order |
| Empty line (`;;`) | zero segments; every column on it is unmapped |

`Lookup(genLine, genCol int) (Position, bool)` returns `ok=false` when the line is out of range, the segment list is empty, no segment starts at or before the column, or the found segment is unmapped. Otherwise binary-search the greatest `genCol <= query`.

**Step 5: Run it, watch it pass**

```bash
cd packages/ingestion && go test ./sourcemapping -v
```

**Step 6: Commit**

```bash
git add packages/ingestion/sourcemapping
git commit -m "feat(ingestion): add a VLQ decoder that honours unmapped segments"
```

---

## Task 4: `CopyObject` on the MinIO client

**Files:** Modify `packages/ingestion/minio/client.go`, `client_test.go`

`client_test.go` reads `REPLAY_STORE_ENDPOINT` only and skips otherwise. Confirm Task 0.5's harness check printed PASS and not SKIP, or this task will appear to succeed without running.

**Step 1: Write the failing test** in `client_test.go` using the existing `testClient(t)` helper: put bytes at `a/x.map`, `CopyObject` to `b/x.map`, `GetObject` both, assert equal.

**Step 2: Run, watch it fail**

```bash
cd packages/ingestion && go test ./minio -run TestCopyObject -v
```

Expected: `c.CopyObject` undefined. If you see `SKIP`, fix the environment first.

**Step 3: Implement.** Verified against the vendored `minio-go/v7 v7.2.1`, whose signature is `CopyObject(ctx, dst CopyDestOptions, src CopySrcOptions) (UploadInfo, error)`, destination first:

```go
// CopyObject copies an object inside the bucket without routing the bytes
// through this process. Source-map promotion moves up to 100 MiB per file.
func (c *Client) CopyObject(ctx context.Context, srcKey, dstKey string) error {
	_, err := c.mc.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: c.bucket, Object: dstKey},
		minio.CopySrcOptions{Bucket: c.bucket, Object: srcKey})
	return err
}
```

**Step 4: Run, watch it pass, commit**

```bash
cd packages/ingestion && go test ./minio -run TestCopyObject -v
git add packages/ingestion/minio && git commit -m "feat(minio): add server-side CopyObject"
```

---

## Task 5: Route hygiene

**Files:** Modify `handler/routes.go`, `handler/project_keys.go`, `handler/ingest_limits.go`, `handler/routes_test.go`

**Step 1: Write the failing tests first.** In `handler/routes_test.go`:

- `TestUnknownAPIPathReturnsJSON404`: `POST /api/v1/sourcemaps` returns `404`, `Content-Type: application/json`, body `code == "not_found"`.
- `TestUnknownAPIVersionReturnsJSON404`: `POST /api/v2/anything` returns `404` JSON, **not** the SPA. Set `DASHBOARD_DIR` to a temp dir holding an `index.html` so the catch-all is live, or this test proves nothing.
- `TestWrongMethodReturnsJSON405`: `GET /api/v1/events` returns `405` JSON with `code == "method_not_allowed"`.

```bash
cd packages/ingestion && go test ./handler -run 'TestUnknownAPI|TestWrongMethod' -v
```

Expected: fail with `text/plain` and `404 page not found`.

**Step 2: Implement the JSON handlers**

Contract section 2.4 says `/api/*`, not just `/api/v1`. Registering only inside the `/api/v1` group leaves `/api/v2/...` falling through to the dashboard catch-all. Register at both levels:

```go
	// Inside r.Route("/api/v1", func(r chi.Router) { ... }):
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeJSONErrorCode(w, http.StatusNotFound, "not found", "not_found")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			writeJSONErrorCode(w, http.StatusMethodNotAllowed, "method not allowed", "method_not_allowed")
		})
```

and, before the dashboard catch-all, a guard so any other `/api/` path is JSON too:

```go
	r.Handle("/api/*", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSONErrorCode(w, http.StatusNotFound, "not found", "not_found")
	}))
```

The `/api/*` handler is registered **after** the `/api/v1` group, and chi still prefers the more specific mount, so it does not shadow real routes. Verified against chi v5 with this exact shape:

```
POST  /api/v1/events                 -> 201 EVENTS              (real route, unaffected)
GET   /api/v1/projects/abc/incidents -> 200 INCIDENTS           (param route, unaffected)
POST  /api/v1/sourcemaps             -> 404 {"code":"not_found"}
GET   /api/v1/events                 -> 405 {"code":"method_not_allowed"}
POST  /api/v2/anything               -> 404 {"code":"not_found"}
GET   /dashboard                     -> 200 SPA                 (catch-all still reachable)
```

Keep that ordering. Registering `/api/*` before the `/api/v1` group is not covered by this evidence.

**Step 3: Scope-gate the environment lookup, without breaking the build**

`ProjectKey` resolves the project's `production` environment for every scope and 500s when absent. Source-map routes never read it. **Do not wrap `project_keys.go:43-56` in an `if`**: `envID` is declared there with `:=` and used later at line 62 when building the context, so a naive wrap fails to compile. Declare it outside:

```go
			var envID string
			if requiredScope == db.ScopeIngest {
				var err error
				envID, err = d.environmentNameResolver().resolve(
					r.Context(), lookup.ProjectID, "production",
				)
				if err != nil { /* existing 500 handling */ }
				if envID == "" { /* existing 500 handling */ }
			}
```

`ctxEnvironmentID` then carries `""` for sourcemaps keys. Verified safe:

- `envID` really is consumed after the block, at `project_keys.go:62`
  (`ctx = context.WithValue(ctx, ctxEnvironmentID, envID)`), which is why the
  naive wrap fails to compile.
- Only `handler/session.go:69` and `handler/error_event.go:52` read
  `EnvironmentIDFromCtx`, and both sit on ingest-scope routes, which still
  resolve `envID` inside the conditional.
- No route uses `db.ScopeSourcemaps` today (`grep ScopeSourcemaps handler/routes.go`
  returns nothing), so this change cannot alter the behavior of any existing route.

Test: a sourcemaps-scope request succeeds against a project whose `production` environment row was deleted, and an ingest-scope request against the same project still gets a populated `ctxEnvironmentID`.

**Step 4: Give the rate limiter a `code`**

`ingest_limits.go:42` writes `429` with no `code`. Change it to `writeJSONErrorCode(w, http.StatusTooManyRequests, "rate limit exceeded", "rate_limited")`. Additively improves the six existing ingest routes; assert the new field.

**Step 5: Add the limiters**

`ingest_limits.go` imports only `log/slog`, `net/http`, `net/url`, `strings`. The snippet below needs `"github.com/go-chi/chi/v5"` added or it will not compile. `writeJSONErrorCode` is in `handler/auth.go:299` and `newRateLimiter` in `handler/auth_handlers.go:35`, both same-package.

```go
	// Per-replica, in-memory, reset each minute. Contract 7.2 wants these
	// cluster-wide; #226 does that.
	sourcemapBatchLimiter    = newRateLimiter(20)
	sourcemapFileLimiter     = newRateLimiter(600)
	sourcemapCompleteLimiter = newRateLimiter(60)
	sourcemapVerifyLimiter   = newRateLimiter(30)
```

Contract section 9 scopes verify per **user and project**, so key on both. The limiter must also run **after** the project-belongs-to-active-org check, not before, or an unauthorized caller can consume another project's budget:

```go
// rateLimitBySessionUserProject limits by userID+projectID. Session routes have
// no project in context, so rateLimitByProject cannot be used. Chain it AFTER
// the project-belongs-to-active-org check.
func rateLimitBySessionUserProject(limiter *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := chi.URLParam(r, "projectID")
			userID := UserIDFromCtx(r.Context())
			if projectID == "" || userID == "" {
				writeJSONErrorCode(w, http.StatusBadRequest, "project required", "invalid_request")
				return
			}
			if !limiter.allow(userID + ":" + projectID) {
				writeJSONErrorCode(w, http.StatusTooManyRequests, "rate limit exceeded", "rate_limited")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

**Step 6: Run, watch pass, commit**

```bash
cd packages/ingestion && go test ./handler -run 'TestUnknownAPI|TestWrongMethod|TestProjectKey' -v
git add packages/ingestion/handler
git commit -m "fix(ingestion): JSON api 404/405, scope-gate env lookup, code on rate limits"
```

---

## Task 6: The database layer

**Files:** Create `packages/ingestion/db/sourcemaps.go`, `db/sourcemaps_test.go`

This is the API Tasks 7 to 9 consume, so it is specified in full rather than described. Every function takes `projectID` and filters on it in SQL. Cross-project lookups return `ErrBatchNotFound`, never 403, so batch IDs are not enumerable.

**The rule that will cost you an afternoon.** PostgreSQL evaluates `CHECK` constraints per statement, not per transaction. Every state transition must be a single `UPDATE` carrying every column the target state requires. Two `UPDATE`s inside one transaction fail on the first.

**Step 1: Declare the surface**

```go
var (
	ErrBatchNotFound        = errors.New("source map batch not found")   // 404 batch_not_found
	ErrBatchExpired         = errors.New("source map batch expired")     // 410 batch_expired
	ErrBatchComplete        = errors.New("source map batch complete")    // 409 batch_already_complete
	ErrBatchIncomplete      = errors.New("source map batch incomplete")  // 409 batch_incomplete
	ErrDebugIDNotDeclared   = errors.New("debug id not declared")        // 409 debug_id_not_declared
	ErrDebugIDConflict      = errors.New("debug id content conflict")    // 409 debug_id_conflict
	ErrIdempotencyConflict  = errors.New("idempotency key reused")       // 409 idempotency_conflict
	ErrCompletionInProgress = errors.New("completion in progress")       // 409 batch_completion_in_progress
	ErrMapNotFound          = errors.New("source map not resolvable")    // 404 map_not_found
)

`ErrMapNotFound` is distinct from `ErrBatchNotFound` on purpose. Verify must
answer `404 batch_not_found` when the batch is absent or belongs to another
project, and `404 map_not_found` when the batch exists but that debug ID has
no linked row. Same status, different `code`.

type ManifestFile struct {
	DebugID   string
	CodeFile  string
	RawSize   int64 // declared size of the RAW upload
}

type SourceMapBatch struct {
	ID                string
	ProjectID         string
	Status            string // pending | completing | complete | expired
	Probe             bool
	CommitSHA         *string
	Release           *string
	ExpectedFileCount int
	ExpectedBytes     int64
	ReceivedFileCount int
	ReceivedBytes     int64
	ExpiresAt         time.Time
	CompletedAt       *time.Time
}

type BatchClaim struct{ ClaimedAt time.Time } // the claim token

type StagedFile struct {
	DebugID       string
	StagingKey    string
	RawSize       int64
	CanonicalSize int64
	RawSHA256     []byte
	ContentSHA256 []byte
}

type ResolvableMap struct {
	ObjectKey     string
	ContentSHA256 []byte
	CanonicalSize int64
}

func (q *Queries) CreateSourceMapBatch(ctx context.Context, projectID, keyDBID string, idempotencyKey string, manifestSHA256 []byte, commitSHA, release *string, probe bool, files []ManifestFile) (batch SourceMapBatch, reused bool, err error)
func (q *Queries) GetSourceMapBatch(ctx context.Context, projectID, batchID string) (SourceMapBatch, error)
func (q *Queries) GetDeclaredFile(ctx context.Context, projectID, batchID, debugID string) (ManifestFile, string, error) // returns state
func (q *Queries) LinkExistingArtifact(ctx context.Context, projectID, batchID string, f StagedFile) (linked bool, err error)
func (q *Queries) StageBatchFile(ctx context.Context, projectID, batchID string, f StagedFile) (created bool, err error)
func (q *Queries) ClaimBatchCompletion(ctx context.Context, projectID, batchID string) (BatchClaim, error)
func (q *Queries) ListStagedFiles(ctx context.Context, projectID, batchID string) ([]StagedFile, error)
func (q *Queries) ActivateBatch(ctx context.Context, projectID, batchID string, claimedAt time.Time, staged []StagedFile) (rowsChanged int, err error)
func (q *Queries) GetResolvableMap(ctx context.Context, projectID, batchID, debugID string) (ResolvableMap, error)
func (q *Queries) DeleteProject(ctx context.Context, projectID string) (storagePrefix string, err error)
// NOTE: a bare DELETE FROM projects FAILS. Many tables reference projects(id)
// with no ON DELETE CASCADE (verified in 001_baseline.sql, 002_sessions.sql,
// 004_friction.sql). DeleteProject must delete children in dependency order
// inside one transaction. The ordered list already exists: copy it from
// cleanupTenant in db/testhelper_test.go:44-70 and add the three sourcemap
// tables. Returns "sourcemaps/v1/projects/<id>/" for the caller to sweep.
```

Name the fields `RawSize`/`CanonicalSize` and `RawSHA256`/`ContentSHA256` everywhere. Four size fields share one valid range and no `CHECK` can catch a swap.

**Step 2: Write the failing claim test**

```go
func TestClaimBatchCompletionReclaimsExpiredLease(t *testing.T) {
	// ... seed a fully received pending batch ...
	first, err := q.ClaimBatchCompletion(ctx, projectID, batchID)
	if err != nil { t.Fatal(err) }

	if _, err := q.ClaimBatchCompletion(ctx, projectID, batchID); !errors.Is(err, db.ErrCompletionInProgress) {
		t.Fatalf("second claim under a live lease: %v, want ErrCompletionInProgress", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE sourcemap_batches
	    SET completion_lease_expires_at = now() - interval '1 second' WHERE id = $1`, batchID); err != nil {
		t.Fatal(err)
	}
	second, err := q.ClaimBatchCompletion(ctx, projectID, batchID)
	if err != nil { t.Fatalf("reclaim after expiry: %v", err) }
	if second.ClaimedAt.Equal(first.ClaimedAt) { t.Error("reclaim must mint a new claim token") }

	n, err := q.ActivateBatch(ctx, projectID, batchID, first.ClaimedAt, nil)
	if err != nil { t.Fatal(err) }
	if n != 0 { t.Errorf("stale claim activated %d rows, want 0", n) }
}
```

**Step 3: Run it, watch it fail.** Note the `-run` pattern must actually match:

```bash
cd packages/ingestion && go test ./db -run TestClaimBatchCompletion -v
```

Watch the `-run` pattern. A pattern that matches nothing exits 0 and prints, verified:

```
ok  	github.com/opslane/opslane/packages/ingestion/handler	0.358s [no tests to run]
```

The `[no tests to run]` suffix is the only tell, and it is easy to miss in a scroll or a scripted gate that only checks the exit code. `-run TestSourceMap` does **not** match `TestClaimBatchCompletionReclaimsExpiredLease`. Always confirm the subtest names you expect actually appear in `-v` output.

**Step 4: Implement `ClaimBatchCompletion` as one statement**

```sql
UPDATE sourcemap_batches
SET status = 'completing',
    completion_claimed_at = now(),
    completion_lease_expires_at = now() + interval '5 minutes'
WHERE id = $1 AND project_id = $2
  AND received_file_count = expected_file_count
  AND received_bytes = expected_bytes
  AND (status = 'pending'
       OR (status = 'completing' AND completion_lease_expires_at <= now()))
  AND expires_at > now()
RETURNING completion_claimed_at
```

The `expires_at > now()` clause is load-bearing and easy to omit. Without it a
fully received but expired `pending` batch claims successfully and goes on to
`complete`, when Task 8 owes the caller `410 batch_expired`. The handler checks
expiry too, but the handler's read is stale by the time the claim runs, so the
guard has to be in the statement.

Zero rows means not found, wrong project, not fully received, already complete, or a live lease. Re-read the row to pick the right error. Both entry paths stamp from the same `now()`, so successive tokens are at least one lease apart and cannot collide.

**Step 5: Implement `ActivateBatch`**

One transaction. `SELECT ... FOR UPDATE` on the batch; require `status = 'completing'`, a live lease, and `completion_claimed_at = claimedAt`. Any mismatch returns `(0, nil)`: a stale claim is expected, not an error.

Validate **all** staged rows before inserting anything. On `(project_id, debug_id)` conflict, reuse only when `debug_id`, `content_sha256`, and `size_bytes` all match; otherwise abort with `ErrDebugIDConflict`. The composite foreign key alone would allow linking to a same-project artifact with a different debug ID.

Close with the single-statement transition:

```sql
UPDATE sourcemap_batches
SET status = 'complete', completed_at = now(),
    completion_claimed_at = NULL, completion_lease_expires_at = NULL
WHERE id = $1 AND project_id = $2 AND completion_claimed_at = $3
```

**Step 6: Implement the rest.** `StageBatchFile` rechecks project, batch status, expiry, row state, and digest **under lock**, because the handler's first read is stale by the time storage returns, and increments the batch counters only on the first transition out of `pending`.

`GetResolvableMap` requires `sourcemap_batch_files.state = 'linked'` AND `sourcemap_batches.status = 'complete'`. That one predicate is what makes R3 true, and it was checked against the real schema: two batches in one project sharing debug ID `158399f3-1dad-1386-35b2-98c34317d52e`, one complete-and-linked and one pending-and-staged (the interrupted build), give

```
55555555-...  complete  linked  resolvable=t
66666666-...  pending   staged  resolvable=f
```

Both rows were accepted by the section 8.1 CHECK constraints, so the three-state encoding is self-consistent. The interrupted batch is invisible to resolution while its bytes sit in staging, which is exactly R3.

**Step 7: Run the whole package, watch pass, commit**

```bash
cd packages/ingestion && go test ./db -run 'TestSourceMap|TestClaim|TestActivate|TestStage|TestGetResolvable' -v
git add packages/ingestion/db && git commit -m "feat(db): source-map batch, file, claim, and activation helpers"
```

---

## Task 7: The three upload routes

**Files:** Create `handler/sourcemaps.go`, `handler/sourcemaps_test.go`; modify `handler/routes.go`

**Step 1: Write one failing test per branch, before any handler code.** Build the table first; each row is a red test you turn green:

| Test name | Expect |
|---|---|
| `TestCreateBatchZeroFiles` | `400 invalid_manifest` naming `files` |
| `TestCreateBatch501Files` | `413 too_many_files` |
| `TestCreateBatchBytesOverOneGiB` | `413 batch_too_large` |
| `TestCreateBatchMissingIdempotencyKey` | `400 invalid_request` |
| `TestCreateBatchNonUUIDIdempotencyKey` | `400 invalid_request` |
| `TestCreateBatchControlCharsInCodeFile` | `400 invalid_manifest` |
| `TestCreateBatchBadCommitSHALength` | `400 invalid_manifest` |
| `TestCreateBatchIdempotentRetry` | `200`, same `batch_id` |
| `TestCreateBatchSameKeyDifferentManifest` | `409 idempotency_conflict` |
| `TestPutMissingContentLength` | `411 length_required` |
| `TestPutContentLengthMismatch` | `409 size_mismatch` |
| `TestPutBodyLongerThanContentLength` | `409 size_mismatch`, not a truncated accept |
| `TestPutWrongContentType` | `415 unsupported_media_type` |
| `TestPutContentEncodingGzip` | `415`, **not** `400 invalid_source_map` |
| `TestPutUndeclaredDebugIDOnCompleteBatch` | `409 debug_id_not_declared` |
| `TestPutExpiredPendingBatch` | `410 batch_expired` |
| `TestPutCompletedBatchRetriedAfterExpiry` | `200 already_present`, **not** `410` |
| `TestPutWrongClaimedDebugID` | `409 debug_id_mismatch` |
| `TestPutMalformedMap` (BOM, invalid UTF-8, duplicate key, nesting > 64, indexed map, `sourcesContent` length mismatch) | `400 invalid_source_map` |
| `TestPutNilStorage` | `503 storage_unavailable`, no panic |
| `TestCreateBatchNew` | `201` with `batch_id`, `expected_files`, `expected_bytes`, `expires_at` |
| `TestCreateBatchManifestOver256KiB` | `413 manifest_too_large` |
| `TestCreateBatchDuplicateDebugIDs` | `400 duplicate_debug_id` |
| `TestCreateBatchFileOver100MiB` | `413 file_too_large` |
| `TestPutFirstUpload` | `201 stored` |
| `TestPutIdenticalRetry` | `200 already_present`, still one row and one object |
| `TestPutConflictingDigestSameDebugID` | `409 debug_id_conflict` (seed the digest; the real hash cannot collide) |

```bash
cd packages/ingestion && go test ./handler -run TestCreateBatch -v   # all red
```

**Step 2: Register the routes**

```go
		sourcemapKey := deps.ProjectKey(db.ScopeSourcemaps)
		r.With(sourcemapKey, rateLimitByProject(sourcemapBatchLimiter)).
			Post("/sourcemaps/batches", deps.CreateSourceMapBatch)
		r.With(sourcemapKey, rateLimitByProject(sourcemapFileLimiter)).
			Put("/sourcemaps/batches/{batchID}/files/{debugID}", deps.UploadSourceMapFile)
		r.With(sourcemapKey, rateLimitByProject(sourcemapCompleteLimiter)).
			Post("/sourcemaps/batches/{batchID}/complete", deps.CompleteSourceMapBatch)
```

Project ID always comes from `ProjectIDFromCtx`.

**Step 3: Implement the PUT in this exact order.** Two steps are counter-intuitive and both were wrong in an earlier draft.

1. Batch exists in this project, else `404 batch_not_found`.
2. Debug ID declared in this batch, else `409 debug_id_not_declared`. **Before every lifecycle check.**
3. `expires_at` **only when `status = 'pending'`**, else `410`. A completed batch retried an hour later must return its receipt.
4. `Content-Length` required (`411`), equal to the manifest (`409 size_mismatch`).
5. `Content-Type` must be `application/json` (`415`). `Content-Encoding` present is also `415`, checked explicitly, or gzip becomes `400 invalid_source_map` and misdirects the caller.
6. `http.MaxBytesReader` at the declared length; a longer body is `409 size_mismatch`.
7. `debugid.Compute`; failure is `400 invalid_source_map`.
8. **Lifecycle before identity.** On a `complete` batch: matching canonical digest is `200 already_present`, anything else `409 batch_already_complete`. Only on a non-complete batch does a computed ID differing from the path segment become `409 debug_id_mismatch`.
9. `LinkExistingArtifact`, else write canonical bytes to staging and `StageBatchFile`.

Every handler checks `if d.MinIO == nil` and returns `503 storage_unavailable`. Every `400 invalid_manifest` names the offending field and the constraint.

**Step 4: Run until green, commit**

```bash
cd packages/ingestion && go test ./handler -run 'TestCreateBatch|TestPut' -v
git add packages/ingestion/handler && git commit -m "feat(ingestion): source-map batch upload routes"
```

---

## Task 8: Completion

**Files:** Modify `handler/sourcemaps.go`, `handler/sourcemaps_test.go`

**Step 1: Add the test seam before the logic.** Two behaviors cannot be tested against concrete `*db.Queries` and `*minio.Client`. Add narrow interfaces on `Dependencies`, following the existing seam convention in `handler/auth.go:96-104` (`oauthStateStore`, `oauthCompletion`):

```go
	// Narrow test seams. Production falls back to Queries and MinIO.
	sourcemapCopier  func(ctx context.Context, srcKey, dstKey string) error
	sourcemapNow     func() time.Time
	completionWait   time.Duration // 0 means the default 5s
```

`sourcemapCopier` lets a test simulate "copy succeeded, activation failed" by returning nil and then having the test expire the claim. `completionWait` lets the contender test finish in milliseconds instead of five seconds.

**Step 2: Write the failing tests**

| Test | Expect |
|---|---|
| `TestCompleteFirstTime` | `200` receipt with `file_count`, `byte_count`, `completed_at` |
| `TestCompleteIdempotentRepeat` | identical receipt |
| `TestCompleteIncomplete` | `409 batch_incomplete` with `expected_files`/`received_files` and no paths |
| `TestCompleteStaleClaimChangesNothing` | `ActivateBatch` returns 0; batch untouched |
| `TestCompleteContender` | `409 batch_completion_in_progress` + `Retry-After: 2` |
| `TestCompleteCrashAfterCopyBeforeActivate` | map unresolvable; retry completes it |

**Step 3: Implement.** Claim, copy each staged object with `CopyObject`, `ActivateBatch` with the retained token. If another request holds a live lease, poll for `completionWait` (default 5s), then `409` with `Retry-After: 2`. Delete staging objects after success, best effort; a leftover staging object is invisible because no `linked` row points at it.

**Step 4: Run, commit**

```bash
cd packages/ingestion && go test ./handler -run TestComplete -v
git add packages/ingestion/handler && git commit -m "feat(ingestion): source-map batch completion"
```

---

## Task 9: Verify

**Files:** Create `handler/sourcemap_verify.go`, `handler/sourcemap_verify_test.go`

**Step 1: Decide the audit sink.** There is no audit-log table in this repo. Do not invent one. Use structured `slog` at info level with a stable message, which the test asserts by installing a capturing handler:

```go
slog.Info("sourcemap.verify",
	"user_id", userID, "project_id", projectID, "batch_id", batchID,
	"debug_id", debugID, "generated_line", line, "generated_column", col,
	"result", code)
```

Never the resolved path, never source text. `#231` can promote this to a table when the settings card needs history.

**Step 2: Write the failing tests**

| Test | Expect |
|---|---|
| `TestVerifyResolvesKnownPosition` | exact file, 1-based line, 0-based column |
| `TestVerifyResponseHasNoSourceText` | serialized response contains no fixture `sourcesContent` string and no `mappings` key |
| `TestVerifyUnmappedPosition` | `422 position_not_mapped` |
| `TestVerifyLineZero`, `TestVerifyNegativeColumn`, `TestVerifyLineOverflow` | `400 invalid_request` |
| `TestVerifyDebugIDFromDifferentBatch` | `404 map_not_found` |
| `TestVerifyOtherOrgSession` | `403` (see below; not 404) |
| `TestVerifyNameIsNullNotEmptyString` | `"name": null` |
| `TestVerifyAuditLogOmitsPathAndSource` | captured log has no path, no source text |
| `TestVerifyRateLimitedPerUserProject` | 31st call in a minute is `429 rate_limited`; a **different user** on the same project is not limited |

**Step 3: Do ownership, limiting, and auditing inside the handler, in that order**

```go
		r.With(deps.AuthenticateUserSession).
			Post("/projects/{projectID}/sourcemaps/verify", deps.VerifySourceMap)
```

No limiter middleware on this route. Three reasons it has to be in-handler:

1. `AuthenticateUserSession` sets user and org, **not** project authorization. A limiter running first would let an unauthorized caller burn another project's budget.
2. Section 9 says *every* call is audit logged. A middleware that returns `429` short-circuits before the handler, so the rate-limited calls would be the ones missing from the audit trail. Log them.
3. Ordering must be: ownership, then limit, then audit-and-serve, with the `429` branch also audited.

**Reuse the existing ownership check; do not write a new one.** Verified at `handler/read_api.go:189-209`: `checkProjectAccess` returns **403** with `"project not found or does not belong to your organization"` for a session whose active org does not own the project. It is 403, not 404, and `writeJSONError` attaches no `code`. An earlier draft of this plan claimed 404; that was wrong. Match the rest of the `/projects/{projectID}/...` family rather than making this one route behave differently, and assert 403 in the test.

```go
func (d *Dependencies) VerifySourceMap(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return // already wrote 403/401/500
	}
	userID := UserIDFromCtx(r.Context())
	if !sourcemapVerifyLimiter.allow(userID + ":" + projectID) {
		slog.Info("sourcemap.verify", "user_id", userID, "project_id", projectID,
			"result", "rate_limited")
		writeJSONErrorCode(w, http.StatusTooManyRequests, "rate limit exceeded", "rate_limited")
		return
	}
	// ... validate, resolve, audit, respond
}
```

`rateLimitBySessionUserProject` from Task 5 is then unused by this slice. Keep it only if another route needs it; otherwise drop it rather than shipping dead middleware.

**Step 4: Implement.** Validate `generated_line` (1..2147483647) and `generated_column` (0..2147483647). `GetResolvableMap`, fetch the canonical object, `sourcemapping.Parse`, `Lookup`. Return `{status, debug_id, generated{line,column}, original{file,line,column,name}}`. **Never call anything that returns source text.**

**Step 5: Run, commit**

```bash
cd packages/ingestion && go test ./handler -run TestVerify -v
git add packages/ingestion/handler && git commit -m "feat(ingestion): session-authenticated source-map verify"
```

---

## Task 10: Isolation and deletion

**Files:** Create `handler/sourcemaps_isolation_test.go`

**Scope note, stated plainly.** There is no production project-delete route, and this slice does not add one. `db.DeleteProject` plus a prefix sweep is a helper that R6's test drives and that #229 builds the durable version on. Deletion is therefore **not reachable by the product** at the end of this task. That is expected; do not go add an endpoint.

**Step 1: Write the test**

`TestTwoProjectsSameDebugIDIsolated`: projects A and B upload byte-identical maps under the same debug ID and both complete. Assert two `sourcemap_files` rows, two distinct `object_key`s, each containing its own project UUID.

`TestDeleteProjectLeavesOtherProjectIntact`: `DeleteProject(A)` plus `RemovePrefix` on A's prefix. Assert A's rows and objects are gone; assert B's row, object, and a real `verify` call all still work.

**Step 2: Run, commit**

```bash
cd packages/ingestion && go test ./handler -run 'TestTwoProjects|TestDeleteProject' -v
git add packages/ingestion/handler && git commit -m "test(ingestion): source-map project isolation and deletion"
```

---

## Task 11: Route matrix and CORS

**Files:** Modify `handler/route_matrix_test.go`; create `handler/sourcemaps_cors_test.go`

**Step 1: Restructure the matrix before adding rows.**

`TestRouteMatrixDenyByDefault` cannot simply take four more rows. Verified at `route_matrix_test.go:176-189`, its non-read branch hardcodes the **ingest** polarity: a public key must authenticate, and `matrixSK` must get `403 insufficient_scope`. The three upload routes are the exact inverse, so appending them makes the existing assertions fail on the new rows.

Add an expected-principal field to `matrixRoute` and branch on it:

```go
type matrixRoute struct {
	method  string
	pattern string
	path    string
	body    string
	// principal is which credential this route accepts:
	//   "ingest"  -> pk authenticates, sk is 403 insufficient_scope
	//   "sourcemaps" -> sk authenticates, pk is 403 insufficient_scope
	//   "session" -> only a session; every key is 401
	principal string
}
```

Set `principal: "ingest"` on the existing rows (preserving today's behavior exactly), `"session"` on the three read rows that currently use the `read` bool, and `"sourcemaps"` on the new upload rows. Then add a `wrong-project-sk` credential: R1 names a wrong-project key and the table only carries a wrong-project public key.

Run the matrix before adding new rows to confirm the refactor is behavior-preserving:

```bash
(cd packages/ingestion && go test ./handler -run TestRouteMatrix -v)
```

**Step 2: Narrow the completeness assertion.** The matrix lists ten routes while `routes.go` registers dozens under `/api/v1`, so a `chi.Walk` assertion over *all* routes cannot pass without an unmaintainable exemption list. Assert over a mechanically identifiable family instead: every route whose pattern starts with `/api/v1/sourcemaps` or ends with `/sourcemaps/verify` must appear in the table. That makes the claim true for the surface this slice adds and stays true as #226 and #231 add more.

**Step 3: CORS needs an implementation change, not just tests.**

Verified at `handler/routes.go:227-236`: the `else if origin == dashboardOrigin` branch grants `Access-Control-Allow-Origin` **and** `Access-Control-Allow-Credentials: true` to every non-SDK path. That includes the three upload routes. Contract section 2.5 says source-map upload is server-to-server and gets no browser CORS at all, so a test-only task would fail against current code.

Add a third classifier next to `isSDKEndpoint`:

```go
// isSourcemapUploadEndpoint marks the server-to-server upload routes. They get
// no browser CORS of any kind, not even the dashboard origin: no browser is
// supposed to hold an opslane_sk_. Contract 2.5.
func isSourcemapUploadEndpoint(path string) bool {
	return path == "/api/v1/sourcemaps/batches" ||
		strings.HasPrefix(path, "/api/v1/sourcemaps/batches/")
}
```

and short-circuit before the dashboard branch:

```go
	if isSourcemapUploadEndpoint(r.URL.Path) {
		// no ACAO, no credentials
	} else if isSDKEndpoint(r.URL.Path) {
		...
```

Use exact-path plus `prefix + "/"` boundaries, the same shape `isSDKEndpoint` already uses, so `/api/v1/sourcemapsX` is not classified as an upload route.

**Also make the dashboard catch-all GET-only.** Contract section 2.4 requires it, and `routes.go:180` currently registers `r.Handle("/*", ...)` for all methods, so `DELETE /anything` still serves the SPA. Change to `r.Get("/*", ...)` and add a test that `POST /not-an-api-path` no longer returns the SPA.

**Step 4: Then the per-route CORS expectations.** The earlier draft said none of the four routes gets `Access-Control-Allow-Origin`. That is wrong for verify. Contract section 2.5:

| Route | Expect |
|---|---|
| the three `sourcemaps/batches` routes | **no** `Access-Control-Allow-Origin` for any origin, including the dashboard origin; these are server-to-server |
| `/projects/{id}/sourcemaps/verify` | `Access-Control-Allow-Origin: <DASHBOARD_ORIGIN>` and `Access-Control-Allow-Credentials: true` for the configured dashboard origin, and **nothing** for any other origin |
| a lookalike path such as `/api/v1/sourcemapsX` | no permissive SDK CORS |

**Step 5: Run, commit**

```bash
(cd packages/ingestion && go test ./handler -run 'TestRouteMatrix|TestSourcemapCORS' -v)
git add packages/ingestion/handler && git commit -m "test(ingestion): route matrix and CORS for source-map routes"
```

---

## Task 12: Docs and the live run

**Files:** Modify `docs/reference/http-routes.md`

Add all four routes. That file is hand-maintained, was touched in 15 of the last 14 days of commits, and nothing enforces it.

**The live run.** Tests passing is not done. Use Compose, not the disposable
containers: Compose serves port 8082 and has its own database, MinIO, credentials,
and bucket (`opslane-replays`, user `minio`, password `minio12345`).

**Step 1: Bring up a freshly built stack.** `ingestion` uses `build:`, so without
`--build` you can smoke-test a stale binary that lacks your changes.

```bash
docker compose up -d --build postgres minio minio-setup ingestion
docker compose run --rm migrate
curl -sf localhost:8082/health && echo " health OK"
```

**Step 2: Mint the credentials.** No CLI can create a sourcemaps key (#238), so
create one directly. `db.CreateProjectKey` returns the raw value exactly once:

```bash
cat > /tmp/mintkey.go <<'GO'
//go:build ignore
package main
// Prints: <projectID> <rawSecretKey>. Run with the compose DATABASE_URL.
GO
# Use an existing seeded project, or scripts/seed-e2e.sql, then:
#   q.CreateProjectKey(ctx, projectID, db.ScopeSourcemaps, "smoke", nil)
export PROJECT=...   # uuid
export SK=...        # opslane_sk_...
export SESSION=...   # a dashboard JWT for the owning org
```

**Step 3: Build the two fixtures.** `DEBUG` must be the ID the server will
compute, so derive it rather than inventing it:

```bash
cat > /tmp/real.map <<'JSON'
{"version":3,"sources":["src/a.ts"],"names":[],"mappings":"AAAA",
 "sourcesContent":["export const x = 1;\n"]}
JSON
export DEBUG=$( (cd packages/ingestion && go run ./cmd/debugidtool /tmp/real.map) )   # or a 3-line Go main calling debugid.Compute
export SIZE=$(wc -c < /tmp/real.map | tr -d ' ')
jq -n --arg d "$DEBUG" --argjson n "$SIZE" \
  '{files:[{debug_id:$d,code_file:"assets/a.js",size_bytes:$n}]}' > /tmp/manifest.json
```

**Step 4: Run the three steps, asserting status on each.** Bare `curl` happily
continues with `BATCH=null`:

```bash
set -e
code=$(curl -sS -o /tmp/b.json -w '%{http_code}' -X POST localhost:8082/api/v1/sourcemaps/batches \
  -H "X-API-Key: $SK" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d @/tmp/manifest.json)
[ "$code" = 201 ] || { echo "create=$code"; cat /tmp/b.json; exit 1; }
BATCH=$(jq -r .batch_id /tmp/b.json); [ "$BATCH" != null ]

code=$(curl -sS -o /tmp/p.json -w '%{http_code}' -X PUT \
  "localhost:8082/api/v1/sourcemaps/batches/$BATCH/files/$DEBUG" \
  -H "X-API-Key: $SK" -H 'Content-Type: application/json' --data-binary @/tmp/real.map)
[ "$code" = 201 ] || { echo "put=$code"; cat /tmp/p.json; exit 1; }

code=$(curl -sS -o /tmp/c.json -w '%{http_code}' -X POST \
  "localhost:8082/api/v1/sourcemaps/batches/$BATCH/complete" \
  -H "X-API-Key: $SK" -H 'Content-Type: application/json' -d '{}')
[ "$code" = 200 ] || { echo "complete=$code"; cat /tmp/c.json; exit 1; }
cat /tmp/c.json
```

**Step 5: Verify, and prove the negative.**

```bash
curl -sS -X POST "localhost:8082/api/v1/projects/$PROJECT/sourcemaps/verify" \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d "{\"batch_id\":\"$BATCH\",\"debug_id\":\"$DEBUG\",\"generated_line\":1,\"generated_column\":0}"
# expect: {"status":"resolved",...,"original":{"file":"src/a.ts","line":1,"column":0,"name":null}}
# and NO "export const x = 1" anywhere in that response.

# The secret key must not be able to read anything back:
curl -sS -o /dev/null -w 'sk on verify = %{http_code}\n' -X POST \
  "localhost:8082/api/v1/projects/$PROJECT/sourcemaps/verify" -H "X-API-Key: $SK" \
  -H 'Content-Type: application/json' -d '{}'   # expect 401
```

**Step 6: Inspect storage.** `mc` lives in the `minio-setup` image, not the
`minio` server image, so `docker compose exec minio mc` fails:

```bash
docker compose run --rm --entrypoint sh minio-setup -c \
  "mc alias set local http://minio:9000 minio minio12345 >/dev/null &&
   mc ls --recursive local/opslane-replays/sourcemaps/v1/projects/$PROJECT/"
```

Expect exactly one object under `maps/` and nothing under `batches/` once
completion has swept staging.

Report the actual responses and the actual object listing. Not "this should work."

## Full gate

```bash
cd packages/ingestion && go build ./... && go test ./...
cd ../.. && pnpm -r build && pnpm test
docker compose config --quiet
MIGRATION_DIR=packages/ingestion/db/migrations ./scripts/check-migration-reapply.sh
```

## Cleanup

```bash
docker rm -f s2b-pg s2b-minio
docker compose down
```
