# Digest Holds Back Failed Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The unified (ON) daily digest ships only cards that passed their checks: authored or cached cards. It never ships a mechanical receipt, an overflow line, or an unformatted fallback card.

**Architecture:** The change touches four places. (1) Freeze stops admitting incidents that `publishable()` refuses, and it gives error candidates an explicit `why`. (2) Validation holds back every card that fails its checks or that the writer deferred: the card is ledgered as excluded with reason `card_held_back` instead of being turned into a receipt. Infrastructure failures fail the run so the scheduler retries it. A run whose cards were all held back commits its ledger and sends nothing. (3) The v5 Slack renderer drops the receipt loop and the "And N more" line. (4) The worker prompt tells the model to write `why` whenever a `why` is supplied.

**Tech Stack:** Go 1.24 + pgx (`packages/ingestion`); Node 22 + TypeScript + Vitest (`packages/worker`).

**Spec:** GitHub issue #496, plus the decisions below from a grilling session with the maintainer on 2026-09-14. They override the issue's options and its acceptance criteria.

### Decisions (the spec)

1. **Hold back failed cards.** A card that fails validation, or that the writer defers for any reason (card check, unusable card, budget, "Redundant with…"), does not ship that day. This supersedes R6 in `docs/design/2026-08-27-unified-digest-cards.md`.
2. **Remove the "And N more on the dashboard" line** from the digest (the v5 renderer). Maintainer: "nobody cares … we should only surface issues that can be actioned on".
3. **Incidents that `publishable()` refuses leave the digest** (no validated diagnosis, a PR status with no URL, filler root cause). They stay on the dashboard.
4. **An infrastructure failure during validation fails publication.** The scheduler retries the run. There is no "showing receipts instead" alert.
5. **Why fix.** Error candidates carry `why` = their root cause, and the prompt says to write `why` whenever one is supplied.
6. **No hardcoded title sanitizer.** The prompt already bans error text in cards: prod had 0 of 69 cached titles with a minified prefix.
7. **The OFF lane is unchanged.** Renderers v1–v4 are unchanged. "Don't optimize too much."

### Revised acceptance criteria

- AC1: A card that fails its checks, or that the writer defers, never renders. An incident that cannot earn a card never renders.
- AC2: The v5 Slack digest has no overflow line and no receipt-derived card.
- AC3: A database error during ON validation leaves the run `failed` with no outbox event. Today the digest ships receipts in that case.
- AC4: An error candidate with a validated root cause freezes with `why` equal to that root cause. With a stub writer's card, it publishes a card whose Slack text contains a `Why:` line (Go integration test).
- AC5: A run whose cards were all held back commits `delivered` with its ledger and writes no `digest.daily` outbox event. That means no Slack message claiming "No known problems need attention today" while incidents wait.

## Global Constraints

- DB-gated Go and Vitest suites skip without `DATABASE_URL`. Before trusting a green run, export the worktree variable block from root `AGENTS.md` (Compose Postgres on a free port) and confirm **zero skips**.
- No migration. `render_mode`'s CHECK keeps `'receipt_fallback'` for historical rows. `primary_reason_code` has no CHECK constraint, so the new code needs only Go's `knownReasonCodes`.
- Do not bump `DIGEST_PROMPT_VERSION` (worker, 7) or `digestPromptVersion` (Go). The `why` input is not part of the card fingerprint, and cached error cards already carry `why` (Go's validator has always required it for diagnosed cards).
- Keep the worker's `notCardEligible`/`receiptOnly` path. Runs frozen by the old ingestion before deploy still carry that flag, and authoring those candidates would ship cards the new validator no longer re-checks for eligibility.
- Leave `notify.ReceiptItem.FallbackReason`, `notify.ReceiptFallbackNeverEligible`, `toReceiptItems`, and the OFF actionable lane alone. The v4 renderer and pre-existing OFF runs still use them.
- Deploy ingestion before the worker: the new prompt assumes candidates carry `why`.
- TypeScript: strict ESM, `unknown` + narrowing, no `any`. Tests colocated in `__tests__`.
- Commits: git identity `abhishek@opslane.com`. Every commit message ends with `Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9`.

### Test environment (all Go DB tasks)

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/digest-ships-cards-that-failed-their-checks-as-u
export INGESTION_PORT=8093 OPSLANE_POSTGRES_HOST_PORT=5445 OPSLANE_MINIO_HOST_PORT=9023
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT" REPLAY_STORE_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT" REPLAY_STORE_PUBLIC_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
docker compose -p opslane-holdback up -d postgres minio
# migrations apply on ingestion start; for package tests, testPool applies them (see digest/build_test.go testPool)
```

If `testPool` does not migrate, start ingestion once (`docker compose -p opslane-holdback up -d ingestion`) and then stop it. Pick other ports if these are taken.

---

## File Structure

| File | Change |
| --- | --- |
| `packages/ingestion/digest/freeze_friction.go` | Exclude never-eligible incidents; rank by impact only; set `Why` for non-ticket candidates; drop the never-eligible freeze-ledger branch |
| `packages/ingestion/digest/freeze.go` | Delete the `Candidate.NotCardEligible` field |
| `packages/ingestion/digest/actionable.go` | Delete `selectOnCardEligibleFirst`; add `reasonCardHeldBack` to the constants and `knownReasonCodes` |
| `packages/ingestion/digest/validate.go` | Hold back instead of receipt fallback; infrastructure errors return; all-held-back sends nothing; delete the degrade machinery and receipt helpers used only by ON |
| `packages/ingestion/notify/slack_digest_v5.go` | Render `GeneratedCards` only; no overflow line |
| `packages/worker/src/digest-writer/job.ts` | Prompt `why` sentence; comments that promise a receipt |
| `packages/worker/src/digest-writer/schema.ts` | Comments that promise a receipt |
| Tests | `digest/oncard_test.go`, `digest/validate_unified_test.go`, `digest/validate_test.go`, `digest/cache_invalidation_test.go`, `digest/validate_actionable_test.go`, `digest/known_problems_integration_test.go`, `notify/slack_digest_v5_test.go`, `worker/src/__tests__/digest-writer.test.ts` |
| Docs | `docs/design/2026-08-27-unified-digest-cards.md` (R6 and the §"repeat contract outranks the writer" paragraph), `docs/design/2026-08-28-unified-cards-fixes.md` (note under the card-vs-receipt diagram) |

---

### Task 1: Freeze admits only card-eligible incidents, and error candidates carry `why`

**Files:**
- Modify: `packages/ingestion/digest/freeze_friction.go:15-131` (`selectOnCardCandidates`), `:156-252` (`writeUnifiedFreezeLedger`)
- Modify: `packages/ingestion/digest/freeze.go:81-91` (delete `NotCardEligible` and its comment)
- Modify: `packages/ingestion/digest/actionable.go:413-432` (delete `selectOnCardEligibleFirst`)
- Test: `packages/ingestion/digest/oncard_test.go`

**Interfaces:**
- Consumes: `actionablePublishable(actionableCandidate) bool`, `moreImpactfulActionable(left, right actionableCandidate) bool`, `takeWithOldestWaiter(eligible, ranked []actionableCandidate, limit int) ([]actionableCandidate, int)` (all in `actionable.go`)
- Produces: frozen `Candidate` values that are always card-eligible; `Candidate.Why` set to `RootCause` for non-ticket candidates; no `Candidate.NotCardEligible` field

- [ ] **Step 1: Write the failing tests** (append to `oncard_test.go`)

```go
func TestFreezeOnExcludesIncidentsThatCannotEarnACard(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	undiagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		false, "", "The submit handler is never wired to the control.", now.Add(-time.Hour))
	prWithoutURL := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "", "The save request never leaves the page.", now.Add(-2*time.Hour))
	diagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-3*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, diagnosed, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ErrorGroupID != diagnosed {
		t.Fatalf("frozen candidates = %+v, want only the diagnosed incident", candidates)
	}
	for _, groupID := range []string{undiagnosed, prWithoutURL} {
		var outcome, reason string
		if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code
			FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
			runID, groupID).Scan(&outcome, &reason); err != nil {
			t.Fatal(err)
		}
		if outcome != "excluded" || reason != reasonNotPublishable {
			t.Fatalf("ledger for %s = %s/%s, want excluded/%s", groupID, outcome, reason, reasonNotPublishable)
		}
	}
}

func TestFreezeOnGivesErrorCandidatesTheirRootCauseAsWhy(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	const rootCause = "The refresh call has no catch, so a rejected view refresh escapes."
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", rootCause, now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].Why != rootCause {
		t.Fatalf("frozen why = %q, want the validated root cause %q", candidates[0].Why, rootCause)
	}
}
```

- [ ] **Step 2: Run the tests and confirm both fail**

Run: `cd packages/ingestion && go test ./digest -run 'TestFreezeOnExcludesIncidentsThatCannotEarnACard|TestFreezeOnGivesErrorCandidatesTheirRootCauseAsWhy' -count=1 -v`
Expected: both FAIL. The first freezes 3 candidates; the second gets an empty `why`. If the output says `SKIP`, `DATABASE_URL` is not set; fix that first.

- [ ] **Step 3: Implement**

In `selectOnCardCandidates` (`freeze_friction.go`), after the `source.ActionableSince == nil` block and before `eligible = append(eligible, source)`:

```go
		if !actionablePublishable(source) {
			// Nothing a reader can act on yet: no validated cause, no PR to
			// open. It stays on the dashboard and never reaches the digest.
			excluded[source.GroupID] = reasonNotPublishable
			continue
		}
```

Replace `selected, _ := selectOnCardEligibleFirst(eligible, notify.DigestV4CardCap)` and the comment above it with:

```go
	// Every eligible incident can earn a card, so the cap ranks by impact and
	// still reserves one slot for the oldest waiting incident.
	ranked := append([]actionableCandidate(nil), eligible...)
	sort.SliceStable(ranked, func(i, j int) bool { return moreImpactfulActionable(ranked[i], ranked[j]) })
	selected, _ := takeWithOldestWaiter(eligible, ranked, notify.DigestV4CardCap)
```

In the `Candidate{...}` literal, delete `NotCardEligible: !actionablePublishable(source),`. After the `if f := source.TicketFacts; f != nil { ... }` block add:

```go
		if source.TicketFacts == nil {
			// The writer writes why only from a supplied why. A non-ticket
			// incident's cause is its root cause, the same source the worker's
			// grounding and checkUnifiedWrittenCard check the sentence against.
			candidate.Why = source.RootCause
		}
```

Rewrite the function's doc comment: every waiting incident that can earn a card becomes a candidate; an incident `publishable()` refuses is excluded as `not_publishable`.

In `writeUnifiedFreezeLedger`, delete the `if included && candidate.NotCardEligible { ... }` block together with the `renderMode` variable, the `renderModes` slice, and the `render_mode` column: remove `,render_mode` from the INSERT column list, `,($9::text[])[ids.ordinality]` from the SELECT, `,render_mode=EXCLUDED.render_mode` from the upsert, and the `renderModes` argument. Rewrite the function's doc comment so it no longer mentions `receipt_fallback`.

In `freeze.go`, delete the `NotCardEligible` field and its comment. In `actionable.go`, delete `selectOnCardEligibleFirst` and its doc comment.

- [ ] **Step 4: Fix the tests that pinned the old freeze**

Run `cd packages/ingestion && go vet ./digest` and fix every compile error caused by the deleted field or function. Known sites:
- `writeOnCardPayload` (`oncard_test.go:95`): delete the `if candidate.NotCardEligible { ... }` branch.
- `TestValidateOnRequiresACauseSentenceFromADiagnosedCard`: delete the `candidate.NotCardEligible` loop. Its receipt assertions change in Task 2; leave them for now.
- Delete `TestFreezeOnRanksCardEligibleIncidentsAboveReceiptOnlyOnes`, `TestValidateOnNeverEligibleRendersReceiptWithoutAuthoring`, its helper `neverEligibleRendersReceipt`, and `TestValidateOnCompactionReadsTodaysEligibility`. `TestFreezeOnExcludesIncidentsThatCannotEarnACard` replaces all of them.
- `TestFreezeOnCoversEveryStatusAndKind`, `TestFreezeOnSkipsAnActionableRowWithNoWaitingAge`: wherever they expect an undiagnosed or URL-less incident as a candidate or as a `receipt_fallback` ledger row, expect it excluded with `not_publishable`. Give the incidents the test needs as candidates a validated diagnosis (`seedValidatedDiagnosis`).
- Any test calling `selectOnCardEligibleFirst` directly (`grep -n selectOnCardEligibleFirst packages/ingestion/digest/*_test.go`): delete it.

- [ ] **Step 5: Run the freeze tests**

Run: `cd packages/ingestion && go test ./digest -run 'TestFreezeOn' -count=1`
Expected: PASS with no skips. Validation tests may still fail until Task 2; do not run them yet.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/digest/freeze_friction.go packages/ingestion/digest/freeze.go packages/ingestion/digest/actionable.go packages/ingestion/digest/oncard_test.go
git commit -m "fix(digest): freeze only incidents that can earn a card

Error candidates now carry their validated root cause as why, so the
writer's why rule reads from one field for every candidate.

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 2: Validation holds back failed cards and never ships receipts in ON

**Files:**
- Modify: `packages/ingestion/digest/validate.go` (lines cited as they are before this task)
- Modify: `packages/ingestion/digest/actionable.go:17-29,89-93`
- Test: `packages/ingestion/digest/validate_unified_test.go`, `validate_test.go`, `oncard_test.go`, `cache_invalidation_test.go`, `validate_actionable_test.go`, `known_problems_integration_test.go`

**Interfaces:**
- Consumes: Task 1's always-eligible candidates
- Produces: ledger rows `outcome='excluded', primary_reason_code='card_held_back', details.held_reason=<validation error or writer reason>`; the constant `reasonCardHeldBack = "card_held_back"`; ON payloads with `ReceiptItems` empty, `OverflowCount` 0, `ReceiptOverflow` 0, `DeliveryAlert` ""

- [ ] **Step 1: Write the failing tests** (append to `validate_unified_test.go`)

```go
func heldBackLedger(t *testing.T, pool *pgxpool.Pool, runID, groupID string) (outcome, reason, held string) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT outcome,primary_reason_code,
		COALESCE(details->>'held_reason','') FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, runID, groupID).Scan(&outcome, &reason, &held); err != nil {
		t.Fatal(err)
	}
	return outcome, reason, held
}

func digestOutboxEvents(t *testing.T, pool *pgxpool.Pool, projectID, runID string) int {
	t.Helper()
	var events int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbound_events
		WHERE project_id=$1 AND dedup_key=$2`, projectID, "digest.daily:"+projectID+":"+runID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	return events
}

func TestValidateOnHoldingBackEveryCardSendsNothing(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	writeUnifiedPayload(t, pool, runID, candidate, "People clicked save 987 times.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "delivered" {
		t.Fatalf("run status = %q, want delivered: a held-back day is finished, not retried", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0: nothing passed its checks", events)
	}
	outcome, reason, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID)
	if outcome != "excluded" || reason != reasonCardHeldBack || held == "" {
		t.Fatalf("ledger = %s/%s/%q, want excluded/%s with a held reason", outcome, reason, held, reasonCardHeldBack)
	}
}

func TestValidateOnHoldsBackTheWriterDeferral(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	const reason = "card check: ungrounded number 99 in card for the incident"
	encoded, err := json.Marshal(writtenDigestPayload{Deferred: []deferredDigestItem{{
		ErrorGroupID: candidate.ErrorGroupID, Reason: reason,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 0 {
		t.Fatalf("deferred card shipped: cards=%+v receipts=%+v", payload.GeneratedCards, payload.ReceiptItems)
	}
	outcome, code, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID)
	if outcome != "excluded" || code != reasonCardHeldBack || held != reason {
		t.Fatalf("ledger = %s/%s/%q, want excluded/%s/%q", outcome, code, held, reasonCardHeldBack, reason)
	}
}

func TestValidateOnFailsTheRunWhenTheLiveReloadFails(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-2*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	writeOnCardPayload(t, pool, runID, candidates)

	restore := loadActionableCandidatesForValidation
	loadActionableCandidatesForValidation = func(context.Context, pgx.Tx, string, actionableStatusSet, time.Time) ([]actionableCandidate, error) {
		return nil, errors.New("injected actionable reload failure")
	}
	t.Cleanup(func() { loadActionableCandidatesForValidation = restore })

	if err := ValidateAndPublish(ctx, pool, runID); err == nil {
		t.Fatal("ValidateAndPublish succeeded, want the run to fail so the scheduler retries it")
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("run status = %q, want failed", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/ingestion && go test ./digest -run 'TestValidateOnHoldingBackEveryCardSendsNothing|TestValidateOnHoldsBackTheWriterDeferral|TestValidateOnFailsTheRunWhenTheLiveReloadFails' -count=1 -v`
Expected: all three FAIL; they don't compile until `reasonCardHeldBack` exists. That is the expected first failure.

- [ ] **Step 3: Add the reason code** (`actionable.go`)

In the first `const` block add:

```go
	// reasonCardHeldBack marks a card that failed its checks, or that the
	// writer deferred, at validation. The incident stays on the dashboard and
	// is re-frozen tomorrow; the digest never ships a receipt in its place.
	reasonCardHeldBack = "card_held_back"
```

Append `reasonCardHeldBack` to `knownReasonCodes`.

- [ ] **Step 4: Implement hold-back in `validateAndPublish`** (`validate.go`)

Make these edits in order. Line numbers refer to the file before this task.

4a. Delete the ON card-section savepoint and degrade machinery: the `unifiedSavepointOpen`, `unifiedDegraded`, and `unifiedDeliveryAlert` variables, the `SAVEPOINT unified_card_section` exec, and the `rollbackUnified` closure (`:634-655`). Replace `receiptReasons` (`:658-661`) with:

```go
	// Why a card-eligible incident was held back: the validation error, or the
	// writer's own deferral reason. Stored as details.held_reason in the ledger.
	heldReasons := make(map[string]string, len(candidates))
```

4b. Replace the ON branch of the included-card loop (`:676-726`, from `if run.Mode != UnifiedCardsOff {` through its closing `continue }`) with:

```go
		if run.Mode != UnifiedCardsOff {
			validated, mode, validationErr := validateUnifiedWrittenCard(ctx, tx, run, card, candidate)
			if validationErr != nil {
				var infrastructureError unifiedInfrastructureError
				if errors.As(validationErr, &infrastructureError) {
					// A database failure says nothing about the card. Failing the
					// run lets the scheduler retry it; publishing now would ship a
					// partial digest that looks complete.
					return fmt.Errorf("validate digest card %s: %w", identity, validationErr)
				}
				slog.Warn("digest card held back", "diagnostic", "card_held_back", "run_id", runID,
					"error_group_id", candidate.ErrorGroupID, "error", validationErr)
				accounted[identity] = "deferred"
				var changedError unifiedCandidateChangedError
				if (candidate.SpellStartedAt == nil || candidate.TicketID != "") && errors.As(validationErr, &changedError) {
					excludedReasons[identity] = reasonNotPublishable
					continue
				}
				excludedReasons[identity] = reasonCardHeldBack
				heldReasons[identity] = validationErr.Error()
				continue
			}
			card = validated
			renderModes[identity] = mode
			// ... keep the existing replayURL + generated = append(...) + continue unchanged ...
		}
```

(Keep the existing `replayURL := …` / `generated = append(generated, notify.GeneratedDigestCard{…})` / `continue` lines exactly as they are. Only the error handling and the `unifiedDegraded` short-circuit change.)

4c. In the deferred loop (`:831-839`), replace the `if run.Mode != UnifiedCardsOff { renderModes…; receiptReasons… }` block with:

```go
		if run.Mode != UnifiedCardsOff {
			excludedReasons[identity] = reasonCardHeldBack
			heldReasons[identity] = strings.TrimSpace(item.Reason)
		}
```

4d. In the unaccounted-candidate loop (`:841-851`), replace the ON branch with:

```go
			if run.Mode != UnifiedCardsOff {
				accounted[identity] = "deferred"
				excludedReasons[identity] = reasonCardHeldBack
				heldReasons[identity] = "the writer did not account for this incident"
				continue
			}
```

4e. Delete the `if unifiedDegraded { kept := generated[:0] … }` block (`:852-865`).

4f. Restructure the actionable section (`:886-1061`) so that ON loads only the live rows it still needs (ticket action re-checks and the held-back reason correction below) and never builds receipts:

```go
	receiptItems := []notify.ReceiptItem(nil)
	receiptOverflow := 0
	deliveryAlert := ""
	var actionableEvaluatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
		return fmt.Errorf("load actionable evaluation clock: %w", err)
	}
	actionableByGroup := make(map[string]actionableCandidate)
	if run.Mode == UnifiedCardsOn {
		live, err := loadActionableCandidatesForValidation(ctx, tx, run.ProjectID, onCardStatusSQL, run.WindowTo)
		if err != nil {
			return fmt.Errorf("reload actionable digest candidates: %w", err)
		}
		for _, candidate := range live {
			actionableByGroup[candidate.GroupID] = candidate
		}
		// A held-back incident that stopped waiting, or was snoozed, since the
		// freeze is ledgered as that, not as a card failure.
		for identity, reason := range excludedReasons {
			if reason != reasonCardHeldBack {
				continue
			}
			current, ok := actionableByGroup[byIdentity[identity].ErrorGroupID]
			switch {
			case ok && current.SnoozedUntil != nil && current.SnoozedUntil.After(actionableEvaluatedAt):
				excludedReasons[identity] = reasonSnoozed
			case !ok:
				excludedReasons[identity] = reasonNotPublishable
			case current.ActionableSince == nil:
				excludedReasons[identity] = reasonMissingWaitingAge
			default:
				continue
			}
			delete(heldReasons, identity)
		}
	} else {
		// OFF: the existing actionable receipts lane, unchanged. Move the block
		// from `if _, err := tx.Exec(ctx, SAVEPOINT actionable_delivery)` through
		// `RELEASE SAVEPOINT actionable_delivery` here, deleting its two
		// `run.Mode == UnifiedCardsOn` sub-branches (the ON actionableEval gate and
		// the FallbackReason stamping), which are unreachable in OFF, and the
		// `if actionableErr != nil && run.Mode != UnifiedCardsOff { rollbackUnified }` tail.
	}
```

The OFF block currently declares its own `actionableEvaluatedAt`, `actionableByGroup`, `receiptItems`, `receiptOverflow`, and `deliveryAlert`. Remove those declarations inside the moved block so it assigns the outer variables. Keep the `actionableBaseReceipts` variable only if the OFF block still uses it after `rebuildUnifiedFallbacks` is deleted. If nothing reads it any more, delete it.

4g. Delete `rebuildUnifiedFallbacks` and its `if unifiedDegraded { … }` call (`:1062-1137`). Delete the `frozenOverflow` query block (`:1138-1152`) and leave `overflowCount` unchanged there. `baseOverflowCount, baseReceiptOverflow := overflowCount, receiptOverflow` stays.

4h. Replace the ledger finalize block (`:1176-1220`) with:

```go
	if run.Mode != UnifiedCardsOff {
		for _, candidate := range candidates {
			identity := candidateIdentity(candidate)
			renderMode := renderModes[identity]
			if renderMode == "" {
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations SET phase='validation',render_mode=$3,
				details=details || jsonb_build_object('validated_at',$4::text,'unified_cards_mode',$5::text)
				WHERE digest_run_id=$1 AND error_group_id=$2 AND outcome='included'`,
				runID, candidate.ErrorGroupID, renderMode,
				actionableEvaluatedAt.Format(time.RFC3339Nano), run.Mode); err != nil {
				return fmt.Errorf("finalize unified ledger for %s: %w", identity, err)
			}
		}
	}
```

4i. In the `if fresh { … }` block, delete the `keptReceipts` loop (`:1302-1321`): `fresh` implies ON, which now has no receipts.

4j. Replace the exclusion write (`:1324-1332`) with:

```go
	for identity, reason := range excludedReasons {
		if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations
			SET outcome='excluded',primary_reason_code=$3,phase='validation',
			    render_mode=NULL,
			    details=details || jsonb_strip_nulls(jsonb_build_object(
			      'validation_exclusion',$3::text,'held_reason',NULLIF($4::text,'')))
			WHERE digest_run_id=$1 AND error_group_id=$2`, runID, identity, reason, heldReasons[identity]); err != nil {
			return fmt.Errorf("store digest validation exclusion for %s: %w", identity, err)
		}
	}
```

4k. Before building `eventPayload`, zero the ON overflow counts and compute whether everything was held back:

```go
	if run.Mode == UnifiedCardsOn {
		// A v5 digest shows what a reader can act on and nothing else.
		overflowCount, receiptOverflow = 0, 0
	}
	// Every card that could have shipped was held back. Sending now would tell
	// the reader nothing needs attention while incidents wait, so the run is
	// finished without a message. Committing (not failing) keeps the retirement
	// of rejected cached cards, which a rollback would undo every day.
	heldEverything := run.Mode == UnifiedCardsOn && len(generated) == 0 && len(heldReasons) > 0
```

4l. Wrap the outbox and deliveries writes (`:1406-1422`) in `if !heldEverything { … } else { slog.Warn("digest held back every card; nothing sent", "diagnostic", "digest_all_held_back", "run_id", runID, "project_id", run.ProjectID, "held", len(heldReasons)) }`. The `UPDATE digest_runs SET status='delivered',rendered_payload=…` and the commit stay unconditional.

4m. Delete the ON-only helpers and their comments: `cardCheckReasonPrefix`, `writerDemotedCard`, `liveFallbackReason`, `receiptForUnifiedFallback` (`:1433-1512`). Update the comment on `validateUnifiedWrittenCard` (`:220-223`) from "demotes its card to a receipt every day forever" to "holds its card back every day forever". Update the comment at `:275-279` from "hide the incident behind a receipt" to "hold the card back".

- [ ] **Step 5: Build and run the new tests**

Run: `cd packages/ingestion && go build ./... && go test ./digest -run 'TestValidateOnHoldingBackEveryCardSendsNothing|TestValidateOnHoldsBackTheWriterDeferral|TestValidateOnFailsTheRunWhenTheLiveReloadFails' -count=1 -v`
Expected: PASS.

- [ ] **Step 6: Flip the tests that pinned receipt fallback**

For each test below, keep the setup and replace the receipt assertions as stated:
- `validate_test.go` `assertFellBackToReceipt` → rename to `assertHeldBack`. Assert `len(payload.GeneratedCards)==0 && len(payload.ReceiptItems)==0`, and the ledger row is `excluded`/`card_held_back`. Update every caller. `unifiedLedger`: change its fourth return to read `COALESCE(details->>'held_reason','')` and rename it `heldReason`.
- `validate_unified_test.go`:
  - Delete `TestValidateOnDeliversFrozenReceiptsWhenTheLiveReloadFails`; `TestValidateOnFailsTheRunWhenTheLiveReloadFails` replaces it.
  - Delete `TestValidateUnifiedDigitSmuggleFallsBackPerCard`; `TestValidateOnHoldingBackEveryCardSendsNothing` replaces it.
  - Delete `TestValidateUnifiedKeepsTheWriterDeferralReason`; `TestValidateOnHoldsBackTheWriterDeferral` replaces it.
  - Delete `TestReceiptForUnifiedFallbackSanitizesLikeItsSibling`.
  - `TestValidateUnifiedLedgerFailureRollsBackCacheAndDeliversReceipts`: rename to `TestValidateUnifiedLedgerFailureFailsTheRun`. Assert `ValidateAndPublish` returns a non-nil error, `digest_runs.status='failed'`, `digestOutboxEvents(...)==0`, and keep its cache-rows==0 and phase=='freeze' assertions.
  - `TestValidateUnifiedGroundedDigitInCopyFallsBack`: assert the card is held back (`heldBackLedger` → `excluded`/`card_held_back`) and no receipts.
  - `TestValidateWriterFailureFallsBackForZeroDiagnosisFriction`: the zero-diagnosis incident is now excluded at freeze. Rewrite it to assert it is not frozen and is ledgered `not_publishable`, or delete it if `TestFreezeOnExcludesIncidentsThatCannotEarnACard` already covers its shape.
  - `TestValidateSnoozedUnifiedFallbackIsExcludedNotDelivered`: rename to `TestValidateSnoozedCandidateIsExcludedAsSnoozed` and keep its assertions (excluded/`snoozed`/`validation`).
- `oncard_test.go`:
  - `TestValidateOnRequiresACauseSentenceFromADiagnosedCard`: replace the receipts and `receipt_reason` assertions with `len(delivered.ReceiptItems)==0`, plus `heldBackLedger(t,pool,runID,diagnosed)` returning `excluded`, `card_held_back`, and a held reason containing `carries no cause sentence`.
  - `TestValidateOnRefusesACauseSentenceWithoutAStoredCause`: same flip, with a held reason containing `has no stored cause to answer to`.
  - `TestValidateOnKeepsAnIncidentWhoseAskChangedAfterFreeze`: rename to `TestValidateOnHoldsBackACardWhoseAskChangedAfterFreeze`. The incident is not delivered, and the ledger is `excluded`/`card_held_back`.
  - `TestFreezeOnCapsAtTheRendererLimitAndRendersOverflow`: rename to `TestFreezeOnCapsAtTheRendererLimit`. Delete the payload-overflow assertion, replace `strings.Contains(body, "And 3 more on the dashboard")` with `!strings.Contains(string(body), "more on the dashboard")` (failing with "Slack message still carries an overflow line"), and keep the block-count and capped-ledger assertions.
  - `TestValidateOnPRCardRepeatsFromCache`, `TestValidateOnWritesNoPublicationsForAnyStatus`: remove any expectation of receipt items. Candidates without a URL or diagnosis are no longer frozen, so seed what the test needs as card-eligible.
- `cache_invalidation_test.go` `TestValidateInvalidatesRejectedCachedRow` and `TestValidateGroundsCachedCardTitleAgainstMovedCounts`: replace receipt expectations with held-back ledger expectations, and **keep** the assertion that the rejected `digest_card_copy` row has `invalidated_at` set. That assertion proves the all-held-back run commits.
- `validate_actionable_test.go` `TestActionableReceiptFallsBackToAPreSpellRecording`: if the run is ON (frozen via `FreezeCandidates`), the receipt-replay enrichment it pins no longer exists in ON; delete the test. If it drives an OFF run, leave it.
- `known_problems_integration_test.go` `TestTicketDigestValidatesAtFrozenEvaluationTime`: replace ticket-receipt expectations with held-back ledger expectations (`card_held_back`, or `not_publishable` where the ticket left the card state).

- [ ] **Step 7: Run the whole ingestion suite**

Run: `cd packages/ingestion && go build ./... && go vet ./... && go test ./... -count=1 2>&1 | tee /tmp/claude-1000/holdback-go-test.txt; grep -c -- '--- SKIP' /tmp/claude-1000/holdback-go-test.txt`
Expected: every package `ok`; the SKIP count is 0.

- [ ] **Step 8: Commit**

```bash
git add packages/ingestion/digest
git commit -m "fix(digest): hold back cards that fail their checks

A card that fails validation or that the writer defers is ledgered
card_held_back instead of shipping as a mechanical receipt. An
infrastructure error fails the run so the scheduler retries it, and a
run whose cards were all held back finishes without a message.

Supersedes R6 of the unified digest cards design (#496).

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 3: The v5 renderer shows cards only

**Files:**
- Modify: `packages/ingestion/notify/slack_digest_v5.go:11-99`
- Test: `packages/ingestion/notify/slack_digest_v5_test.go`

**Interfaces:**
- Consumes: `DigestPayload.GeneratedCards` (Task 2 guarantees ON payloads have no receipts)
- Produces: a v5 Slack body with no receipt-derived cards and no overflow context block

- [ ] **Step 1: Write the failing test** (append to `slack_digest_v5_test.go`)

```go
func TestKnownProblemsDigestShowsOnlyCards(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project:      ProjectRef{ID: "project", Name: "Shop"},
		DashboardURL: "https://app.example.com",
		Digest: &DigestPayload{
			SchemaVersion: 5, Date: "2026-09-14",
			GeneratedCards: []GeneratedDigestCard{{IncidentID: "card", Kind: "error", Title: "Saving is blocked",
				Copy: "People cannot save their work.", Why: "The submit handler is never wired.",
				AffectedUsers: 2, OccurrenceCount: 17}},
			ReceiptItems: []ReceiptItem{{IncidentID: "receipt", Kind: "error",
				Title: "e: this resource's view is not refreshable.", RootCauseExcerpt: "forge-adapter refresh has no catch"}},
			OverflowCount: 3, ReceiptOverflow: 2,
		},
	}
	body, _, err := formatSlackDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "Why: The submit handler is never wired.") {
		t.Fatalf("card lost its why line: %s", text)
	}
	for _, banned := range []string{"not refreshable", "forge-adapter", "more on the dashboard"} {
		if strings.Contains(text, banned) {
			t.Fatalf("v5 digest rendered %q: %s", banned, text)
		}
	}
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/ingestion && go test ./notify -run TestKnownProblemsDigestShowsOnlyCards -count=1 -v`
Expected: FAIL on `not refreshable`.

- [ ] **Step 3: Implement**

In `formatSlackDigestV5`, replace `cards := append([]GeneratedDigestCard(nil), d.GeneratedCards...)` and the whole `for _, r := range d.ReceiptItems { … }` loop with `cards := d.GeneratedCards`. Delete the overflow block:

```go
	overflow := max(d.OverflowCount+d.ReceiptOverflow, len(cards)-DigestV4CardCap)
	if overflow > 0 {
		blocks = append(blocks, digestContextBlock(fmt.Sprintf("And %d more on the dashboard", overflow)))
	}
```

Change the doc comment to: `// formatSlackDigestV5 is the known-problems list: only cards that passed their checks, one template and one primary action each. Receipts and overflow counts in the payload are ignored.` Remove `fmt` or `strconv` imports only if they become unused.

- [ ] **Step 4: Fix the v5 test that built a receipt**

In `TestKnownProblemsDigestFixInProgressIsNotAButton`, move the `ReceiptItems` entry (`IncidentID: "receipt", TicketID: "ticket-2", … Action: "Fix in progress"`) into `GeneratedCards` as a `GeneratedDigestCard` with the same fields, and adjust any index-based assertion. Run `go test ./notify -count=1`. If any other v5 (`SchemaVersion: 5`) test expects receipts or an overflow line, flip it the same way. Leave v4 tests (`SchemaVersion: 4` or `renderV4`) untouched.

- [ ] **Step 5: Run the notify suite**

Run: `cd packages/ingestion && go test ./notify -count=1`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add packages/ingestion/notify/slack_digest_v5.go packages/ingestion/notify/slack_digest_v5_test.go
git commit -m "fix(notify): v5 digest renders cards only, no overflow line

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 4: The writer prompt demands `why` whenever one is supplied

**Files:**
- Modify: `packages/worker/src/digest-writer/job.ts:80-83,241-248,261-263,276-283,290-293,548`
- Modify: `packages/worker/src/digest-writer/schema.ts:105-107,118-119,286-289`
- Test: `packages/worker/src/__tests__/digest-writer.test.ts`

**Interfaces:**
- Consumes: Task 1's frozen `why` on non-ticket candidates (`DigestCandidate.why?: string`, already declared)
- Produces: `DIGEST_SYSTEM_PROMPT` containing `When a candidate supplies why, the card must include why`

- [ ] **Step 1: Write the failing tests**

Add `groundPayload` to the existing import from `'../digest-writer/job.js'`. Extend `'publishes the prompt v7 prose-only contract'` by adding `'When a candidate supplies why, the card must include why'` to its phrase list. Add:

```ts
  it('keeps an error card that writes why and holds back one that omits a supplied why', () => {
    const errorCandidate = candidate(1, {
      promptVersion: 7,
      rootCause: 'The refresh call has no catch.',
      why: 'The refresh call has no catch.',
    });
    const card = {
      errorGroupId: errorCandidate.errorGroupId,
      title: 'Refreshing a view fails',
      copy: 'People see an error when they refresh a view.',
    };
    const kept = groundPayload({ included: [{ ...card, why: 'A rejected refresh is never caught.' }], deferred: [] },
      [errorCandidate]);
    expect(kept.included[0]?.why).toBe('A rejected refresh is never caught.');
    const held = groundPayload({ included: [card], deferred: [] }, [errorCandidate]);
    expect(held.included).toHaveLength(0);
    expect(held.deferred[0]?.reason).toMatch(/^card check: why must match qualified cause availability/);
  });
```

- [ ] **Step 2: Run them and confirm the prompt test fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/digest-writer.test.ts`
Expected: the prompt-contract test FAILS on the missing phrase. The grounding test already passes; it pins current behavior the prompt must match.

- [ ] **Step 3: Implement**

Replace prompt line `job.ts:548` with:

```
Write why (under 300 characters) only from the candidate's supplied why, and never invent causes. When a candidate supplies why, the card must include why; omit why only when no why is supplied. A ticket needs coverage at least 0.5 before its why counts; below that, omit why.
```

Update the comments that promise a receipt so they describe hold-back:
- `job.ts:80-83` (`notCardEligible`): "Set only by ingestion builds before #496, which froze such incidents. The writer still defers them without a model call; validation holds them back."
- `job.ts:241-248`: "…deferring holds this card back from today's digest and leaves its siblings alone." Log message: `'digest card failed a factual check and was held back'`.
- `job.ts:261-263`: "A card the parser rejected is deferred, so validation holds it back instead of the run failing."
- `job.ts:276-283`: "Deferring holds that incident back; failing the run would drop every sibling card too."
- `job.ts:290-293` (`CARD_CHECK_REASON_PREFIX`): "The prefix a demoted card's deferral reason carries. Validation stores it as the ledger's held_reason."
- `schema.ts:105-107`: "The deferral reason a structurally unusable card carries; validation holds the incident back."
- `schema.ts:118-119`: "…accounts for them as deferred, so the card is held back; rejection never fails the run."
- `schema.ts:286-289`: comment "Scoped to this card: its siblings still deliver and this incident is held back." Warning message: `` `included[${index}] card rejected; holding it back` ``.

If a test asserts the old log or warning text (`grep -n "fell back to its receipt\|delivering its receipt instead" packages/worker/src/__tests__/*.ts`), update it to the new text.

- [ ] **Step 4: Run the worker checks**

Run: `pnpm --filter @opslane/worker build && pnpm --filter @opslane/worker exec vitest run src/__tests__/digest-writer.test.ts src/__tests__/digest-writer-metering.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/digest-writer/job.ts packages/worker/src/digest-writer/schema.ts packages/worker/src/__tests__/digest-writer.test.ts
git commit -m "fix(worker): digest writer writes why whenever one is supplied

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 5: End-to-end proof that a diagnosed error card ships a `Why:` line (AC4)

**Files:**
- Test: `packages/ingestion/digest/oncard_test.go`

**Interfaces:**
- Consumes: Tasks 1–3 (`FreezeCandidates` sets `Why`, validation publishes, the v5 renderer prints `Why:`); `writeOnCardPayload` (stub writer: its cards carry `Why: "The submit handler is never wired to the control."`)

- [ ] **Step 1: Write the test**

```go
func TestDigestErrorCardWithValidatedRootCauseShipsAWhyLine(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	const rootCause = "The submit handler is never wired to the control."
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", rootCause, now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	if candidates[0].Why != rootCause {
		t.Fatalf("frozen why = %q, want %q", candidates[0].Why, rootCause)
	}
	// Stub writer: the card a writer following the prompt returns for this candidate.
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID)
	if payload.Digest.SchemaVersion != 5 || len(payload.Digest.GeneratedCards) != 1 || payload.Digest.GeneratedCards[0].Why == "" {
		t.Fatalf("published digest = %+v, want one v5 card with a why", payload.Digest)
	}
	body, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "Why: The submit handler is never wired to the control.") {
		t.Fatalf("Slack digest has no Why line: %s", body)
	}
}
```

- [ ] **Step 2: Run it**

Run: `cd packages/ingestion && go test ./digest -run TestDigestErrorCardWithValidatedRootCauseShipsAWhyLine -count=1 -v`
Expected: PASS. If it fails because `SchemaVersion` is 4, the candidate's `PromptVersion` is below 7. Check `digestPromptVersion` rather than weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/ingestion/digest/oncard_test.go
git commit -m "test(digest): diagnosed error card ships a Why line end to end

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 6: Record the superseded contract in the design docs

**Files:**
- Modify: `docs/design/2026-08-27-unified-digest-cards.md:86,191-195`
- Modify: `docs/design/2026-08-28-unified-cards-fixes.md` (below the mermaid diagram that contains `receipt_fallback`, around `:68`)

- [ ] **Step 1: Edit R6**

Replace the R6 row's requirement cell with `~~Writer failure or budget exhaustion for one candidate never suppresses that incident~~ **Superseded 2026-09-14 (#496):** a card that fails its checks, or that the writer defers, is held back from that day's digest and ledgered \`card_held_back\`; an incident that cannot earn a card is excluded at freeze (\`not_publishable\`). The digest never ships a receipt in place of a card.` Replace its verification cell with `Integration tests: TestValidateOnHoldingBackEveryCardSendsNothing, TestValidateOnHoldsBackTheWriterDeferral, TestFreezeOnExcludesIncidentsThatCannotEarnACard`.

- [ ] **Step 2: Edit the paragraph**

At the start of the paragraph beginning "The repeat contract outranks the writer" (`:191`), insert: `**Superseded 2026-09-14 (#496):** failed and deferred cards are held back rather than falling back to receipts, a validation infrastructure failure fails the run for the scheduler to retry, and the v5 digest has no overflow line. The original text follows.` Add the same one-line note after the paragraph that introduces `receipt_fallback` for never-eligible candidates (`:195`).

- [ ] **Step 3: Edit the fixes doc**

Directly below the mermaid block in `2026-08-28-unified-cards-fixes.md` that ends in `receipt_fallback`, add: `> Superseded 2026-09-14 (#496): the "no" branch now excludes the incident at freeze (\`not_publishable\`); no mechanical receipt ships.`

- [ ] **Step 4: Commit**

```bash
git add docs/design/2026-08-27-unified-digest-cards.md docs/design/2026-08-28-unified-cards-fixes.md
git commit -m "docs(digest): record that failed cards are held back (#496)

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 7: Repository gate

- [ ] **Step 1: Run the full gate with the test environment exported**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test 2>&1 | tee /tmp/claude-1000/holdback-pnpm-test.txt
(cd packages/ingestion && go build ./... && go test ./... -count=1 2>&1 | tee /tmp/claude-1000/holdback-go-gate.txt)
docker compose config --quiet
```

Expected: all green. `grep -c -- '--- SKIP' /tmp/claude-1000/holdback-go-gate.txt` prints `0`. Read the Vitest summary's skipped count: DB-gated worker suites must not be skipped.

- [ ] **Step 2: Live digest smoke** (pipeline change: root `AGENTS.md`)

Rebuild the ingestion and worker images (`docker compose -p opslane-holdback up -d --build ingestion worker`), apply `scripts/seed-e2e.sql`, and seed one card-eligible error incident plus one undiagnosed incident in a project with a `digest.daily` webhook sink. Force a freeze and write, then confirm:
- (a) the delivered Slack body contains the eligible card with a `Why:` line, the undiagnosed incident is absent, and there is no "more on the dashboard";
- (b) `digest_run_candidate_evaluations` shows the undiagnosed incident as `excluded`/`not_publishable`.

`/verify` owns the detailed recipe; see memory `digest-v4-verify-rig` for the in-network sink technique.

---

## Self-Review

- **Spec coverage:** D1 → Task 2 (4b–4d, 4j) and Task 6. D2 → Task 3, plus 4k zeroing counts. D3 → Task 1. D4 → Task 2 (4b, 4f, 4h). D5 → Task 1 (`Why`) and Task 4 (prompt). D6 → no task, by decision. D7 → constraints and Task 2 4f (OFF block moved unchanged). AC1–AC5 → the tests named in Tasks 1, 2, 3, and 5.
- **Derived decision to review:** AC5 (an all-held-back run commits and sends nothing) was not asked explicitly. It follows from D1 and D2: the only alternatives are a false "No known problems need attention today" message, or a failed run whose rollback un-retires rejected cached cards.
- **Type consistency:** `reasonCardHeldBack`, `heldReasons`, `heldBackLedger`, `digestOutboxEvents`, and `assertHeldBack` are defined before use. `writeOnCardPayload`'s `Why` text matches Task 5's expected line.
