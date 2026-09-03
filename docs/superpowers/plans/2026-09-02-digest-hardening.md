# Digest Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten review findings on the digest-readability branch and bake in the product decisions from the 2026-09-02 alignment session, so the branch is shippable.

**Architecture:** The pivotal decision is templated impact: the writer authors number-free prose once (cacheable, stable) and the renderer prints today's measured numbers mechanically under it. That single move dissolves the cache-thrash, guaranteed-scale, and zero-grounding findings together and lets the writer's copy digit ban return. The remaining findings are per-card blast radius in the TS writer, one SQL function as the single source of fix provenance, a third receiptState twin, live receipt reasons, and the two-ask copy model.

**Tech Stack:** Go (ingestion digest/notify/handler, one SQL migration edited pre-ship), TypeScript (worker digest-writer), Vitest + Go tests against a disposable Postgres.

**Branch:** continue on `abhishekray07/digest-reads-like-a-human` (local only; its 7 commits are unshipped; migration 072 still must NOT be edited (see Global Constraints: it is durably applied locally and the repo rule is append-only)).

Revision 4 — final alignment (2026-09-03): the payload protocol gate is DROPPED. The mixed-version failure is benign by construction once Task 2 ships (an in-flight run's cards demote to receipts for one day and self-heal), deploys are conscious and rare, and the machinery would live in the payload protocol forever to prevent a cosmetic one-day degradation. Task 6's deploy note carries the honest sentence instead. Confirmed: interim three asks until the autonomy-removal change ships; error cards render exactly as today.

Revision 3 — after codex round 2 (user-run, 14 findings). The decisive corrections: migration 072 is durably applied in a local volume and Postgres cannot rename function parameters via CREATE OR REPLACE, so the SQL fix is a NEW migration 073 (append-only, with an upgrade-path test applying it over a database that already holds 072); the deploy window is replaced by protocol gating (the writer stamps its prompt version into the payload and validation applies v6 rules only to v6 payloads); the fixAttempted plumbing goes through db/queries.go's ErrorGroup, not a handler-local query; the impact line is friction-only, branch-on-kind-first, with an explicit partial-fact rule; why grounds against RootCause ONLY, field-specifically, in both validators; the worker gains the unified copy/action digit rejection as a per-card demotion (existing whole-run-rejection tests INVERT); MCP renders the same impact line and the field name is impact_visits_recovered; narrative.go's "Investigation report ready" copy is replaced; the lifecycle test's fix-transition reset expectation changes; the 3-arg classifier call in bucket-promotion.integration.test.ts:780 moves to 4-arg; a two-day cached-card round-trip test proves day-2 numbers; fingerprint_test gains impact-field mutations and freeze.go:41's stale comment is fixed; the branch is 7 commits, GeneratedDigestCard.AffectedUsers already exists, and the impact line's position is specified relative to the action line.

Revision 2 — after codex round 1 (three parallel focused reviews). Confirmed: cached cards stamp today's impact numbers (freeze_friction.go:79 freezes current values; validate.go:647 composes the rendered card from the current candidate; the cache stores prose only). Changes below: Task 2's catch covers every card-local factual check and preserves the deferral reason in the ledger; Task 5 uses the live actionableByGroup rows and fixes a second frozen stamp; Task 3 threads fixAttempted through the shared attachReceiptAndRecordings helper; Task 4 gets separate page/digest sentences and the full string inventory; both prompt-version constants bump to 6.

**Spec:** the ten confirmed review findings (2026-09-02 code review of `32bfce6..HEAD`) plus these approved decisions:

- (C) Impact numbers are rendered mechanically from today's facts, never written by the model.
- Card slots go to incidents with finished investigation reports; others appear via the overflow count and the oldest-waiter guarantee (already implemented in commit `88bc323`; unchanged here).
- Deploy safety: NO version gating (revision 4 decision). The only mixed-version exposure is deploying while a digest run is in flight (normally a ~10-minute morning window, or a stuck retrying run); the consequence, given Task 2's per-card demotion, is one day's cards rendering as receipts, self-healed the next morning. Task 6's deploy note states exactly that sentence. Do not implement promptVersion stamping or version-branched validation.
- Exactly two authored ask lines for report-bearing states: `Review the fix PR.` and `Decide how to handle this.` (`Approve the proposed fix.` survives only until the separate autonomy-removal change ships; "fix attempt failed" ceases to be an ask and becomes story context.)
- No system jargon in reader-facing copy (no "diagnosis", "investigation", "friction", category names, or route templates).

## Global Constraints

- The writer's copy and action are digit-free again, enforced in BOTH validators: Go's restored ban, and a matching unified-card check in the worker that rejects per-card (demotion, never a run failure). The `why` sentence's digits ground FIELD-SPECIFICALLY against `RootCause` alone in both validators (not the pooled whitelist); title keeps the pooled whitelist. Legacy (pre-v6 payload) cards validate under the old rules via the protocol gate. The spelled-out-quantities ban returns to the prompt. Tests to invert, not supplement: the worker tests asserting whole-run rejection for account/link/number defects (digest-writer.test.ts:146, :485) and the impact-digits-pass expectation (digest-writer/__tests__/grounding.test.ts:46).
- `ImpactVisits`/`ImpactRecovered` leave both grounding whitelists (added in commit `2e20c2c`; that commit's relaxation of the copy digit ban is reverted).
- Both prompt-version constants (TS DIGEST_PROMPT_VERSION, Go digestPromptVersion in fingerprint.go:11) bump 5 -> 6 in Task 1: v5's semantics change here pre-ship, and the bump guarantees no v5-cached copy (from any environment or test database) survives into the new rules.
- Migration 072 is NOT edited (it is durably applied in at least one volume-backed database, the runner reapplies all migrations on boot, and the repo rule is append-only). The SQL fix ships as migration 073: CREATE OR REPLACE the function KEEPING the existing parameter names but correcting the body to use $1/$2 positional references (sidesteps both the rename restriction and the self-comparison), and update ask strings in a re-created action-class function. 073's tests: double-apply idempotency AND an upgrade-path case that applies 073 over a database already carrying 072's definitions, asserting the wrong-project call now returns false.
- The mechanical impact line is FRICTION-ONLY and the renderer branches on kind first. Partial-fact rule: visits>0 and recovered>0 -> `N visits this week, M recovered`; visits>0 and recovered absent-or-zero -> `N visits this week`; visits absent-or-zero -> no line. Error cards keep their existing people-count context exactly as today (no new line, no duplication). Field name matches the existing API: `impact_visits_recovered`. Position: the impact line renders directly after the `Why:` line and before the action line. MCP's digest formatter renders the same friction impact line so Slack and MCP agree.
- Every task's verification uses a migrated disposable Postgres; DB-gated suites must run, not skip.

---

## File Structure

- `packages/ingestion/notify/slack_digest.go` — mechanical impact line on authored cards; nothing else in card layout changes.
- `packages/ingestion/notify/event.go` — `GeneratedDigestCard` carries `ImpactVisits`/`ImpactRecovered`/`AffectedUsers` stamped facts.
- `packages/ingestion/digest/validate.go` — stamps those facts onto validated cards; whitelist revert; ask-copy collapse; live `FallbackReason`.
- `packages/ingestion/digest/actionable.go` — `digestAction` two-ask collapse; `fixAttemptedSQL` becomes a call to the SQL function.
- `packages/ingestion/db/migrations/072_action_class_fix_provenance.sql` — qualified parameters; ask strings updated to match Go.
- `packages/ingestion/handler/read_api.go` — `receiptStateFor` learns fix provenance.
- `packages/worker/src/digest-writer/job.ts` — per-card grounding demotion; whitelist revert; prompt edits.
- Tests colocated with each.

### Task 1: Mechanical impact line, writer numbers withdrawn

**Files:**
- Modify: `packages/ingestion/notify/event.go` (GeneratedDigestCard), `packages/ingestion/digest/validate.go` (stamp site, near where `claimedUsers` is stamped), `packages/ingestion/notify/slack_digest.go` (`digestV4CardBlocks`)
- Modify: `packages/worker/src/digest-writer/job.ts` (prompt text, whitelist, digit rules), `packages/ingestion/digest/validate.go` (restore copy digit ban, revert whitelist)
- Test: `packages/ingestion/notify/slack_digest_test.go`, `packages/ingestion/digest/validate_review_test.go`, `validate_unified_test.go`, `packages/worker/src/__tests__/digest-writer.test.ts`

**Interfaces:**
- Produces: `GeneratedDigestCard.ImpactVisits *int64`, `ImpactRecovered *int64` (json `impact_visits`/`impact_recovered`, omitempty), stamped by validation from the candidate; renderer contract: authored friction card block order is title, copy, `Why: …` (when present), impact line, context line.

- [ ] **Step 1: Failing renderer tests**

In `slack_digest_test.go`, extend the authored-friction-card test: friction card with visits=17, recovered=14 renders exactly `17 visits this week, 14 recovered`; visits=17, recovered nil-or-0 renders `17 visits this week`; visits nil-or-0 renders no impact line; an ERROR card with visits set renders NO impact line and its existing people-count context is byte-identical to today. Assert position: after the Why line, before the action line.

- [ ] **Step 2: Implement stamp + render**

`event.go`: add the two pointer fields (plus `AffectedUsers int` if the authored card does not already carry it — check; `ClaimedUsers` exists on the written card, the notify card may differ). `validate.go`: where the validated card is composed into `GeneratedDigestCard`, copy `candidate.ImpactVisits`/`ImpactRecovered`/`AffectedUsers`. `slack_digest.go` `digestV4CardBlocks`:

```go
	if card.Kind == "friction" && card.ImpactVisits != nil && *card.ImpactVisits > 0 {
		line := fmt.Sprintf("%d visits this week", *card.ImpactVisits)
		if card.ImpactVisitsRecovered != nil && *card.ImpactVisitsRecovered > 0 {
			line += fmt.Sprintf(", %d recovered", *card.ImpactVisitsRecovered)
		}
		impactLine = line
	}
	// error cards: no new line; their existing people-count context is untouched
```

(Adapt names to the file's local style. Position: directly after the Why line, before the action line. `GeneratedDigestCard.AffectedUsers` already exists — only the two impact pointer fields are new, json `impact_visits` / `impact_visits_recovered`. Update the shared TS mirror in `shared/src/types.ts` (GeneratedDigestCard, ~line 44) and the C0 receipt fixture; update MCP's digest formatter (`packages/ingestion/mcp/format.go` ~141) to render the same friction impact line.)

- [ ] **Step 3: Withdraw writer numbers**

`validate.go`: restore `containsDigit(card.Copy)` to the ban alongside action (reverting `2e20c2c`'s relaxation; keep its improved comment shape). Remove `ImpactVisits`/`ImpactRecovered` from `firstUngroundedNumber`'s whitelist. Keep `RootCause` in the whitelist (the `why` sentence grounds against it). `job.ts`: remove `impactVisits`/`impactRecovered` from `factNumbers`; prompt: delete the "copy carries the measured scale" paragraph, restore `Never state counts as digits in copy or action` plus `Do not spell out volatile quantities either ("dozens", "three people")`, and add one sentence: `The message prints the measured numbers under your copy; never restate them.`

- [ ] **Step 4: Rework the tests the revert touches**

`validate_review_test.go`: `TestMeasuredImpactGroundsCardProse` inverts — a copy stating `17 visits` now fails even though the fact is frozen (numbers are renderer-owned); rename to `TestMeasuredImpactStaysOutOfProse`. `validate_unified_test.go`: `TestValidateUnifiedGroundedDigitInCopyShips` is deleted (its premise reverted); the smuggle test keeps its 987. TS `digest-writer.test.ts`: prompt-phrase assertions swap to the restored sentences. A why-digit test stays green: digits in `why` grounded by `RootCause` still pass (add one if absent: rootCause "timeout after 10 seconds", why "requests time out after 10 seconds" → card ships).

- [ ] **Step 5: Run**

`go test ./digest ./notify` and `pnpm --filter @opslane/worker test -- digest-writer` — green.

- [ ] **Step 4b: Prove day-2 numbers and the protocol gate**

Two-day cached-card round-trip test (Go, DB-backed): author and cache prose on day 1 with visits=17; mutate the incident's impact to 23; freeze day 2, replay the cache, validate; assert the rendered payload's card carries 23 and the Slack blocks contain `23 visits`. Add impact-field mutations to `fingerprint_test.go` (~30) asserting the fingerprint does NOT change. Fix the now-false comment at `freeze.go:41` claiming impact values feed writer prose. (Revision 4: no protocol gate — do not add promptVersion stamping or version-branched validation; the deploy note in Task 6 covers mixed-version exposure.)

- [ ] **Step 5b: Version bump** — TS `DIGEST_PROMPT_VERSION` and Go `digestPromptVersion` both 5 -> 6; update the tests that pin 5 (`TestCandidateFingerprintSemanticContract`, the cached-copy prompt-version assertion in `TestValidateOnPublishesAuthoredFrictionAndCachesCopy`, the TS prompt-contract test name).

Known and accepted: the why sentence's digits ground against the whole candidate fact set, not RootCause alone (grounding is one whitelist); acceptable because every entry in it is a frozen fact.

- [ ] **Step 6: Commit** `fix(digest): render measured impact mechanically, keep the writer digit-free`

### Task 2: One bad card demotes itself, not the digest

**Files:**
- Modify: `packages/worker/src/digest-writer/job.ts` (`groundPayload`, the grounding loop inside `parsed.included.map` ~line 224)
- Test: `packages/worker/src/__tests__/digest-writer.test.ts`

**Interfaces:**
- Consumes: the existing `deferred`/`rejected` routing (job.ts ~261): a deferral with a reason reaches the Go validator as `receipt_fallback`.

- [ ] **Step 1: Failing test** — a payload with two cards, one containing an ungrounded number: `groundPayload` returns one included card and one deferred entry whose reason names the grounding failure; it does not throw. A second test pins that identity-level corruption (unknown episode/group id, duplicate disposition) still throws for the run — those are protocol violations, not card defects.

- [ ] **Step 2: Implement** — restructure the map into a loop whose try/catch covers EVERY card-local factual check: the claimed users echo (job.ts:191), claimed occurrences (:200), accounts mismatch (:211), PR URL mismatch (:217), session/identified count echoes, and the grounding scan. On failure, log and push `{...frozenIdentities(truth), reason: 'card check: <message>'}` into the deferred list. These stay throws (protocol-level, outside the catch): malformed top-level payload (job.ts:96), frozen candidate lacking identity (:171), colliding frozen identities (:175), disposition lacking identity (:184), unknown included/deferred identity (:252), duplicate disposition, and a candidate neither included nor deferred (:272).

- [ ] **Step 2b: Preserve the reason** — in Go validation, writer-deferred items currently reach receipt_fallback but their `item.Reason` never enters `receiptReasons` (validate.go:623 vs :1080) and the ledger flips them to `included` once their receipt is admitted (:947, :1165). Copy the writer's reason through so the freeze ledger and FallbackReason distinguish `card check: …` deferrals from `never_card_eligible`; a `card check` receipt renders as a FULL card-style receipt, never compact.

- [ ] **Step 3: Run** worker digest-writer suite; commit `fix(worker): a card that fails grounding demotes alone`.

### Task 3: One SQL function owns fix provenance

**Files:**
- Modify: `packages/ingestion/db/migrations/072_action_class_fix_provenance.sql`, `packages/ingestion/digest/actionable.go` (`fixAttemptedSQL`), `packages/ingestion/handler/read_api.go` (`receiptStateFor` + its query, ~line 708)
- Test: `packages/ingestion/db/migration_test` file for 072 (extend), `packages/ingestion/handler/` incident-detail test

- [ ] **Step 1: Fix the tautology** — in 072, rename the function parameters (`p_terminal_fix_job_id UUID, p_project_id UUID`) and qualify the predicate (`j.id = p_terminal_fix_job_id AND j.project_id = p_project_id`). Update every call site inside the migration's trigger bodies.

- [ ] **Step 2: Failing SQL test** — extend `TestMigration072FixAttemptedChecksTheJobType` (or add a sibling): a fix job in project A queried with project B's id returns false; with project A's id returns true.

- [ ] **Step 3: Single source** — `actionable.go`: replace the hand-written `fixAttemptedSQL` fragment with `error_groups_fix_attempted(g.terminal_fix_job_id, g.project_id)`. The incident data comes from `db.Queries.GetErrorGroup` (packages/ingestion/db/queries.go:1897) and `ErrorGroup` has no FixAttempted field (queries.go:1133): add the field, add `error_groups_fix_attempted(g.terminal_fix_job_id, g.project_id)` to the SQL projection, extend the scan, then pass it through the shared `attachReceiptAndRecordings` helper (read_api.go, used by the GET at ~613 and lifecycle responses at ~1343) into `receiptStateFor(status, hasSavedDiff, fixAttempted)`. Deploy ordering: migrations commit before new code serves (the pipeline's migrate-first step guarantees it; say so in the Task 6 doc).

- [ ] **Step 4: Failing handler test** — an incident whose `terminal_fix_job_id` points at a dead-lettered *investigation* job renders `receipt_state: report_ready` (not `attempt_failed_no_diff`) in the incident API; one with a real failed `fix` job keeps `attempt_failed_no_diff`.

- [ ] **Step 5: Run** `go test ./db ./digest ./handler`; migrations double-apply check; commit `fix(digest): one SQL function decides whether a fix ran`.

### Task 4: Two asks, no jargon

**Files:**
- Modify: `packages/ingestion/digest/actionable.go` (constants + `digestAction`), `packages/ingestion/db/migrations/072_…` (action-class strings), `packages/ingestion/narrative/narrative.go` (receipt lines ~111), `packages/ingestion/digest/validate.go` (anything echoing the old strings), prompt text in `job.ts` if it names asks
- Test: the ask-pinning tests codex listed: `TestDigestActionIsExhaustive`, `TestFreezeOnCoversEveryStatusAndKind`, `TestBuildReceiptItemsStatesAndValidatedProse`, `TestReceiptLine`, `TestMigration072…`, plus `slack_digest` fixtures carrying old strings

- [ ] **Step 1: Collapse** — `actionReviewInvestigation` and the `report_ready` ask (`Review the diagnosis.` if present from the earlier commit) both become one constant `actionDecide = "Decide how to handle this."`. Mapping: `awaiting_approval`+diff → `Approve the proposed fix.` (kept until autonomy removal); `pr_created`/`pr_draft` with URL → `Review the fix PR.`; every other report-bearing state → `actionDecide`. The `attempt_failed_no_diff` receipt narrative line (narrative.go) becomes `We tried a fix and couldn't produce a working change; details on the issue page.` — context, not an ask. narrative.go has TWO surfaces carrying the failed-fix phrase: the issue-page line (narrative.go:89) and the digest receipt line (:122). The digest line becomes `We tried a fix and couldn't produce a working change; details on the issue page.`; the page line (already ON the issue page) becomes `We tried a fix and couldn't produce a working change.` Codex's full inventory of the removed strings — update every non-historical occurrence, byte-identical to Go in 072:
  - Production: actionable.go:35,41; narrative.go:89,122; migrations/072:5,37,39,49,51; worker/src/index.ts:1145.
  - Tests: digest/freeze_test.go:233,466,467; validate_test.go:356 (:364 is a deliberate legacy payload — keep); oncard_test.go:143-192,336; cache_invalidation_test.go:134; narrative/narrative_test.go:59,79; db/migration_072_test.go:60-64; notify/slack_digest_test.go:241,486,490,549,560,569,587,819; dashboard incident-detail-receipts.test.ts:80; worker digest-writer.test.ts:256,352,375; worker bucket-promotion.integration.test.ts:796; worker digest-writer/__tests__/grounding.test.ts:35,57,68,85,99,111.
  - Historical, do NOT rewrite: migrations/066:26,34; db/migration_069_test.go:66.

- [ ] **Step 2: Update the pinned tests** — each listed test's expected strings change. One structural expectation legitimately CHANGES: migration_072_test.go:127 asserts a terminal-fix-job transition resets actionable_since; with fix-attempted and never-attempted now sharing one ask, that transition no longer changes action class and the waiting age is PRESERVED — rewrite the assertion to pin preservation. No backfill for existing rows: merged classes keep their current actionable_since (an older age is acceptable and favors the oldest-waiter guarantee; note this in 073's comment). Update the 3-argument classifier call in worker bucket-promotion.integration.test.ts:780 to the 4-argument form. narrative.go's remaining jargon: `Investigation report ready` (~:80) becomes `We found the cause`; the `investigation report` phrase in the digest line (~:111) follows the Task 4 replacement sentences. The no-jargon rule is prompt guidance plus these explicit copy replacements — NOT a new validator vocabulary check. Honest action matrix until autonomy-removal ships: `Approve the proposed fix.` (diff held), `Review the fix PR.` (PR open), `Decide how to handle this.` (everything else report-bearing).

- [ ] **Step 3: Run** `go test ./digest ./notify ./db ./handler`; commit `feat(digest): two plain asks`.

### Task 5: Live receipt fallback reason

**Files:**
- Modify: `packages/ingestion/digest/validate.go` (~line 940, the `FallbackReason` stamp)
- Test: `packages/ingestion/digest/oncard_test.go` or `validate_unified_test.go`

- [ ] **Step 1: Failing test** — freeze an incident as never-card-eligible, then give it a validated diagnosis before validation runs; the rendered receipt is NOT compact (it carries the root-cause excerpt as a full receipt card).

- [ ] **Step 2: Implement** — receipt validation already batch-loads live actionable rows into `actionableByGroup` and keeps them through the stamp site (validate.go:839-843): stamp `FallbackReason` from `onCardEligible` over `actionableByGroup[item.IncidentID]`, replacing the frozen `byIdentity` lookup at :940. Also fix BOTH other frozen-stamp paths: the degraded-fallback construction (validate.go:1023, :1252) and `receiptForUnifiedFallback`'s independent restore (validate.go:1225, :1249). Rule everywhere: live eligibility when available; when live evaluation is unavailable, leave `FallbackReason` empty (un-compacted full receipt is the safe default). The frozen flag stays only as the freeze-time model-call-skip signal; the freeze ledger keeps its historical record.

- [ ] **Step 3: Run**; commit `fix(digest): receipt compaction reads today's eligibility`.

### Task 6: Deploy note

**Files:**
- Modify: `docs/reference/environment-variables.md` sibling deploy doc (or `docs/install.md` deploy section — put it where the existing deploy guidance lives; create nothing new)

- [ ] **Step 1:** Add: services deploy atomically; deploying while a digest run is in flight (roughly 09:00-09:10 project-local, or any day a run is stuck retrying) can render that day's authored cards as plain receipts; the next morning's run recovers on its own. Also: migrations commit before new code serves traffic (the pipeline's migrate-first step guarantees this). Commit `docs: digest deploy note`.

### Task 7: Whole-branch verification

- [ ] The FULL repository gate, per the root AGENTS.md, not a subset: `pnpm install --frozen-lockfile`; `pnpm -r build`; root `pnpm test` with `DATABASE_URL` exported (read the skip count; only the known env-gated skips are allowed); `(cd packages/ingestion && go build ./... && go test ./...)` on a migrated disposable Postgres with ZERO skips; `docker compose config --quiet`; migration idempotency (all migrations twice) AND the 073 upgrade-path case (apply over a database already carrying 072). Also run each earlier task's focused suites WITH `DATABASE_URL` set (the global no-skip rule applies to Tasks 1-5's step commands too — prefix each with the disposable DB URL). The live event-to-terminal pipeline smoke (worker AGENTS.md) is run by the /verify pass that follows this plan; state that hand-off explicitly in the report rather than skipping it silently. Report exact tallies.

---

## Self-review notes

- Findings coverage: 1 (cache thrash) + 5 (grounded zero) + 7 (scale unenforced/pre-v5 payloads) → Task 1 (numbers renderer-owned; old stored payloads simply lack the pointer fields and render no impact line, which is the pre-deploy status quo). 2 (whole-digest loss) → Task 2. 3 (deploy skew) → Task 6 note per the atomic-deploy decision. 4 (dashboard twin) + 6 (tautology/drift) → Task 3. 9 (spelled-out quantities) → Task 1 step 3. 10 (stale fallback reason) → Task 5. Finding 8 (migration 064 trigger churn) is pre-existing and explicitly deferred. Ask decisions → Task 4.
- The OFF-lane "byte-identical" comments predate #443's switch removal; unified is the only lane, so the renderer change has no rollback-lane drift to protect. The implementer should still leave `Build`/receipt-lane code untouched except where Task 3/4 name it.
- Type consistency: `ImpactVisits *int64` matches the candidate's existing pointer type; `receiptStateFor` and `digestAction` both take `fixAttempted bool` after Tasks 3–4.
