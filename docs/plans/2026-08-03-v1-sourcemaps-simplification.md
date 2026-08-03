# V1 source maps: one stack trace resolves end to end

Status: implemented (revision 5)
Date: 2026-08-03
Supersedes-for-v1: the unimplemented sections of `docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` (see "Contract amendment")

## Problem

The S1–S7 issue series (14 open issues) grew far beyond the actual v1 goal, which was:

1. Separate the public (write-events) key from the secret (upload-source-maps) key.
2. Get source maps uploaded.
3. Make the fix agent read them.

Goal 1 is merged (S1, #243). The stamping half of goal 2 is merged (S2a, #249),
and the Vite-config codemod exists (S6a, #253). But **no source map has ever been
uploaded and the fix agent has never resolved a frame**, because:

- Nothing mints an `opslane_sk_` key (the scope exists; zero mint sites).
- No upload route exists (`POST /api/v1/sourcemaps` was deleted in S1; the frozen
  three-step batch API was never built).
- The Vite plugin stamps debug IDs but uploads nothing.
- The worker's resolver (`packages/worker/src/source-map.ts`) looks maps up by
  `(project_id, release)` in a `source_maps` table that has no writer, so it
  always resolves null. It never reads `error_events.debug_meta`.

Three finished components with the wires between them cut.

Maintainer decision (2026-08-03): this is **standalone new work**. The existing
S-series issues will all be closed by the maintainer; nothing here tracks or
amends them individually. Onboarding/CLI integration is a **separate later
track** (see "Deferred: onboarding track").

## Plan: one tracer-bullet slice

Ship **"one stack trace resolves end to end."** Ugly path allowed. One fixture
app, one map, one error. It touches SDK, ingestion, and worker, and it proves
the idea works at all — which nothing currently does.

It keeps four non-negotiables; everything else defers:

- Uploads use a real sk-scoped secret key (S1's middleware makes this free).
- The server recomputes the debug ID from the uploaded bytes — one bad upload
  must not wedge a chunk's ID forever.
- A leaked sk can be revoked (v1: one documented SQL statement).
- No API can download a map; storage is project-isolated.

Stages, in landing order so no intermediate state is dead:
**(1)** migrations + upload route → **(2)** mint-key command →
**(3)** plugin uploader + SDK 3.0.0 → **(4)** worker resolution →
**(5)** build harness + E2E.

### 1. Mint the sk manually (ingestion)

No onboarding or CLI changes in this slice. A ~40-line
`packages/ingestion/cmd/mint-key` command (`go run ./cmd/mint-key -project
<uuid>`) reuses the existing, tested `db.CreateProjectKey(...,
ScopeSourcemaps, ...)`, prints the raw `opslane_sk_` value exactly once
together with its `key_id`, and prints the **exact-key** revocation statement
alongside it (preserving frozen §3.2's one-exact-key rule — no blanket
project-wide revoke):

```sql
UPDATE project_api_keys SET revoked_at = now() WHERE key_id = '<key_id printed above>';
```

That is the entire v1 key lifecycle. The operator (us, right now) pastes the
key into CI as `OPSLANE_SOURCEMAP_KEY`, and/or into the repo's gitignored
`.env.local` for local production builds (see §3 — the plugin reads both).
The sk's blast radius on leak is uploads only: scope `sourcemaps` cannot read
incidents or send events.

The server-side leak floor from S1 stays: request logger records only
method/path/status, `masking.go` redacts `opslane_sk_`, and the CLI's
`envfile.ts` continues to refuse sk values (it writes browser-bundle env
only; the operator edits `.env.local` by hand for this slice).

### 2. One dumb upload route (ingestion)

- `PUT /api/v1/sourcemaps/{debugID}` behind the existing
  `ProjectKey(db.ScopeSourcemaps)` middleware — the first route to accept an
  sk. Per-project rate limit via the existing `rateLimitByProject` helper at
  **60/min** (a 248-map build finishes in ~4 minutes; deploys are rare). The
  worst case is then 60 × 32 MiB ≈ 1.9 GiB/min per replica for a leaked key —
  bounded, visible in disk metrics, and revocable with one SQL statement. The
  limiter is process-local and the compose deployment is single-replica; the
  frozen §7's cluster-wide byte budgets return with the batch protocol if it
  is ever needed.
- Body = identity-encoded source-map bytes. **No gzip in v1** (frozen §7.2
  agreed; the only client is our own plugin, which holds the bytes in Node).
  Any `Content-Encoding` header → 415. Wire cap via `http.MaxBytesReader` at
  32 MiB.
- **The server recomputes the debug ID** from the map bytes using
  `packages/ingestion/debugid/` and rejects a mismatch with the URL param
  (`409 debug_id_mismatch`). The `{debugID}` param is regex-validated before
  any storage access, so it can never contribute path segments to an object
  key. Recompute doubles as validation: non-source-map bytes are rejected.
- **`content_sha256` is the canonical hash `debugid.Compute` already
  returns** (RFC 8785 canonical bytes minus root `debugId`) — never a raw
  wire-byte hash. Two serializations that canonicalize identically are the
  same map; a same-ID/different-canonical-digest upload is
  `409 debug_id_conflict` (frozen §6's code), reachable only by attack or
  hash-collision, and it can never wedge honest retries.
- **`sourcesContent` becomes optional.** This requires relaxing the `debugid`
  validator (Go and TS mirror) and an explicit amendment to frozen §6's
  validity rules — the hash algorithm and existing golden vectors are
  unaffected, and a **new golden vector without `sourcesContent`** is added to the vector
  GENERATOR (`test-fixtures/debug-id/build-vectors.mjs`) and the regenerated
  `vectors.json`, so the Go and TS implementations cannot drift on the newly
  accepted shape and regeneration cannot silently drop the case. Record `has_sources_content` on
  the row; such maps resolve without snippets.
- Storage: **digest-addressed object keys** make overwrite structurally
  impossible (the frozen §8 insight, kept in miniature): the object key is
  `sourcemaps/{projectID}/{debugID}/{content_sha256}`, and the row stores it.
  Two concurrent first uploads with different canonical content (attack or
  hash collision — the server recomputed the ID from the bytes) write two
  DIFFERENT objects; whichever row insert wins, its `object_key` points at
  its own bytes, and the loser's object is an unreferenced orphan (cleaned
  with the prefix, never readable — resolution reads only row-referenced
  keys). Sequence: (1) SELECT the row for `(project_id, debug_id)`: same
  digest → heal (re-put only when `StatObject` fails) → 200 no-op; different
  digest → `409 debug_id_conflict` without any object write. (2) Otherwise
  put the digest-keyed object, then `INSERT ... ON CONFLICT DO NOTHING`; on
  losing the race, re-read and compare digests — equal → 200, different →
  409 (the loser's object stays orphaned and unreferenced). Existing bucket,
  distinct `sourcemaps/` prefix (the retention sweeper only touches session
  prefixes; state this co-tenancy in the PR).
- **The worker verifies what it fetches:** before use, recompute the fetched
  object's canonical digest and compare with the row's `content_sha256`; a
  mismatch counts as `invalid_map`, so silent object corruption cannot feed
  wrong source to the fix agent.
- The dead `InsertSourceMap` Go code is deleted; the legacy release-keyed
  `source_maps` table is dropped by a follow-up migration in the NEXT release
  (expand/contract — dropping it alongside the worker change would break an
  old worker against a migrated database). New migrations start at `030`
  (append-only numbering; the `028` pair is already a collision).
- **No read path.** No GET, no presigned URL, no dashboard/admin route returns
  map bytes or `sourcesContent`. The route simply does not exist.
- **Deletion floor:** no project DELETE endpoint exists, so the tombstone
  cannot live in a handler. The `030` migration adds a `BEFORE DELETE ON
  projects` trigger writing a tombstone row (project ID + storage prefix) so
  even a manual SQL delete records which object prefixes hold orphaned
  customer source. The object sweeper itself is deferred.

### 3. Plugin uploads what it stamped (SDK)

- The plugin resolves `OPSLANE_SOURCEMAP_KEY` and `OPSLANE_ENDPOINT` from
  `process.env` first (CI), falling back to the project's Vite env files via
  `loadEnv(config.mode, config.root, 'OPSLANE_')` — so a key pasted into the
  gitignored `.env.local` makes local production builds upload with no shell
  exports. Non-`VITE_`-prefixed vars never reach browser code, so this
  cannot leak the sk into the bundle.
- When both are present, upload each stamped map. Payload bytes are
  **recorded at stamp time** (each stamp path stores the final map string in
  an upload buffer keyed by map file name; the later restamp path overwrites
  its entry) — the discard sweep removes bundle entries, not these recorded
  copies, so remove mode always has bytes to upload. Uploads run in
  `closeBundle`. Custody per mode: **remove mode (the default when the
  plugin itself enabled source maps; a project's explicitly configured maps
  are kept, matching existing behavior)** uploads the recorded in-memory
  bytes; **keep mode** re-reads
  the on-disk bytes at upload time and **recomputes each file's debug ID
  immediately before upload**, skipping and warning on any mismatch — this
  closes the window where another plugin's later `writeBundle` mutates files
  after our verification pass.
- **The uploader paces itself against the server limit:** on 429 it waits
  the `Retry-After` (default 30 s, capped at 120 s) and retries the file; one
  retry on network error; concurrency stays small (4). A 248-map build at
  60/min therefore completes in ~4–5 minutes instead of losing everything
  after the first 60 requests. The per-file cap is enforced on the FINAL
  stamped bytes at upload time (the plugin's existing `maxMapBytes` check
  runs pre-stamp, so it alone cannot guarantee the wire size): oversized
  entries are skipped with a warning naming the file.
- A key not matching `opslane_sk_` is refused with a warning. Upload failure
  (after retries) logs a clear warning naming the files and never fails the
  customer build; in keep mode the warning names which maps must not be
  deployed.
- Warn when the user-configured `maxMapBytes` exceeds the server's 32 MiB cap.
- Version via the Changesets workflow: one new major changeset joins the two
  already pending for `@opslane/sdk`, and the next release consumes them all
  as a single 2.0.1 → 3.0.0 bump (majors don't stack). The S6a codemod's
  `OPSLANE_VITE_PLUGIN_MIN_VERSION = '3.0.0'` gate un-inerts when that
  release ships, not at merge.

### 4. Worker resolves by debug ID (worker)

- Extend the worker's event query to select `debug_meta`
  (`getErrorEvent` in `packages/worker/src/db.ts` currently doesn't).
- **Drop the `event?.release` gate** at both call sites in
  `packages/worker/src/index.ts` — debug-ID lookup needs no release.
- **Run resolution before the LLM-key check and the repo clone** in the
  investigate path: resolution depends only on the database and object
  storage, and relocating it means a keyless or clone-failing worker still
  records the resolution outcome (and the E2E needs no `ANTHROPIC_API_KEY`
  to assert it).
- **Fix the column base:** browser stack columns are 1-based;
  `@jridgewell/trace-mapping` expects 0-based columns. The current
  `resolveFrame` passes them through unadjusted — an off-by-one on every
  frame. The shared resolver subtracts 1 (floored at 0) and a test pins a
  known position.
- Extract the duplicated per-event resolution loop into **one shared resolver
  module**; both the investigate and fix paths consume its output.
- Join rule, stated so it cannot be improvised: a stack frame resolves against
  the image whose `code_file` **exactly equals** the frame's file URL. No
  basename fallback (the current dead code's heuristic is deleted with it).
- Fetch `sourcemap_files` rows by `(project_id, debug_id)`, fetch objects
  from the shared bucket prefix, resolve with the existing `resolveFrame`.
- Store the frozen `resolution_status` enum value (`resolved | partial |
  no_debug_ids | map_not_found | invalid_map | resolution_failed`) on the
  event row (**new migration**), and **persist the resolved frames into the
  existing `stack_trace_resolved` column in a pinned v1 envelope**:

  ```json
  {"version": 1, "frames": [{
    "original_file": "src/App.vue", "original_line": 12, "original_column": 4,
    "source_snippet": "…", "generated_file": "http://…/index-abc.js",
    "generated_line": 1, "generated_column": 100,
    "debug_id": "aaaaaaaa-…"
  }]}
  ```

  (snake_case, generated position and debug ID included so the frame is
  auditable without re-resolution; the resolver output is extended
  accordingly). `invalid_map` is distinguished from `resolution_failed` by
  an explicit map-parse probe, not inferred from a shared null. Frozen
  §10's remaining fields (frame counters, `resolution_problem`, consistency
  constraints) are explicitly superseded for v1 — see the amendment.
  Written at investigation time for the investigated sample event; a seed
  for later health surfaces, not a census.
- The "Resolved Stack Trace (source-mapped)" prompt blocks in
  `investigate.ts` / `agent-fix.ts` already exist and light up unchanged.

### 5. Prove it (E2E)

**New harness required.** The existing browser E2E boots fixtures with a Vite
dev server, but the plugin is `apply: 'build'`. The slice includes a
build-then-serve harness (`vite build` + `vite preview`) for
`test-fixtures/vue-app`. Known prerequisites: config injection via the
fixture's existing `VITE_*` env pattern at build time; make the fixture's
hardcoded `release` env-controlled so the run can omit it; seed two projects
with pks and sks in `scripts/seed-e2e.sql` for the isolation assertion.

Acceptance, which is also the v1 definition of done:

1. Build the fixture with the plugin and a seeded sk in env.
2. Assert `sourcemap_files` has the expected rows (positive signal — "no maps
   in build output" alone is vacuous in remove mode) **and** no `.map` files
   or `sourceMappingURL` references are in the build output.
3. Serve the built bundle, throw one error with the pk, no release configured.
4. Assert the stored event resolves — database assertions, no LLM key needed
   because resolution runs before the LLM-key check: `resolution_status =
   'resolved'` and `stack_trace_resolved` contains the original file, line,
   and snippet. (That the prompt renders stored frames is covered by the
   existing "Resolved Stack Trace" formatting unit tests.)
5. Negative floor: a pk cannot upload (`403 insufficient_scope`); an sk cannot
   send events; no route returns map bytes. Isolation is proved by a
   DISCRIMINATING check (identical content in both projects would prove
   nothing): project B sends an event carrying the same `debug_meta` while B
   has uploaded no map — B's event must record `map_not_found` while A's
   resolves; after B uploads, B's next event resolves.

## Contract amendment

`docs/design/2026-07-29-keys-sourcemaps-s0-contracts.md` is marked frozen, but
most of it was never implemented. Amend the doc explicitly (repo guardrail:
change contracts explicitly, never silently):

- **Stays frozen (shipped or shipping here):** event `debug_meta` wire shape,
  debug-ID algorithm, canonical `content_sha256`, and golden vectors, key
  formats, the sk-only authorization boundary, server-side debug-ID recompute
  on upload with `debug_id_mismatch` / `debug_id_conflict`, the
  `resolution_status` enum.
- **Superseded for v1, each named:** §3's key CRUD endpoints → manual
  `cmd/mint-key` + documented SQL revocation (key management returns with
  the onboarding track); §5's "2.1.0" version note → 3.0.0; **§6 map-validity
  rules → `sourcesContent` optional** (hash and vectors unaffected); §6's
  100 MiB per-file limit → 32 MiB; §7 batch protocol → single-map identity-
  encoded PUT (its "no Content-Encoding in v1" rule is kept and enforced with
  415); §7's cluster-wide upload throttles → one
  process-local 60/min per-project limiter (single-replica deployment; byte
  budgets return with the batch protocol); §8 batch tables →
  `sourcemap_files` with digest-addressed object keys
  (`sourcemaps/{project}/{debugID}/{content_sha256}` — conflicting concurrent
  uploads write different objects, so overwrite is structurally unreachable); §9 verify endpoint and §11 status endpoint →
  dropped; **§10 resolution persistence → `resolution_status` +
  `stack_trace_resolved` only** (frame counters, `resolution_problem`, and
  the consistency CHECKs are dropped for v1); §12's deletion loop → tombstone
  trigger plus a documented manual purge command (see risks); the "sk never
  touches disk" onboarding posture → "sk never enters a tracked file or the
  bundle" (operator-managed `.env.local` is acceptable).

## Deferred: onboarding track (settled decisions, not in this slice)

Decisions already made with the maintainer for when onboarding integration is
built, recorded so they are not re-litigated:

- `opslane onboard` mints the sk in `ProvisionOnboardSession` only (never in
  the shared `provisionProjectTx` — `POST /api/v1/projects` must not mint).
- Plain rerun is never destructive; an explicit `--rotate-sourcemap-key` flag
  revokes prior sks in the mint transaction and tells the user to update CI.
- The CLI writes the sk to the gitignored `.env.local` (non-`VITE_`-prefixed)
  and prints the CI instruction; every other CLI sink (agent-credentials,
  pending sessions, run log, sealed session key) is guarded against sk values.
- The S6a codemod (`opslane sourcemaps install-plugin`) gets wired into the
  onboarding flow with its consent screen.

## Risks and accepted trade-offs

- **Manual key handling.** Minting requires database access and the Go
  toolchain; fine while the operators are the maintainers. The onboarding
  track replaces it.
- **Per-file uploads on big builds.** A 248-map build makes 248 PUTs. With a
  generous per-project limit and idempotent retries this is acceptable now;
  the shelved batch protocol is the known fix if it hurts.
- **No upload-health visibility (accepted explicitly).** If CI loses the key,
  maps silently stop; the build log warns but green builds go unread. The
  first signal is `resolution_status = 'map_not_found'` on an investigated
  event. S5b remains the successor.
- **Late maps don't heal old events.** No reprocessing; the next occurrence
  resolves.
- **Deleting a project does not automatically purge its maps.** The trigger
  records a tombstone; the operator runs the documented one-liner against
  object storage (`mc rm -r --force <bucket>/sourcemaps/<projectID>/` or the
  ingestion client's `RemovePrefix`) and deletes the tombstone. The automatic
  sweeper stays deferred; the tombstone guarantees the prefix is never
  forgotten.
- **The sk sits in plaintext in the operator's `.env.local`** (explicit DX
  decision). Exposure via backups or local tooling is accepted for v1; the
  response to any suspicion is the printed exact-key revocation SQL plus a
  fresh mint.

## What v1 explicitly does not do

Batch/atomic uploads, probe batches, gzip upload bodies, upload health UI,
key-management UI/API, any onboarding or CLI changes, dashboard missing-map
warnings, deployed-commit checkout, the project-deletion object sweeper
(tombstone trigger only), verify/status endpoints, non-Vite build tools.
