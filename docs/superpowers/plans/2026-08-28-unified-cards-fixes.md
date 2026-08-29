# Unified digest cards — verification fixes Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four defects found by verification run `.verify/runs/20260827-192819` and apply the user's rulings: no shadow mode, one action-only repeating card lane, status-derived action text.

**Architecture:** In ON mode the digest is a single lane: an incident appears if and only if it awaits a human action, and it repeats until that action is taken. **Actionability is decided by status alone; `publishable()` only decides whether the incident gets an authored card or its mechanical receipt — it can never remove the incident from the digest.** PR-review incidents (`pr_created`/`pr_draft`) join the actionable lifecycle. Action text is a deterministic function of incident state, rendered mechanically (the model never owns it). Shadow mode is deleted; the flag is `off | on`, default off. OFF mode stays byte-identical M1+episode-lane behavior, which requires the OFF receipt lane to keep the M1 status set — the extended set exists as a separate ON-only constant.

**Rulings (user, 2026-08-28):** drop shadow; cards must carry an action; verified-fix/PR cards are actionable (repeat until the PR is resolved); pure FYI ("investigated, nothing to do") never appears in the digest, by design.

**Spec:** `docs/design/2026-08-28-unified-cards-fixes.md` (this plan implements it; the parent `docs/design/2026-08-27-unified-digest-cards.md` is updated by T7). Note the spec's R5 refinement: merging the PR removes the incident (webhook sets `merged`); closing a draft unmerged KEEPS the incident and swaps its card to "Review the investigation." with a reset waiting age (webhook sets `needs_human`, `queries.go:2212`) — T3's tests must cover both outcomes. Findings being fixed: F1 (FYI cards authored then discarded daily by the actionable publishable() check), F2 (shadow burned FYI cards), F3 (ON actionable cards wrote issue_publications), F4 (empty `remediation` made an actionable error vanish; prod: the approval path leaves the field empty 11/11 times on friction). P2s: rejected cached copy never invalidated; capped ledger rows ended at phase='validation'; `digest_unified_run_items` undocumented; writer budget unwired.

## Global Constraints

- Migration 064 is SHIPPED: never edited. Migration 065 is UNSHIPPED and may be edited in place; note that dev/verification databases that already applied the old 065 keep the dropped columns as harmless drift — fresh-schema tests run against a recreated database, never a stack that ran the old 065.
- Two status constants, not one: `m1ActionableStatusSQL = ('awaiting_approval','needs_human')` (OFF receipts, 064 trigger semantics, unchanged) and `onCardStatusSQL = ('awaiting_approval','needs_human','pr_created','pr_draft')` (ON lane only). OFF-mode output stays byte-identical; the existing suites prove it untouched.
- Deterministic action text, one Go function, exhaustive over the ON status set:
  - `awaiting_approval` + saved diff → "Approve the proposed fix."
  - `awaiting_approval` without diff → "Review the investigation."
  - `pr_created`/`pr_draft` + `pr_url` → "Review the fix PR."
  - `pr_created`/`pr_draft` without `pr_url` (inconsistent state) → "Review the issue." + a diagnostic log; the incident still renders.
  - `needs_human` → "Review the investigation."
  **The model never owns action text: validation OVERWRITES the card's action with this deterministic value before caching and rendering** (a differing model action is logged diagnostically, never demoted — demoting on wording would waste the model call over punctuation). The prompt keeps asking for an action so the model reasons about it, but the stored and rendered value is always the Go function's.
- An actionable incident is ALWAYS eligible and accounted for in ON: it renders as an authored card, cached card, or mechanical receipt, or it is counted in the cap's overflow line with a ledger row. No code path may silently drop it (F1/F4 root rule).
- **Action class** is the value of the deterministic function. The lifecycle trigger resets `actionable_since` and clears `snoozed_until` whenever the action class CHANGES, and preserves both when it does not — for status changes AND for the inputs the function reads (saved diff appearing/disappearing on `awaiting_approval`, `pr_url` empty→present). `pr_draft`↔`pr_created` is the same class (preserve).
- ON mode performs no `issue_publications` reads or writes.
- Each commit leaves `go test ./...` (DATABASE_URL set, zero skips) and `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker test` green.

---

### Task 1: Delete shadow mode

**Files:**
- Modify: `packages/ingestion/digest/mode.go` (+test), `freeze.go`, `freeze_friction.go`, `validate.go`, `packages/ingestion/db/migrations/065_unified_digest_cards.sql`, `packages/ingestion/db/migration_065_test.go`

- [ ] **Step 1:** Failing tests: `ReadUnifiedCardsMode` accepts only off/on ("shadow" → off + warn like any invalid value); migration test (fresh database) asserts `shadow_render_mode` and `digest_card_copy.source` do not exist and mode CHECK is `('off','on')`.
- [ ] **Step 2:** Edit 065 in place (remove both columns and the shadow CHECK); before re-adding the two-value mode CHECK, `UPDATE digest_runs SET unified_cards_mode='off' WHERE unified_cards_mode NOT IN ('off','on')` so replay on a database that ran the old draft (and holds 'shadow' rows) cannot fail; add a migration test replaying from the old draft shape with a 'shadow' row present. Strip every shadow branch from freeze/validation (shadow card building, shadow ledger writes, source-tagged cache writes).
- [ ] **Step 3:** Both suites green. Commit `feat(digest): remove shadow mode; flag is off|on`.

---

### Task 2: Additive PR-actionable schema (no behavior change)

**Files:**
- Create: `packages/ingestion/db/migrations/066_pr_actionable.sql`, `packages/ingestion/db/migration_066_test.go`

DB-only and additive so it is safe to deploy before any ON-lane code understands PR cards (Codex: tasks must be independently shippable). No shared-constant edits here.

**Interfaces:**
- Produces: the `error_groups_actionable_lifecycle` trigger FUNCTION replaced via guarded `CREATE OR REPLACE FUNCTION` (the trigger object itself is not dropped/recreated on replay; the 064 trigger keeps calling the one function, so the two migrations cannot fight), implementing the **action-class semantics** from Global Constraints. The trigger's `UPDATE OF` column list extends to cover every input the action function reads: `status`, `candidate_diff`, `pr_url`, plus the existing `actionable_since`/`snoozed_until`. Class change → reset `actionable_since=now()`, clear `snoozed_until`; same class → preserve both, INCLUDING an explicitly supplied `actionable_since` (pin with a test — the backfill path depends on it).
- Backfill for existing `pr_created`/`pr_draft` rows with NULL `actionable_since`: use `updated_at` (best available transition timestamp; `now()` only when NULL) so old PRs do not masquerade as fresh asks.

- [ ] **Step 1:** Failing tests: INSERT into `pr_created` stamps; `awaiting_approval` (snoozed, actionable_since=T0) → `pr_created` clears the snooze and resets actionable_since; `pr_draft` → `pr_created` preserves both; `awaiting_approval` gains a saved diff (class "Review the investigation." → "Approve the proposed fix.") → resets; `pr_created` gains a `pr_url` (class change from the inconsistent-state action) → resets; explicitly supplied `actionable_since` within the same class is preserved; leaving the extended set clears; backfill uses `updated_at`; reapply-safe; old-binary insert shape works; M1 statuses behave exactly per the 064 tests (rerun them).
- [ ] **Step 2:** Implement; green. Commit `feat(digest): PR statuses join the actionable lifecycle (schema only)`.

---

### Task 3: One lane in ON — status-derived actions, card-vs-receipt split, no publications

**Files:**
- Modify: `packages/ingestion/digest/actionable.go` (add `onCardStatusSQL`; `m1ActionableStatusSQL` untouched), `freeze.go`, `freeze_friction.go`, `validate.go`, `packages/ingestion/handler/read_api.go` (snooze accepts the extended set), `packages/worker/src/digest-writer/job.ts` (+tests both sides)

**Interfaces:**
- ON freeze: candidates come only from the actionable query over `onCardStatusSQL` (both kinds); the episode/one-shot lane runs only in OFF. `ValidAction` from the deterministic function; `remediation` may enrich the model's fact envelope but never gates candidacy.
- Card-vs-receipt split (the F1/F4 root fix): `publishable()` decides authored-card eligibility only. Not publishable (missing validated diagnosis, missing PR URL, filler root cause) → the incident renders its mechanical M1 receipt with the deterministic action, ledger `render_mode='receipt_fallback'` with a reason distinguishing "never card-eligible" from "card failed validation". Nothing is authored for never-eligible candidates (no daily wasted model calls) and nothing disappears.
- Validation: one staleness/grounding path for all candidates; action exact-equality check against the deterministic function; failures demote to receipt.
- Publications: zero `issue_publications` reads/writes in ON (freeze gate and delivery write both removed on that branch). OFF untouched.
- Snooze endpoint: 204 for the extended set, 409 otherwise; in OFF, snoozing a PR-status incident is accepted but has no digest effect (documented).

- [ ] **Step 1:** Failing tests (Go, table-driven over all four statuses × both kinds where valid): F4 regression — `awaiting_approval` error with diff and EMPTY remediation renders (card or receipt, never absent); `awaiting_approval` friction without diff gets "Review the investigation."; `pr_created` with `pr_url` gets "Review the fix PR." and repeats across three day-shifted runs from cache; `pr_created` without `pr_url` renders receipt + diagnostic; pre-existing `issue_publications` row does not gate any status; delivered ON run writes zero publication rows; investigated/closed incidents produce no candidate AND zero writer model calls; missing validated diagnosis → receipt with deterministic action, zero authoring.
- [ ] **Step 2:** Failing tests (worker): four-status candidate set authors once and caches; validation OVERWRITES a deviating model action with the candidate's deterministic `validAction` (card still delivers; mismatch logged, never demoted); no FYI branch remains.
- [ ] **Step 2b:** Failing tests (SLA/reconciliation, mode-aware): in ON, PR-status incidents participate in the actionable diagnostics — omitted (unledgered) fires, capped is quiet, snoozed is quiet, delivered-selected is quiet; in OFF, PR statuses keep today's behavior (absent from actionable diagnostics). Extend `sla.go`/reconciliation status predicates to branch on the run's stamped mode.
- [ ] **Step 3:** Implement; both suites green; OFF suites byte-identical.
- [ ] **Step 4:** PR-completion check: confirm (and pin with a test) that merging/closing the PR moves the group out of `pr_created`/`pr_draft` via the existing ci-watch/PR pipeline so cards stop repeating; if no such transition exists, STOP and surface it — do not ship repeat-forever PR cards.
- [ ] **Step 5:** Commit `feat(digest): single action-only card lane in ON mode`.

---

### Task 4: Cache and ledger correctness

**Files:**
- Modify: `packages/ingestion/digest/validate.go` (+tests)

- [ ] **Step 1:** Failing tests: a cached copy rejected by validation (digit scan, grounding, action mismatch, or fingerprint race) is invalidated **by primary key** (`error_group_id, spell_started_at, authored_at`) in the same transaction, so the next run re-authors; a NEWER current row inserted concurrently (different `authored_at`) is NOT invalidated by the late validator; capped rows keep `phase='freeze'` through delivery while selected rows reach `phase='validation'`, and the SLA sweep reports neither.
- [ ] **Step 2:** Implement; green. Commit `fix(digest): invalidate exactly the rejected cached row; capped rows stay freeze-phase`.

---

### Task 5: Wire the writer budget

**Files:**
- Modify: `packages/worker/src/digest-writer/job.ts` (`defaultDependencies` reads `DIGEST_WRITER_MAX_WRITES`), `docker-compose.yml` passthrough, `docs/reference/environment-variables.md` (+tests)

- [ ] **Step 1:** Failing tests: env `0` → cached deliver, cold appear as explicit deferred dispositions; unset/invalid → unlimited with one warn.
- [ ] **Step 2:** Implement; green. Note in the env-var doc that prod ECS task definitions (deploy repo) must add the variable to take effect — compose passthrough alone does not reach prod.
- [ ] **Step 3:** Commit `feat(worker): DIGEST_WRITER_MAX_WRITES budget knob`.

---

### Task 6: Document digest_unified_run_items and align rollout preconditions

**Files:**
- Modify: `docs/design/2026-08-27-unified-digest-cards.md`, `docs/superpowers/plans/2026-08-27-unified-digest-cards.md` (hardening-migration preconditions)

- [ ] **Step 1:** Document the table as the ON-mode snapshot store (rows CASCADE with runs); extend the future hardening-migration NULL/duplicate preconditions to cover it; document the dev-database drift note for the edited 065 (old columns persist on databases that applied the old version; harmless, fresh installs never see them).
- [ ] **Step 2:** Commit `docs(digest): unified run-items store and hardening preconditions`.

---

### Task 7: Update the design doc + re-verify on a fresh stack

**Files:**
- Modify: `docs/design/2026-08-27-unified-digest-cards.md` (rulings; delete shadow milestones; action-text function; card-vs-receipt split)

- [ ] **Step 1:** Design doc updated; docs gates green.
- [ ] **Step 2:** **Recreate the verification stack** (new compose project + fresh volumes — the standing `verifyuc` database applied the old 065 and would fake-pass or fake-fail the schema assertions). Black-box re-verify at minimum:
  - F4 regression: awaiting_approval error, empty remediation, with and without diff → renders both days.
  - PR card: pr_created with pr_url → card day 1 (authored), day 2 (cached); snooze carried from awaiting_approval is cleared on transition (age line resets); PR merged/closed → card gone next day.
  - No-publication proof: pre-existing publication row does not gate; delivered ON runs write zero publication rows (all four statuses).
  - Pure FYI (investigated) → no candidate, zero model calls.
  - "shadow" env value behaves exactly as off.
  - Rejected-cache invalidation tail: digit-tampered row re-authors the next day instead of demoting forever.
  - OFF parity spot-check (M1 receipts unchanged, PR statuses absent from OFF receipts).
- [ ] **Step 3:** Record outcomes in the run dir; report.

---

## Self-review notes

- F1→T3 (publishable gates card vs receipt, never presence; FYI lane gone in ON; never-eligible candidates are not authored, killing the daily waste); F2→T1; F3→T3; F4→T3 (deterministic action + regression tests incl. the diff/no-diff split); cache demotion→T4 (exact-row + concurrency); capped phase→T4; unified table + 065-drift→T6; budget→T5 (+prod task-def note).
- Codex round-1 P1s: incidents never disappear (1); hasSavedDiff mapping (2); deterministic action (3); action-class transitions (4); PR-completion pinned or STOP (5); OFF keeps `m1ActionableStatusSQL` (6); T2 additive-only (7); backfill from `updated_at` (8); PK-targeted invalidation + concurrency (9); four-status publication tests + zero-authoring FYI proof (10); re-verify expanded (11); fresh stack (12). P2s: guarded function replace, inconsistent-PR receipt+diagnostic, prod task-def note, 065 drift, capped/SLA expansion.
- Codex round-2 fixes: validation overwrites the model action instead of equality-demoting (1); action-class semantics extended to diff/pr_url input changes with the trigger's UPDATE OF list covering them, same-class explicit `actionable_since` preserved (2, 6); SLA/reconciliation made mode-aware for PR statuses with four diagnostic tests (3); PR-completion STOP retained (4); old-draft-065 replay normalizes 'shadow' rows before the CHECK, with a replay test (7); cap wording corrected to eligible-and-accounted (8). Round-2 item 5 (drop the superpowers header) is intentionally not applied: the header is this repo's plan-execution convention, not a foreign dependency.
- Rollback: OFF byte-identical at every commit; 064 untouched; 066 additive+guarded; 065 edits only affect fresh installs.
