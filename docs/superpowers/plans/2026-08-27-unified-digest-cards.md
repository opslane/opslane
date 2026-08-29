# Unified digest cards Implementation Plan (v3, rollout-safe)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friction incidents render as model-authored digest cards through the same writer, grounding validator, and template as error cards, with copy cached per actionable spell so repeat days cost zero model calls.

**Architecture:** Everything ships behind `DIGEST_UNIFIED_CARDS` (`off | shadow | on`, default **off**), with an additive-only first migration and dual-compatible wire types, so an ECS rolling deploy with in-flight `frozen`/`written` runs can never strand a run between versions. The mode that governed a run is **persisted on the run row** (`digest_runs.unified_cards_mode`), so every ledger, SLA, and publication predicate branches on recorded history, never on the current environment value. Card identity becomes the incident (`error_group_id`, deduplicated to one canonical episode per group) with episode fields as optional provenance; the ledger's `phase` column is a lifecycle state (`freeze` → `validation`); authored copy is digit-free and cached per actionable spell for BOTH kinds. The renderer lands BEFORE the behavior task so `on` is never operationally enableable against a binary that cannot render unified cards. Receipts survive as per-card fallback and as the whole-section savepoint degrade.

**Tech Stack:** Go 1.24 (ingestion), TypeScript Node 22 (worker), PostgreSQL.

**Spec:** `docs/design/2026-08-27-unified-digest-cards.md` (R1-R9; spikes S1-S3). Deviations agreed in review: default mode is `off` (not shadow); `NOT NULL` and uniqueness on `digest_run_items.error_group_id` are deferred to migration 066 after prod dual-write verification; shadow-validated copy warms the cache (justified: it passed full validation; `cached` means "delivered from cache", not "previously delivered").

## Global Constraints

- Migrations append-only from `065`, reapply-safe, and **additive-only until T7**: no `SET NOT NULL`, never `DELETE` queued work to satisfy a constraint (raise with a diagnostic count instead), and constraint reapplication uses conditional `DO` blocks (add-if-missing), never `DROP CONSTRAINT`/`ADD CONSTRAINT` on every deploy.
- Old binaries must run against every migration in this plan; migrations deploy before binaries.
- Wire protocol dual-compatible during transition: the validator accepts both `episodeId`- and `errorGroupId`-keyed dispositions until T7 retires the old key.
- **Mode is per-run history**: freeze stamps `digest_runs.unified_cards_mode` with the mode in effect; every downstream consumer (validation, publication, SLA, reconciliation) branches on the stamped value. Rows from runs stamped `off`/`shadow` (including all pre-065 history via the column default `'off'`) keep exact M1 semantics: `render_mode` stays NULL there and no predicate may require it.
- Publication policy (only for runs stamped `on`): actionable cards are ledger-published (no episode publication read or write); FYI cards keep the episode-keyed one-shot gate and write. Publication predicate for `on` runs: delivered AND `outcome='included'` AND `phase='validation'` AND `render_mode IS NOT NULL`.
- Actionable statuses: `awaiting_approval`, `needs_human`. FYI outcomes: `investigated`, `insight`, PR events.
- Authored `copy`/`action`: no numeric glyph, server-enforced (`unicode.IsDigit` scan).
- One fingerprint implementation (Go), used at freeze and validation; the worker never computes fingerprints.
- **One candidate per error group**: when an error group has multiple qualifying episodes, freeze selects the canonical (latest `decided_at`, tiebreak highest `episode_sequence`) episode and emits exactly one candidate/run item.
- M1 contracts stay green in `off` mode byte-for-byte, including against ledger rows created before migration 065.
- Each task's commit leaves BOTH `go test ./...` (DATABASE_URL set, zero skips) and `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` green.
- Rollback boundary: after migration 066 (T7) deploys, rolling back to a pre-dual-write binary is prohibited; the T7 task records this in the deploy notes.

---

### Task 1: Migration 065 — additive identity, run mode, copy cache, ledger lifecycle columns

**Files:**
- Create: `packages/ingestion/db/migrations/065_unified_digest_cards.sql`
- Test: `packages/ingestion/db/migration_065_test.go`

**Interfaces:**
- Produces: nullable `digest_run_items.error_group_id`; `digest_runs.unified_cards_mode` (default `'off'`); `digest_card_copy` with unique current-copy partial index; ledger columns `render_mode`, `shadow_render_mode`, `input_fingerprint`, `spell_started_at`, `cache_hit`, `phase`.

- [ ] **Step 1: Failing test** (mirror `migration_064_test.go`): columns exist; old-binary shape works (`INSERT INTO digest_run_items` WITHOUT `error_group_id` succeeds; `INSERT INTO digest_runs` without the mode column succeeds and reads back `'off'`); two current copies for one `(group, spell)` violate the unique partial index; `phase='bogus'` and `render_mode='bogus'` violate their CHECKs; re-applying the migration file twice succeeds without dropping constraints (assert constraint OIDs unchanged across reapply).
- [ ] **Step 2: Run** `go test ./db -run TestMigration065 -v` → FAIL.
- [ ] **Step 3: Migration:**

```sql
BEGIN;
ALTER TABLE digest_run_items ADD COLUMN IF NOT EXISTS error_group_id uuid REFERENCES error_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_digest_run_items_run_group ON digest_run_items (run_id, error_group_id);
-- NOT NULL and UNIQUE(run_id, error_group_id) arrive in migration 066, after
-- dual-write covers every writer (old binaries still insert without this column).

ALTER TABLE digest_runs ADD COLUMN IF NOT EXISTS unified_cards_mode text NOT NULL DEFAULT 'off';

CREATE TABLE IF NOT EXISTS digest_card_copy (
  error_group_id   uuid NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  spell_started_at timestamptz NOT NULL,
  authored_at      timestamptz NOT NULL DEFAULT now(),
  input_fingerprint text NOT NULL,
  title text NOT NULL, copy text NOT NULL, action text NOT NULL,
  model text NOT NULL, prompt_version int NOT NULL,
  source text NOT NULL DEFAULT 'live',  -- live | shadow: where the copy was validated
  invalidated_at   timestamptz,
  PRIMARY KEY (error_group_id, spell_started_at, authored_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_card_copy_current
  ON digest_card_copy (error_group_id, spell_started_at) WHERE invalidated_at IS NULL;

ALTER TABLE digest_run_candidate_evaluations
  ADD COLUMN IF NOT EXISTS render_mode text,
  ADD COLUMN IF NOT EXISTS shadow_render_mode text,
  ADD COLUMN IF NOT EXISTS input_fingerprint text,
  ADD COLUMN IF NOT EXISTS spell_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS cache_hit boolean,
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'validation';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drce_render_mode_check') THEN
    ALTER TABLE digest_run_candidate_evaluations ADD CONSTRAINT drce_render_mode_check
      CHECK (render_mode IS NULL OR render_mode IN ('authored','cached','receipt_fallback'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drce_shadow_render_mode_check') THEN
    ALTER TABLE digest_run_candidate_evaluations ADD CONSTRAINT drce_shadow_render_mode_check
      CHECK (shadow_render_mode IS NULL OR shadow_render_mode IN ('authored','cached','receipt_fallback'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='drce_phase_check') THEN
    ALTER TABLE digest_run_candidate_evaluations ADD CONSTRAINT drce_phase_check
      CHECK (phase IN ('freeze','validation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='digest_runs_unified_mode_check') THEN
    ALTER TABLE digest_runs ADD CONSTRAINT digest_runs_unified_mode_check
      CHECK (unified_cards_mode IN ('off','shadow','on'));
  END IF;
END $$;
COMMIT;
```

Semantics pinned here: `render_mode` records what was actually DELIVERED for the candidate and is written only by runs stamped `on`; `shadow_render_mode` records what shadow authoring WOULD have delivered and is written only by runs stamped `shadow`; both stay NULL for `off` runs and all historical rows.

- [ ] **Step 4: Green + reapply** (`TestMigration065|TestMigrations`).
- [ ] **Step 5: Commit** `feat(digest): additive schema for unified cards (migration 065; old-binary safe)`.

---

### Task 2: Mode flag with exact semantics

**Files:**
- Create: `packages/ingestion/digest/mode.go`
- Test: `packages/ingestion/digest/mode_test.go`

**Interfaces:**
- Produces:

```go
type UnifiedCardsMode string // off | shadow | on
// ReadUnifiedCardsMode: env DIGEST_UNIFIED_CARDS; empty/invalid -> off with one
// startup warning (invalid config must not dark-launch anything).
func ReadUnifiedCardsMode() UnifiedCardsMode
```

Semantics contract (enforced by later tasks):
- `off`: exact M1 behavior; run stamped `off`; no cache reads/writes, no new ledger columns written.
- `shadow`: run stamped `shadow`; freeze+author+validate through the FULL unified path including building the final `GeneratedDigestCard` shape (then discarding it from the user payload), so cutover is not the first renderer-level exercise; delivered output is M1 receipts; ledger records `shadow_render_mode` + `cache_hit`, `render_mode` stays NULL; shadow cards never set `frozen_lane_owns` and never suppress receipts; fully validated shadow copy enters the cache with `source='shadow'`; publication changes disabled.
- `on`: run stamped `on`; unified cards render; receipts are fallback-only; actionable publication switches to the ledger; FYI keeps the episode gate.
- Rollback `on`→`shadow`→`off` is always safe: stamped historical runs keep their own semantics; new runs follow the new mode.

- [ ] Steps: failing test (parse/default/invalid→off+warn), implement, PASS, commit `feat(digest): unified-cards mode flag (default off)`.

---

### Task 3: Dual-compatible types, dual-write identity, canonical episode dedup (behavior still off)

**Files:**
- Modify: `packages/ingestion/digest/freeze.go` (Candidate + run-item insert + per-group dedup), `packages/ingestion/digest/validate.go` (parse both disposition keys)
- Modify: `packages/worker/src/digest-writer/schema.ts`, `job.ts` (accept either identity; emit BOTH `episodeId` and `errorGroupId` in dispositions)
- Create: `packages/ingestion/digest/fingerprint.go` + test
- Test: worker wire-compat tests; Go candidate round-trip + dedup tests

**Interfaces:**
- Produces:

```go
type CachedDigestCard struct {
	Title string `json:"title"`; Copy string `json:"copy"`; Action string `json:"action"`
	AuthoredAt time.Time `json:"authoredAt"`; Fingerprint string `json:"fingerprint"`
}
type Candidate struct {
	ErrorGroupID    string            `json:"errorGroupId"`
	EpisodeID       string            `json:"episodeId,omitempty"`
	EpisodeSequence *int              `json:"episodeSequence,omitempty"` // pointer: absent means "no recurrence claim"
	Kind            string            `json:"kind"` // error | friction
	SpellStartedAt  *time.Time        `json:"spellStartedAt,omitempty"`
	Fingerprint     string            `json:"fingerprint,omitempty"`
	CachedCard      *CachedDigestCard `json:"cachedCard,omitempty"` // atomic: no partial cache hits
	// ...existing fact fields unchanged
}
func candidateFingerprint(c Candidate, promptVersion, validatorVersion int) string
```

- Error-lane freeze dual-writes `error_group_id` on run items and populates `ErrorGroupID`/`Kind` in every mode; when one group has multiple qualifying episodes, exactly one run item is emitted for the canonical episode (latest `decided_at`, tiebreak highest `episode_sequence`).
- Worker: dispositions validated against `errorGroupId ?? episodeId` in one accounting pass covering every candidate exactly once; prompt/schema version unchanged in this task.

- [ ] **Step 1: Failing tests:** fingerprint determinism + sensitivity matrix (title, summary/root-cause content, outcome, status, validAction, diff identity, route purpose, kind, signal type, sorted accounts, episode id/sequence, prompt+validator versions) and INsensitivity (AffectedUsers, OccurrenceCount, LastSeen); Go↔TS round-trip on episode-only and both-key snapshots; error freeze writes `error_group_id`; **two qualifying episodes for one group produce exactly one run item keyed to the canonical episode**.
- [ ] **Step 2-4:** FAIL → implement → both suites green (M1 tests byte-identical, flag off).
- [ ] **Step 5: Commit** `feat(digest): dual-compatible incident identity with per-group canonical episode`.

---

### Task 4: Renderer — buttons, mechanical counts, waiting age (lands before behavior so `on` can never outrun it)

**Files:**
- Modify: `packages/ingestion/notify/event.go` (`GeneratedDigestCard` gains `SignalCount int64`, `ActionableSince *time.Time`, `Kind string`), `slack_digest.go`
- Test: `packages/ingestion/notify/slack_digest_test.go`

Inert until Task 5 populates the new fields: friction cards cannot appear in payloads yet, so prod behavior is unchanged; snapshot tests drive synthetic payloads.

- [ ] **Step 1: Failing tests:** friction card renders authored copy + mechanical "N friction signals" line + waiting-age line + Watch replay/Issue page buttons; zero-user card omits the 👥 line; error cards byte-identical to current snapshots; merged error+friction list respects the existing card cap with overflow counted once; rendered output stays under Slack's 50-block message cap at max cards.
- [ ] **Steps 2-4:** FAIL → implement → PASS incl. receipts contract tests.
- [ ] **Step 5: Commit** `feat(notify): unified friction card rendering (inert until payloads carry them)`.

---

### Task 5: Behavior behind the flag — freeze sources, cold-only writer, ordered validation

One task because it completes a protocol: freeze emits what the writer must consume and validation must finalize. The commit lands when the protocol is green in `shadow` and `on`, and byte-identical in `off`.

**Files:**
- Create: `packages/ingestion/digest/freeze_friction.go` (+test), modify `freeze.go`, `validate.go`, `actionable.go`, `sla.go`
- Modify: `packages/worker/src/digest-writer/job.ts` (+tests)

**Interfaces:**
- Freeze (`shadow`/`on`): stamp `unified_cards_mode` on the run row; sources are error episodes (the `issue_publications` freeze gate is bypassed for actionable errors in `on` only; kept in `shadow`) + capped actionable friction; cache lookup for EVERY actionable candidate of both kinds (current row where `invalidated_at IS NULL`, fingerprint match → `CachedCard` attached, `cache_hit` recorded); LEFT JOIN/scalar-subquery shape so zero-diagnosis or zero-cache candidates still appear; ledger rows written at freeze with `phase='freeze'` for every evaluated candidate.
- Worker: partition cached vs cold BEFORE the model call and BEFORE `maxWritesPerRun` accounting; cached cards pass through verbatim; `DIGEST_PROMPT_VERSION=4` with the digit-free line: `Never state counts as digits in copy or action; the message template renders people and occurrence counts separately. Do not spell out volatile quantities either ("dozens", "three people").`
- Validation order (inside the M1 savepoint): (1) pure per-card checks — disposition present, status still actionable/eligible, unsnoozed, fingerprint recomputed-and-matching, digit scan, grounding for cold cards; a failure converts that card to its M1 receipt (`render_mode='receipt_fallback'` when stamped `on`; `shadow_render_mode='receipt_fallback'` when stamped `shadow`); (2) assemble payload (in `shadow`: build the full card shapes, then swap in receipts for delivery); (3) batch cache writes for newly validated cold copy — retire-then-insert; **on unique-index conflict from a concurrent writer, load the surviving row and accept it only if its `input_fingerprint` matches this candidate's; on match, record it as the cache winner; on mismatch, deliver this run's already-validated copy but do NOT overwrite the cache, and log a `cache_conflict` diagnostic**; (4) ledger update: selected rows transition to `phase='validation'` with the mode-appropriate render column; capped/excluded rows stay `phase='freeze'` by design. A cache/SQL error is not per-card recoverable: it aborts to the section-level savepoint fallback (full receipts + delivery alert), exactly M1's degrade — including rolling back any cache insert from the failed section.
- Mode-aware consumers: publication predicate as in Global Constraints for `on`-stamped runs; runs stamped `off`/`shadow` keep the untouched M1 predicates. SLA/reconciliation branch on the stamp; a delivered `on`-stamped run holding a selected row still at `phase='freeze'` is a new reconciliation finding; diagnostic details records include the run mode and cache `source`.

- [ ] **Step 1: Failing tests (Go, freeze):** friction candidate mapping (diff-gated action, replay id); cap with ledger `phase='freeze'` rows; cache hit/miss for friction AND for an actionable error; publication-gate bypass only in `on`; zero-diagnosis candidate survives as cold; run stamped with the active mode.
- [ ] **Step 2: Failing tests (worker):** all-cached (zero model calls, `persistWrittenDigest` runs), mixed (model sees only cold), empty, `maxWritesPerRun=0` (cached deliver; cold appear as EXPLICIT deferred dispositions, not omissions), cached count > budget (all deliver), every-candidate-accounted-once.
- [ ] **Step 3: Failing tests (validation):** authored/cached/digit-smuggle/fingerprint-race/snoozed-race/writer-omission per the design's R-matrix; R5's four publication transitions on an `on`-stamped run; M1 publication/SLA predicates unchanged for `off`-stamped rows INCLUDING a fixture row created with NULL render_mode/phase-default (pre-065 shape); shadow run renders receipts while `shadow_render_mode` and cache fill and `frozen_lane_owns` never suppresses a receipt; cache-conflict test (concurrent current row, matching vs mismatching fingerprint); downstream failure after a cache insert rolls the cache write back; delivered-with-frozen-selected-row reconciliation finding.
- [ ] **Step 4:** Implement until both suites green; `off`-mode M1 suites untouched.
- [ ] **Step 5: Commit** `feat(digest): unified card protocol behind DIGEST_UNIFIED_CARDS (freeze/writer/validate)`.

---

### Task 6: Prod-cold smoke and shadow rehearsal (design M1+M5 evidence)

**Files:** none (verification; results recorded in the design doc).

- [ ] **Step 1:** Full gates both packages; zero Go skips.
- [ ] **Step 2:** Worktree stack; **fresh project per mode** (an `on` run warms cache and publication state, which would contaminate a later shadow assertion). Project A, `on`, REAL model call: seed one actionable friction incident + one frozen-lane error episode → actual scheduler → worker → validate chain unforced → delivered payload has two authored cards; cache rows exist; ledger phases and run stamp correct. Day-shift → second run cached, zero model calls (worker logs). Then cached-only and empty shapes. Project B, `shadow`: receipts delivered, `shadow_render_mode` + warm cache with `source='shadow'`, no publication changes. Project C, `off`: byte-identical M1.
- [ ] **Step 3:** Record against design milestones M1/M5.

---

### Task 7: Hardening follow-up — NOT NULL + retire dual-read (separate deploy, after prod dual-write verified)

> **Amended 2026-08-28.** The number `066` is taken: it now holds the additive
> PR-actionable lifecycle migration from
> `docs/superpowers/plans/2026-08-28-unified-cards-fixes.md`. This hardening
> migration takes the next free number. Its preconditions also have to cover
> `digest_unified_run_items`, which did not exist when this task was written and
> is where every ON-mode candidate snapshot now lives.

**Files:**
- Create: `packages/ingestion/db/migrations/0NN_run_items_incident_identity.sql` (next free number)
- Modify: worker/validator to drop `episodeId`-keyed disposition acceptance
- Test: migration test + wire tests updated

- [ ] **Step 1: Prod preconditions (read-only), all five:** zero `digest_run_items` rows with NULL `error_group_id` created since the T3 deploy; zero duplicate `(run_id, error_group_id)` pairs **in `digest_run_items`**; zero duplicate `(run_id, error_group_id)` pairs **in `digest_unified_run_items`**, and no identity present in both tables for one run; all ingestion and worker tasks run the dual-compatible build; no nonterminal (`frozen`/`written`) run predates that deployment and no queued `digest_write` job carries an episode-only snapshot.
- [ ] **Step 2:** The hardening migration: verification `DO` block that RAISEs with diagnostic counts on NULL stragglers OR duplicates in **either** snapshot table (never DELETE), then `SET NOT NULL` and `CREATE UNIQUE INDEX (run_id, error_group_id)`.
- [ ] **Step 3:** Remove dual-read; wire tests now reject episode-only dispositions.
- [ ] **Step 4:** Record the rollback boundary in the PR/deploy notes: after 066, rolling back to a pre-dual-write binary is prohibited.
- [ ] **Step 5: Commit** `feat(digest): enforce incident identity on run items; retire episode-keyed wire`.

---

### Task 8: Docs

- [ ] Update the design doc's milestone table + deviations (default off; NOT NULL deferred; shadow warms cache with `source='shadow'`; per-run mode stamp; canonical-episode dedup). Update digest prose docs that describe the delivery pipeline. Commit.

---

## Self-review notes

- Spec coverage: R1→T4/T5/T6; R2→T5 cached paths + T6 second-day smoke; R3→spike + T5 digit enforcement; R4→T5 freeze+validate halves; R5→T5 transitions on `on`-stamped runs; R6→T5 writer-omission + per-card fallback; R7→T5 worker shapes + T6; R8→T5 freeze-phase ledger; R9→T1 (+T7 deferred constraints).
- Rollout safety: additive migration (T1) → flag off (T2) → dual identity + dedup (T3) → renderer inert (T4) → behavior behind flag (T5) → three-mode smoke on fresh projects (T6) → tightening only after prod proof (T7). `on` cannot outrun the renderer (T4 precedes T5); mode is stamped per run so history never reinterprets under a different environment value; every commit dual-suite green.
- Codex round-2 P1s addressed: mode stamp on `digest_runs` + mode-aware predicates + pre-065-shape test (P1.1/judgment c); canonical-episode dedup in T3 + duplicate check in T7 preconditions (P1.2); cache-conflict fingerprint acceptance rule + concurrency test (P1.3); `DO`-block constraint guards (P1.4); four-part T7 precondition + rollback boundary (P1.5); shadow records `shadow_render_mode` (never claims a render), builds full card shapes before discarding, cache rows carry `source='shadow'` (judgment a); renderer reordered before behavior instead of a downgrade hack (judgment b). P2s: fresh project per smoke mode, `frozen_lane_owns` shadow receipt test, explicit deferred dispositions at `maxWritesPerRun=0`, 066 duplicate diagnostics, mode+cache-source in diagnostics, cache-insert rollback test.
