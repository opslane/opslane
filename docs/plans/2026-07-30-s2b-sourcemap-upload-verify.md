<!-- /autoplan restore point: /Users/abhishekray/.gstack/projects/opslane-opslane-oss/abhishekray07-s2b-securely-upload-and-verify-one-source-map-2-autoplan-restore-20260730-162541.md -->
# S2b implementation plan: securely upload and verify one source map

**Issue:** [#225](https://github.com/opslane/opslane-oss/issues/225)
**Contract:** [S0 frozen contracts](../design/2026-07-29-keys-sourcemaps-s0-contracts.md) (#216)
**Base:** `abhishekray07/s2a-carry-debug-ids-from-vite-builds-into-error` (#224), which itself sits on `main` after #243 (S1)
**Date:** 2026-07-30

---

## 1. What this slice is

Prove that one source map can be uploaded by a write-only secret key, stored
privately, and resolved for exactly one generated position by a signed-in user.
One map, correct. Not 248 maps, reliable — that is #226.

The frozen contract in #216 describes the whole system, S1 through S7. This plan
implements only the part #225's R1–R6 require, and names every deferral.

---

## 2. Where we start

S1 (#243) already landed on `main`:

| Thing | Location | State |
|---|---|---|
| `project_api_keys` table, both scopes | `db/migrations/028_project_api_keys.sql` | done |
| `ProjectKey(scope)` middleware, `403 insufficient_scope` | `handler/project_keys.go:15-69` | done, no `sourcemaps` route consumes it yet |
| `db.ScopeIngest` / `db.ScopeSourcemaps` | `db/project_keys.go:21-22` | done |
| `POST /api/v1/sourcemaps` | deleted | gone |
| MinIO client: Put/Get/Stat/Remove/RemovePrefix | `minio/client.go` | done |

S2a (#224) is in flight on its own branch and already landed:

| Thing | Location | State |
|---|---|---|
| Go canonicalizer + fingerprint | `packages/ingestion/debugid/debugid.go` (385 lines) | done; `Compute([]byte) (Result{DebugID, ContentSHA256}, error)` |
| `jcs` RFC-8785 dependency | `go.mod`, `github.com/gowebpki/jcs v1.0.1` | present (currently marked indirect) |
| Map shape validation + stable reject reasons | `debugid.validateSourceMap` | done |
| Go golden-vector tests | `debugid/debugid_test.go` | done |
| Postgres raw-UUID round trip | `db/debugid_storage_test.go` | done |

Nothing source-map-shaped exists in `handler/` or `db/`.

### 2.1 Decisions taken before planning

| # | Question | Decision |
|---|---|---|
| D1/D5 | Who owns the Go hasher | #224 owns it. #225 imports `packages/ingestion/debugid` and branches off the #224 branch. One hasher, one set of golden vectors. |
| D2 | Vite plugin | Out of scope. It cannot stamp a debug ID without #224's TypeScript hasher. Its build-time error message is retargeted from #218 to #226. |
| D3 | Limits and leases | Correctness machinery only: status machine, completion lease, `expires_at`. No rate limits, no byte budgets, no per-PUT concurrency leases, no `Retry-After`. Abuse protection is not a v1 requirement. |
| D4 | Project deletion | Best-effort: cascade plus a synchronous prefix delete. No tombstone table, no retry worker. Durability is #229's job. Accepted risk stated in §8. |

---

## 3. Requirement to work mapping

| Req | What it demands | Where it lands |
|---|---|---|
| R1 | Active sk can create/upload/complete; public, revoked, malformed, wrong-project rejected | Three routes behind `ProjectKey(db.ScopeSourcemaps)`; `handler/sourcemaps_auth_test.go` |
| R2 | Server recomputes the fingerprint; identical content idempotent, conflicting content rejected | `debugid.Compute` in the PUT path; `409 debug_id_mismatch` / `409 debug_id_conflict` |
| R3 | Completed maps stored per project; incomplete uploads invisible to resolution | `sourcemap_files` keyed `(project_id, debug_id)`; verify reads only `linked` rows on `complete` batches |
| R4 | Session verify returns only path, line, column, function | `POST /projects/{projectID}/sourcemaps/verify`; response-shape assertion scans for source text |
| R5 | No surface downloads a full map | Route enumeration test; no presigned URL is minted for any `sourcemaps/` key |
| R6 | Deleting a project deletes its map, not another project's same ID | `db.DeleteProject` + `RemovePrefix`; two-project isolation test |

---

## 4. Task list

### T1 — Return canonical bytes from `debugid.Compute`

`Compute` today discards the canonical JSON after hashing. §8.1 requires
staging to hold the deterministic canonical bytes, not the raw request, and
`sourcemap_files.size_bytes` is the canonical length.

- Add `Canonical []byte` and `CanonicalSize int64` to `debugid.Result`.
- Reject `CanonicalSize > 104857600` with reason `too_large` before returning.
- Promote `gowebpki/jcs` from `// indirect` to a direct require.
- Extend `debugid_test.go`: for each of #216 §6.1's three golden vectors,
  assert `string(Canonical)` equals the frozen `canonical` string byte for byte.
  That is a stronger assertion than the digest alone and it costs three lines.

This is an additive change to a package #224 owns. Coordinate on the #224
branch so there is no merge conflict.

### T2 — Migration `031_sourcemap_batches.sql`

Copy #216 §8.1 verbatim for these three objects:

- `sourcemap_batches`, including every `CHECK` (status/timestamp coherence,
  received-count bounds, `expires_at > created_at`, the completing-lease
  coherence check, and the `status IN ('completing','complete')` full-receipt
  check).
- `sourcemap_files`, including the `object_key` derivation `CHECK` and the
  `UNIQUE (project_id, debug_id)` / `UNIQUE (project_id, object_key)` pair.
- `sourcemap_batch_files`, including the three-state `pending`/`staged`/`linked`
  coherence `CHECK` and both composite foreign keys.
- `prevent_sourcemap_file_identity_update()` and its `BEFORE UPDATE` trigger.
- Indexes: `idx_sourcemap_batches_project_health`,
  `idx_sourcemap_batches_expiry`, `idx_sourcemap_batches_completion_reclaim`,
  `idx_sourcemap_batch_files_source_map`.

Deliberately omitted from this migration:

- `sourcemap_project_tombstones` — D4.
- `idx_project_api_keys_last_rejected` — serves the §11 status endpoint and
  depends on `last_rejected_at`, which #217 deferred to #230.

Guard every statement with `IF NOT EXISTS` / `CREATE OR REPLACE` per
`packages/ingestion/AGENTS.md`. Renumber if #224 lands its own `030` first.

**Migration numbering note:** #224 currently carries `028_event_debug_meta.sql`,
which collides with S1's `028_project_api_keys.sql` on `main`. #224 must
renumber to `030` before merge; this plan assumes `031`.

### T3 — `db/sourcemaps.go`

Every function takes `projectID` and filters on it in SQL, per
`packages/ingestion/AGENTS.md`.

- `CreateSourceMapBatch(ctx, projectID, keyDBID, idempotencyKey, manifest)` —
  one transaction inserting the batch and all `sourcemap_batch_files` rows.
  On `UNIQUE (project_id, upload_key_db_id, idempotency_key)` conflict, load
  the existing row and compare `manifest_sha256`: equal returns it with a
  `reused` flag, different returns `ErrIdempotencyConflict`.
- `GetBatchForUpload(ctx, projectID, batchID)` — returns the batch and its
  declared file row, or `ErrBatchNotFound`. Cross-project lookups return the
  same error, never a 403, so batch IDs are not enumerable.
- `StageBatchFile(...)` — one transaction: write digests, sizes, staging key;
  flip `pending → staged`; increment `received_file_count` / `received_bytes`
  only on the first transition out of `pending`.
- `LinkExistingArtifact(...)` — the §8.3 step 2 shortcut. If an activated
  `sourcemap_files` row already has this `(project_id, debug_id)` and the same
  `content_sha256`, go straight to `linked` and write no staging object. A
  different digest returns `ErrDebugIDConflict`.
- `ClaimBatchCompletion(ctx, projectID, batchID)` — atomically moves one fully
  received `pending` batch to `completing`, sets `completion_claimed_at` and a
  five-minute `completion_lease_expires_at`, and returns the exact
  database-generated `completion_claimed_at`. That timestamp is this request's
  claim token.
- `ActivateBatch(ctx, projectID, batchID, claimedAt, rows)` — the single
  visibility point. Locks the batch, revalidates `status = 'completing'`, a
  live lease, the exact `claimedAt`, and exact received counts; inserts missing
  `sourcemap_files` rows; on `(project_id, debug_id)` conflict reuses the row
  when digest and canonical size match and aborts with `ErrDebugIDConflict`
  otherwise; links every manifest row; sets `status = 'complete'` and
  `completed_at`; clears both completion timestamps. A stale claim changes zero
  rows and reports that to the caller.
- `GetResolvableMap(ctx, projectID, batchID, debugID)` — used by verify.
  Joins `sourcemap_batch_files` to `sourcemap_files` and requires
  `sourcemap_batch_files.state = 'linked'` AND
  `sourcemap_batches.status = 'complete'`. This one predicate is what makes R3
  true; an interrupted batch has no `linked` row and no `complete` status.
- `DeleteProject(ctx, projectID)` — deletes the project row in a transaction
  and lets the existing `ON DELETE CASCADE` chain remove batches, batch files,
  and map rows. Returns the project's storage prefix so the caller can sweep.

### T4 — `handler/sourcemaps.go`: the three sk routes

Registered inside the `/api/v1` group:

```go
sourcemapKey := deps.ProjectKey(db.ScopeSourcemaps)
r.With(sourcemapKey).Post("/sourcemaps/batches", deps.CreateSourceMapBatch)
r.With(sourcemapKey).Put("/sourcemaps/batches/{batchID}/files/{debugID}", deps.UploadSourceMapFile)
r.With(sourcemapKey).Post("/sourcemaps/batches/{batchID}/complete", deps.CompleteSourceMapBatch)
```

Project ID always comes from `ProjectIDFromCtx`. No request body or path
segment ever supplies it.

**`POST /sourcemaps/batches`**

- Read at most 256 KiB with `http.MaxBytesReader`; over that is
  `413 manifest_too_large`.
- Require an `Idempotency-Key` header parseable as a UUID.
- Validate per §7.1: 1–500 files, unique `debug_id`, `code_file` 1–4096 UTF-8
  bytes with no control characters, `size_bytes` 1–104857600, summed
  `size_bytes` at most 1 GiB, optional 40/64-hex `commit_sha`, optional
  `release` at most 200 bytes, optional `probe`.
- Normalize: apply defaults, sort files by `debug_id`, keep only recognized
  fields, serialize with `jcs`, hash to `manifest_sha256`.
- `expires_at = now() + 1 hour`.
- `201` for a new batch, `200` for an identical retry,
  `409 idempotency_conflict` for the same key with a different manifest.

**`PUT /sourcemaps/batches/{batchID}/files/{debugID}`**

Ordering matters; the contract fixes precedence:

1. Batch must exist in this project, else `404 batch_not_found`.
2. `expires_at` in the past, else `410 batch_expired`.
3. Debug ID must be declared in this batch, else `409 debug_id_not_declared`.
   This precedes the already-complete check, per §7.2.
4. `Content-Length` required, else `411 length_required`; must equal the
   manifest declaration, else `409 size_mismatch`.
5. `Content-Type` must be `application/json`, else
   `415 unsupported_media_type`. No `Content-Encoding` support in v1.
6. Read the body through `http.MaxBytesReader` set to the declared length. No
   unbounded `io.ReadAll`.
7. `debugid.Compute(body)`. A validation failure is `400 invalid_source_map`.
   A computed ID that differs from the path `{debugID}` is
   `409 debug_id_mismatch`.
8. Batch already `complete`: a matching canonical digest returns idempotent
   `200 already_present`; any other body returns `409 batch_already_complete`.
   This lifecycle check outranks reclassifying the body as a mismatch.
9. Try `LinkExistingArtifact`. If it links, return `201`/`200` with no object
   write. A different digest is `409 debug_id_conflict`.
10. Otherwise write `result.Canonical` to
    `sourcemaps/v1/projects/{project}/batches/{batch}/{debug}.map` and call
    `StageBatchFile`. Storage failure is `503 storage_unavailable`.
11. Response: `{batch_id, debug_id, status, received_bytes}` with `status` of
    `stored` or `already_present`. `received_bytes` is the raw received length.

**`POST /sourcemaps/batches/{batchID}/complete`**

- `404` unknown or cross-project, `410` expired.
- Already `complete` returns the original receipt with `200`.
- Not fully received returns `409 batch_incomplete` with `expected_files` and
  `received_files` and nothing else — no paths, no map data.
- `ClaimBatchCompletion`. If another request holds a live lease, wait up to
  five seconds for it, then return `409 batch_completion_in_progress` with
  `Retry-After: 2`.
- For every `staged` row: if an activated artifact already matches
  `(project_id, debug_id)` with the same digest, skip the copy; a different
  digest aborts with `409 debug_id_conflict`. Otherwise copy the staging object
  to `sourcemaps/v1/projects/{project}/maps/{content_sha256}.map`.
- `ActivateBatch` with the retained claim token. A stale claim means the batch
  was completed or reclaimed underneath us: re-read and return the current
  receipt, or `409` if it expired.
- Delete staging objects after success, best effort. A leftover staging object
  is invisible: no `linked` row points at it.
- Receipt: `{batch_id, status, file_count, byte_count, commit_sha, release,
  probe, completed_at}`.

### T5 — `POST /api/v1/projects/{projectID}/sourcemaps/verify`

Behind `deps.AuthenticateUserSession`, plus the same
project-belongs-to-active-org check the neighbouring project routes use.

- Validate `batch_id`, `debug_id`, `generated_line` (1-based, 1..2147483647),
  `generated_column` (0-based, 0..2147483647).
- `GetResolvableMap`. Missing batch or wrong project is `404 batch_not_found`;
  a debug ID with no `linked` row is `404 map_not_found`.
- Fetch the canonical object, parse it, look up the position.
- `422 position_not_mapped` when the position has no mapping.
- `200` with `{status, debug_id, generated{line,column},
  original{file,line,column,name}}`. `name` is nullable. **No source snippet
  and no map bytes, ever.**
- Audit-log user, project, batch, debug ID, generated line/column, result code,
  timestamp. Never the resolved path or any source text.

**Convention verified by running it, not by reading docs.** Against
`go-sourcemap/sourcemap` v2.1.4 with a hand-built map:

```
gen(line=1,col=0) -> ok=true  src="src/a.ts" name="render" line=1 col=0
gen(line=2,col=0) -> ok=true  src="src/a.ts" name=""       line=2 col=0
gen(line=1,col=5) -> ok=true  src="src/a.ts" name="render" line=1 col=0
gen(line=3,col=0) -> ok=false
```

`Consumer.Source(genLine, genCol)` takes 1-based line and 0-based column and
returns 1-based line and 0-based column. That matches contract section 9 on
both ends, so no conversion is needed and there is no off-by-one. `ok=false`
maps to `422 position_not_mapped`. An empty `name` must serialize as JSON
`null`, not `""`.

**Custody guardrail, also verified:** the same consumer exposes
`SourceContent(source)` and it returns the embedded original source text. The
library holds `sourcesContent` in memory. The verify handler must never call
`SourceContent`, and the R4 test must assert the response contains none of the
fixture's source strings. This is one line away from being the exact leak R4
and R5 forbid.

**Dependency decision — Go source-map consumer.** The verify endpoint needs
generated-to-original lookup in Go; today symbolication only exists in the
TypeScript worker. Recommendation: add `github.com/go-sourcemap/sourcemap`
v2.1.4 (BSD-2-Clause, compatible with this package's AGPL-3.0-only). Its
`Consumer.Source(line, col)` returns exactly the four fields we return and
nothing else. Writing VLQ decoding plus binary search by hand is roughly 120
lines and a new source of off-by-one bugs on a 1-based/0-based boundary the
contract is picky about. Tradeoff to accept: the library parses the entire map
including `sourcesContent` into memory, so a 100 MiB map costs real memory for
one verify call. Acceptable for a one-map, rate-limited-later, session-only
endpoint; revisit if #227's worker path needs streaming.

### T6 — Route hygiene

- `isSDKEndpoint` must not match `/api/v1/sourcemaps/...`. It uses exact prefix
  boundaries today, so it already does not — add a regression case rather than
  a code change. Source-map upload is server-to-server and gets no permissive
  CORS.
- Add the `/api/v1` JSON not-found handler required by §2.4. **Measured, not
  assumed:** with `DASHBOARD_DIR` set the way the production Dockerfile sets
  it, `POST /api/v1/sourcemaps` already returns `404` — chi's `/api/v1`
  subrouter owns that subtree, so the SPA catch-all never sees it. The gap is
  narrower than §2.4's wording implies: the body is
  `text/plain "404 page not found\n"` with no `code` field, where the contract
  requires `404 {"error":..., "code":"not_found"}`. One `r.NotFound(...)`
  inside the `/api/v1` group. Also register a `MethodNotAllowed` handler so a
  wrong method returns JSON rather than chi's plain-text 405.
- `ProjectKey` currently resolves the project's `production` environment on
  every authenticated request, including `sourcemaps`-scope ones that have no
  use for it, and 500s if it is missing. Skip the environment lookup when the
  scope is not `ingest`. Small, in blast radius, removes a needless failure
  mode on the new routes.

### T7 — Project deletion (R6)

- `db.DeleteProject` as described in T3.
- Caller deletes `sourcemaps/v1/projects/{project_uuid}/` via the existing
  `minio.Client.RemovePrefix`.
- No HTTP endpoint. No product-facing delete exists today and #225 does not add
  one; the helper is what R6's test drives and what #229 will build on.

---

## 5. Test plan

Integration tests need Postgres and MinIO. Follow the existing
`testPool`-style skip-if-unreachable pattern, and use a disposable database per
`AGENTS.md` — port 5434 is shared across worktree sessions.

### R1 — authorization matrix (extend `handler/route_matrix_test.go`)

**Do not write a new auth test file.** S1 already shipped
`handler/route_matrix_test.go:TestRouteMatrixDenyByDefault`, which crosses every
project-key route with `none`, `pk`, `sk`, `revoked`, `malformed`,
`wrong-project-pk`, and `session`. Add the three batch routes and the verify
route to its `routes` table and add one missing credential,
`wrong-project-sk` — R1 names a wrong-project key and the existing table only
carries a wrong-project *public* key.

Two gaps in that test worth closing while we are in it:

- The `routes` table is hand-maintained. #217's risk table claims "route matrix
  defaults to deny; a route opts in," but nothing enforces that today: add a
  route and the matrix silently ignores it. Add a `chi.Walk` assertion that
  every registered `/api/v1` route either appears in the table or in a short,
  named exemption list. Ten lines, and it makes the claim true.
- Assert the JSON 404/405 shape from T6 in the same test.

Each of the three routes crossed with:

| Credential | Expected |
|---|---|
| active `opslane_sk_` for this project | 2xx |
| active `opslane_pk_` | `403 insufficient_scope` |
| revoked `opslane_sk_` | `401 invalid_api_key` |
| malformed key (bad prefix, bad `key_id`, wrong secret) | `401 invalid_api_key` |
| valid `opslane_sk_` for a different project | `404 batch_not_found` |
| no credential | `401 invalid_api_key` |
| session cookie instead of a key | `401 invalid_api_key` |

The public-key row is the first real exercise of S1's `sourcemaps` scope. Until
now no route accepted it.

### R2 — fingerprint and idempotency

- Upload map M declaring its true ID → `201 stored`. Upload M again → `200
  already_present`, still one `sourcemap_files` row, one object.
- Upload M under a different declared debug ID → `409 debug_id_mismatch`.
- Complete a batch with M. Then, in a second batch, upload different bytes
  claiming M's debug ID via a database-seeded digest → `409 debug_id_conflict`.
  Producing that collision through the real hash is infeasible, so seed it, the
  way #216 §13.11 specifies.
- Reordering manifest fields and file order does not change `manifest_sha256`.
- Same `Idempotency-Key`, different manifest → `409 idempotency_conflict`.

### R3 — per-project storage and invisibility

- Projects A and B upload byte-identical M under the same debug ID and both
  complete. Assert two `sourcemap_files` rows, two distinct `object_key`s, and
  that A's key contains A's UUID and B's contains B's.
- A third batch uploads M and never completes. Assert `verify` returns
  `404 map_not_found`, the batch is `pending`, and no `sourcemap_files` row
  exists for it.
- A `completing` batch whose activation transaction fails leaves no `linked`
  row and no resolvable map.

### R4 — verify response shape

- Build a small real map fixture whose generated position is known. Resolve it
  and assert `original.file`, `original.line` (1-based), `original.column`
  (0-based), and nullable `name`.
- Serialize the whole response and assert it contains none of the fixture's
  `sourcesContent` strings and no `"mappings"` key.
- Unmapped position → `422 position_not_mapped`.
- Another org's session on this project → 404.

### R5 — no download surface

- Walk every route registered by `NewRouter` via `chi.Walk`. For each, assert
  no path segment is a map object key and no handler returns
  `application/octet-stream` for a `sourcemaps/` key.
- Assert `PresignedPutURL` is never called with a `sourcemaps/` prefix.
- Assert `GET /api/v1/sourcemaps/batches/{id}/files/{debugID}` is `404`.
- Assert `POST /api/v1/sourcemaps` is `404` with code `not_found`, not SPA HTML.

### R6 — deletion isolation

- Projects A and B, same debug ID, same bytes, both complete.
- `DeleteProject(A)` plus prefix sweep.
- Assert A's rows are gone and A's object is gone from storage.
- Assert B's row, B's object, and B's `verify` all still work.

### Cross-cutting

- Log scan: run the full suite with a capturing handler and assert no log line
  contains an object key, a secret, or fixture source text.
- Migration reapply: apply `031` twice against a disposable database.

---

## 6. Verification gate

```bash
cd packages/ingestion && go build ./... && go test ./...
pnpm -r build
pnpm test
docker compose config --quiet
```

Then a live run, per repo convention: apply migrations, start Postgres and
MinIO, mint an `opslane_sk_`, run the three-step upload against the real
server with a real map, and call `verify` with a real session. Report the
actual HTTP responses and the actual MinIO object listing, not a claim that it
should work.

---

## 7. Explicitly not in scope

| Deferred | Owner | Why |
|---|---|---|
| Vite plugin upload path, stamping, spill custody | #224 stamping, #226 upload | D2; plugin cannot stamp without #224's TypeScript hasher |
| Rate limits, rolling byte budgets, per-PUT concurrency leases, `Retry-After` on budget | #226 | D3; abuse protection is not a v1 requirement |
| Batch expiry sweeper worker, staging garbage collection | #226 | D3; `expires_at` is stored and checked, nothing reaps yet |
| Tombstones, leased deletion worker, retry-until-empty, docs | #229 | D4 |
| `GET /projects/{id}/sourcemaps/status` (§11) | #231 | not an R in #225 |
| `debug_meta` on events, `resolution_*` columns (§5, §10) | #224, #227 | not an R in #225 |
| Worker symbolication, source snippet cache | #227 | not an R in #225 |
| `last_used_at`, `last_rejected_at` | #230 | #217 deferred them |
| Key management UI and CLI | #230, #238 | #217 deferred them |

---

## 8. Risks

| Risk | Mitigation | Residual |
|---|---|---|
| A crash between object copy and the activation transaction leaves an unreferenced canonical object | §8.3 step 6: the activation transaction is the only visibility point, so the orphan is unreadable; retry re-copies safely | An orphan object occupies storage until project deletion. Accepted; #226 owns collection. |
| Two requests complete the same batch at once | Claim token: `ActivateBatch` requires the exact `completion_claimed_at` it was handed, so a stale claim changes zero rows | None known; covered by test |
| Equal debug IDs across projects reuse each other's bytes | Every row and object key carries the project UUID; two-project test asserts two objects | None |
| Storage delete fails during project deletion and nothing retries | **None in this slice.** D4 chose best-effort on the basis that production is S3 and will be up. | Customer source can survive a failed delete with no record that it did. #229 adds the durable sweep. Stated and accepted. |
| No upload rate limiting on a write-only key | **None in this slice.** D3 deferred abuse protection. | A leaked `opslane_sk_` can consume unbounded storage. Mitigated only by revocation. #226 adds budgets. |
| #224's `debugid` API shifts before merge | #225 branches off #224 and the canonical-bytes change is made there | Merge churn if #224 rebases |
| Migration number collision (both branches used `028`) | #224 renumbers to `030`, #225 takes `031` | Must be checked at merge time |

---

# CEO REVIEW (Phase 1)

Mode: SELECTIVE EXPANSION, constrained by an explicit user instruction not to
increase scope. Expansions are surfaced, not adopted.

## 0A. Premise challenge

**P1: "The public browser key can upload source maps, so a copied key can poison
the fix agent."** This is #225's opening sentence and it is **false today**.
#217/#243 deleted `POST /api/v1/sourcemaps`. Measured: with `DASHBOARD_DIR` set
as the production Dockerfile sets it, that path returns `404`. The issue's own
"Inherited from #217" section already says this. The stated problem is solved;
what remains is building the replacement. Keep the work, fix the framing.

**P2: "Maps must be uploaded at all."** Open issue #245 asks whether the worker
could regenerate maps in its sandbox from the repo. The spike (design §5.2.1)
proved 248/248 maps byte-reproducible across two clean builds of one real app.
If that holds across customers, this entire pipeline is optional. **This premise
is assumed, not tested.** Counter-evidence verified in this repo: the worker
shallow-clones the current default branch (`worker/src/harness/sandbox-repo.ts`),
not the deployed commit, and symbolication runs before the sandbox exists
(`worker/src/index.ts:361`). Reproducing a customer's CI artifact needs the exact
commit, Node version, package manager, build mode, and build-time env. The spike
proved same-machine determinism, not cross-environment reproducibility. Verdict:
regeneration is plausible as a future default, unproven as a replacement. It does
not block this slice, but it should be resolved before #226's plugin custody work.

**P3: "One-map correctness is the right unit of work."** Defensible. It is the
smallest slice that makes the sk boundary real. But it cannot answer the only
question that matters commercially, which is whether symbolication improves fix
quality. #244 exists to measure that and is not blocked by this.

**P4: "The frozen S0 contract's complexity is justified."** Partly assumed. The
contract was written for the whole S1-S7 arc against a real 248-map, 29.6 MB
build. For one map it is heavy. But it is frozen, #224 is already implementing
against it, and diverging now costs two implementations. Accept.

**P5: "Do nothing" cost.** Real and documented, not hypothetical. #242 shows the
concrete damage: minified frames make the fix agent's scope reviewer tell the
agent its own correct edit is out of scope and invite it to revert it. Today
every CLI-onboarded app hits this. That is the strongest justification in the
set, and notably it is not the one #225 leads with.

## 0B. Existing code leverage

| Sub-problem | Existing code | Reuse or build |
|---|---|---|
| Authenticate an sk, reject pk | `handler/project_keys.go:15` `ProjectKey(scope)` | Reuse unchanged |
| Scope constants | `db/project_keys.go:21-22` | Reuse |
| Canonicalize and fingerprint a map | `packages/ingestion/debugid` (#224) | Reuse, add canonical bytes |
| Object put/get/remove/prefix-remove | `minio/client.go:90-143` | Reuse |
| Auth matrix across credentials | `handler/route_matrix_test.go` | **Extend, do not duplicate** |
| Session + project-in-org check | the `/projects/{projectID}/...` route family | Reuse the pattern |
| Resolve a generated position | `packages/worker/src/source-map.ts` (TypeScript, wrong runtime) | Build in Go |
| Bounded body reads | `handler/ingest_limits.go` | Reuse the pattern |
| Rate limiting by project | `rateLimitByProject(...)` in `routes.go` | **Already exists, unused by this plan** |

The last row matters. Per-project rate limiting is already built and wired on
six ingest routes. Applying it to the new routes is one middleware argument, not
new infrastructure. That materially changes the cost of decision D3.

## 0C. Dream state

```
  CURRENT STATE                THIS PLAN                    12-MONTH IDEAL
  -------------                ---------                    --------------
  No upload path at all.       Three sk routes + storage    Zero config. Plugin
  Plugin fails the build.      + one session verify.        stamps and uploads,
  Every minified frame         One map, provably private,   or the worker
  reaches the fix agent as     project isolated, and        regenerates and never
  garbage; #242 shows the      resolvable.                  needs an upload.
  agent then reverts its                                    Customer never
  own correct patch.           Still nothing end to end:    configures a second
                               no event carries a debug     secret. Fix quality
                               ID yet, no worker reads a    measurably better,
                               map, no customer benefit.    with #244's numbers.
```

**Delta:** this plan builds the load-bearing middle of the arc and delivers zero
user-visible value on its own. Correct for a tracer-bullet slice, and also the
honest reason it must not sprawl.

## 0C-bis. Implementation alternatives

```
APPROACH A: Full frozen contract now
  Summary: Implement S0 sections 7-9 completely, including cluster-wide budgets,
           per-PUT leases, the expiry sweeper, and tombstoned deletion.
  Effort:  XL   (human: ~2 weeks / CC: ~1 day)
  Risk:    Med
  Pros:    Contract conformant. #226 shrinks to plugin work. Nothing to revisit.
  Cons:    Duplicates #226's multi-replica test plan. Builds throughput
           machinery before any traffic exists to throttle.
  Reuses:  debugid, minio, ProjectKey

APPROACH B: Correctness core plus reused limiters  (RECOMMENDED)
  Summary: The plan as written, plus the thing 0B surfaced: apply the existing
           rateLimitByProject middleware to the three sk routes and verify, at
           the contract's stated numbers.
  Effort:  L    (human: ~1 week / CC: ~3 hours)
  Risk:    Low
  Pros:    Same scope, one extra middleware argument per route. Closes the
           enumeration oracle on verify that the parent design section 5.6 names
           as part of its custody guarantee. Removes the unbounded-leaked-sk
           finding both voices raised.
  Cons:    Not the full cluster-wide budget story; a multi-replica deployment
           still has per-replica limits until #226.
  Reuses:  debugid, minio, ProjectKey, rateLimitByProject, route_matrix_test

APPROACH C: Defer the server, prototype #245 first
  Summary: Spend this slice measuring whether worker-side regeneration matches
           deployed debug IDs on 10-20 real repos. Build upload only if it fails.
  Effort:  M    (human: ~4 days / CC: ~2 hours)
  Risk:    High
  Pros:    Could make the pipeline unnecessary. Answers P2 with data.
  Cons:    #224 has already shipped the stamping half against the frozen
           contract. #226 and #229 are sequenced behind #225. Reordering now
           strands committed work. Regeneration also cannot cover customers
           whose build is not reproducible, so an upload path is needed anyway.
  Reuses:  worker sandbox, debugid
```

**RECOMMENDATION: B.** The user's stated scope plus one reused middleware.
Explicit over clever, and it reuses infrastructure that already exists rather
than deferring a control to a later issue.

## 0D. Selective expansion scan

Complexity check: roughly 8 files (1 migration, `db/sourcemaps.go`,
`handler/sourcemaps.go`, `handler/sourcemap_verify.go`, `routes.go`,
`debugid.go`, `route_matrix_test.go`, plus tests). At the edge of the 8-file
smell threshold, not over it, and no new service or abstraction layer.

| # | Candidate | Effort | Disposition |
|---|---|---|---|
| E1 | Apply existing `rateLimitByProject` to the four new routes | S (CC ~15 min) | **Escalate as a user challenge** — both voices call its absence a defect and 0B shows it is nearly free |
| E2 | Batch expiry sweeper | M | Defer to #226 |
| E3 | Tombstoned durable deletion | M | Defer to #229 (user decided) |
| E4 | `chi.Walk` completeness assertion on the route matrix | S | **Adopt** — in blast radius; makes #217's "deny by default" claim true |
| E5 | JSON 404/405 handler on `/api/v1` | S | **Adopt** — measured gap against contract section 2.4 |
| E6 | Skip the environment lookup for non-ingest scopes in `ProjectKey` | XS | **Adopt** — removes a 500 path on the new routes |
| E7 | Recommend `sourcemapPathTransform` in docs (spike found absolute home paths inside stored maps) | S | Defer to #226 docs |
| E8 | Retention expiry policy for stored maps | L | Defer, record in TODOS.md |

## 0E. Temporal interrogation

```
HOUR 1 (foundations)   Which branch? The #224 branch, decided (D5).
                       Which migration number? 031, after #224 renumbers to 030.
HOUR 2-3 (core logic)  The PUT check ordering is contract-fixed and counter
                       intuitive: debug_id_not_declared outranks
                       batch_already_complete. Written into T4 so it is not
                       rediscovered through a failing test.
                       received_bytes in the response is the RAW length;
                       size_bytes in sourcemap_files is the CANONICAL length.
                       Easy to swap, and the CHECK constraints will not catch it.
HOUR 4-5 (integration) The claim-token protocol. ActivateBatch must compare the
                       exact completion_claimed_at it was handed. Wrong looks
                       fine until two completes race.
                       minio/client.go has no CopyObject today, only Put and
                       Get. Completion's staging-to-canonical copy would round
                       trip through ingestion memory: 100 MiB of heap per map.
HOUR 6+ (polish)       docs/reference/http-routes.md is hand maintained on every
                       route change (15 commits in 14 days) and nothing enforces
                       it. Four new routes must land there.
                       docs/contracts/ has no source-map page yet.
```

The MinIO copy point is a real gap the plan did not name. Adding `CopyObject` to
`minio/client.go` (the minio-go SDK provides it) keeps the bytes server side.
One method, in blast radius. **Adopt.**

## 0F. Mode confirmation

SELECTIVE EXPANSION, Approach B, with E4/E5/E6 and `CopyObject` adopted as
blast-radius work, and E1 escalated to the user rather than auto-adopted.

## Error and rescue registry

| Failure | Named error | Who sees it | Rescue | Tested |
|---|---|---|---|---|
| Manifest over 256 KiB | `413 manifest_too_large` | plugin build log | shrink batch | yes |
| Duplicate debug ID in manifest | `400 duplicate_debug_id` | plugin | fix build | yes |
| Same idempotency key, different manifest | `409 idempotency_conflict` | plugin | new key | yes |
| Body length missing | `411 length_required` | plugin | set Content-Length | yes |
| Body length differs from declaration | `409 size_mismatch` | plugin | re-declare | yes |
| Map fails contract section 6 validity | `400 invalid_source_map` | plugin | regenerate | yes |
| Computed ID differs from claimed ID | `409 debug_id_mismatch` | plugin | poisoned or stale map | yes |
| Same ID, different full digest | `409 debug_id_conflict` | plugin | immutability held | yes (seeded) |
| PUT to a completed batch | `409 batch_already_complete` | plugin | new batch | yes |
| Undeclared debug ID | `409 debug_id_not_declared` | plugin | fix manifest | yes |
| Batch past `expires_at` | `410 batch_expired` | plugin | new batch | yes |
| Complete with files missing | `409 batch_incomplete` plus counts | plugin | retry PUTs | yes |
| Two completes race | `409 batch_completion_in_progress`, `Retry-After: 2` | plugin | retry | yes |
| Object storage down | `503 storage_unavailable` | plugin | retry | yes |
| Verify: unmapped position | `422 position_not_mapped` | dashboard | none needed | yes |
| Verify: no linked map | `404 map_not_found` | dashboard | upload first | yes |
| **Storage delete fails during project deletion** | **none** | **nobody** | **none** | **no** |
| **Leaked sk floods storage** | **none** | **nobody** | **manual revoke** | **no** |
| **Abandoned `completing` lease** | **none** | **nobody** | **none until #226** | **no** |

The last three are the plan's silent failures. Prime Directive 1 says a failure
that can happen silently is a critical plan defect. Two are user decisions
(D3, D4). The third was never surfaced as a decision; see F8.

## Failure modes registry

| # | Mode | Severity | Status in plan |
|---|---|---|---|
| F1 | Crash between object copy and activation leaves an orphan object | Low | Handled: activation is the only visibility point |
| F2 | Two completes interleave and double the counts | High | Handled: claim token |
| F3 | Cross-project debug-ID reuse | Critical | Handled: project UUID in every row and object key |
| F4 | Verify leaks source text | Critical | Handled: response-shape assertion |
| F5 | Verify enumerates source paths one position at a time | Medium | **Unhandled.** Design section 5.6 names rate limiting as part of the mitigation; D3 removed it |
| F6 | Leaked sk consumes unbounded storage and CPU | High | **Unhandled.** D3 |
| F7 | Project deletion half fails, source survives untracked | High | **Unhandled.** D4 |
| F8 | A `completing` batch whose request dies is stuck forever | Medium | **Unhandled and never surfaced as a decision.** The contract makes an expired lease reclaimable. With no reclaimer the batch can never complete and its declared files can never be re-uploaded, so that build's maps are unrecoverable without a whole new batch. Not merely inefficient. |
| F9 | 100 MiB map parsed into ingestion heap on verify | Medium | Named as an accepted tradeoff in T5 |
| F10 | Staging-to-canonical copy round trips bytes through ingestion memory | Medium | Newly found in 0E. Fix: add `CopyObject` |

---

# ENG REVIEW (Phase 3)

## Step 0: scope challenge

Files touched: 1 migration, `db/sourcemaps.go`, `handler/sourcemaps.go`,
`handler/sourcemap_verify.go`, `handler/routes.go`, `debugid/debugid.go`,
`minio/client.go`, `handler/route_matrix_test.go`, plus test files. Eight
production files, no new service, no new abstraction layer. Under the smell
threshold. No scope reduction proposed.

Minimum set that achieves R1-R6: everything in T2-T5 plus the R6 delete helper.
T1 is a prerequisite. T6 is blast-radius cleanup, adopted in the CEO phase.

**Search check.** `[Layer 1]` The three-step declare/upload/complete protocol is
what Sentry (`sentry-cli sourcemaps upload`) and PostHog both do; not novel.
`[Layer 1]` RFC 8785 canonicalization via `gowebpki/jcs` is the standard Go JCS
implementation and is already a transitive dependency. `[Layer 2]`
`go-sourcemap/sourcemap` v2.1.4 is the de facto Go consumer; last release is
old, but the source-map v3 format is frozen so staleness is low risk.
`[Layer 3]` Nothing here contradicts conventional wisdom. No eureka.

## Section 1: architecture

```
                        ingestion (Go)
  ┌───────────────────────────────────────────────────────────┐
  │                                                           │
  │  routes.go                                                │
  │    ├── ProjectKey(ScopeSourcemaps) ──┐                    │
  │    │     (EXISTS, S1)                │                    │
  │    │                                 v                    │
  │    │                        handler/sourcemaps.go  (NEW)  │
  │    │                          POST  /sourcemaps/batches   │
  │    │                          PUT   .../files/{debugID}   │
  │    │                          POST  .../complete          │
  │    │                                 │                    │
  │    └── AuthenticateUserSession ──┐   │                    │
  │          (EXISTS)                v   │                    │
  │                     handler/sourcemap_verify.go (NEW)     │
  │                       POST /projects/{id}/sourcemaps/     │
  │                            verify                         │
  │                                  │   │                    │
  │            ┌─────────────────────┴───┴──────────┐         │
  │            v                                    v         │
  │   debugid.Compute (#224)                db/sourcemaps.go  │
  │     canonicalize + SHA-256                    (NEW)       │
  │     + NEW: canonical bytes           batches / files /    │
  │            (EXISTS, extended)        batch_files          │
  │            │                                    │         │
  │            └────────────┬───────────────────────┘         │
  │                         v                                 │
  │                  minio/client.go                          │
  │                  Put / Get / Remove / RemovePrefix        │
  │                  + NEW: CopyObject                        │
  └───────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              v                             v
        PostgreSQL 16                 S3 / MinIO
   sourcemap_batches                  sourcemaps/v1/projects/{p}/
   sourcemap_files                      batches/{b}/{d}.map   (staging)
   sourcemap_batch_files                maps/{sha256}.map     (canonical)
```

Batch state machine:

```
                  create
                    │
                    v
                pending ──────────── expires_at passes ──────> (no reaper
                    │                                            in v1: the
       all files received                                        row just sits)
                    │
                    v  ClaimBatchCompletion (sets claim token + 5-min lease)
               completing ───── request dies ─────> STUCK FOREVER  <-- F8
                    │
       objects copied, ActivateBatch with exact claim token
                    │
                    v
                complete  (only visibility point; verify reads only from here)
```

Per-file state machine:

```
  pending ──PUT, digest matches an activated artifact──> linked (no object written)
     │
     └──PUT, new content──> staged (canonical bytes at staging key)
                              │
                              └──batch completion──> linked (canonical object)
```

**Findings.**

- **A1 [P1] (confidence 9/10)** `handler/routes.go:255` — `isSDKEndpoint`
  correctly excludes `/api/v1/sourcemaps/...` because it uses exact prefix
  boundaries. But nothing asserts that. If someone later adds
  `"/api/v1/sourcemaps"` to that slice, source-map upload silently gains
  permissive CORS with `Access-Control-Allow-Origin: *`, and the contract
  (section 2.5) forbids it. Fix: a `cors_test.go` case per new route.
- **A2 [P1] (confidence 9/10)** `handler/project_keys.go:43-56` — `ProjectKey`
  resolves the project's `production` environment for every scope and returns
  `500` when it is absent. On sourcemap routes that value is never read. A
  project with no production environment row would 500 on upload for no reason.
  Fix: gate the lookup on `requiredScope == db.ScopeIngest`.
- **A3 [P1] (confidence 10/10)** `packages/ingestion/db/migrations/` — the repo
  has **zero triggers today** (verified: no `CREATE TRIGGER` in any migration).
  The immutability trigger from contract section 8.1 would be the first.
  `scripts/run-migrations.sh` has no ledger and replays every file on every
  boot, and `scripts/check-migration-reapply.sh` enforces that in CI. So the
  trigger MUST be `CREATE OR REPLACE TRIGGER` (PostgreSQL 14+, and the repo
  runs `postgres:16`), not `CREATE TRIGGER`, or the second boot fails.
  Same for the function: `CREATE OR REPLACE FUNCTION`.
- **A4 [P2] (confidence 8/10)** Migration numbering: the runner globs and
  lexically sorts, so a gap is harmless and a duplicate number is not fatal
  (both files apply, `028_event_debug_meta.sql` sorting before
  `028_project_api_keys.sql`). The renumbering is still correct for legibility,
  but it is not load-bearing. Downgrade the plan's "must renumber" to "should".
- **A5 [P2] (confidence 9/10)** `minio/client.go` has no `CopyObject`. The
  staging-to-canonical promotion in contract section 8.3 step 4 would otherwise
  be Get-then-Put through ingestion heap: 100 MiB per map. Fix: add
  `CopyObject` using minio-go's server-side copy.
- **A6 [P2] (confidence 7/10)** Single point of failure: `handler.Dependencies.MinIO`
  may be nil in narrow handler tests (several existing tests construct
  `Dependencies` literals). Every new handler must nil-check and return
  `503 storage_unavailable` rather than panicking into `middleware.Recoverer`.

## Section 2: code quality

- **Q1 [P1] (confidence 10/10)** DRY violation in the plan itself: section 5
  originally proposed `handler/sourcemaps_auth_test.go` while
  `handler/route_matrix_test.go:TestRouteMatrixDenyByDefault` already crosses
  every project-key route with seven credentials. Corrected in the plan: extend
  the existing matrix, add a `wrong-project-sk` credential.
- **Q2 [P2] (confidence 8/10)** The matrix's `routes` slice is hand-maintained
  (`route_matrix_test.go:126-146`). #217's risk table claims "route matrix
  defaults to deny; a route opts in," which is not enforced. A `chi.Walk`
  completeness assertion makes the claim true and costs ten lines.
- **Q3 [P2] (confidence 9/10)** Naming trap: `received_bytes` in the PUT
  response is the RAW request length; `sourcemap_files.size_bytes` is the
  CANONICAL length; `sourcemap_batch_files` carries `received_size_bytes`,
  `canonical_size_bytes`, `raw_sha256`, and `content_sha256`. Four size-ish and
  two digest-ish fields whose confusion the schema CHECKs cannot catch, because
  both are plain BIGINTs in the same valid range. Fix: name the Go struct
  fields `RawSize`/`CanonicalSize` and `RawSHA256`/`ContentSHA256`, never
  `Size`/`SHA256`, and assert both independently in the idempotency test using
  a fixture whose raw and canonical lengths deliberately differ (add trailing
  whitespace and reordered keys to the raw body).
- **Q4 [P3] (confidence 6/10)** Three new handler files for one feature is
  reasonable, but `handler/sourcemaps.go` will carry three handlers with heavy
  validation. If it passes ~400 lines, split the PUT into its own file rather
  than growing one file the way `db/queries.go` grew to 3350 lines.

## Section 3: test review

Coverage diagram. `[GAP]` items are additions this review makes to section 5.

```
CODE PATHS                                          USER / OPERATOR FLOWS
[+] handler/sourcemaps.go
  ├── CreateBatch                                   [+] CI build uploads one map
  │   ├── [PLANNED] valid manifest -> 201             ├── [PLANNED] create->PUT->complete
  │   ├── [PLANNED] idempotent retry -> 200           ├── [PLANNED] retry each step
  │   ├── [PLANNED] same key diff manifest -> 409     └── [GAP] complete called twice
  │   ├── [PLANNED] >256 KiB -> 413                        concurrently -> one 200,
  │   ├── [PLANNED] dup debug_id -> 400                    one 200 or 409, never
  │   ├── [GAP] 0 files -> 400                             double counts   [->E2E]
  │   ├── [GAP] 501 files -> 413
  │   ├── [GAP] size_bytes sum > 1 GiB -> 413       [+] Interrupted build
  │   ├── [GAP] missing Idempotency-Key -> 400        ├── [PLANNED] never resolvable
  │   ├── [GAP] non-UUID Idempotency-Key -> 400       └── [GAP] batch stuck in
  │   ├── [GAP] control chars in code_file -> 400          'completing' is
  │   └── [GAP] commit_sha wrong length -> 400             permanently un-completable
  │                                                        and unrecoverable  <- F8
  ├── UploadFile
  │   ├── [PLANNED] new map -> 201 stored           [+] Two projects, same map
  │   ├── [PLANNED] identical retry -> 200          │   ├── [PLANNED] two rows,
  │   ├── [PLANNED] wrong claimed ID -> 409         │   │   two object keys
  │   ├── [PLANNED] conflicting digest -> 409       │   └── [PLANNED] delete one,
  │   ├── [GAP] missing Content-Length -> 411       │       other still resolves
  │   ├── [GAP] Content-Length != declared -> 409
  │   ├── [GAP] body longer than Content-Length     [+] Custody
  │   │        -> truncated by MaxBytesReader,        ├── [PLANNED] no route returns
  │   │        must 409 not silently accept          │   map bytes
  │   ├── [GAP] Content-Type not JSON -> 415         ├── [PLANNED] no presigned URL
  │   ├── [GAP] Content-Encoding: gzip -> 415        │   for sourcemaps/
  │   ├── [GAP] undeclared debug ID on a COMPLETE    └── [GAP] log scan across the
  │   │        batch -> 409 debug_id_not_declared,       whole suite for object
  │   │        NOT batch_already_complete  <- the        keys, secrets, and
  │   │        one ordering rule most likely to          fixture source text
  │   │        be got wrong
  │   ├── [GAP] expired batch -> 410
  │   ├── [GAP] map with sourcesContent length
  │   │        != sources length -> 400
  │   ├── [GAP] indexed map (has "sections") -> 400
  │   ├── [GAP] duplicate JSON key -> 400
  │   ├── [GAP] nesting deeper than 64 -> 400
  │   ├── [GAP] BOM / invalid UTF-8 -> 400
  │   └── [GAP] MinIO nil or down -> 503, no panic
  │
  └── CompleteBatch
      ├── [PLANNED] first complete -> 200 receipt
      ├── [PLANNED] repeat -> same receipt
      ├── [PLANNED] incomplete -> 409 + counts
      ├── [GAP] stale claim token changes 0 rows
      ├── [GAP] contender -> 409 + Retry-After: 2
      └── [GAP] crash after copy, before activate:
               retry completes; map not resolvable
               in between

[+] handler/sourcemap_verify.go
  ├── [PLANNED] known position -> exact file/line/col/name
  ├── [PLANNED] response contains no sourcesContent, no "mappings"
  ├── [PLANNED] unmapped -> 422
  ├── [PLANNED] other org's session -> 404
  ├── [GAP] line 0 -> 400 (1-based)
  ├── [GAP] column -1 -> 400 (0-based)
  ├── [GAP] line 2147483648 -> 400
  ├── [GAP] batch complete but debug ID belongs to a DIFFERENT batch -> 404
  ├── [GAP] name is null when the mapping has no name -> null, not ""
  └── [GAP] audit log written, and contains no path and no source text

[+] debugid.Compute (T1)
  ├── [PLANNED] three golden vectors: digest + debug ID
  ├── [PLANNED] canonical bytes match the frozen string exactly
  └── [GAP] canonical > 100 MiB -> reject before returning

[+] db/sourcemaps.go
  └── [GAP] every exported function rejects a cross-project ID  [->unit]

[+] migration 031
  ├── [PLANNED] applies twice (already enforced by
  │             scripts/check-migration-reapply.sh in CI)
  ├── [GAP] the raw-bit debug ID 158399f3-1dad-1386-35b2-98c34317d52e
  │         round-trips through BOTH sourcemap_batch_files.debug_id and
  │         sourcemap_files.debug_id  (contract section 6.2 names this
  │         explicitly as the S2 migration test; #224 covers only its own
  │         column)
  └── [GAP] the immutability trigger actually rejects an identity UPDATE

COVERAGE (planned vs total): 22 / 60 paths  (37%)
GAPS: 38, of which 1 [->E2E]
```

Test plan artifact: written to
`~/.gstack/projects/opslane-opslane-oss/`.

## Section 4: performance

- **P1 [P2] (confidence 8/10)** Verify parses the whole map, including
  `sourcesContent`, into ingestion heap. At the 100 MiB ceiling that is a
  ~100 MiB allocation per concurrent call on a shared API process, with no
  rate limit in this slice. The parse cost is the reason the contract puts a
  30/min cap on this endpoint. Cheapest mitigation inside this slice: apply the
  existing `rateLimitByProject` middleware.
- **P2 [P2] (confidence 9/10)** Staging-to-canonical promotion without
  `CopyObject` is a full Get-then-Put through the API process. Same 100 MiB.
  Fix: `CopyObject`.
- **P3 [P3] (confidence 7/10)** No N+1: batch creation inserts manifest rows in
  one transaction, completion reads all `staged` rows once. Use a single
  multi-row `INSERT ... SELECT unnest(...)` for manifest rows rather than a
  loop of 500 inserts.
- **P4 [P3] (confidence 6/10)** No caching opportunity worth taking in v1. The
  worker path (#227) will want one; not here.

---

# DX REVIEW (Phase 3.5)

**Scope note, stated honestly:** DX scope for #225 is thin by construction.
The plugin is out of scope (D2), there is no CLI surface, no SDK change, and no
new docs page in this slice. The only developer-facing artifact is the HTTP
error contract, and that is frozen in #216. Dual voices were NOT run for this
phase — the earlier CEO Claude subagent hung and the budget went to the eng
phase instead. This section is `[primary-only]`. Treat its scores as one
reviewer's judgment, not cross-model consensus.

## Developer journey (the only real consumer in this slice)

| Stage | Who | What they see today | After this slice |
|---|---|---|---|
| 1. Discover | build engineer | plugin throws, points at #218 | plugin throws, points at #226 |
| 2. Get a key | build engineer | no `opslane keys` command (#238) | unchanged |
| 3. Configure | build engineer | n/a | n/a |
| 4. First call | integrator with curl | 404 | 201 with a batch ID |
| 5. Upload | integrator | n/a | 201 / 200 / a named 4xx |
| 6. Complete | integrator | n/a | receipt with counts |
| 7. Verify | dashboard user | n/a | resolved position |
| 8. Debug a failure | integrator | n/a | a stable `code` per error |
| 9. Upgrade | n/a | n/a | n/a |

TTHW: not measurable in this slice. Nobody can reach these routes without an
`opslane_sk_`, and #217 deferred key minting to #230/#238, so today the only way
to obtain one is `CreateProjectKey` in Go or raw SQL. That is a real DX cliff,
but it is #230's cliff and predates this plan.

## Findings

- **X1 [P1]** Nothing can mint an `opslane_sk_` through any user-facing path.
  This slice ships an API that no developer can call. That is acceptable for a
  server slice whose consumers are #226 and #231, but it must be stated in the
  issue so nobody expects to try it. **Fix: name it in the plan's "not in
  scope" table and in the PR description.** Adopted below.
- **X2 [P2]** Error bodies carry `code`, which is right, but the plan does not
  say the `error` string must be actionable. `"source map batch is incomplete"`
  plus `expected_files`/`received_files` is good. `"invalid manifest"` alone is
  not: it should name the offending field. **Fix: every `400 invalid_manifest`
  names the field and the constraint it violated.** Adopted.
- **X3 [P2]** `docs/reference/http-routes.md` is hand-maintained and touched on
  15 of the last 14 days' commits with nothing enforcing it. Four new routes
  must land there in the same PR. **Fix: add it to the task list.** Adopted.
- **X4 [P3]** `docs/contracts/` has `events.md` and `reliability.md` but no
  source-map page, while `AGENTS.md` treats `docs/contracts/` as the home of
  public contracts. Deferred to #226, which is when a customer can first use it.

DX scorecard (one reviewer, thin surface):

| Dimension | Score | Note |
|---|---|---|
| Getting started | n/a | no developer can reach these routes yet (X1) |
| API naming | 9/10 | frozen in #216, conventional REST, guessable |
| Error messages | 7/10 | stable codes; message text unspecified (X2) |
| Docs | 4/10 | route reference not updated by the plan (X3) |
| Upgrade path | n/a | nothing to upgrade from; old route already deleted |
| Dev environment | 8/10 | Postgres + MinIO already in compose; tests skip cleanly |

Overall: **7/10** across the dimensions that apply.

---

# REQUIRED OUTPUTS

## NOT in scope

| Deferred | Owner | Rationale |
|---|---|---|
| Vite plugin upload path, stamping, encrypted spill custody | #224 stamping, #226 upload | Decision D2. The plugin cannot stamp a debug ID without #224's TypeScript hasher, and #226 owns 248-map scale and delete-after-receipt. |
| Rate limits, rolling byte budgets, per-PUT concurrency leases, `Retry-After` on budget | #226 | Decision D3. **Both review voices dispute this.** See the challenge at the gate. |
| Batch expiry sweeper and staging garbage collection | #226 | Decision D3. `expires_at` is stored and checked; nothing reaps. |
| Reclaimer for an abandoned `completing` lease | unassigned | **Never surfaced as a decision.** See F8 and the challenge at the gate. |
| Tombstones, leased deletion worker, retry-until-empty, custody docs | #229 | Decision D4. |
| `GET /projects/{id}/sourcemaps/status` (contract section 11) | #231 | Not an R in #225. |
| `debug_meta` on events, `resolution_*` columns (contract sections 5 and 10) | #224, #227 | Not an R in #225. |
| Worker symbolication and the bounded source-snippet cache | #227 | Not an R in #225. |
| `last_used_at`, `last_rejected_at`, and their index | #230 | #217 deferred them. |
| Any user-facing way to mint an `opslane_sk_` | #230, #238 | DX X1. This slice ships an API nobody can call yet; that is expected and must be said in the PR. |
| `docs/contracts/sourcemaps.md` | #226 | Write it when a customer can first use the thing. |
| Retention expiry for stored maps | none yet | Design section 5.6 names it as a follow-up. Record in TODOS.md. |
| Recommending `sourcemapPathTransform` (spike found build-machine home paths inside stored maps) | #226 docs | Real leak of local paths into stored artifacts, but a docs fix on the plugin side. |

## What already exists

Reused unchanged: `ProjectKey(scope)` middleware and both scope constants
(S1); `minio.Client` Put/Get/Stat/Remove/RemovePrefix; the
`AuthenticateUserSession` plus project-in-org pattern used by every
`/projects/{projectID}/...` route; the `rateLimitByProject` limiter family;
`http.MaxBytesReader` bounded-read pattern from `handler/ingest_limits.go`;
`scripts/check-migration-reapply.sh` replay enforcement in CI.

Reused and extended: `packages/ingestion/debugid` (#224) gains canonical-byte
return; `handler/route_matrix_test.go` gains four routes and one credential;
`minio/client.go` gains `CopyObject`.

Not rebuilt: nothing. The one duplication risk the review caught was a second
auth-test file duplicating `route_matrix_test.go`, corrected before this
section was written.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| T1 canonical bytes | `debugid/` | — |
| T2 migration | `db/migrations/` | — |
| T10 `CopyObject` | `minio/` | — |
| T7 ProjectKey scope gate, T14 JSON 404 | `handler/` | — |
| T3 db layer | `db/` | T2 |
| T4 handlers, T11, T17 | `handler/` | T1, T3, T10 |
| T5 verify | `handler/` | T3 |
| T8, T9, T12, T15, T18 tests | `handler/`, `db/` | T4, T5 |
| T16 docs | `docs/` | T4, T5 |

```
Lane A: T1 (debugid/)                      independent
Lane B: T2 -> T3 (db/migrations/, db/)     sequential, shared db/
Lane C: T10 (minio/)                       independent
Lane D: T7 -> T14 (handler/)               sequential, shared handler/
        ---- barrier ----
Lane E: T4 -> T5 -> T11 -> T17 (handler/)  needs A, B, C, D
Lane F: T8, T9, T12, T15, T18 (tests)      needs E
Lane G: T16 (docs/)                        needs E
```

Launch A, B, C, D in parallel worktrees. Merge. Then E, then F and G in
parallel.

**Conflict flag:** lanes D and E both touch `handler/routes.go`. Land D first
and rebase E, or do both in one lane. Lane A touches a package #224 owns on a
branch still in flight; coordinate before editing `debugid.go`.

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding.

- [ ] **T1 (P1, human: ~2h / CC: ~15min) — debugid** — Return canonical bytes and canonical size from `Compute`; enforce the 100 MiB canonical cap
  - Surfaced by: plan T1 — contract 8.1 stores canonical JSON, not the raw request
  - Files: `packages/ingestion/debugid/debugid.go`, `debugid_test.go`
  - Verify: `go test ./debugid` with the three frozen vectors asserting canonical bytes
- [ ] **T2 (P1, human: ~4h / CC: ~25min) — migration** — Migration 031: three tables, every CHECK, four indexes, immutability trigger
  - Surfaced by: plan T2 — contract 8.1
  - Files: `packages/ingestion/db/migrations/031_sourcemap_batches.sql`
  - Verify: `scripts/check-migration-reapply.sh`
- [ ] **T3 (P1, human: ~2d / CC: ~1h) — db** — `db/sourcemaps.go`, every helper project-filtered in SQL
  - Surfaced by: plan T3
  - Files: `packages/ingestion/db/sourcemaps.go`
  - Verify: `go test ./db`
- [ ] **T4 (P1, human: ~2d / CC: ~1h) — handler** — Three sk handlers with the contract's exact check ordering
  - Surfaced by: plan T4 — contract 7.1-7.3
  - Files: `packages/ingestion/handler/sourcemaps.go`, `routes.go`
  - Verify: `go test ./handler`
- [ ] **T5 (P1, human: ~1d / CC: ~30min) — handler** — Session verify endpoint, four fields only
  - Surfaced by: plan T5 — contract 9, issue R4
  - Files: `packages/ingestion/handler/sourcemap_verify.go`
  - Verify: response-shape assertion scans for `sourcesContent` and `mappings`
- [ ] **T6 (P1, human: ~15min / CC: ~2min) — migration** — `CREATE OR REPLACE TRIGGER` and `FUNCTION`, not bare `CREATE`
  - Surfaced by: Eng A3 — repo has zero triggers; the runner replays every file every boot and CI enforces it
  - Files: `031_sourcemap_batches.sql`
  - Verify: `scripts/check-migration-reapply.sh`
- [ ] **T7 (P1, human: ~30min / CC: ~5min) — handler** — Gate the production-environment lookup on the ingest scope
  - Surfaced by: Eng A2 — `project_keys.go:43-56` resolves an unused environment and 500s when absent
  - Files: `packages/ingestion/handler/project_keys.go`
  - Verify: a sourcemaps-scope request succeeds against a project with no production environment row
- [ ] **T8 (P1, human: ~1h / CC: ~10min) — test** — Extend `route_matrix_test.go`; add a `wrong-project-sk` credential
  - Surfaced by: Eng Q1 — the matrix already crosses every project-key route with seven credentials
  - Files: `packages/ingestion/handler/route_matrix_test.go`
  - Verify: `go test ./handler -run TestRouteMatrix`
- [ ] **T9 (P1, human: ~30min / CC: ~5min) — test** — CORS regression cases for the four new routes
  - Surfaced by: Eng A1 — `routes.go:255` excludes them today, nothing asserts it, contract 2.5 forbids permissive CORS here
  - Files: `packages/ingestion/handler/cors_test.go`
  - Verify: no `Access-Control-Allow-Origin: *` on any source-map route
- [ ] **T10 (P2, human: ~1h / CC: ~10min) — minio** — Add `CopyObject` for server-side promotion
  - Surfaced by: Eng A5 and Perf P2 — otherwise 100 MiB round trips through ingestion heap
  - Files: `packages/ingestion/minio/client.go`
  - Verify: `go test ./minio`
- [ ] **T11 (P2, human: ~30min / CC: ~5min) — handler** — Nil `MinIO` returns `503 storage_unavailable`, never a panic
  - Surfaced by: Eng A6 — existing tests construct `Dependencies` literals with no MinIO
  - Files: `packages/ingestion/handler/sourcemaps.go`
- [ ] **T12 (P2, human: ~1h / CC: ~10min) — test** — `chi.Walk` completeness assertion on the route matrix
  - Surfaced by: Eng Q2 — #217 claims deny-by-default but the table is hand maintained
  - Files: `packages/ingestion/handler/route_matrix_test.go`
- [ ] **T13 (P2, human: ~1h / CC: ~10min) — handler/db** — Name fields `RawSize`/`CanonicalSize`, `RawSHA256`/`ContentSHA256`
  - Surfaced by: Eng Q3 — four size fields in the same valid range; CHECK constraints cannot catch a swap
  - Files: `db/sourcemaps.go`, `handler/sourcemaps.go`
  - Verify: idempotency test uses a fixture whose raw and canonical lengths differ
- [ ] **T14 (P1, human: ~30min / CC: ~5min) — handler** — `/api/v1` JSON `NotFound` and `MethodNotAllowed`
  - Surfaced by: measured — unknown `/api/v1` paths return `text/plain "404 page not found"` with no `code`; contract 2.4 requires JSON `not_found`
  - Files: `packages/ingestion/handler/routes.go`
- [ ] **T15 (P1, human: ~1d / CC: ~45min) — test** — Close the 38 coverage gaps, starting with `debug_id_not_declared` outranking `batch_already_complete`
  - Surfaced by: Eng section 3 — planned coverage is 22 of 60 paths
  - Files: `handler/sourcemaps_test.go`, `db/sourcemaps_test.go`
- [ ] **T16 (P2, human: ~30min / CC: ~5min) — docs** — Four new routes into `docs/reference/http-routes.md`
  - Surfaced by: DX X3 — hand maintained, nothing enforces it
  - Files: `docs/reference/http-routes.md`
- [ ] **T17 (P2, human: ~1h / CC: ~10min) — handler** — Every `400 invalid_manifest` names the field and the constraint
  - Surfaced by: DX X2 — a bare "invalid manifest" is not actionable in a build log
  - Files: `packages/ingestion/handler/sourcemaps.go`
- [ ] **T18 (P1, human: ~30min / CC: ~5min) — test** — Round-trip `158399f3-1dad-1386-35b2-98c34317d52e` through both new `debug_id` columns
  - Surfaced by: Eng section 3 — contract 6.2 names this as the S2 migration test; #224 covers only its own column
  - Files: `packages/ingestion/db/sourcemaps_test.go`

---

# DUAL VOICES

## CEO consensus  `[codex-only]` — the Claude CEO subagent never produced output

Both Claude subagents were spawned, read the plan and the codebase, then went
idle without returning findings. Each was asked twice more for a
deltas-only reply after the review closed; both went idle again with nothing.
After three idle cycles and zero content they were stopped. Every "consensus"
below is therefore one outside voice (Codex) plus the primary review, and the
CONFIRMED/DISAGREE labels carry correspondingly less weight than genuine
cross-model agreement would.

| # | Dimension | Claude (primary) | Codex | Consensus |
|---|---|---|---|---|
| 1 | Premises valid? | No — P1 is stale, P2 untested | No — business premise unmeasured | **CONFIRMED no** |
| 2 | Right problem? | Yes, but justified by the wrong argument (#242, not the stale P1) | No — commodity capability, not the differentiator | **DISAGREE** |
| 3 | Scope calibration? | Yes for the slice; three deferrals are load-bearing | No — deferrals make it non-shippable | **DISAGREE** |
| 4 | Alternatives explored? | Partly — #245 named but untested | No — five substitutes unconsidered | **CONFIRMED no** |
| 5 | Competitive risk covered? | Not assessed | No — Sentry/Bugsnag solved this years ago | N/A (single voice) |
| 6 | 6-month trajectory sound? | Yes if #226/#229 land | No — custody obligations before custody is launchable | **DISAGREE** |

## Eng consensus  `[codex-only]` — the Claude eng subagent also hung

| # | Dimension | Claude (primary) | Codex | Consensus |
|---|---|---|---|---|
| 1 | Architecture sound? | Yes, with 6 findings | Yes, with 8 findings | **CONFIRMED yes** |
| 2 | Test coverage sufficient? | No — 22 of 60 paths | No — parity test for the Go consumer missing | **CONFIRMED no** |
| 3 | Performance risks addressed? | No — two 100 MiB heap paths | Not raised | N/A |
| 4 | Security threats covered? | Partly — verify leaks nothing if `SourceContent` is never called | Partly | **CONFIRMED partly** |
| 5 | Error paths handled? | No — 3 silent failures | No — `completing` unrecoverable | **CONFIRMED no** |
| 6 | Deployment risk manageable? | **No — migration will not apply** | **No — same, found independently** | **CONFIRMED no** |

Both voices independently found the migration blocker. I then reproduced it against
a disposable PostgreSQL 16.14 rather than reasoning about it.

## Findings I verified by running, not by reading

**V1 — the migration cannot apply. P0.** Applied the real `001`-`029` to a
disposable `postgres:16`, then applied contract section 8.1 verbatim:

```
ERROR: there is no unique constraint matching given keys
       for referenced table "project_api_keys"
```

`sourcemap_batches` declares
`FOREIGN KEY (upload_key_db_id, project_id) REFERENCES project_api_keys(id, project_id)`.
Contract section 3.3 line 299 specifies `UNIQUE (id, project_id)` on that table,
but the shipped `028_project_api_keys.sql` **omitted it**. Verified against the
live table: its only unique indexes are the `id` primary key, `key_id`, and
`secret_hash`. So S1 shipped a schema that diverges from the frozen contract,
and #225 is the first thing to trip over it.
**Fix:** migration 031 begins with
`ALTER TABLE project_api_keys ADD CONSTRAINT project_api_keys_id_project_key UNIQUE (id, project_id);`
guarded for replay. This is a correction to S1's schema, in blast radius.

**V2 — the proposed Go source-map consumer fabricates mappings. P0.** For a map
whose second generated line carries a 1-field segment (explicitly unmapped in
the source-map v3 spec), the two consumers disagree:

```
                      go-sourcemap v2.1.4        @jridgewell/trace-mapping
gen(line=1,col=0)     src/a.ts:1:0               src/a.ts:1:0        agree
gen(line=2,col=0)     src/a.ts:1:0   ok=true     source: null        DIVERGE
gen(line=2,col=3)     src/a.ts:1:0   ok=true     source: null        DIVERGE
```

The Go library defaults the source index to 0 and reports success. The TypeScript
consumer the worker already uses reports no original position. Contract section 9
requires `422 position_not_mapped` here. As written, T5 would answer "your frame
is at src/a.ts line 1" for a frame that maps nowhere — a confident wrong answer,
which for a debugging tool is worse than an error. **The dependency choice in T5
does not survive.** See the gate.

**V3 — line and column conventions are otherwise correct.** `Source(genLine,
genCol)` takes 1-based line, 0-based column and returns the same. No conversion
needed. Matches contract section 9 and `worker/src/source-map.ts`.

**V4 — `SourceContent()` returns embedded original source.** The consumer holds
`sourcesContent` in memory and exposes it in one call. Verify must never call it.

**V5 — the deleted route already returns 404, not the SPA.** Measured with
`DASHBOARD_DIR` set the way the production Dockerfile sets it. chi's `/api/v1`
subrouter owns the subtree. The real gap is only the body shape:
`text/plain "404 page not found"` with no `code`.

**V6 — migration numbering is not load-bearing.** `run-migrations.sh` globs and
sorts lexically with no ledger; `031` sorts after both `028` files and `029`
regardless. Renumbering is convention. A `030` gap must never be backfilled
later, because fresh and upgraded databases would then see different first-apply
order.

## Codex eng findings adopted into the task list

| # | Finding | Disposition |
|---|---|---|
| C1 | P0 migration FK has no matching unique constraint | **Adopt** — V1, new task T19 |
| C2 | Claim token is sufficient, but the plan never defines atomic expired-lease reclaim, and activation must lock and validate before inserting | **Adopt** — T3 amended |
| C3 | P0 `completing` is unrecoverable: Claim only accepts `pending`, and after `expires_at` the handler 410s before recovering | **Escalate** — this is F8, never surfaced as a decision. Gate. |
| C4 | PUT ordering: a non-matching body on a declared path of a *completed* batch must be `batch_already_complete`, not `debug_id_mismatch`. Also `expires_at` must only apply to `pending`. Also `Content-Encoding` needs an explicit 415. Also `StageBatchFile` must recheck under lock | **Adopt** — T4 rewritten, this is the ordering rule most likely to be got wrong |
| C5 | Nothing proves `sourcemap_files.size_bytes` equals the linked row's canonical size; the FK permits linking to a same-project artifact with a different debug ID | **Adopt** — `ActivateBatch` compares all identity fields explicitly |
| C6 | The Go consumer fabricates mappings for unmapped segments | **Adopt and verified** — V2, gate |
| C7 | Migration numbering is convention, not correctness | **Adopt** — matches V6, plan downgraded |
| C8 | PostgreSQL CHECKs are per-statement, so each state transition must be ONE `UPDATE` carrying every field that state requires, not several statements in a transaction | **Adopt** — the single most useful implementation note in the review; T3 amended |

C8 deserves emphasis. The contract's coherence CHECKs mean
`UPDATE ... SET status='completing'` followed by
`UPDATE ... SET completion_claimed_at=...` fails on the first statement. Every
transition is one statement or it does not work.

---

# AMENDMENTS (supersede sections 4 and 5 where they conflict)

## A-T2 / new T19 — unblock the migration

Migration 031 opens with, guarded for replay:

```sql
ALTER TABLE project_api_keys
  DROP CONSTRAINT IF EXISTS project_api_keys_id_project_key;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_id_project_key UNIQUE (id, project_id);
```

Without it the `sourcemap_batches` foreign key is rejected. Verified by running
it. This corrects a divergence between shipped S1 and frozen contract 3.3.

Use `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER` (PG14+; the
repo runs `postgres:16`), because the runner replays every migration on every
boot and CI enforces that.

## A-T3 — state transitions and activation

- **Every state transition is exactly ONE `UPDATE`** carrying every column that
  the target state's CHECK requires. PostgreSQL evaluates CHECKs per statement,
  so splitting a transition across two statements inside one transaction fails
  on the first. This applies to `pending → completing` (plus both claim
  timestamps), `completing → complete` (plus `completed_at`, clearing both claim
  timestamps), `completing → expired` (plus `expired_at`, clearing claims), and
  every `sourcemap_batch_files` state change.
- `ClaimBatchCompletion` accepts **two** entry conditions in one atomic
  statement: a fully received `pending` batch, OR a `completing` batch whose
  `completion_lease_expires_at <= now()`. The second is the reclaim path. Both
  set a fresh `completion_claimed_at` and lease from the same database
  `now()`, so successive claim tokens are at least one lease apart and cannot
  collide.
- `ActivateBatch` locks the batch row and revalidates everything **before**
  inserting any `sourcemap_files` row; a mismatch rolls back the whole
  transaction. It compares **all** identity fields when reusing an existing
  artifact — `debug_id`, `content_sha256`, and canonical size — because the
  composite foreign key alone permits linking a batch row to a same-project
  artifact with a different debug ID.
- `StageBatchFile` rechecks project, batch status, expiry, row state, and digest
  **under lock**. The handler's initial read is stale by the time storage and
  database writes happen.

## A-T4 — corrected PUT check ordering

The ordering in section 4 was wrong at two points. Correct order:

1. Batch exists in this project, else `404 batch_not_found`.
2. Debug ID is declared in this batch, else `409 debug_id_not_declared`.
   This precedes every lifecycle check.
3. **`expires_at` applies only to a `pending` batch.** A completed batch retried
   after an hour must return its receipt, not `410`. The original ordering
   returned `410` for a legitimate idempotent retry.
4. `Content-Length` required (`411`), equal to the declaration (`409 size_mismatch`).
5. `Content-Type` must be `application/json`, else `415`.
   **`Content-Encoding` present is an explicit `415`**, checked here. Without an
   explicit step, a gzipped body falls through to `400 invalid_source_map`,
   which misdirects the caller.
6. Bounded read via `http.MaxBytesReader` at the declared length. A body longer
   than `Content-Length` must produce `409 size_mismatch`, never a silently
   truncated accept.
7. `debugid.Compute`. Validation failure is `400 invalid_source_map`.
8. **Lifecycle classification comes BEFORE identity mismatch.** If the batch is
   already `complete`: a body whose canonical digest matches the stored row is
   idempotent `200 already_present`; any other body is `409
   batch_already_complete`. Only for a non-complete batch does a computed ID
   differing from the path segment become `409 debug_id_mismatch`. The original
   ordering returned `debug_id_mismatch` first, contradicting contract 7.2.
9. Link-existing shortcut, else stage canonical bytes.

## A-T5 — the Go source-map consumer is unresolved

`go-sourcemap/sourcemap` v2.1.4 fabricates a mapping for spec-unmapped
segments (V2, measured). T5 cannot use it as-is. Three ways forward, put to the
user at the gate rather than auto-decided, because they differ materially in
effort.

## A-section 5 — additional required tests

- Parity vector: the exact map from V2 (`"mappings":"AAAA;A"`). Assert
  `gen(2,0)` yields `422 position_not_mapped`, matching
  `@jridgewell/trace-mapping`. This is the test that would have caught V2.
- Completed batch retried after `expires_at` returns its receipt, not `410`.
- `Content-Encoding: gzip` returns `415`, not `400`.
- A body longer than its `Content-Length` returns `409`, not a truncated accept.
- A batch abandoned in `completing`: a retry after the lease expires reclaims
  and completes it.
- Each state transition executed as a single `UPDATE` (a deliberately split
  transition must fail the CHECK — prove the constraint is doing work).
- `ActivateBatch` refuses to link a batch row to a same-project artifact with a
  different debug ID.

---

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | 0 | Branch off #224 rather than main | user | — | D5; one hasher, one set of golden vectors | copy the hasher; develop on main |
| 2 | 0 | Plugin out of scope | user | — | D2; cannot stamp without #224's TS hasher | wire it here |
| 3 | 0 | Correctness machinery only | user | — | D3 | full contract 7.2; no lease at all |
| 4 | 0 | Best-effort deletion | user | — | D4; user reaffirmed after I raised the risk | tombstone; full sweeper |
| 5 | CEO | Mode SELECTIVE EXPANSION | mechanical | P6 | Feature iteration on an existing system | EXPANSION; REDUCTION |
| 6 | CEO | Approach B (correctness core + reused limiters) | **taste** | P1, P4 | Reuses `rateLimitByProject` rather than deferring a control | A full contract; C prototype #245 first |
| 7 | CEO | Adopt E4 `chi.Walk` matrix completeness | mechanical | P2 | In blast radius, 10 lines, makes #217's claim true | defer |
| 8 | CEO | Adopt E5 JSON 404/405 | mechanical | P2 | In blast radius, measured gap vs contract 2.4 | defer |
| 9 | CEO | Adopt E6 scope-gate the environment lookup | mechanical | P2 | XS, removes a 500 path on the new routes | defer |
| 10 | CEO | Adopt `CopyObject` | mechanical | P2, P3 | Avoids 100 MiB through ingestion heap | Get-then-Put |
| 11 | CEO | Defer E2 sweeper, E3 tombstones, E7 docs, E8 retention | mechanical | P3 | Owned by #226/#229; outside blast radius | adopt |
| 12 | CEO | Escalate E1 rate limiting rather than auto-adopt | **challenge** | — | Contradicts user decision D3 | auto-adopt; drop it |
| 13 | Eng | Extend `route_matrix_test.go`, do not add a new auth test file | mechanical | P4 | DRY; the matrix already exists | new file |
| 14 | Eng | Name fields Raw*/Canonical* explicitly | mechanical | P5 | Explicit over clever; CHECKs cannot catch a swap | keep short names |
| 15 | Eng | Adopt Codex C2, C4, C5, C8 | mechanical | P1 | Correctness defects in the plan as written | reject |
| 16 | Eng | Escalate C3 / F8 (`completing` unrecoverable) | **challenge** | — | Never surfaced as a decision; adjacent to D3 | silently adopt |
| 17 | Eng | Escalate V2 (Go consumer fabricates mappings) | **taste** | — | Options differ materially in effort | pick one silently |
| 18 | Eng | Adopt V1 unique-constraint fix | mechanical | P1 | Migration provably fails without it | defer to S1 follow-up |
| 19 | DX | Adopt X1, X2, X3; defer X4 | mechanical | P1, P3 | First three are in blast radius | defer all |

## A-T5 resolved — write a minimal VLQ decoder in Go

`go-sourcemap/sourcemap` is rejected. New package
`packages/ingestion/sourcemapping` (~120-150 lines):

- base64 VLQ segment decoding;
- per-generated-line segment tables, sorted by generated column;
- binary search for the greatest segment start at or before the query column;
- **a segment with fewer than 4 fields is unmapped** — return "not mapped",
  never a defaulted source index. This is the single rule the rejected library
  gets wrong;
- return `(source, origLine 1-based, origCol 0-based, name *string, ok bool)`.
  Never expose `sourcesContent`; the decoder does not even retain it.

Parity suite: shared vectors run against `@jridgewell/trace-mapping` output,
including the V2 map `{"mappings":"AAAA;A"}` where `gen(2,0)` must be unmapped.
No new third-party dependency and no license review.

## A-limits resolved — apply the contract's four request limits

| Route | Limit | Mechanism |
|---|---|---|
| `POST /sourcemaps/batches` | 20/min per project | existing `rateLimitByProject` |
| `PUT .../files/{debugID}` | 600/min per project | existing `rateLimitByProject` |
| `POST .../complete` | 60/min per project | existing `rateLimitByProject` |
| `POST .../sourcemaps/verify` | 30/min per project | **new** `rateLimitBySessionProject` |

- `rateLimitByProject` reads `ProjectIDFromCtx`, which only `ProjectKey` sets.
  Verify is session-authenticated, so that value is empty and the existing
  middleware would return `401 "missing project context"`. Add
  `rateLimitBySessionProject`, keyed on the URL `{projectID}` after the
  project-belongs-to-active-org check (~15 lines).
- `rateLimitByProject` currently writes `429` with no `code`
  (`ingest_limits.go:42`). Switch it to `writeJSONErrorCode(..., "rate_limited")`
  per contract section 1. This additively improves the six existing ingest
  routes; assert the new field in `route_matrix_test.go`.
- **Honest caveat:** `newRateLimiter` is in-memory and per-replica, resetting
  each minute. Contract section 7.2 requires cluster-wide limits. On a single
  ingestion replica these are identical; on N replicas the effective cap is N
  times the stated number. Cluster-wide enforcement, rolling byte budgets
  (2 GiB/10 min), the 1 GiB in-flight cap, the 20-concurrent-PUT cap, and
  `Retry-After` on budget rejection all remain #226.
- Contract section 9 scopes verify per user+project; this keys per project,
  which is stricter when several users share a project. Acceptable and recorded.

## A-completion resolved — reclaim an expired lease online

Folded into A-T3: `ClaimBatchCompletion` accepts, in one atomic statement,
either a fully received `pending` batch or a `completing` batch whose
`completion_lease_expires_at <= now()`. F8 is closed. The background sweeper
stays in #226; this is online recovery in the endpoint itself.

## Updated failure registry

| # | Mode | Severity | Status |
|---|---|---|---|
| F5 | Verify enumerates source paths | Medium | **Closed** — 30/min limit |
| F6 | Leaked sk consumes unbounded storage | High | **Reduced** — request limits applied; byte budget still #226 |
| F7 | Project deletion half fails, source survives untracked | High | **Open, accepted** (D4). #229 owns durability |
| F8 | Batch stranded in `completing` | High | **Closed** — online lease reclaim |
| F11 | Multi-replica deployment gets N times the request cap | Medium | **Open, accepted** — #226 makes limits cluster-wide |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | 8 proposals, 4 accepted, 4 deferred; mode SELECTIVE_EXPANSION |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | CEO: 6 strategic blind spots. Eng: 8 findings, 2 P0, all adopted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 17 issues, 38 test gaps, 4 critical gaps, 3 now closed |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | issues_open | 7/10, 4 findings, `[primary-only]` |

- **CODEX:** Two substantive passes. The eng pass found the migration foreign-key P0 and the unrecoverable `completing` P0; I reproduced the first against a disposable PostgreSQL 16.14 and the second's premise by reading the claim protocol. All eight eng findings adopted.
- **CROSS-MODEL:** Agreement on every eng dimension, including both P0s found independently. Divergence on strategy: Codex says stop the slice; the primary review says ship it with corrected framing, because #242 documents present-day damage the issue never cites. Both Claude subagents hung, so CEO and Eng consensus are `[codex-only]` and DX is `[primary-only]`.
- **VERDICT:** CEO + ENG + DX reviewed. Two P0s resolved in-plan, three escalated decisions answered. Ready to implement, with two accepted open risks (F7 best-effort deletion, F11 per-replica limits) recorded rather than hidden.

NO UNRESOLVED DECISIONS
