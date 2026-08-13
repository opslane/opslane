# C6: Identity Cutover (host-free friction keys) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friction identity stops depending on the page's origin — one versioned URL-normalization contract (Go behavior is the spec) shared by Go and TypeScript through a single golden fixture file, cut over via a `RULE_VERSION` bump with no in-place rewrite, and `route_map` canonicalized to path-only patterns behind a dual-read window, with every collision resolved deterministically or recorded in an audit table.

**Architecture:** Five deploy steps, expand/contract (pipeline design §6.1, verbatim): (1) dual-read route lookups ship first — the four exact-equality join sites learn to match either dialect; (2) canonical-writing code deploys — the worker's `upsertRouteMapRows` strips origins at the write boundary — and old workers drain; (3) an idempotent migration (`050`) canonicalizes `route_map`, recording name conflicts in `route_map_migration_conflicts`; (4) the friction `RULE_VERSION` cutover — `fingerprint.ts` adopts the shared host-free normalizer and old buckets freeze under their version; (5) canonical-writes-only enforcement (`051`: straggler sweep + CHECK constraint). Each step is its own PR and its own deploy; a later step never ships in the same release as the one before it.

**Tech Stack:** Go 1.24 (`packages/ingestion`: `priority`, `db/migrations`), TypeScript Node 22 (`packages/worker`: `friction`, `db.ts`), Postgres (psql-replayed migrations, autocommit per statement), Vitest + Go testing over one shared JSON fixture, `test-e2e` friction lane.

**Spec:** `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` §C6 (CP6 criteria) — authority above it: `docs/design/2026-08-10-unified-actionable-program.md` (decision 8) and `docs/design/2026-08-10-actionable-pipeline-design.md` §6.1. Source issues: #308 (contract + fixtures), #309 (RULE_VERSION cutover), #310 (route_map canonicalization — its migration half). #311 is a decision issue: this plan adopts option A (age out; nothing implemented) and #311 closes by recording that. #312 (route-name titles) is T2, after C6, not here. Per the program plan, **C6 owns its own cross-language URL golden fixtures**; W7.1's splinter fixtures are message-normalization cases and stay out.

## Global Constraints

- Postgres queue only; wire contract append-only (`test-fixtures/wire/` untouched — the SDK sends raw URLs; normalization is entirely server/worker-side); lease and terminal-status contracts preserved; human-trigger bypass untouched.
- **Go `NormalizePageURL` is the spec and does not change in C6.** Error-lane keys (`error_groups.page_url_normalized`) are *not* version-namespaced; changing the Go normalizer would silently re-key the error book. Every fixture row is authored against Go's current output; where Go has a quirk (see Deviation 1), the fixture pins the quirk.
- **No in-place rewrite of any fingerprint-keyed data.** Bucket watermarks (`friction_bucket_state`, PK includes `rule_version`), generation evidence, and incident attachments freeze under version 3. The 521 origin-full friction `error_groups` rows are not rewritten (#311-A): active ones are re-stamped path-only by the sweeper's existing 7-day back-stamp, stale ones age out.
- **Migration discipline** (`packages/ingestion/AGENTS.md` + runner reality): `scripts/run-migrations.sh` replays *every* file on *every* boot, psql autocommit per statement, `ON_ERROR_STOP=1`. Every statement must be guarded (`IF NOT EXISTS` / `applied_data_migrations` ledger, per the `045` pattern) so any statement prefix re-runs safely, forever. New migrations take `050` and `051` (current highest: `049_action_scope.sql`).
- **No silent collision resolution:** every route_map merge that discards a name writes a `route_map_migration_conflicts` row. (This audit table supersedes #310's "stop and surface" wording — the audit row *is* the surfacing; the program plan's AC6.4 is the later authority.)
- Deploy-order constraint: a PR in this train merges only after the previous PR's deploy is live and old workers have drained. C6 interleaves freely with C2–C5 (own track since C0) but its own five steps are strictly ordered.
- ESM + strict TypeScript, `unknown` + narrowing, Vitest colocated in `__tests__`; server-side packages stay AGPL-3.0-only; no new dependencies.
- Go tests must not add unexplained skips; worker DB-gated tests follow the `db.test.ts` convention (skip without `DATABASE_URL`); `pnpm -r build` after shared-surface changes.

## Dependencies (consumed, never edited)

- **C0/044:** nothing — C6 has no reserved contracts in 044 (verified); it owns `050`/`051` cleanly.
- Go normalizer: `packages/ingestion/priority/urlnorm.go` (`NormalizePageURL` :32, `templateSegment` :77, `boundPattern` :97, `MaxPatternBytes = 512` :27) and its inline test table `packages/ingestion/priority/urlnorm_test.go` (33 rows + oversized case + `TestConvergesAcrossBothStampingPaths` :67-91).
- Route table: `packages/ingestion/db/migrations/040_route_map.sql` — `route_map(project_id, pattern, name, purpose, tier CHECK IN ('customer','standard','admin'), source, created_at, updated_at)`, PK `(project_id, pattern)`, no pattern constraint today.
- The four exact-equality lookup sites: `packages/ingestion/priority/sweeper.go:102` (`scoreErrorGroupsSQL`), `:152` (`scoreFrictionGroupsSQL`), `:271-274` (`enqueueRouteMapJobsSQL` anti-join); `packages/worker/src/db.ts:1597-1616` (`listUnmappedPatterns` anti-join).
- The one route_map writer: `packages/worker/src/db.ts:1626+` `upsertRouteMapRows` (lease-checked upsert, `WHERE route_map.source <> 'human'`; SQL text pinned by `packages/worker/src/__tests__/db-queries.test.ts:298-342`).
- Friction identity: `packages/worker/src/friction/fingerprint.ts` (`normalizePageUrl` :4 — returns `` `${url.origin}${path}` ``, the defect; `frictionFingerprint` :52-61 — `sha256(`${signalType}|${canonicalSelector}|${pageUrl}`)` first 32 hex chars); `RULE_VERSION = 3` (`analyzer.ts:8`); the only `normalizePageUrl` call site is `analyzer.ts:137-146` (`pageAt`), feeding both `fingerprint` and `pageUrlNormalized` in `makeSignal` (:166-176) — fingerprint and stored URL always move in lockstep.
- Version machinery (all verified version-scoped): `friction_bucket_state` PK `(project_id, environment_id, fingerprint, rule_version, prompt_version)` (041:11-28); `countEligibleUsers`/`listEligibleSignals` filter `rule_version` (`promotion-db.ts:332-348`, `:101-120`); `persist.ts:66-82` supersedes same-fingerprint lower versions and retracts the rest; generations' in-flight uniqueness includes `rule_version` (007:49-51).
- Fold path: `promotion-db.ts:59-94` `findFoldTarget` — session + ±30s time only, **no URL predicate**; C6 cannot affect it (e2e already proves it: `test-e2e/friction-incidents.test.ts` fold case).
- Migration tooling: `applied_data_migrations` ledger (028:28-31; usage template `045:3-17`); disposable-DB migration test harness `packages/ingestion/db/migrations_test.go` (`applyMigration` twice = idempotency proof, template `migration_049_test.go:38,84`); CI reapply gate `scripts/check-migration-reapply.sh` (extend `SEED_SQL`/`cleanup_seed` when adding a constraint).
- Fixture-loading conventions: Go `os.ReadFile("../../../test-fixtures/<dir>/<file>.json")` (`grouping/python_test.go:21`); TS `JSON.parse(await readFile(new URL('<relative>/test-fixtures/...', import.meta.url), 'utf8'))` (`worker/src/harness/__tests__/python-frames.test.ts:11-14`; from `src/friction/__tests__/` the prefix is four `../`).
- Line numbers are anchors into the working tree, verified 2026-08-12. Where a symbol has moved, locate it by name (`grep -n`); the named function is the contract, not the line.

## File Structure

| File | Responsibility |
| --- | --- |
| `test-fixtures/url-normalization/vectors.json` (create, Task 1) | The cross-language golden vector table — the identity contract |
| `packages/ingestion/priority/urlnorm_test.go` (modify, Task 1) | Consumes the fixture (inline table retired into it); convergence test kept |
| `packages/worker/src/friction/urlnorm.ts` (create, Task 2) | TS port of the Go spec (host-free, hashbang, `:token`, byte cap) |
| `packages/worker/src/friction/__tests__/urlnorm.test.ts` (create, Task 2) | Vitest suite over the same fixture file |
| `packages/ingestion/priority/sweeper.go` (modify, Task 3) | Dual-read in both score SQLs + the enqueue anti-join |
| `packages/ingestion/priority/sweeper_test.go` (extend, Task 3) | Mixed-dialect resolution matrix (AC6.3), no-duplicate-join guard |
| `packages/worker/src/db.ts` (modify, Tasks 4, 5) | Dual-read anti-join in `listUnmappedPatterns`; canonical writes in `upsertRouteMapRows` |
| `packages/worker/src/__tests__/db-queries.test.ts` (extend, Tasks 4, 5) | Updated SQL pins + canonicalization/dedupe behavior |
| `packages/ingestion/db/migrations/050_route_map_canonicalization.sql` (create, Task 6) | Canonicalization + `route_map_migration_conflicts` audit table |
| `packages/ingestion/db/migration_050_test.go` (create, Task 6) | Collision matrix on a disposable DB, applied twice |
| `packages/ingestion/priority/testutil_test.go` (modify, Task 6) | `seedTenant` cleanup gains the audit table |
| `packages/worker/src/friction/fingerprint.ts` (modify, Task 7) | `normalizePageUrl` delegates to `urlnorm.ts` (host-free) |
| `packages/worker/src/friction/analyzer.ts` (modify, Task 7) | `RULE_VERSION` 3 → 4 |
| `packages/worker/src/friction/__tests__/analyzer.test.ts` (modify, Task 7) | Origin-retaining assertions rewritten host-free |
| `packages/worker/src/friction/promotion.ts` (modify, Task 8) | Pending-signal selection gains a `rule_version` filter |
| `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts` (extend, Task 8) | Cross-version isolation (AC6.6) + retract-not-supersede across the key change |
| `test-e2e/friction-incidents.test.ts` (extend, Task 9) | Origin-rotation case (AC6.2) |
| `packages/ingestion/db/migrations/051_route_map_enforcement.sql` (create, Task 10) | Straggler sweep + `CHECK (pattern !~* '^https?://')` |
| `packages/ingestion/db/migration_051_test.go` (create, Task 10) | Constraint + straggler behavior, applied twice |
| `scripts/check-migration-reapply.sh` (modify, Task 10) | Seed + cleanup rows for the new constraint |

**PR train (each PR = one deploy step; strict order):** PR1 = Tasks 1–4 (expand: contract + dual-read) · PR2 = Task 5 (canonical writes) · PR3 = Task 6 (migration 050) · PR4 = Tasks 7–9 (RULE_VERSION cutover) · PR5 = Task 10 (enforcement) · CP6 = Task 11.

## Deviations and recorded decisions (each deliberate, source-verified)

1. **Go quirks are pinned, not fixed.** Two known oddities survive into the contract because Go output must not change (unversioned error-lane keys): (a) protocol-relative input (`//cdn.example.net/a`) takes the bare-path branch and keeps the host as a path segment (`/cdn.example.net/a`); (b) a plain `#/route` (non-hashbang) fragment is dropped, collapsing hash-only SPA routes onto their base path. Both get fixture rows with their current-Go outputs and a `"quirk": true` note field. Fixing either is a future Go-side change with its own re-keying analysis.
2. **`normalizeEntryPath` is untouched.** #308's problem statement lists its drift, but it feeds `session_analysis.entry_path` (analytics, no fingerprint, no version namespace); changing it mid-book would split the entry-path facts without a version to freeze behind. Unifying it onto the contract is follow-up work, not C6.
3. **Across the cutover, changed-key rows retract and unchanged-key rows supersede.** `persist.ts:66-75` supersession matches on identical fingerprints; after the key change a v3 signal and its v4 re-detection usually have different fingerprints, so the v3 row falls to the retract-the-rest statement (`:76-82`). Rows whose fingerprint is identical under both normalizers (e.g. the empty-URL fallback) still supersede — also correct. Both paths remove the old row from every count while leaving v3 bucket state frozen. Task 8 pins both with tests rather than "fixing" either.
4. **A new friction incident is minted for a recurring page; the old one goes quiet.** `error_groups.fingerprint` (`friction:${environmentId}:${signalFingerprint}`) is not version-namespaced; the new key creates a new row. Old incidents stop accumulating (their signals retract on re-analysis, never re-detect) and age out — the accepted #311-A cost. No code change.
5. **Adjudication has no job type to re-check.** #309's "claimed adjudication job re-checks version after claim" maps onto reality as: adjudication runs inline in `session_analysis` (`index.ts:1008-1109`), so the guards are (a) `writeFrictionSignals` retracting old-version rows before `processFrictionOutcomes` runs, and (b) Task 8's explicit `rule_version` filter on the pending-signal selection — closing the one path where an escaped old-version pending row could be adjudicated into its old namespace. The rolling-deploy hazard (an old *binary* re-inserting v3 rows) is handled by the deploy-order constraint (drain before the next step), not by code.
6. **Dual-read is symmetric and stays after C6.** "Try path-only then origin-full" is implemented as one strip-origin-both-sides predicate with a preference order (exact match first, then path-only row) — covering all four dialect combinations during the window, including path-only group keys against not-yet-migrated origin-full route rows. It remains in place after step 5 because old origin-full *group* keys (the #311-A book) still exist; removing dual-read is post-program cleanup once that book has aged out. The regexp predicate is unindexed by design: `route_map` is ~50 rows/project and the join is bounded by it.
7. **Canonical-write normalization is strip-origin only, not the full normalizer.** Patterns arriving at `upsertRouteMapRows` are already-normalized keys (they came out of `page_url_normalized`); the only dialect difference is the origin prefix. Re-running the full normalizer would re-template literal `:id`/`:token` segments' neighbors and is strictly riskier than removing the prefix.
8. **The byte-cap constant now exists three times, pinned by one fixture.** Go `MaxPatternBytes` (urlnorm.go:27), the new TS `MAX_PATTERN_BYTES` (urlnorm.ts), and the pre-existing query guard `MAX_ROUTE_PATTERN_BYTES` (db.ts:1577) all say 512. The fixture's over-cap rows fail both language suites if either normalizer's cap drifts; db.ts:1577 is a read-side guard with its own comment and stays.
9. **AC6.2's "three signals, one candidate" is staged.** `PROMOTION_THRESHOLD_USERS = 5` is a constant, not injectable. The e2e case asserts one bucket + three signals after three rotated-origin sessions, then crosses the threshold with two more users and asserts exactly one candidate. Both halves of the criterion hold, at their natural moments.
10. **Migration 050 resolves collisions instead of aborting.** #310 said "stop and surface" for non-trivial name conflicts; the program plan's AC6.4 (later authority) says "resolved per policy or present in the audit table." The policy below is total and deterministic; every discarded name is a durable audit row reviewed at CP6, so no conflict is silent and none blocks the deploy.
11. **Fixture rows are authored red-then-green against Go.** The fixture is written first from the algorithm reading, then the Go suite runs; any row Go disagrees with is corrected to Go's actual output *before* the TS port is written. Go is the oracle; the fixture is its transcript; TS conforms to the transcript.
12. **The TS port does not trust WHATWG for the path — or for validity.** `new URL` collapses dot segments, rewrites backslashes, and tolerates invalid percent-escapes — places it disagrees with Go `net/url`. The port uses `new URL` only as a coarse parse gate; the path and fragment are extracted from the raw string, and explicit checks mirror `net/url`'s stricter validation: invalid percent-escapes in the **authority, path, or fragment** fail (Go validates those but *not* the query, which it keeps raw), and a backslash in the authority fails (Go rejects it in a host; WHATWG rewrites it to `/`). Fixture rows pin each divergence area. **Decode-count note (round-2 pushback, recorded):** Go reads `u.EscapedPath()` (`urlnorm.go:51`) — the still-escaped form — so decoding happens exactly once, in `templateSegment`'s `PathUnescape`; `%252F` therefore decodes to `%2F`, not `/`. A reviewer claim of double decoding was checked against the source and rejected; Deviation 11's run-against-Go step remains the arbiter for every such row.
13. **Every SQL origin-strip is case-insensitive.** Stored origins are lowercase in practice (WHATWG lowercases `url.origin`), but detection uses `~*` while `regexp_replace` defaults to case-sensitive — a mismatched pair is a landmine (a row detected but not stripped loops or breaks the CHECK). All strips pass the `'i'` flag; migration tests seed an `HTTPS://` row.
14. **Case-only name differences are trivial, not conflicts.** Twins whose names differ only in case merge without an audit row (the `lower()` comparison), matching #310's "beyond trivial casing" line. The audit table records *name* conflicts only; `purpose` follows the name-winner (recorded here, tested, and the dropped row's `source`/`purpose` are captured on the audit row for forensics).
15. **The merged survivor keeps its own `updated_at`.** #310's sketch said "latest `updated_at`"; that manufactures provenance (a row claiming an update time from a row that no longer exists). The survivor keeps its own `updated_at`; `created_at` takes the twin-set minimum (age is a real property of the logical route). Deliberate deviation from #310's wording.
16. **v3 `pending` signals stay pending; that is terminal by decay, not neglect.** After the cutover, an old-version pending row is (a) retracted the next time its session is re-analyzed, or (b) simply ages out of the 7-day evidence window; version-scoped counting ignores it either way, and Task 8 makes it invisible to adjudication. Actively retracting the v3 book would be exactly the in-place rewrite this program forbids. Recorded, not "fixed."

---

### Task 1: The golden fixture and the Go side of the contract

**Files:**
- Create: `test-fixtures/url-normalization/vectors.json`
- Modify: `packages/ingestion/priority/urlnorm_test.go`

**Interfaces:**
- Produces: the fixture file consumed verbatim by Task 2's Vitest suite. Shape:

```json
{
  "comment": "Cross-language URL-normalization contract (C6). Go NormalizePageURL is the oracle; both suites load this file. Changing a row must break both languages or neither.",
  "vectors": [
    { "name": "hashbang fragment", "in": "https://app.example.com/#!/reports", "want": "/reports" }
  ]
}
```

  Row fields: `name` (unique), `in`, `want`, optional `"quirk": true` (documentation only — suites ignore it).

- [ ] **Step 1: Author the fixture.** Port **every** row of `TestNormalizePageURL`'s inline table (`urlnorm_test.go:5-61`, 33 rows) into `vectors.json` verbatim (`name`/`in`/`want` copied field-for-field), then append these new rows (coverage #308 names; `want` values derived from the algorithm, to be corrected against Go in Step 2 if any disagree):

```json
{ "name": "default https port dropped with host", "in": "https://app.example.com:443/reports", "want": "/reports" },
{ "name": "explicit port dropped with host", "in": "http://app.example.com:8080/a/b", "want": "/a/b" },
{ "name": "trailing slash trimmed", "in": "https://app.example.com/reports/", "want": "/reports" },
{ "name": "repeated slashes collapse", "in": "https://app.example.com//reports///weekly", "want": "/reports/weekly" },
{ "name": "query and fragment both stripped", "in": "https://app.example.com/reports?tab=1#section", "want": "/reports" },
{ "name": "hashbang route with query", "in": "https://app.example.com/#!/reports?tab=2", "want": "/reports" },
{ "name": "bare-path hashbang", "in": "/#!/reports", "want": "/reports" },
{ "name": "plain hash route drops to base path", "in": "https://app.example.com/#/reports", "want": "/", "quirk": true },
{ "name": "protocol-relative keeps host as segment", "in": "//cdn.example.net/assets/app.js", "want": "/cdn.example.net/assets/app.js", "quirk": true },
{ "name": "percent-encoded unicode segment decodes", "in": "https://app.example.com/caf%C3%A9/menu", "want": "/café/menu" },
{ "name": "hashbang unicode route", "in": "https://app.example.com/#!/caf%C3%A9", "want": "/café" },
{ "name": "multibyte segment over the byte cap", "in": "/reports/日日日…(200 repetitions of 日)", "want": "/too-long" },
{ "name": "uuid segment", "in": "https://app.example.com/assets/9d4e2a71-77aa-4f83-b8f1-0123456789ab", "want": "/assets/:id" },
{ "name": "numeric segment", "in": "https://app.example.com/orders/12345", "want": "/orders/:id" },
{ "name": "jwt segment", "in": "https://app.example.com/auth/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x1y2", "want": "/auth/:token" },
{ "name": "hex-16 segment", "in": "https://app.example.com/trace/deadbeefdeadbeef", "want": "/trace/:token" },
{ "name": "mixed alnum 16 no hyphen", "in": "https://app.example.com/s/abc123def456ghi7", "want": "/s/:token" },
{ "name": "letters-25 no separators", "in": "https://app.example.com/k/abcdefghijklmnopqrstuvwxy", "want": "/k/:token" },
{ "name": "base64url-22 with uppercase", "in": "https://app.example.com/b/AbCdEfGhIjKlMnOpQrStUv", "want": "/b/:token" },
{ "name": "forge canary shape", "in": "https://1a2b3c4d.cdn.forge.example/9d4e2a71-77aa-4f83-b8f1-0123456789ab/f0e1d2c3-4b5a-6789-abcd-ef0123456789/12345/global-page", "want": "/:id/:id/:id/global-page" },
{ "name": "context segments dropped", "in": "https://x.cdn.example.net/spa/_ctx_abc123/settings", "want": "/spa/settings" },
{ "name": "hostless scheme is not parseable", "in": "mailto:foo@example.com", "want": "/not-parseable" },
{ "name": "empty input stays empty", "in": "", "want": "" },
{ "name": "dot segments are literal, not resolved", "in": "https://app.example.com/a/../b", "want": "/a/../b", "quirk": true },
{ "name": "single dot segment is literal", "in": "https://app.example.com/a/./b", "want": "/a/./b", "quirk": true },
{ "name": "backslash is an ordinary character", "in": "https://app.example.com/a\\b/c", "want": "/a\\b/c", "quirk": true },
{ "name": "double-encoded segment decodes once", "in": "https://app.example.com/x%252Fy/z", "want": "/x%2Fy/z" },
{ "name": "invalid percent escape is not parseable", "in": "https://app.example.com/a%zzb", "want": "/not-parseable" },
{ "name": "uppercase scheme parses", "in": "HTTPS://app.example.com/reports", "want": "/reports" },
{ "name": "userinfo is not the path", "in": "https://user:pass@app.example.com/reports", "want": "/reports" },
{ "name": "ipv6 host with port", "in": "https://[2001:db8::1]:8443/reports", "want": "/reports" },
{ "name": "invalid escape in userinfo is not parseable", "in": "https://u%zz@app.example.com/reports", "want": "/not-parseable" },
{ "name": "invalid escape in query is tolerated", "in": "https://app.example.com/reports?q=%zz", "want": "/reports" },
{ "name": "backslash in authority is not parseable", "in": "https://app.example.com\\evil/reports", "want": "/not-parseable" }
```

  (The dot-segment, backslash, and invalid-escape rows are the divergence pins from Deviation 12 — Step 2 corrects any of their `want` values to Go's actual output, same as every other row.)

  (Write the multibyte row with the actual 200-character repetition in the file, not the ellipsis.)
- [ ] **Step 2: Rewrite the Go test to consume the fixture — run it and correct rows to Go's output.** Replace the inline table in `TestNormalizePageURL` with:

```go
func TestNormalizePageURL(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/url-normalization/vectors.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Vectors []struct {
			Name string `json:"name"`
			In   string `json:"in"`
			Want string `json:"want"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.Vectors) < 50 {
		t.Fatalf("fixture suspiciously small: %d rows", len(fixture.Vectors))
	}
	for i, tc := range fixture.Vectors {
		if tc.Name == "" {
			t.Fatalf("row %d: empty name (schema guard — a malformed row must not silently pass)", i)
		}
		if tc.In == "" && tc.Name != "empty input stays empty" {
			t.Fatalf("row %q: empty input on a row not named for it", tc.Name)
		}
		if got := NormalizePageURL(tc.In); got != tc.Want {
			t.Errorf("%s: NormalizePageURL(%q) = %q, want %q", tc.Name, tc.In, got, tc.Want)
		}
	}
}
```

  Keep the programmatic oversized-case check and `TestConvergesAcrossBothStampingPaths` unchanged. Run `go test ./priority/ -run TestNormalizePageURL -v` (from `packages/ingestion`). Expected: PASS, or per-row failures naming any authored row whose `want` disagrees with Go — fix those fixture rows to Go's printed output (Deviation 11), re-run to PASS. **Do not touch `urlnorm.go`.**
- [ ] **Step 3: Duplicate-name guard.** Add to the same test file a check that fixture `name`s are unique (a `map[string]bool` loop, `t.Errorf` on repeat). Run; PASS.
- [ ] **Step 4: Full package check.** `go build ./... && go test ./priority/` — PASS, zero new skips.
- [ ] **Step 5: Commit.** `git add test-fixtures/url-normalization/vectors.json packages/ingestion/priority/urlnorm_test.go && git commit -m "feat(identity): golden URL-normalization vectors, Go suite consumes them (C6 #308)"`

### Task 2: The TypeScript port

**Files:**
- Create: `packages/worker/src/friction/urlnorm.ts`
- Create: `packages/worker/src/friction/__tests__/urlnorm.test.ts`

**Interfaces:**
- Consumes: `test-fixtures/url-normalization/vectors.json` (Task 1).
- Produces (consumed by Tasks 5 and 7):

```ts
export const MAX_PATTERN_BYTES = 512;
export function normalizePageUrl(raw: string): string;   // the contract function
export function canonicalPattern(pattern: string): string; // strip-origin for already-normalized keys
```

- [ ] **Step 1: Write the failing test.**

```ts
// packages/worker/src/friction/__tests__/urlnorm.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalPattern, normalizePageUrl } from '../urlnorm.js';

interface Vector { name: string; in: string; want: string; quirk?: boolean }

const fixture = JSON.parse(
  await readFile(new URL('../../../../../test-fixtures/url-normalization/vectors.json', import.meta.url), 'utf8'),
) as { vectors: Vector[] };

describe('normalizePageUrl (cross-language contract)', () => {
  it('fixture is present and substantial', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(50);
  });
  it.each(fixture.vectors)('$name', ({ in: input, want }) => {
    expect(normalizePageUrl(input)).toBe(want);
  });
});

describe('canonicalPattern', () => {
  it('strips an origin prefix', () => {
    expect(canonicalPattern('https://app.example.com/assets/:id')).toBe('/assets/:id');
  });
  it('origin-only becomes root', () => {
    expect(canonicalPattern('https://app.example.com')).toBe('/');
  });
  it('path-only passes through', () => {
    expect(canonicalPattern('/assets/:id')).toBe('/assets/:id');
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm --filter @opslane/worker test src/friction/__tests__/urlnorm.test.ts` — module not found.
- [ ] **Step 3: Implement the port.** Go semantics, not WHATWG semantics, wherever they differ. `new URL` is used **only** to decide parseability and host presence; the path and fragment come from the raw string (WHATWG would collapse dot segments, rewrite backslashes, and tolerate invalid escapes — Deviation 12). Fragment decoded once in the absolute branch only, mirroring net/url; byte lengths, not UTF-16 lengths:

```ts
// packages/worker/src/friction/urlnorm.ts
// TypeScript half of the URL-normalization contract. The Go implementation
// (packages/ingestion/priority/urlnorm.go) is the spec; both sides are pinned
// by test-fixtures/url-normalization/vectors.json. Port faithfully — WHATWG
// URL behavior yields where it disagrees with Go net/url on a fixture row.

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const JWT = /^eyJ[A-Za-z0-9_-]+\./;
const HEX = /^[0-9a-fA-F]{16,}$/;
const MIXED = /^(?:[A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*|[A-Za-z0-9+/=_]*[A-Za-z][A-Za-z0-9+/=_]*\d[A-Za-z0-9+/=_]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const MAX_PATTERN_BYTES = 512;

export function normalizePageUrl(raw: string): string {
  if (raw === '') return '';
  let path: string;
  let frag = '';
  if (raw.startsWith('/')) {
    // Bare path: split the fragment off raw (Go does the same, undecoded).
    path = raw;
    const i = path.indexOf('#');
    if (i >= 0) {
      frag = path.slice(i + 1);
      path = path.slice(0, i);
    }
  } else {
    // Coarse parse gate via WHATWG; everything else from the raw string,
    // because WHATWG normalizes the path (dot segments, backslashes, invalid
    // escapes) where Go net/url does not.
    let host = '';
    try {
      host = new URL(raw).host;
    } catch {
      return '/not-parseable';
    }
    if (host === '') return '/not-parseable';
    // Split "scheme://authority" off the raw string; the remainder is
    // path[?query][#fragment], byte-for-byte what Go's EscapedPath sees.
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
    if (m === null) return '/not-parseable';
    const authority = m[1] ?? '';
    const rest = raw.slice(m[0].length);
    const hashAt = rest.indexOf('#');
    const rawFrag = hashAt >= 0 ? rest.slice(hashAt + 1) : '';
    const pathAndQuery = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
    const queryAt = pathAndQuery.indexOf('?');
    path = queryAt >= 0 ? pathAndQuery.slice(0, queryAt) : pathAndQuery;
    // net/url fails Parse on invalid escapes in the authority, path, or
    // fragment (the query is kept raw and unvalidated), and rejects a
    // backslash in the host. WHATWG tolerates or rewrites all of these.
    if (authority.includes('\\')) return '/not-parseable';
    if (hasInvalidEscape(authority) || hasInvalidEscape(path) || hasInvalidEscape(rawFrag)) {
      return '/not-parseable';
    }
    // net/url hands Go a decoded fragment; the raw string is not. Decode once.
    try {
      frag = decodeURIComponent(rawFrag);
    } catch {
      frag = rawFrag;
    }
  }
  if (frag.startsWith('!')) path = frag.slice(1);
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const out: string[] = [];
  for (const seg of trimSlashes(path).split('/')) {
    // Framework context segments carry per-session state, not route identity.
    if (seg === '' || seg.startsWith('_ctx_')) continue;
    out.push(templateSegment(seg));
  }
  return boundPattern('/' + out.join('/'));
}

// Strip-origin canonicalization for values that are already normalized keys
// (route_map patterns, stored page_url_normalized). Not the full normalizer:
// re-templating an already-templated key is riskier than removing its prefix.
export function canonicalPattern(pattern: string): string {
  const stripped = pattern.replace(/^https?:\/\/[^/]*/i, '');
  return stripped === '' ? '/' : stripped;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+/, '').replace(/\/+$/, '');
}

// Mirrors net/url's escape validation: every '%' must head a 2-hex-digit
// escape, or Go's Parse fails and NormalizePageURL returns /not-parseable.
function hasInvalidEscape(s: string): boolean {
  for (let i = s.indexOf('%'); i >= 0; i = s.indexOf('%', i + 1)) {
    if (!/^[0-9a-fA-F]{2}/.test(s.slice(i + 1))) return true;
  }
  return false;
}

function templateSegment(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // Mirrors Go: a failed PathUnescape leaves the segment as-is.
  }
  const bytes = Buffer.byteLength(s, 'utf8'); // Go len() counts bytes
  if (NUMERIC.test(s) || UUID.test(s)) return ':id';
  if (
    JWT.test(s) ||
    HEX.test(s) ||
    (bytes >= 16 && !s.includes('-') && MIXED.test(s)) ||
    (bytes >= 25 && !/[-_]/.test(s)) ||
    (bytes >= 22 && BASE64URL.test(s) && (/\d/.test(s) || s !== s.toLowerCase()))
  ) {
    return ':token';
  }
  return s;
}

function boundPattern(pattern: string): string {
  return Buffer.byteLength(pattern, 'utf8') > MAX_PATTERN_BYTES ? '/too-long' : pattern;
}
```

- [ ] **Step 4: Run → PASS.** Same command. Every fixture row must pass — a red row here is a porting bug (fix `urlnorm.ts`), never a fixture edit: Go already blessed the row in Task 1.
- [ ] **Step 5: Cross-check the whole worker suite still builds and passes.** `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` (nothing imports the new module yet; this catches config/tsconfig slips).
- [ ] **Step 6: Commit** (both files are new — `-am` would miss them): `git add packages/worker/src/friction/urlnorm.ts packages/worker/src/friction/__tests__/urlnorm.test.ts && git commit -m "feat(worker): host-free URL normalizer, fixture-pinned to Go (C6 #308)"`

### Task 3: Dual-read in the sweeper (Go)

**Files:**
- Modify: `packages/ingestion/priority/sweeper.go` (`scoreErrorGroupsSQL` :80-122, `scoreFrictionGroupsSQL` :124-172, `enqueueRouteMapJobsSQL` :263-282)
- Test: `packages/ingestion/priority/sweeper_test.go`

**Interfaces:**
- Produces: one canonical-form SQL expression, used identically at all Go sites, Task 4's TS site, and migrations 050/051 (the `'i'` flag is load-bearing — detection elsewhere uses `~*`, and a strip that misses what detection catches loops; Deviation 13):

```sql
COALESCE(NULLIF(regexp_replace(x, '^https?://[^/]*', '', 'i'), ''), '/')
```

- [ ] **Step 1: Write the failing tests** (extend `sweeper_test.go`, DB-gated, `seedTenant` convention). Three cases in one test func `TestRouteLookupDualRead`:
  1. **Origin-full route row resolves a path-only group** (post-cutover shape): seed `route_map(pattern='https://app.test/orders/:id', name='Orders', tier='customer')` and an error group stamped `page_url_normalized='/orders/:id'`; run the score pass; assert `priority_inputs.route_name = 'Orders'` and `route_weight` reflects `customer` (3.0).
  2. **Path-only route row resolves an origin-full group** (pre-back-stamp friction shape): seed `route_map(pattern='/checkout', …)` and a friction group keyed `https://x.cdn.test/checkout`; assert resolution.
  3. **Both dialect twins present → exactly one match, exact preferred:** seed both `'/orders/:id'` (name `PathOnly`) and `'https://app.test/orders/:id'` (name `OriginFull`) for one project plus a group keyed `'/orders/:id'`; assert the group scores **once** (no row multiplication from the join) and resolves to `PathOnly`.
  4. **Anti-join respects dialects:** with the twins above and a group keyed `https://app.test/orders/:id`, assert `enqueueRouteMapJobsSQL` does *not* enqueue a route_map job (the pattern is known under either spelling).
- [ ] **Step 2: Run → FAIL.** `go test ./priority/ -run TestRouteLookupDualRead` (exact-equality joins miss the cross-dialect cases).
- [ ] **Step 3: Implement.** In both score statements, replace the plain join

```sql
LEFT JOIN route_map rm ON rm.project_id = eg.project_id AND rm.pattern = eg.page_url_normalized
```

with a best-match lateral (dual-read; `route_map` is small per project, so the unindexed strip is bounded — Deviation 6):

```sql
LEFT JOIN LATERAL (
  SELECT rm.pattern, rm.name, rm.tier
  FROM route_map rm
  WHERE rm.project_id = eg.project_id
    AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/')
      = COALESCE(NULLIF(regexp_replace(eg.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
  ORDER BY (rm.pattern = eg.page_url_normalized) DESC,
           (rm.pattern !~* '^https?://') DESC,
           rm.created_at, rm.pattern
  LIMIT 1
) rm ON TRUE
```

  (`rm.pattern` closes the ordering — two origin-full twins with equal `created_at` must resolve deterministically during the pre-050 window.)

and in `enqueueRouteMapJobsSQL`, replace the `NOT EXISTS` equality with the same both-sides-stripped comparison. Keep every selected column (`rm.pattern`, `rm.name`, `rm.tier` feed the `jsonb_build_object` at :116-117/:166-167 and the tier CASE at :84/:128) working unchanged.
- [ ] **Step 4: Run → PASS**, then the whole package: `go build ./... && go test ./priority/` — in particular `TestRunOnceConvergesFrictionAndErrorOnOneRoutePattern` must still pass (preserving witness).
- [ ] **Step 5: Commit.** `git commit -am "feat(priority): dual-read route lookups across URL dialects (C6 expand)"`

### Task 4: Dual-read in the worker's unmapped-pattern query (TS)

**Files:**
- Modify: `packages/worker/src/db.ts` (`listUnmappedPatterns` :1597-1616)
- Test: `packages/worker/src/__tests__/db-queries.test.ts` (SQL pins) and the package's DB-gated suite

**Interfaces:**
- Consumes: the canonical-form SQL expression from Task 3, byte-for-byte.

- [ ] **Step 1: Write the failing test.** DB-gated (skip without `DATABASE_URL`): seed an error group keyed `'/orders/:id'` and a route_map row `'https://app.test/orders/:id'`; `listUnmappedPatterns` must **not** return `'/orders/:id'` (its origin-full twin covers it). Second case: no route row at all → the pattern is returned. Also update the SQL-text pin in `db-queries.test.ts` to expect the stripped comparison (assert the string `regexp_replace` appears in the query source, alongside the existing pins).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — inside `listUnmappedPatterns`'s `NOT EXISTS`:

```sql
NOT EXISTS (
  SELECT 1 FROM route_map rm
  WHERE rm.project_id = eg.project_id
    AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/')
      = COALESCE(NULLIF(regexp_replace(eg.page_url_normalized, '^https?://[^/]*', '', 'i'), ''), '/')
)
```

- [ ] **Step 4: Run → PASS**, then `pnpm --filter @opslane/worker test`.
- [ ] **Step 5: Commit and open PR1** (Tasks 1–4): `feat(identity): URL contract fixtures + dual-read route lookups (C6 step 1)`. **Deploy before PR2 merges.**

### Task 5: Canonical writes at the route_map write boundary

**Files:**
- Modify: `packages/worker/src/db.ts` (`upsertRouteMapRows` :1626+)
- Test: `packages/worker/src/__tests__/db-queries.test.ts` + DB-gated suite

**Interfaces:**
- Consumes: `canonicalPattern` from `packages/worker/src/friction/urlnorm.ts` (Task 2).
- Produces: the invariant Task 10's CHECK constraint later enforces — no new `route_map` row carries `^https?://`.

- [ ] **Step 1: Write the failing tests.**
  1. DB-gated: call `upsertRouteMapRows` with a resolved row `{pattern: 'https://app.test/assets/:id', name: 'Assets', tier: 'customer'}` and an unresolved entry `'https://app.test/checkout'`; assert the stored patterns are `'/assets/:id'` and `'/checkout'` — zero rows matching `^https?://`.
  2. Collapse dedupe: rows `{pattern: 'https://a.cdn.test/checkout', name: 'Checkout', tier: 'customer'}` and `{pattern: 'https://b.cdn.test/checkout', name: 'Checkout v2', tier: 'standard'}` canonicalize to one key. Assert exactly one `'/checkout'` row lands, and it carries the higher-reach tier (`customer`) with the first row's name (order: tier reach desc, then input order — deterministic).
  3. Resolved-over-unresolved: a resolved row and an unresolved entry collapsing to the same key → the resolved row wins (`source='llm'`, not `'llm-unresolved'`).
  4. Existing pin preserved: the `WHERE route_map.source <> 'human'` guard assertion at `db-queries.test.ts:298-342` still passes.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In `upsertRouteMapRows`, after lease validation and after `parseRouteMapSubmission`'s asked-set validation has already happened upstream (validation stays keyed on the *asked* patterns — the classifier echoes what it was asked; canonicalization is a storage concern):

```ts
const byCanonical = new Map<string, { row: RouteMapRow; source: string }>();
const reach = { customer: 2, standard: 1, admin: 0 } as const;
for (const row of rows) {
  const key = canonicalPattern(row.pattern);
  const prev = byCanonical.get(key);
  if (!prev || prev.source === 'llm-unresolved' || (prev.source === 'llm' && reach[row.tier] > reach[prev.row.tier as RouteTier])) {
    byCanonical.set(key, { row: { ...row, pattern: key }, source: 'llm' });
  }
}
for (const pattern of unresolved) {
  const key = canonicalPattern(pattern);
  if (!byCanonical.has(key)) {
    byCanonical.set(key, { row: { pattern: key, name: key, purpose: '', tier: 'standard' }, source: 'llm-unresolved' });
  }
}
```

  then iterate `byCanonical` through the existing per-row upsert (unchanged SQL, unchanged human guard). Match the surrounding function's actual row/unresolved handling — the existing code already writes the two sources in two passes; fold the map in front of both.
- [ ] **Step 4: Run → PASS**, plus `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test`.
- [ ] **Step 5: Commit and open PR2:** `feat(worker): route_map writes are canonical path-only (C6 step 2)`. **Deploy and let old workers drain before PR3 merges.**

### Task 6: Migration 050 — canonicalize route_map with an audited collision policy

**Files:**
- Create: `packages/ingestion/db/migrations/050_route_map_canonicalization.sql`
- Create: `packages/ingestion/db/migration_050_test.go`
- Modify: `packages/ingestion/priority/testutil_test.go` (`seedTenant` cleanup list :48-63 gains `route_map_migration_conflicts`)

**Interfaces:**
- Produces: `route_map_migration_conflicts` (audit surface read at CP6) and the post-state Task 10's CHECK depends on: zero `^https?://` patterns.

- [ ] **Step 1: Write the failing migration test.** `migration_050_test.go`, on the `migrations_test.go` disposable-DB harness (template `migration_049_test.go`): apply `001`–`049`, seed one project with the full collision matrix, apply `050` **twice**, assert:
  - Zero rows `WHERE pattern ~* '^https?://'`.
  - **Equal-name twins merged:** `('/assets', 'Assets home', source llm, created 2026-01-01)` + `('https://app.test/assets', 'Assets home', source llm, created 2026-02-01)` → one `/assets` row, `created_at = 2026-01-01`, no conflict row.
  - **Conflicting names audited:** `('/reports', 'Reports')` + `('https://app.test/reports', 'Weekly report screen')` → one `/reports` row named `Reports` (path-only's name wins among equal sources), and a conflict row recording `dropped_name = 'Weekly report screen'`.
  - **Richer source wins:** `('/checkout', 'checkout', source llm-unresolved)` + `('https://app.test/checkout', 'Checkout', source llm)` → survivor named `Checkout`, `source = 'llm'`; conflict row recorded (names differ).
  - **Human beats llm regardless of dialect:** `('/billing', 'Billing v1', source llm)` + `('https://app.test/billing', 'Billing', source human)` → survivor named `Billing`, `source='human'`; conflict row for the discarded llm name.
  - **Origin-full twins, no path-only row:** `('https://a.cdn.test/settings', 'Settings', tier standard, created 2026-03-02)` + `('https://b.cdn.test/settings', 'Settings page', tier customer, created 2026-03-01)` → one `/settings` row from the higher tier (`customer`, so name `Settings page`), conflict row for the loser.
  - **Tier never downgrades:** every merged survivor's tier is the max reach across its twins (`customer > standard > admin`).
  - **Case-only names merge silently:** `('/profile', 'profile')` + `('https://app.test/profile', 'Profile')` → one row, **no** conflict row (trivial casing, Deviation 14).
  - **Uppercase scheme is canonicalized:** `('HTTPS://app.test/shouty', 'Shouty')` → `/shouty` (the `'i'` flag on the strip, Deviation 13).
  - **Provenance is honest:** the survivor's `updated_at` is unchanged by the merge (Deviation 15); conflict rows carry the dropped row's `source` and `purpose`.
  - **Untouched rows untouched:** a pre-existing path-only row with no twin is byte-identical after both applies.
  - **Second apply is a no-op:** conflict-row count and `route_map` contents identical after the second run (the `applied_data_migrations` guard).
- [ ] **Step 2: Run → FAIL** (`go test ./db/ -run TestMigration050`) — file missing.
- [ ] **Step 3: Write the migration.**

```sql
-- 050_route_map_canonicalization.sql (C6 step 3). Rewrites route_map patterns
-- to path-only with a deterministic, audited collision policy (#310, AC6.4).
-- The runner has no ledger and autocommits per statement: each statement is
-- guarded so any prefix of this file can re-run safely, forever. The rewrite
-- itself is one DO block (one transaction) guarded by applied_data_migrations.

CREATE TABLE IF NOT EXISTS route_map_migration_conflicts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id UUID NOT NULL,
  canonical_pattern TEXT NOT NULL,
  kept_pattern TEXT NOT NULL,
  dropped_pattern TEXT NOT NULL,
  kept_name TEXT NOT NULL,
  dropped_name TEXT NOT NULL,
  dropped_source TEXT NOT NULL DEFAULT '',
  dropped_purpose TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  grp RECORD;
  winner route_map%ROWTYPE;
  twin route_map%ROWTYPE;
  max_tier TEXT;
  min_created TIMESTAMPTZ;
BEGIN
  -- Serialize concurrent boots: two ingestion instances replaying migrations
  -- at once must not both run the rewrite (xact-scoped, self-releasing).
  PERFORM pg_advisory_xact_lock(hashtext('050_route_map_canonicalization'));

  IF EXISTS (SELECT 1 FROM applied_data_migrations WHERE name = '050_route_map_canonicalization') THEN
    RETURN;
  END IF;

  -- Block the live canonical writer (PR2 is deployed) for the rewrite: a
  -- concurrent upsert landing between twin deletion and the survivor's
  -- PK-changing UPDATE would collide or mutate the merge set mid-run.
  LOCK TABLE route_map IN SHARE ROW EXCLUSIVE MODE;

  FOR grp IN
    SELECT project_id,
           COALESCE(NULLIF(regexp_replace(pattern, '^https?://[^/]*', '', 'i'), ''), '/') AS canonical
    FROM route_map
    WHERE pattern ~* '^https?://'
    GROUP BY 1, 2
    ORDER BY 1, 2
  LOOP
    -- Pick the surviving row's content: source rank (human > llm >
    -- llm-unresolved), then path-only over origin-full, then tier reach,
    -- then earliest created_at, then pattern. Deterministic and total.
    SELECT * INTO winner FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
    ORDER BY CASE rm.source WHEN 'human' THEN 2 WHEN 'llm' THEN 1 ELSE 0 END DESC,
             (rm.pattern !~* '^https?://') DESC,
             CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END DESC,
             rm.created_at, rm.pattern
    LIMIT 1;

    -- Conservative aggregates across the whole twin set. The survivor keeps
    -- its own updated_at (no manufactured provenance — plan Deviation 15).
    SELECT max(CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END),
           min(rm.created_at)
    INTO max_tier, min_created
    FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical;
    max_tier := CASE max_tier WHEN '2' THEN 'customer' WHEN '1' THEN 'standard' ELSE 'admin' END;

    -- Audit every discarded row whose name differs beyond case (case-only
    -- differences are trivial per #310 — plan Deviation 14).
    FOR twin IN
      SELECT * FROM route_map rm
      WHERE rm.project_id = grp.project_id
        AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
        AND rm.pattern <> winner.pattern
    LOOP
      IF lower(twin.name) <> lower(winner.name) THEN
        INSERT INTO route_map_migration_conflicts
          (project_id, canonical_pattern, kept_pattern, dropped_pattern,
           kept_name, dropped_name, dropped_source, dropped_purpose, reason)
        VALUES (grp.project_id, grp.canonical, winner.pattern, twin.pattern,
                winner.name, twin.name, twin.source, twin.purpose, 'name_conflict');
      END IF;
      DELETE FROM route_map WHERE project_id = twin.project_id AND pattern = twin.pattern;
    END LOOP;

    -- Land the survivor on the canonical key with conservative metadata.
    UPDATE route_map
    SET pattern = grp.canonical, tier = max_tier, created_at = min_created
    WHERE project_id = winner.project_id AND pattern = winner.pattern;
  END LOOP;

  INSERT INTO applied_data_migrations (name) VALUES ('050_route_map_canonicalization');
END $$;
```

  (Note the `UPDATE … SET pattern` cannot collide: every same-canonical twin was deleted in the inner loop, including a pre-existing path-only twin when an origin-full row out-ranked it on source.)
- [ ] **Step 4: Run → PASS** (`go test ./db/ -run TestMigration050`), then the migration harness end-to-end: `go test ./db/`.
- [ ] **Step 5: Rehearse on a prod-shaped copy.** Seed a disposable DB with the known prod split (38 origin-full / 12 path-only, including the real twin — "Assets home" as both `/assets` and `https://app.assetmanagementforjira.com/assets`); apply; record row counts and the conflicts table in the PR description. This is AC6.4's witness, staged pre-prod.
- [ ] **Step 6: Commit and open PR3:** `feat(ingestion): migration 050 — route_map canonicalization with conflict audit (C6 step 3)`. **Deploy (the runner applies it on boot) before PR4 merges.**

### Task 7: The cutover — host-free fingerprints under RULE_VERSION 4

**Files:**
- Modify: `packages/worker/src/friction/fingerprint.ts` (`normalizePageUrl` :4-18)
- Modify: `packages/worker/src/friction/analyzer.ts` (:8)
- Modify: `packages/worker/src/friction/__tests__/analyzer.test.ts` (:192-216), `packages/worker/src/friction/__tests__/fingerprint.test.ts`

**Interfaces:**
- Consumes: `normalizePageUrl` from `urlnorm.ts` (Task 2).
- Produces: `RULE_VERSION = 4`; `fingerprint.ts` re-exports the contract normalizer so `analyzer.ts`'s import surface is unchanged.

- [ ] **Step 1: Write the failing tests.**
  1. In `fingerprint.test.ts`: `frictionFingerprint('dead_click', '#save', normalizePageUrl('https://a.cdn.test/checkout'))` equals the same call with `'https://b.cdn.test/checkout'` — **origin rotation no longer changes the key** — and both differ from the `'/orders'` key.
  2. Rewrite `analyzer.test.ts:192-216`'s origin-retaining assertions to the host-free contract (`normalizePageUrl('https://app.example.com/orders/123')` → `'/orders/:id'`; the bare-path case `'/orders/123'` now also templates → `'/orders/:id'`, per the contract's bare-path branch — the old catch-branch passthrough is gone).
  3. `RULE_VERSION` is `4` (an explicit assertion in `analyzer.test.ts` — the bump is a contract, not an incident).
- [ ] **Step 2: Run → FAIL.** `pnpm --filter @opslane/worker test src/friction`
- [ ] **Step 3: Implement.** In `fingerprint.ts`, delete the origin-retaining `normalizePageUrl` body and re-export the contract: `export { normalizePageUrl } from './urlnorm.js';` (keep `normalizeEntryPath`, `canonicalizeSelector`, `frictionFingerprint` untouched — Deviation 2). In `analyzer.ts`: `export const RULE_VERSION = 4;`
- [ ] **Step 4: Run → PASS**, then the full worker suite with `DATABASE_URL` exported: `pnpm --filter @opslane/worker test`. Also `pnpm -r build` (fingerprint is imported across the friction lane).
- [ ] **Step 5: Update the sweeper's workaround comment.** `sweeper.go:51-58` documents reading origin-full friction URLs and normalizing at read time; amend it to note the cutover (reads stay defensive — old v3 rows still flow through the tallies for 7 days). Comment-only change, no behavior.
- [ ] **Step 6: Commit.** `feat(worker)!: host-free friction fingerprints, RULE_VERSION 4 (C6 step 4, #309)`

### Task 8: Version hygiene — the stale-queue guard and cross-version isolation proofs

**Files:**
- Modify: `packages/worker/src/friction/promotion.ts` (the pending-signal selection :74-85)
- Test: `packages/worker/src/friction/__tests__/promotion-db.integration.test.ts`, `packages/worker/src/friction/__tests__/persist.test.ts`

**Interfaces:**
- Consumes: `RULE_VERSION` (already imported where `processFrictionOutcomes` lives).

- [ ] **Step 1: Write the failing tests** (DB-gated integration, on the `bucket-promotion.integration.test.ts` harness):
  1. **Pending old-version rows are invisible to new-version adjudication:** seed a session with a `friction_signals` row at `rule_version = 3`, `adjudication_status = 'pending'`, not retracted (simulating an escaped row); run `processFrictionOutcomes` at version 4; assert the v3 row's `adjudication_status` is still `'pending'` and no v3-tuple generation or bucket-state row was created or touched.
  2. **AC6.6 — old buckets untouched:** drive a v3 bucket to an adjudicated state (existing harness), snapshot its `friction_bucket_state` and `friction_adjudication_generations` rows; run a full v4 analysis pass over the same session shape (same page, same selector); assert the v3 rows compare equal, column for column, and the v4 activity landed under its own `(fingerprint, rule_version)` tuple.
  3. **Cross-version persistence, both key shapes** (Deviation 3, narrowed): (a) *changed key* — active v3 signal with the old origin-full fingerprint; `writeFrictionSignals` at v4 with the new path-only fingerprint for the same interaction; assert the v3 row has `retracted_at` set and `superseded_by IS NULL`, and the v4 row exists. (b) *unchanged key* — a v3 signal whose fingerprint is identical under both normalizers (empty-URL fallback: `pageAt` with no meta event yields `''` in both versions); assert the v3 row is **superseded** (`superseded_by` points at the v4 row), which is `persist.ts`'s same-fingerprint path working as designed. The claim is per-row, not global: changed keys retract, unchanged keys supersede.
  4. **Old cannot count toward new:** `countEligibleUsers` for the v4 tuple ignores v3 rows even when fingerprints hypothetically collide (seed a v3 row whose fingerprint string equals the v4 one; the version column alone must exclude it).
- [ ] **Step 2: Run → FAIL** on (1) — the selection at `promotion.ts:74-85` has no version filter; (2)–(4) should pass already (they pin existing behavior; if any fails, that is a real defect to fix before proceeding, not a test to adjust).
- [ ] **Step 3: Implement** — add `AND rule_version = $N` to the pending-signal `SELECT` in `promotion.ts`, passing `RULE_VERSION` from its caller (`processFrictionOutcomes`' existing plumbing; thread it as a parameter, matching how the tuple already carries `signal.rule_version` at :146 — the filter narrows *which* signals enter, the tuple still derives from the row).
- [ ] **Step 4: Run → PASS**, full worker suite green.
- [ ] **Step 5: Commit.** `fix(worker): pending-signal adjudication is rule_version-scoped (C6 stale-queue guard)`

### Task 9: Origin-rotation end-to-end (AC6.2)

**Files:**
- Modify: `test-e2e/friction-incidents.test.ts`

**Interfaces:**
- Consumes: the built worker's `RULE_VERSION` (the spec already imports it from `dist` at :47) and `analyzeSessionInProcess` (:123-142).

- [ ] **Step 1: Write the failing test.** New case beside the promotion case:

```ts
const FORGE_ORIGINS = [
  'https://1a2b3c4d.cdn.forge.example',
  'https://5e6f7a8b.cdn.forge.example',
  'https://9c0d1e2f.cdn.forge.example',
];
const FORGE_PATH = '/9d4e2a71-77aa-4f83-b8f1-0123456789ab/f0e1d2c3-4b5a-6789-abcd-ef0123456789/12345/global-page';

it('rotated origins land in one bucket and promote once', async () => {
  // Three sessions, three distinct users, three different origins, same page + selector.
  const sessionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    sessionIds.push(await driveDeadClickSession(`rot-user-${i}`, `${FORGE_ORIGINS[i]}${FORGE_PATH}`));
  }
  // Scope every assertion to this case's sessions + signal shape — the file
  // drives other sessions in the same stack, and an unscoped count would
  // flake on them (or worse, pass because of them).
  const bucketSQL = `
    SELECT COUNT(*) AS signals, COUNT(DISTINCT fingerprint) AS keys,
           MIN(fingerprint) AS fp
    FROM friction_signals
    WHERE project_id = $1 AND session_id = ANY($2)
      AND signal_type = 'dead_click' AND rule_version = $3
      AND retracted_at IS NULL AND superseded_by IS NULL`;
  let buckets = await pool.query(bucketSQL, [projectId, sessionIds, RULE_VERSION]);
  expect(Number(buckets.rows[0].keys)).toBe(1);      // one bucket
  expect(Number(buckets.rows[0].signals)).toBe(3);   // three signals
  const signalFp = buckets.rows[0].fp as string;      // the one observed key
  expect(await frictionIncidentCount('/:id/:id/:id/global-page')).toBe(0); // below threshold

  // Two more users push past PROMOTION_THRESHOLD_USERS = 5.
  sessionIds.push(await driveDeadClickSession('rot-user-3', `${FORGE_ORIGINS[0]}${FORGE_PATH}`));
  sessionIds.push(await driveDeadClickSession('rot-user-4', `${FORGE_ORIGINS[1]}${FORGE_PATH}`));

  const incidents = await pool.query(
    `SELECT fingerprint, page_url_normalized FROM error_groups
     WHERE project_id = $1 AND kind = 'friction' AND status = 'candidate'
       AND page_url_normalized = '/:id/:id/:id/global-page'`, [projectId]);
  expect(incidents.rows).toHaveLength(1);            // one candidate for this page
  // The candidate is THIS bucket's: friction:<envId>:<signalFingerprint>.
  expect(incidents.rows[0].fingerprint.endsWith(`:${signalFp}`)).toBe(true);
});
```

  `driveDeadClickSession(userId, pageUrl)` (returns the session id) and `frictionIncidentCount(pageUrlNormalized)` are small helpers wrapping the file's existing `initSession` + `rageChunk`-style chunk builder + `analyzeSessionInProcess` plumbing, parameterizing the currently-constant `PAGE` (:53) — extract, don't duplicate; the existing cases keep their current fixed origin and must keep passing.
- [ ] **Step 2: Run → FAIL** pre-Task-7 semantics would yield three keys; on the cutover branch it must pass. Run: `pnpm --filter test-e2e test friction-incidents` (with the stack up per the AGENTS.md worktree block, worker built first: `pnpm --filter @opslane/worker build`).
- [ ] **Step 3: Green + whole friction lane.** The fold case, the 4-invisible/5th-promotes case, and environment isolation all still pass.
- [ ] **Step 4: Commit and open PR4** (Tasks 7–9): `feat!: friction identity cutover — host-free keys, RULE_VERSION 4 (C6 step 4)`. **Deploy and drain before PR5.**

### Task 10: Enforcement — migration 051 and the write-boundary backstop

**Files:**
- Create: `packages/ingestion/db/migrations/051_route_map_enforcement.sql`
- Create: `packages/ingestion/db/migration_051_test.go`
- Modify: `scripts/check-migration-reapply.sh` (SEED_SQL + cleanup_seed)

**Interfaces:**
- Consumes: migration 050's post-state and PR2's canonical writes (live and drained).
- Produces: the durable invariant — `route_map.pattern` can never again match `^https?://`.

- [ ] **Step 1: Write the failing migration test.** `migration_051_test.go` on the disposable-DB harness: apply `001`–`050`; then:
  1. Insert a straggler `('https://x.test/late', 'Late', 'standard', 'llm')` **and** its canonical twin `('/late', 'Late kept', 'customer', 'llm')`; apply `051` twice; assert the straggler is gone, `/late` kept its name (equal source, path-only preferred — same precedence ladder as 050), a conflict row with `reason = 'post_migration_straggler'` exists, and the second apply added nothing.
  2. **A human straggler beats an llm twin:** straggler `('https://x.test/hand', 'Handmade', 'customer', 'human')` + twin `('/hand', 'Auto', 'standard', 'llm')` → the surviving `/hand` row carries `name='Handmade'`, `source='human'`, `tier='customer'`; conflict row records the discarded `Auto`. (051 must not blindly keep the path-only row — it reuses 050's winner selection.)
  3. A lone straggler with no twin is rewritten in place to its path form; an uppercase `HTTPS://` straggler is handled too.
  4. Post-apply, a raw `INSERT INTO route_map (…, pattern, …) VALUES (…, 'https://x.test/nope', …)` fails with a CHECK violation (AC6.5's reject leg at the deepest layer).
  5. A path-only insert succeeds.
- [ ] **Step 2: Run → FAIL** — file missing.
- [ ] **Step 3: Write the migration.**

```sql
-- 051_route_map_enforcement.sql (C6 step 5). By this point every writer is
-- canonical (PR2) and the book is canonical (050). Sweep any straggler that
-- landed in the window using 050's precedence ladder, then lock the invariant
-- with a CHECK — all in ONE transaction, under a lock, so no row can slip in
-- between the sweep and the constraint. Idempotent by construction (the sweep
-- only ever sees ^https?:// rows, which stop existing once the CHECK is up).

DO $$
DECLARE
  grp RECORD;
  winner route_map%ROWTYPE;
  twin route_map%ROWTYPE;
  max_tier TEXT;
  min_created TIMESTAMPTZ;
BEGIN
  -- Serialize concurrent boots and block writers for the sweep+ALTER window.
  PERFORM pg_advisory_xact_lock(hashtext('051_route_map_enforcement'));
  LOCK TABLE route_map IN SHARE ROW EXCLUSIVE MODE;

  -- Same group-based loop as 050 (each canonical group is one immutable set,
  -- so winner selection cannot depend on sweep order): for every canonical
  -- key that still has an origin-full member, pick the winner by the same
  -- ladder, audit differing names, aggregate tier/created_at, converge on
  -- the canonical PK.
  FOR grp IN
    SELECT project_id,
           COALESCE(NULLIF(regexp_replace(pattern, '^https?://[^/]*', '', 'i'), ''), '/') AS canonical
    FROM route_map
    WHERE pattern ~* '^https?://'
    GROUP BY 1, 2
    ORDER BY 1, 2
  LOOP
    SELECT * INTO winner FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
    ORDER BY CASE rm.source WHEN 'human' THEN 2 WHEN 'llm' THEN 1 ELSE 0 END DESC,
             (rm.pattern !~* '^https?://') DESC,
             CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END DESC,
             rm.created_at, rm.pattern
    LIMIT 1;

    SELECT max(CASE rm.tier WHEN 'customer' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END),
           min(rm.created_at)
    INTO max_tier, min_created
    FROM route_map rm
    WHERE rm.project_id = grp.project_id
      AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical;
    max_tier := CASE max_tier WHEN '2' THEN 'customer' WHEN '1' THEN 'standard' ELSE 'admin' END;

    FOR twin IN
      SELECT * FROM route_map rm
      WHERE rm.project_id = grp.project_id
        AND COALESCE(NULLIF(regexp_replace(rm.pattern, '^https?://[^/]*', '', 'i'), ''), '/') = grp.canonical
        AND rm.pattern <> winner.pattern
    LOOP
      IF lower(twin.name) <> lower(winner.name) THEN
        INSERT INTO route_map_migration_conflicts
          (project_id, canonical_pattern, kept_pattern, dropped_pattern,
           kept_name, dropped_name, dropped_source, dropped_purpose, reason)
        VALUES (grp.project_id, grp.canonical, winner.pattern, twin.pattern,
                winner.name, twin.name, twin.source, twin.purpose, 'post_migration_straggler');
      END IF;
      DELETE FROM route_map WHERE project_id = twin.project_id AND pattern = twin.pattern;
    END LOOP;

    UPDATE route_map
    SET pattern = grp.canonical, tier = max_tier, created_at = min_created
    WHERE project_id = winner.project_id AND pattern = winner.pattern;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'route_map'::regclass AND conname = 'route_map_pattern_path_only'
  ) THEN
    ALTER TABLE route_map ADD CONSTRAINT route_map_pattern_path_only CHECK (pattern !~* '^https?://');
  END IF;
END $$;
```

  (The 050/051 group loops are deliberately near-identical text — 051 differs only in the ledger guard being absent, the audit `reason`, the table lock timing, and the trailing CHECK. A shared SQL function was considered and rejected: migrations must stay self-contained snapshots, and 051 replays on every boot where the loop body is a no-op scan of zero `^https?://` rows.)

- [ ] **Step 4: Extend `scripts/check-migration-reapply.sh`:** add a `route_map` seed row (path-only) to `SEED_SQL` and its delete to `cleanup_seed()`. This proves only that valid data survives a full replay with the constraint in place — the *rejection* proof lives in `migration_051_test.go`'s CHECK-violation case, not here.
- [ ] **Step 5: Run → PASS:** `go test ./db/ -run TestMigration051`, then `go test ./db/`, then `bash scripts/check-migration-reapply.sh` against a disposable database.
- [ ] **Step 6: Commit and open PR5:** `feat(ingestion): migration 051 — canonical-writes-only enforcement (C6 step 5)`.

### Task 11: CP6 — checkpoint verification

**Files:**
- Create: `docs/research/2026-XX-XX-c6-forge-canary.md` (AC6.7's dated evidence; date filled at write time)
- Modify: `docs/superpowers/plans/2026-08-10-unified-actionable-program-plan.md` (tick C6 in the sequencing summary)

(Issue closes and prod queries are owner-ritual operations: prod access is the read-only `prod-sql.sh` runner; closing #308–#311 with witnesses is the program's standard checkpoint bookkeeping.)

- [ ] **Step 1: Gate re-run.** Export the **full** worktree environment block from the root `AGENTS.md` first — `DATABASE_URL` alone is not enough: without the MinIO/replay variables, Go storage tests `t.Skip` while reporting `ok` and the "zero skips" claim is false. Then: `pnpm install --frozen-lockfile && pnpm -r build && pnpm test` (read the skip count, not the pass count), `(cd packages/ingestion && go build ./... && go test ./...)` with a real zero-skip assertion — `grep -c` alone is a printout, not a check, and exits nonzero on a count of zero:

```bash
(cd packages/ingestion && go test -v ./... > /tmp/go-test.out; test $? -eq 0 && test "$(grep -c '^--- SKIP' /tmp/go-test.out || true)" -eq 0) || { echo 'FAIL: tests failed or skipped'; exit 1; }
```

  then `docker compose config --quiet`.
- [ ] **Step 2: Walk the CP6 table** (program plan §C6) and record each criterion's witness:
  - **AC6.1 [gate]:** both fixture suites green — `go test ./priority/ -run TestNormalizePageURL` and `pnpm --filter @opslane/worker test src/friction/__tests__/urlnorm.test.ts`. Mutate one fixture `want`, observe **both** suites fail, revert (the "changing a fixture value breaks both" witness from #308).
  - **AC6.2:** the Task 9 e2e case, green in CI.
  - **AC6.3:** Task 3's dual-read matrix (origin-full stored and path-only stored both resolving), green — and, on the deployed expand-phase stack before PR3 merged, one manual lookup of each dialect recorded in PR3's description.
  - **AC6.4:** Task 6 Step 5's prod-shaped rehearsal (twice-applied, zero `^https?://`, conflicts audited) + post-deploy prod check via `~/deploy/scripts/prod-sql.sh` (read-only): `SELECT count(*) FROM route_map WHERE pattern ~* '^https?://'` → 0; `SELECT * FROM route_map_migration_conflicts` reviewed and pasted into the PR.
  - **AC6.5:** Task 5's normalize tests + Task 10's CHECK-violation test.
  - **AC6.6:** Task 8's frozen-bucket comparison test.
  - **AC6.7:** post-PR4-deploy, watch the prod Forge canary (the page that split into 14 buckets, `/:id/:id/:id/global-page`) across ≥2 origin rotations. Two halves, both required: (a) **one bucket** — via prod-sql.sh, `SELECT signal_type, element_selector, COUNT(DISTINCT fingerprint) AS keys, COUNT(*) AS signals FROM friction_signals WHERE rule_version = 4 AND page_url_normalized = '/:id/:id/:id/global-page' AND retracted_at IS NULL AND superseded_by IS NULL GROUP BY 1, 2` shows `keys = 1` *per (signal_type, selector) tuple* while its `signals` count grows — the per-tuple grouping matters because two selectors on that page legitimately mean two fingerprints, and an unscoped count would call that a failure (or mask one); (b) **rotation actually happened, observed in data** — signals don't store the raw origin, but the raw URL survives elsewhere: pick the bucket's signal sessions and read each session's raw page URL from its retained replay (the rrweb type-4 meta `href`, reachable through the existing session detail surface; the sessions are pinned 90 days by promotion, so the data is there). Assert **≥2 distinct origins** among those sessions' hrefs. A deploy log alone is *not* accepted as rotation proof — a deploy needn't rotate the origin; the AMFJ deploy log (`~/asset-management-jira`, origin/master) is corroboration for *when* to expect a rotation, not the witness. Record both halves as the dated evidence file and link it from the program plan's checkpoint.
- [ ] **Step 3: Run `/opslane-verify:verify`** with the drivable (non-[gate]) criteria as the pre-drafted acceptance set, per the program plan's verification method.
- [ ] **Step 4: Close the book:** tick C6 in the program plan's sequencing summary; close #308/#309/#310 with witnesses; close #311 recording option A; note on #312 that its dependencies are now met.

## Self-Review

- **Spec coverage:** AC6.1→Tasks 1–2; AC6.2→Task 9; AC6.3→Tasks 3–4; AC6.4→Task 6; AC6.5→Tasks 5+10; AC6.6→Task 8; AC6.7→Task 11. §6.1's five deploy steps→PR1–PR5 in order. #308 scope 1–4 → Tasks 1–2 (origin stays in raw data: `error_events.context->>'url'` and replay chunks are untouched — dropped from the key, not the data). #309 scope 1–4 → Tasks 7–9 + deploy order. #310 → Tasks 5–6 + sweeper note (Go sweeper already writes normalized patterns; its defensive read-time normalization stays).
- **Type consistency:** `canonicalPattern`/`normalizePageUrl`/`MAX_PATTERN_BYTES` named identically in Tasks 2, 5, 7; the SQL strip expression is byte-identical at all five sites (three sweeper, one worker anti-join, migrations); conflict-table columns match between 050, 051, and both migration tests.
- **Placeholder scan:** every code step carries real code; the one deliberate indirection is Task 1's "port the 33 rows verbatim" (a mechanical copy from a named file:line range, not a design gap).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found → addressed | R1: 8 P1 / 10 P2 / 1 P3, all folded; R2: 5 P1 / 4 P2 — 8 folded, 1 P1 rejected with source-verified pushback |

**CODEX:** Two iterations (session `019ff819`, Codex sandbox could not read the repo, so findings were plan-internal; line anchors were verified separately by direct code exploration). Round 1: WHATWG/net-url divergence in the TS port, case-sensitivity mismatch in every SQL origin-strip, 051's straggler policy contradicting 050, the sweep/CHECK transaction gap, unscoped e2e assertions, AC6.7 looseness, and the zero-skips env gap — all folded (Deviations 12–16). Round 2: 050's missing table lock, 051's loop-order-dependent precedence and incoherent audit rows (fixed by making 051 group-based like 050), authority/userinfo escape validation, the exact-fingerprint e2e assertion, and the non-asserting `grep -c` — folded; the `%252F` double-decode claim was checked against `urlnorm.go:51` (`EscapedPath`, single decode) and rejected, with the pushback recorded in Deviation 12.

**VERDICT:** CODEX CLEARED after two iterations — ready for execution (subagent-driven-development or executing-plans).

NO UNRESOLVED DECISIONS
