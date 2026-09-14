# Digest Holds Back Failed Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The unified (ON) daily digest sends only cards that passed their checks. It never sends a mechanical receipt, an incident overflow line, or a message with no card in it.

**Architecture:** Freeze stops admitting incidents that `publishable()` refuses, and it gives error candidates an explicit `why`. Validation holds back every card that fails its checks or that the writer deferred, ledgering it as excluded with reason `card_held_back` instead of building a receipt. A database failure returns a retryable error, which leaves the run `written`, so the scheduler revalidates the same writer payload on its next tick. A run with no card to send finishes `delivered`, storing its zero-card payload, and writes no outbox event, so no Slack message goes out. The v5 Slack renderer drops the incident overflow line. The worker prompt tells the model to write `why` whenever one is supplied.

**Tech Stack:** Go 1.24 + pgx (`packages/ingestion`); Node 22 + TypeScript + Vitest (`packages/worker`).

**Spec:** GitHub issue #496, plus the decisions below from a grilling session with the maintainer on 2026-09-14. They override the issue's options and its acceptance criteria.

### Decisions (the spec)

1. **Hold back failed cards.** A card that fails validation, or that the writer defers for any reason (card check, unusable card, budget, "Redundant with…"), does not ship that day. This supersedes R6 in `docs/design/2026-08-27-unified-digest-cards.md`.
2. **Remove the "And N more on the dashboard" line.** Maintainer: "nobody cares … we should only surface issues that can be actioned on". The merged-PR footer is a separate element and stays.
3. **Incidents that `publishable()` refuses leave the digest** and stay on the dashboard. That means `publishable()` is false: a filler root cause; `pr_open`/`pr_draft` without a URL; `attempt_failed_with_diff` without a saved diff; `attempt_failed_no_diff`/`report_ready`/`awaiting_approval` without a validated diagnosis; any other state. A `needs_human` incident with a saved diff, or a PR status with a URL, stays eligible without a diagnosis.
4. **A database failure during validation does not ship a degraded digest.** The run is retried. There is no "showing receipts instead" alert.
5. **Why fix.** Error candidates carry `why` = their root cause, and the prompt says to write `why` whenever one is supplied.
6. **No hardcoded title sanitizer.** The prompt already bans error text in cards.
7. **The OFF lane and renderers v1–v4 are unchanged.** "Don't optimize too much." A card that fails every day is visible only in logs and the ledger; the maintainer accepted that risk, so there is no new SLA diagnostic.

**Derived (not asked; follows from 1–3, flag in the PR):** an ON run with zero cards to send sends **no message**. Today it sends "No known problems need attention today.", which is false once incidents can be held back or be ineligible.

### Acceptance criteria

- AC1: The ON digest payload never contains `receipt_items` and never counts incident overflow. A held-back or ineligible incident is absent from Slack, the read API, and MCP.
- AC2: The v5 Slack digest has no "And N more on the dashboard" incident overflow line.
- AC3: A database failure during ON validation returns an error and leaves the run `written`, with no outbox event. A second `ValidateAndPublish` on the same run succeeds with no new writer job.
- AC4: An error candidate with a validated root cause freezes with `why` equal to that root cause. With a stub writer's card, it publishes a card whose Slack text contains a `Why:` line.
- AC5: An ON run with no card to send ends `delivered` with a stored zero-card payload (so the read API and MCP show today's digest as empty rather than yesterday's cards), no `digest.daily` outbox event, and a complete ledger. A rejected cached card is still retired, because the transaction commits.
- AC6: With one card valid and one failing, the valid card ships, one outbox event is written, and only the failing incident is `card_held_back`.

## Global Constraints

- DB-gated Go and Vitest suites **skip** without `DATABASE_URL`, and `testPool` does **not** migrate. Export the environment below, start ingestion once so it applies migrations, and require **zero skips** (see Task 6 for the exact skip count).
- No migration. `render_mode`'s CHECK keeps `'receipt_fallback'` for historical rows. `primary_reason_code` has no CHECK. `digest_runs.status` stays within `frozen|written|validated|delivered|failed`.
- Do not bump `DIGEST_PROMPT_VERSION` (worker, 7) or `digestPromptVersion` (Go). The frozen `why` is not in the card fingerprint, and cached error cards already carry `why`.
- Keep the worker's `notCardEligible`/`receiptOnly` path: runs frozen by the old ingestion still carry that flag. Keep the prompt clause that makes `rootCause` the source of `why` for a non-ticket snapshot without `why`.
- Leave `notify.ReceiptItem.FallbackReason`, `notify.ReceiptFallbackNeverEligible`, `toReceiptItems`, `evaluateActionable`, `writeActionableLedger`, and `reconcileActionable` in place; the OFF lane uses them. Keep the v5 renderer's receipt loop for outbox events written before this deploy.
- Deploy ingestion before the worker.
- TypeScript: strict ESM, `unknown` + narrowing, no `any`. Tests colocated in `__tests__`.
- Commits: git identity `abhishek@opslane.com`. Every commit message ends with `Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9`.

### Test environment

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/digest-ships-cards-that-failed-their-checks-as-u
export INGESTION_PORT=8093 OPSLANE_POSTGRES_HOST_PORT=5445 OPSLANE_MINIO_HOST_PORT=9023
export INGESTION_URL="http://localhost:$INGESTION_PORT"
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:$OPSLANE_POSTGRES_HOST_PORT/opslane?sslmode=disable"
export MINIO_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT" REPLAY_STORE_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT" REPLAY_STORE_PUBLIC_ENDPOINT="http://localhost:$OPSLANE_MINIO_HOST_PORT"
export MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio12345 MINIO_BUCKET=opslane-replays
export REPLAY_STORE_ACCESS_KEY=minio REPLAY_STORE_SECRET_KEY=minio12345 REPLAY_STORE_BUCKET=opslane-replays
docker compose -p opslane-holdback up -d --build postgres minio ingestion   # ingestion start applies migrations
```

Pick other ports if these are taken, and re-export the whole block.

---

## File Structure

| File | Change |
| --- | --- |
| `packages/ingestion/digest/freeze_friction.go` | Exclude ineligible incidents; select with `selectActionable`; set `Why` for non-ticket candidates; drop the never-eligible freeze-ledger branch |
| `packages/ingestion/digest/freeze.go` | Delete `Candidate.NotCardEligible` |
| `packages/ingestion/digest/actionable.go` | Delete `selectOnCardEligibleFirst`; add `reasonCardHeldBack` |
| `packages/ingestion/digest/validate.go` | Hold back instead of receipts in ON; retryable infrastructure errors; nothing-to-send completion; delete ON degrade machinery and ON-only receipt helpers |
| `packages/ingestion/notify/slack_digest_v5.go` | Delete the incident overflow line |
| `packages/worker/src/digest-writer/job.ts`, `schema.ts` | Prompt `why` sentence; comments that promise a receipt |
| Go tests | `digest/oncard_test.go`, `validate_unified_test.go`, `validate_test.go`, `validate_actionable_test.go`, `cache_invalidation_test.go`, `known_problems_integration_test.go`, `notify/slack_digest_v5_test.go` |
| Worker tests | `worker/src/__tests__/digest-writer.test.ts` |
| Docs | `docs/design/2026-08-27-unified-digest-cards.md`, `docs/design/2026-08-28-unified-cards-fixes.md` |

---

### Task 1: Freeze admits only card-eligible incidents; validation holds back failed cards

Freeze and validation change together in one commit. The freeze change alone breaks validation tests that rely on receipts, and the deleted `NotCardEligible` field is also written in `validate.go`.

**Files:**
- Modify: `packages/ingestion/digest/freeze_friction.go`, `freeze.go`, `actionable.go`, `validate.go`
- Test: `packages/ingestion/digest/oncard_test.go`, `validate_unified_test.go`, `validate_test.go`, `validate_actionable_test.go`, `cache_invalidation_test.go`, `known_problems_integration_test.go`

**Interfaces:**
- Consumes: `actionablePublishable(actionableCandidate) bool`; `selectActionable(eligible []actionableCandidate, limit int) ([]actionableCandidate, int)`; `loadActionableCandidatesForValidation` (test-injectable var); `TicketFacts.OnCard()`, `.Generation`, `.EvidenceVersion`
- Produces: `reasonCardHeldBack = "card_held_back"`; ledger `details.held_reason`; `retryableValidationError`; ON payloads with empty `ReceiptItems`, zero `OverflowCount`/`ReceiptOverflow`, empty `DeliveryAlert`; nothing-to-send runs that store their zero-card payload but write no outbox event

- [ ] **Step 1: Write the failing tests**

Append to `oncard_test.go`:

```go
func TestFreezeOnExcludesIncidentsThatCannotEarnACard(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	undiagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval",
		false, "", "The submit handler is never wired to the control.", now.Add(-time.Hour))
	prWithoutURL := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "", "The save request never leaves the page.", now.Add(-2*time.Hour))
	filler := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "TBD", now.Add(-3*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, filler, now.Add(-time.Hour))
	savedDiff := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "needs_human",
		true, "", "The export request never leaves the page.", now.Add(-4*time.Hour))
	prWithURL := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "pr_created",
		false, "https://github.com/acme/shop/pull/7", "The import request never leaves the page.", now.Add(-5*time.Hour))
	diagnosed := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-6*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, diagnosed, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	frozen := map[string]bool{}
	for _, candidate := range candidates {
		frozen[candidate.ErrorGroupID] = true
	}
	// A saved diff or an open PR is something to act on even without a
	// validated diagnosis; publishable() admits both.
	if len(candidates) != 3 || !frozen[diagnosed] || !frozen[savedDiff] || !frozen[prWithURL] {
		t.Fatalf("frozen candidates = %+v, want the diagnosed, saved-diff, and PR-with-URL incidents", candidates)
	}
	for _, groupID := range []string{undiagnosed, prWithoutURL, filler} {
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

Append to `validate_unified_test.go`:

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

// assertNothingSent pins the ON nothing-to-send completion: the run is
// finished, its stored digest is empty, and no message is queued.
func assertNothingSent(t *testing.T, pool *pgxpool.Pool, projectID, runID string) {
	t.Helper()
	if status := runStatus(t, pool, runID); status != "delivered" {
		t.Fatalf("run status = %q, want delivered", status)
	}
	stored := renderedEvent(t, pool, runID).Digest
	if len(stored.GeneratedCards) != 0 || len(stored.ReceiptItems) != 0 {
		t.Fatalf("stored digest cards=%+v receipts=%+v, want an empty digest", stored.GeneratedCards, stored.ReceiptItems)
	}
	if events := digestOutboxEvents(t, pool, projectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}
}

func runStatus(t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestValidateOnHoldingBackEveryCardSendsNothing(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	writeUnifiedPayload(t, pool, runID, candidate, "People clicked save 987 times.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	assertNothingSent(t, pool, fixture.ProjectID, runID)
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
	assertNothingSent(t, pool, fixture.ProjectID, runID)
	outcome, code, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID)
	if outcome != "excluded" || code != reasonCardHeldBack || held != reason {
		t.Fatalf("ledger = %s/%s/%q, want excluded/%s/%q", outcome, code, held, reasonCardHeldBack, reason)
	}
}

func TestValidateOnHoldsBackOneCardAndSendsItsSibling(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	good := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, good, now.Add(-time.Hour))
	bad := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The export request never leaves the page.", now.Add(-2*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, bad, now.Add(-time.Hour))
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	payload := writtenDigestPayload{Deferred: []deferredDigestItem{}}
	for _, candidate := range candidates {
		card := writtenDigestCard{ErrorGroupID: candidate.ErrorGroupID, Title: "Saving is blocked",
			Copy: "People cannot save because the control never submits.",
			Why:  "The submit handler is never wired to the control.",
			Action: "Take a look when you can.", Label: candidate.Label}
		if candidate.ErrorGroupID == bad {
			card.Copy = "People clicked save 987 times."
		}
		payload.Included = append(payload.Included, card)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE digest_runs SET status='written',writer_payload=$2::jsonb WHERE id=$1`,
		runID, encoded); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	delivered := renderedEvent(t, pool, runID).Digest
	if len(delivered.GeneratedCards) != 1 || delivered.GeneratedCards[0].IncidentID != good || len(delivered.ReceiptItems) != 0 {
		t.Fatalf("cards=%+v receipts=%+v, want only the valid card", delivered.GeneratedCards, delivered.ReceiptItems)
	}
	if delivered.OverflowCount != 0 || delivered.ReceiptOverflow != 0 || delivered.DeliveryAlert != "" {
		t.Fatalf("ON payload carries overflow or alert: %+v", delivered)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 1 {
		t.Fatalf("outbox events = %d, want 1", events)
	}
	if outcome, reason, _ := heldBackLedger(t, pool, runID, bad); outcome != "excluded" || reason != reasonCardHeldBack {
		t.Fatalf("failing card ledger = %s/%s", outcome, reason)
	}
	if outcome, reason, _ := heldBackLedger(t, pool, runID, good); outcome != "included" || reason != reasonIncluded {
		t.Fatalf("valid card ledger = %s/%s", outcome, reason)
	}
}

func TestValidateOnRetriesTheSameRunAfterAReloadFailure(t *testing.T) {
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
	t.Cleanup(func() { loadActionableCandidatesForValidation = restore })
	loadActionableCandidatesForValidation = func(context.Context, pgx.Tx, string, actionableStatusSet, time.Time) ([]actionableCandidate, error) {
		return nil, errors.New("injected actionable reload failure")
	}
	if err := ValidateAndPublish(ctx, pool, runID); err == nil {
		t.Fatal("ValidateAndPublish succeeded during a reload failure")
	}
	if status := runStatus(t, pool, runID); status != "written" {
		t.Fatalf("run status = %q, want written so the scheduler revalidates it", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}

	loadActionableCandidatesForValidation = restore
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatalf("retry after recovery: %v", err)
	}
	if cards := renderedEvent(t, pool, runID).Digest.GeneratedCards; len(cards) != 1 || cards[0].IncidentID != groupID {
		t.Fatalf("retried digest cards = %+v", cards)
	}
	var writes int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_jobs WHERE run_id=$1 AND job_type='digest_write'`,
		runID).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	if writes != 0 {
		t.Fatalf("digest_write jobs = %d, want 0: a database failure must not buy another model call", writes)
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/ingestion && go test ./digest -run 'TestFreezeOnExcludesIncidentsThatCannotEarnACard|TestFreezeOnGivesErrorCandidatesTheirRootCauseAsWhy|TestValidateOnHoldingBackEveryCardSendsNothing|TestValidateOnHoldsBackTheWriterDeferral|TestValidateOnHoldsBackOneCardAndSendsItsSibling|TestValidateOnRetriesTheSameRunAfterAReloadFailure' -count=1 -v`
Expected: build failure (`reasonCardHeldBack` undefined). That is the first expected failure. If any test prints `SKIP`, fix `DATABASE_URL` before going on.

- [ ] **Step 3: Freeze** (`freeze_friction.go`, `freeze.go`, `actionable.go`)

In `selectOnCardCandidates`, after the `source.ActionableSince == nil` block and before `eligible = append(eligible, source)`:

```go
		if !actionablePublishable(source) {
			// Nothing a reader can act on yet: no validated cause, no PR to
			// open. It stays on the dashboard and never reaches the digest.
			excluded[source.GroupID] = reasonNotPublishable
			continue
		}
```

Replace `selected, _ := selectOnCardEligibleFirst(eligible, notify.DigestV4CardCap)` and its comment with:

```go
	// Every eligible incident can earn a card, so the renderer's cap ranks by
	// impact and still reserves a slot for the oldest waiting incident.
	selected, _ := selectActionable(eligible, notify.DigestV4CardCap)
```

In the `Candidate{…}` literal, delete `NotCardEligible: !actionablePublishable(source),`. After the `if f := source.TicketFacts; f != nil { … }` block add:

```go
		if source.TicketFacts == nil {
			// The writer writes why only from a supplied why. A non-ticket
			// incident's cause is its root cause, the same source the worker's
			// grounding and checkUnifiedWrittenCard check the sentence against.
			candidate.Why = source.RootCause
		}
```

Rewrite the doc comment on `selectOnCardCandidates`: every waiting incident that `publishable()` accepts becomes a candidate, one it refuses is ledgered `not_publishable`, and nothing else removes an incident except a snooze, a missing waiting age, or the cap.

In `writeUnifiedFreezeLedger`, delete the `if included && candidate.NotCardEligible { … }` block, the `renderMode` variable, and the `renderModes` slice. Remove `,render_mode` from the INSERT column list, `,($9::text[])[ids.ordinality]` from the SELECT, `,render_mode=EXCLUDED.render_mode` from the upsert, and the `renderModes` argument. Rewrite the doc comment so it no longer mentions `receipt_fallback`.

In `freeze.go`, delete the `NotCardEligible` field and its comment. In `actionable.go`, delete `selectOnCardEligibleFirst` and its doc comment, and add to the first `const` block:

```go
	// reasonCardHeldBack marks a card that failed its checks, or that the
	// writer deferred, at validation. The incident stays on the dashboard and
	// is frozen again tomorrow; the digest never sends a receipt in its place.
	reasonCardHeldBack = "card_held_back"
```

Append `reasonCardHeldBack` to `knownReasonCodes`.

- [ ] **Step 4: Validation** (`validate.go`; line numbers are from before this task)

4a. Add below `unifiedCandidateChangedError`:

```go
// retryableValidationError marks a publication failure caused by the database,
// not by the digest. ValidateAndPublish leaves such a run 'written', so the
// scheduler's next tick validates the same writer payload again instead of
// buying a rewrite (a 'failed' run re-enqueues the writer).
type retryableValidationError struct{ err error }

func (e retryableValidationError) Error() string { return e.err.Error() }
func (e retryableValidationError) Unwrap() error { return e.err }
```

In `ValidateAndPublish` (`:151-164`), mark the run failed only for non-retryable errors:

```go
	err := validateAndPublish(ctx, pool, runID, key)
	var retryable retryableValidationError
	if err != nil && !errors.As(err, &retryable) {
		// Validation and transactional failures leave no publication side effects.
		// Marking failed separately lets the scheduler re-enqueue the same frozen run.
		_, _ = pool.Exec(ctx, `UPDATE digest_runs SET status='failed'
			WHERE id=$1 AND status NOT IN ('delivered')`, runID)
	}
	return err
```

4b. In `candidateStillUnified`, delete `current.NotCardEligible = !onCardEligible(…)` (`:486`). The fingerprint comparison is unaffected.

4c. Delete the ON card-section savepoint and degrade machinery (`:634-655`): the `unifiedSavepointOpen`, `unifiedDegraded`, and `unifiedDeliveryAlert` variables, the `SAVEPOINT unified_card_section` exec, and `rollbackUnified`. Replace `receiptReasons` (`:658-661`) with:

```go
	// Why a card-eligible incident was held back: the validation error or the
	// writer's own deferral reason. Stored as the ledger's details.held_reason.
	heldReasons := make(map[string]string, len(candidates))
```

4d. In the included-card loop, replace the error handling of the ON branch (`:676-702`, from `if run.Mode != UnifiedCardsOff {` through the `receiptReasons[identity] = "card_validation_failed"; continue }` block) with the code below. Keep everything after it unchanged: `card = validated`, `renderModes[identity] = mode`, `replayURL`, `generated = append(…)`, `continue`.

```go
		if run.Mode != UnifiedCardsOff {
			validated, mode, validationErr := validateUnifiedWrittenCard(ctx, tx, run, card, candidate)
			if validationErr != nil {
				var infrastructureError unifiedInfrastructureError
				if errors.As(validationErr, &infrastructureError) {
					return retryableValidationError{fmt.Errorf("validate digest card %s: %w", identity, validationErr)}
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
```

4e. In the deferred loop, replace the ON block (`:831-839`) with:

```go
		if run.Mode != UnifiedCardsOff {
			excludedReasons[identity] = reasonCardHeldBack
			heldReasons[identity] = strings.TrimSpace(item.Reason)
		}
```

In the unaccounted-candidate loop, replace the ON branch (`:844-848`) with:

```go
			if run.Mode != UnifiedCardsOff {
				accounted[identity] = "deferred"
				excludedReasons[identity] = reasonCardHeldBack
				heldReasons[identity] = "the writer did not account for this incident"
				continue
			}
```

Delete the `if unifiedDegraded { kept := generated[:0] … }` block (`:852-865`).

4f. Branch **before** the actionable section. Hoist these declarations above the branch (remove their inner declarations): `receiptItems []notify.ReceiptItem`, `receiptOverflow int`, `deliveryAlert string`, `actionableEvaluatedAt time.Time`, and `actionableByGroup := make(map[string]actionableCandidate)`. Then:

```go
	if run.Mode == UnifiedCardsOn {
		if err := tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&actionableEvaluatedAt); err != nil {
			return retryableValidationError{fmt.Errorf("load actionable evaluation clock: %w", err)}
		}
		live, err := loadActionableCandidatesForValidation(ctx, tx, run.ProjectID, onCardStatusSQL, run.WindowTo)
		if err != nil {
			return retryableValidationError{fmt.Errorf("reload actionable digest candidates: %w", err)}
		}
		for _, candidate := range live {
			actionableByGroup[candidate.GroupID] = candidate
		}
		// A held-back incident whose state moved since the freeze is ledgered as
		// that move, not as a card failure: card_held_back means the incident
		// is still waiting and still card-eligible, and only its card failed.
		for identity, reason := range excludedReasons {
			if reason != reasonCardHeldBack {
				continue
			}
			frozen := byIdentity[identity]
			current, ok := actionableByGroup[frozen.ErrorGroupID]
			switch {
			case !ok:
				excludedReasons[identity] = reasonNotPublishable
			case current.SnoozedUntil != nil && current.SnoozedUntil.After(actionableEvaluatedAt):
				excludedReasons[identity] = reasonSnoozed
			case current.ActionableSince == nil:
				excludedReasons[identity] = reasonMissingWaitingAge
			case frozen.TicketID != "" && (current.TicketFacts == nil || !current.TicketFacts.OnCard() ||
				current.TicketFacts.Generation != frozen.Generation || current.TicketFacts.EvidenceVersion != frozen.EvidenceVersion):
				excludedReasons[identity] = reasonNotPublishable
			case !actionablePublishable(current):
				excludedReasons[identity] = reasonNotPublishable
			default:
				continue
			}
			delete(heldReasons, identity)
		}
	} else {
		// OFF: the existing actionable receipts lane (`:891-1056` today), moved
		// here verbatim. Delete only the branches that were already unreachable in
		// OFF: the `if actionableErr == nil && run.Mode == UnifiedCardsOn { … }` gate
		// at `:919-952` (keep its `else if` body as a plain `if actionableErr == nil`),
		// the FallbackReason stamping `if run.Mode == UnifiedCardsOn { … }` at
		// `:1014-1020`, and the `if actionableErr != nil && run.Mode != UnifiedCardsOff`
		// rollback tail at `:1057-1061`. The clock query, savepoint, and degrade-to-
		// alert behavior stay byte-for-byte.
	}
```

4g. Delete `rebuildUnifiedFallbacks` and its `if unifiedDegraded { … }` call (`:1062-1137`), and the `frozenOverflow` query block (`:1138-1152`). If the OFF block's `actionableBaseReceipts` is now unread, delete it too; the compiler will say so.

4h. Replace the ledger finalize block and the savepoint release (`:1176-1220`) with:

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
				return retryableValidationError{fmt.Errorf("finalize unified ledger for %s: %w", identity, err)}
			}
		}
	}
```

4i. In the `if fresh { … }` block, delete the `keptReceipts` loop (`:1302-1321`): `fresh` implies ON, which has no receipts.

4j. Replace the exclusion write (`:1324-1332`) with:

```go
	for identity, reason := range excludedReasons {
		if _, err := tx.Exec(ctx, `UPDATE digest_run_candidate_evaluations
			SET outcome='excluded',primary_reason_code=$3,phase='validation',
			    render_mode=NULL,
			    details=details || jsonb_strip_nulls(jsonb_build_object(
			      'validation_exclusion',$3::text,'held_reason',NULLIF($4::text,'')))
			WHERE digest_run_id=$1 AND error_group_id=$2`, runID, identity, reason, heldReasons[identity]); err != nil {
			return retryableValidationError{fmt.Errorf("store digest validation exclusion for %s: %w", identity, err)}
		}
	}
```

4k. Nothing-to-send completion. Before `eventPayload := …`:

```go
	if run.Mode == UnifiedCardsOn {
		// A v5 digest shows what a reader can act on and nothing else.
		overflowCount, receiptOverflow = 0, 0
	}
	// With no card to send there is no message. The run still finishes, with its
	// ledger committed (so a rejected cached card stays retired) and its empty
	// payload stored, so the read API and MCP report today's digest as empty
	// instead of resurfacing yesterday's cards.
	send := run.Mode != UnifiedCardsOn || len(generated) > 0
	if !send {
		slog.Info("digest has no card to send", "diagnostic", "digest_nothing_to_send",
			"run_id", runID, "project_id", run.ProjectID, "held_back", len(heldReasons))
	}
```

Leave the `eventPayload` construction, `Validate()`, `json.Marshal`, the `for identity, outcome := range accounted` item loop, and the final `UPDATE digest_runs SET status='delivered',rendered_payload=$2::jsonb` unchanged. Wrap only the outbox insert, the deliveries insert, and the `deliveries.RowsAffected() == 0` no-destination check (`:1406-1422`) in `if send { … }`. Declare `var eventID string` inside that block.

4l. Delete the ON-only helpers and their comments: `cardCheckReasonPrefix`, `writerDemotedCard`, `liveFallbackReason`, `receiptForUnifiedFallback` (`:1433-1512`). Remove imports the compiler reports unused (`narrative`). Update the comment on `validateUnifiedWrittenCard` (`:220-223`): "demotes its card to a receipt every day forever" becomes "holds its card back every day forever". Update the comment at `:275-279`: "hide the incident behind a receipt" becomes "hold the card back".

- [ ] **Step 5: Build and run the new tests**

Run: `cd packages/ingestion && go build ./... && go vet ./digest && go test ./digest -run 'TestFreezeOnExcludesIncidentsThatCannotEarnACard|TestFreezeOnGivesErrorCandidatesTheirRootCauseAsWhy|TestValidateOnHoldingBackEveryCardSendsNothing|TestValidateOnHoldsBackTheWriterDeferral|TestValidateOnHoldsBackOneCardAndSendsItsSibling|TestValidateOnRetriesTheSameRunAfterAReloadFailure' -count=1 -v`
`go test ./digest -run …` compiles every test file in the package. Before running it, fix only the **compile errors** in existing tests: reads of `NotCardEligible`, and calls to `selectOnCardEligibleFirst`, `receiptForUnifiedFallback`, and `neverEligibleRendersReceipt`. Delete or stub exactly as Step 6 prescribes for those sites; behavioral rewrites follow in Step 6.
Expected: PASS, no SKIP.

- [ ] **Step 6: Rewrite the tests that pinned receipts or the old freeze**

Start with `grep -niE "receipt|overflow|NotCardEligible|selectOnCardEligibleFirst|DeliveryAlert|publishEmptyWrittenRun" packages/ingestion/digest/*_test.go` and review every hit. Pure unit tests of functions the OFF lane still uses (`capDigestDelivery`, `toReceiptItems`, `evaluateActionable`, `reconcileActionable`) stay as they are. Rules:

- A run that ends with no card uses `assertNothingSent` (empty stored digest, no outbox event).
- A held-back card asserts `heldBackLedger` → `excluded`/`card_held_back` (or the moved-state reason from 4f).
- Delete, don't port, tests whose only subject was a receipt in ON.

Specific sites:
- `oncard_test.go`
  - `writeOnCardPayload`: delete the `NotCardEligible` branch.
  - Remove every other `NotCardEligible` read (around `:222`, `:400`) and assert card eligibility through the frozen candidate set instead.
  - Delete `TestFreezeOnRanksCardEligibleIncidentsAboveReceiptOnlyOnes`, `TestValidateOnNeverEligibleRendersReceiptWithoutAuthoring`, its helper `neverEligibleRendersReceipt`, and `TestValidateOnCompactionReadsTodaysEligibility`.
  - `TestFreezeOnCoversEveryStatusAndKind`, `TestFreezeOnSkipsAnActionableRowWithNoWaitingAge`: incidents for which `actionablePublishable` is false become `excluded`/`not_publishable`. Saved-diff `needs_human` incidents and PR incidents with URLs stay candidates. Give any other incident the test needs as a candidate a validated diagnosis.
  - `TestValidateOnRequiresACauseSentenceFromADiagnosedCard`: the causeless card ships. The diagnosed card is `card_held_back` with a held reason containing `carries no cause sentence`. `len(ReceiptItems)==0`.
  - `TestValidateOnRefusesACauseSentenceWithoutAStoredCause`: same pattern, with a held reason containing `has no stored cause to answer to`. If that leaves the run with no card, use `assertNothingSent`.
  - `TestValidateOnKeepsAnIncidentWhoseAskChangedAfterFreeze`: rename to `TestValidateOnHoldsBackACardWhoseAskChangedAfterFreeze`. Nothing is sent for that incident, and its ledger is `card_held_back`.
  - `TestFreezeOnCapsAtTheRendererLimitAndRendersOverflow`: rename to `TestFreezeOnCapsAtTheRendererLimit`. Keep the frozen-count, `capped_overflow` ledger, and ≤50-block assertions. Replace the overflow assertions with `payload.Digest.OverflowCount+payload.Digest.ReceiptOverflow == 0` and `!strings.Contains(string(body), "more on the dashboard")`.
  - `TestValidateOnPRCardRepeatsFromCache`, `TestValidateOnWritesNoPublicationsForAnyStatus`: drop receipt expectations. Seed card-eligible incidents only.
- `validate_unified_test.go`
  - Delete `TestValidateOnDeliversFrozenReceiptsWhenTheLiveReloadFails` (replaced by `TestValidateOnRetriesTheSameRunAfterAReloadFailure`), `TestValidateUnifiedDigitSmuggleFallsBackPerCard` (replaced by `…HoldingBackEveryCardSendsNothing`), `TestValidateUnifiedKeepsTheWriterDeferralReason` (replaced by `…HoldsBackTheWriterDeferral`), and `TestReceiptForUnifiedFallbackSanitizesLikeItsSibling`.
  - `TestValidateUnifiedLedgerFailureRollsBackCacheAndDeliversReceipts`: rename to `TestValidateUnifiedLedgerFailureLeavesTheRunWritten`. `ValidateAndPublish` returns an error, `runStatus`=='written', `digestOutboxEvents`==0. Keep its cache-rows==0 and phase=='freeze' assertions.
  - `TestValidateUnifiedGroundedDigitInCopyFallsBack`: `heldBackLedger` → `card_held_back`, plus `assertNothingSent` if it is the only candidate.
  - `TestValidateWriterFailureFallsBackForZeroDiagnosisFriction`: the zero-diagnosis, no-diff `needs_human` incident is no longer frozen. Delete the test; `TestFreezeOnExcludesIncidentsThatCannotEarnACard` covers the shape.
  - `TestValidateSnoozedUnifiedFallbackIsExcludedNotDelivered`: rename to `TestValidateSnoozedCandidateIsExcludedAsSnoozed`. Keep excluded/`snoozed`/`validation`, and replace the `renderedEvent` read with `assertNothingSent`.
- `validate_test.go`
  - `assertFellBackToReceipt` → `assertHeldBack(t, pool, projectID, runID, groupID)`: `assertNothingSent` plus `heldBackLedger` → `excluded`/`card_held_back`. Pass `projectID` from each caller.
  - `unifiedLedger`: read `COALESCE(details->>'held_reason','')` as the fourth value, named `heldReason`.
  - `TestValidateRejectsCandidateSupersededAfterFreeze`: delete the `ReceiptItems[0]` live-title assertion (`:181`). Assert the held-back ledger, or `not_publishable` if 4f reclassifies it.
- `validate_actionable_test.go`
  - `publishEmptyWrittenRun`: rename to `publishWrittenRun`. Freeze, `writeOnCardPayload(t, pool, runID, candidates)`, validate.
  - `receiptIDs` → `cardIDs`, reading `GeneratedCards`.
  - `TestValidateRepeatsActionableItemUntilHumanActs`: seed the group with a validated diagnosis (`seedValidatedDiagnosis`) so it can earn a card. Assert both daily runs ship one card for `groupID` with ledger `included`. Move the impact and replay checks to the card (`ImpactVisits`, `ReplayURL` contains `/sessions/actionable-replay-`). Keep the Slack `|Replay>` check, and replace `Review issue` with the stamped action's button text. For the snoozed run: `assertNothingSent` and reason `snoozed`.
  - `TestActionableReceiptFallsBackToAPreSpellRecording`: it covers ON receipt replay enrichment, which no longer exists. Delete it, unless it drives a stored `unified_cards_mode='off'` run, in which case leave it.
- `cache_invalidation_test.go` `TestValidateInvalidatesRejectedCachedRow` and `TestValidateGroundsCachedCardTitleAgainstMovedCounts`: replace receipt expectations with `heldBackLedger` → `card_held_back` (and `assertNothingSent` where no card ships). **Keep** the assertion that the rejected `digest_card_copy` row has `invalidated_at` set; it proves the nothing-to-send run commits.
- `known_problems_integration_test.go`
  - Freeze tests that seed an unrelated undiagnosed `needs_human` incident (`:314-319`): expect one candidate, and the unrelated group ledgered `excluded`/`not_publishable`.
  - The shared `testTicketDigestActionAfterAuthoringCycle` helper (all modes: `authored`, `deferred_changed_cause`, `stale_action`, `fixing_resolved`, `pr_resolved`, `pr_unpublished`, `pr_unchanged`, `pr_replaced`, `short_secret`, `empty_secret`, `deferred_short_secret`): remove the unrelated-receipt premise (`:396`, `:455-460`). For a mode that ships the ticket card, assert the card as today. For a deferred or stale mode, assert no card for the ticket, its ledger reason (`card_held_back` for a deferral while the ticket is still on-card; `not_publishable` when 4f sees the ticket left the card state), and `assertNothingSent` when no other card ships.

- [ ] **Step 7: Run the digest package**

Run: `cd packages/ingestion && go vet ./... && go test ./digest ./notify -count=1 -json > /tmp/claude-1000/holdback-digest.json; echo "exit $?"; grep -c '"Action":"skip"' /tmp/claude-1000/holdback-digest.json; grep '"Action":"fail"' /tmp/claude-1000/holdback-digest.json | head`
Expected: exit 0, skip count 0, no fail lines.

- [ ] **Step 8: Commit**

```bash
git add packages/ingestion/digest
git commit -m "fix(digest): hold back cards that fail their checks

Freeze admits only incidents that can earn a card and gives error
candidates their validated root cause as why. Validation ledgers a
card that fails its checks, or that the writer deferred, as
card_held_back instead of sending a mechanical receipt. A database
failure leaves the run written for the scheduler to revalidate, and
a run with no card to send finishes without a message.

Supersedes R6 of the unified digest cards design (#496).

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 2: The v5 renderer drops the incident overflow line

**Files:**
- Modify: `packages/ingestion/notify/slack_digest_v5.go:96-99`
- Test: `packages/ingestion/notify/slack_digest_v5_test.go`

**Interfaces:**
- Consumes: nothing new. The receipt loop stays, for outbox events written before this deploy.
- Produces: no "And N more on the dashboard" block. The merged-PR footer is unchanged.

- [ ] **Step 1: Write the failing test** (append to `slack_digest_v5_test.go`)

```go
func TestKnownProblemsDigestHasNoIncidentOverflowLine(t *testing.T) {
	payload := EventPayload{
		Version: 1, EventType: "digest.daily",
		Project:      ProjectRef{ID: "project", Name: "Shop"},
		DashboardURL: "https://app.example.com",
		Digest: &DigestPayload{
			SchemaVersion: 5, Date: "2026-09-14",
			GeneratedCards: []GeneratedDigestCard{{IncidentID: "card", Kind: "error", Title: "Saving is blocked",
				Copy: "People cannot save their work.", Why: "The submit handler is never wired.",
				AffectedUsers: 2, OccurrenceCount: 17}},
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
	if strings.Contains(text, "more on the dashboard") {
		t.Fatalf("v5 digest rendered an incident overflow line: %s", text)
	}
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/ingestion && go test ./notify -run TestKnownProblemsDigestHasNoIncidentOverflowLine -count=1 -v`
Expected: FAIL: "v5 digest rendered an incident overflow line".

- [ ] **Step 3: Implement**

Delete from `formatSlackDigestV5`:

```go
	overflow := max(d.OverflowCount+d.ReceiptOverflow, len(cards)-DigestV4CardCap)
	if overflow > 0 {
		blocks = append(blocks, digestContextBlock(fmt.Sprintf("And %d more on the dashboard", overflow)))
	}
```

Add a comment above the receipt loop: `// Receipts reach v5 only from outbox events written before #496; the ON lane no longer produces them.` Keep `fmt` (still used for counts).

- [ ] **Step 4: Run the notify suite**

Run: `cd packages/ingestion && go test ./notify -count=1`
Expected: `ok`. If a `SchemaVersion: 5` test asserts "more on the dashboard" for incidents, flip it. Leave v4 tests and the merged-PR footer test untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/notify/slack_digest_v5.go packages/ingestion/notify/slack_digest_v5_test.go
git commit -m "fix(notify): drop the incident overflow line from the v5 digest

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 3: The writer prompt demands `why` whenever one is supplied

**Files:**
- Modify: `packages/worker/src/digest-writer/job.ts:80-83,241-248,261-263,276-283,290-293,548`
- Modify: `packages/worker/src/digest-writer/schema.ts:105-107,118-119,286-289`
- Test: `packages/worker/src/__tests__/digest-writer.test.ts`

**Interfaces:**
- Consumes: Task 1's frozen `why` on non-ticket candidates (`DigestCandidate.why?: string`, already declared)
- Produces: `DIGEST_SYSTEM_PROMPT` containing `When a candidate supplies why, the card must include why` and `rootCause is the source of why`

- [ ] **Step 1: Write the failing tests**

Add `groundPayload` to the existing import from `'../digest-writer/job.js'`. In `'publishes the prompt v7 prose-only contract'`, add `'When a candidate supplies why, the card must include why'` and `'rootCause is the source of why'` to the phrase list. Add:

```ts
  it('keeps an error card that writes why and holds back one that omits it', () => {
    const card = {
      title: 'Refreshing a view fails',
      copy: 'People see an error when they refresh a view.',
    };
    for (const errorCandidate of [
      candidate(1, { promptVersion: 7, rootCause: 'The refresh call has no catch.', why: 'The refresh call has no catch.' }),
      // Frozen by ingestion before #496: no why, rootCause only.
      candidate(2, { promptVersion: 7, rootCause: 'The refresh call has no catch.' }),
    ]) {
      const identity = { errorGroupId: errorCandidate.errorGroupId };
      const kept = groundPayload({ included: [{ ...identity, ...card, why: 'A rejected refresh is never caught.' }], deferred: [] },
        [errorCandidate]);
      expect(kept.included[0]?.why).toBe('A rejected refresh is never caught.');
      const held = groundPayload({ included: [{ ...identity, ...card }], deferred: [] }, [errorCandidate]);
      expect(held.included).toHaveLength(0);
      expect(held.deferred[0]?.reason).toMatch(/^card check: why must match qualified cause availability/);
    }
  });
```

- [ ] **Step 2: Run them and confirm the prompt test fails**

Run: `pnpm --filter @opslane/worker exec vitest run src/__tests__/digest-writer.test.ts`
Expected: the prompt-contract test FAILS on `When a candidate supplies why…`. The grounding test already passes; it pins current behavior the prompt must match.

- [ ] **Step 3: Implement**

Replace prompt line `job.ts:548` with:

```
Write why (under 300 characters) only from the candidate's supplied why, and never invent causes. When a candidate supplies why, the card must include why; for an error candidate without why, rootCause is the source of why. Omit why only when neither is supplied. A ticket needs coverage at least 0.5 before its why counts; below that, omit why.
```

Update the comments that promise a receipt:
- `job.ts:80-83` (`notCardEligible`): "Set only by ingestion builds before #496, which froze such incidents. The writer still defers them without a model call; validation holds them back."
- `job.ts:241-248`: "…deferring holds this card back from today's digest and leaves its siblings alone." Log message: `'digest card failed a factual check and was held back'`.
- `job.ts:261-263`: "A card the parser rejected is deferred, so validation holds it back instead of the run failing."
- `job.ts:276-283`: "Deferring holds that incident back; failing the run would drop every sibling card too."
- `job.ts:290-293` (`CARD_CHECK_REASON_PREFIX`): "The prefix a demoted card's deferral reason carries. Validation stores it as the ledger's held_reason."
- `schema.ts:105-107`: "The deferral reason a structurally unusable card carries; validation holds the incident back."
- `schema.ts:118-119`: "…accounts for them as deferred, so the card is held back; rejection never fails the run."
- `schema.ts:286-289`: comment "Scoped to this card: its siblings still deliver and this incident is held back." Warning: `` `included[${index}] card rejected; holding it back` ``.

Then `grep -rn "fell back to its receipt\|delivering its receipt instead" packages/worker/src` and update any test that asserts the old text.

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

### Task 4: End-to-end proof that a diagnosed error card ships a `Why:` line (AC4)

**Files:**
- Test: `packages/ingestion/digest/oncard_test.go`

**Interfaces:**
- Consumes: Tasks 1–2; `writeOnCardPayload` (stub writer; its cards carry `Why: "The submit handler is never wired to the control."`)

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
Expected: PASS. If `SchemaVersion` is 4, a candidate's `PromptVersion` is below 7. Check `digestPromptVersion` rather than weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/ingestion/digest/oncard_test.go
git commit -m "test(digest): diagnosed error card ships a Why line end to end

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 5: Mark the superseded design contract

**Files:**
- Modify: `docs/design/2026-08-27-unified-digest-cards.md`, `docs/design/2026-08-28-unified-cards-fixes.md`

- [ ] **Step 1: Add a banner to both docs**

Directly under each document's H1 title, insert:

```markdown
> **Partly superseded 2026-09-14 (#496).** The digest now sends only cards that passed their checks. A card that fails validation, or that the writer defers, is held back and ledgered `card_held_back`; it never falls back to a mechanical receipt. An incident `publishable()` refuses is excluded at freeze as `not_publishable`. A database failure during validation leaves the run `written` for the scheduler to revalidate instead of degrading to receipts with a delivery alert. The v5 digest has no incident overflow line, and a day with no card sends no message. Requirements and paragraphs below that promise receipt fallback, never-eligible receipts, compact receipts, overflow lines, or "every waiting incident appears" describe the earlier contract.
```

- [ ] **Step 2: Strike R6**

In `2026-08-27-unified-digest-cards.md`, change the R6 row's requirement cell to `~~Writer failure or budget exhaustion for one candidate never suppresses that incident~~ **Superseded (#496):** held back, ledgered \`card_held_back\`.` Change its verification cell to `TestValidateOnHoldingBackEveryCardSendsNothing, TestValidateOnHoldsBackOneCardAndSendsItsSibling`.

- [ ] **Step 3: Commit**

```bash
git add docs/design/2026-08-27-unified-digest-cards.md docs/design/2026-08-28-unified-cards-fixes.md
git commit -m "docs(digest): mark receipt fallback superseded by hold-back (#496)

Claude-Session: https://claude.ai/code/session_012GqPQemATqQ72uDYUhaXK9"
```

---

### Task 6: Repository gate and smokes

- [ ] **Step 1: Full gate** (test environment exported)

```bash
bash -euo pipefail -c '
OUT=$(mktemp -d)
pnpm install --frozen-lockfile
pnpm -r build
pnpm test 2>&1 | tee "$OUT/pnpm-test.txt"
(cd packages/ingestion && go build ./... && go test ./... -count=1 -json > "$OUT/go-test.json")
SKIPS=$(jq -r "select(.Action==\"skip\" and .Test!=null) | \"\(.Package) \(.Test)\"" "$OUT/go-test.json")
if [ -n "$SKIPS" ]; then echo "Go skips:"; echo "$SKIPS"; exit 1; fi
grep -nE "skipped" "$OUT/pnpm-test.txt" || true
docker compose config --quiet
echo "reports in $OUT"
'
```

Expected: exit 0 and no Go skips. For Vitest, the DB-gated `packages/worker/src/__tests__/digest-writer.integration.test.ts` must run, not skip. Suites gated on `ANTHROPIC_API_KEY`, Chromium, or reliability flags may skip; list each with its gate in the verification report.

- [ ] **Step 2: In-process known-problems smoke** (required by `packages/worker/AGENTS.md`)

```bash
docker compose -p opslane-holdback stop worker
E2E_IN_PROCESS_WORKER=1 pnpm --filter @opslane/test-e2e exec vitest run friction-incidents.test.ts
```

Expected: zero skipped tests. It publishes a ticket digest through `known-problems-helper.go` and asserts one generated card and no receipts.

- [ ] **Step 3: Live proof** (owned by the `/verify` stage)

Rebuild and start ingestion and worker (`docker compose -p opslane-holdback up -d --build ingestion worker`). Send an event to `$INGESTION_URL/api/v1/events` as root `AGENTS.md` requires, and confirm its job reaches its terminal state. Then prove AC1–AC6 on the running stack with the real worker writing (`ANTHROPIC_API_KEY` set):

1. **First project.** Give it a `digest.daily` webhook destination pointing at an in-network sink, and seed:
   - one card-eligible error incident (validated diagnosis and root cause),
   - one undiagnosed `awaiting_approval` incident,
   - one `pr_created` incident with no URL.
2. Freeze with `go run ../../test-e2e/known-problems-helper.go -mode freeze -project <id> -at <RFC3339>` from `packages/ingestion`.
3. Write through a `digest_write` job.
4. Publish with `-mode publish -run <run id>`.
5. **Second project.** Force a writer payload that omits `why` for its only card. This proves hold-back and nothing-to-send: an empty stored digest, no outbox event, and the ledger row `card_held_back`.

The verification report records the exact SQL, commands, and outputs.

---

## Self-Review

- **Spec coverage:**
  - D1 → Task 1 (4d, 4e, 4j) and Task 5.
  - D2 → Task 2, plus 4k zeroing counts.
  - D3 → Task 1 Step 3, with test cases for all four refusal shapes and the two eligible-without-diagnosis shapes.
  - D4 → 4a, 4f, 4h, 4j (`retryableValidationError`).
  - D5 → Task 1 Step 3 (`Why`) and Task 3 (prompt, with the pre-deploy snapshot clause).
  - D6 → no task.
  - D7 → the OFF block moves verbatim (4f); no SLA change.
  - AC1–AC6 → the tests named in Tasks 1, 2, and 4.
- **Codex round 1 dispositions:**
  - Accepted: atomic freeze + validation task; `publishable()` wording; zero-diagnosis and ticket-helper test sites; filler case; `selectActionable`; `testPool` does not migrate; `narrative` import; OFF branch untouched; nothing-to-send for all zero-card days; NULL `rendered_payload`; retry revalidates without a model call; ticket and eligibility reclassification; `validate_actionable_test` rewrites; `ReceiptItems[0]` panic; outbox assertions; mixed test; prompt compatibility clause; legacy v5 receipt loop kept; `pipefail` and JSON skip count; banners on both design docs; AC1 narrowed to the payload; AC2 excludes the merged-PR footer; smoke recipe via `known-problems-helper.go`.
  - Declined: a new SLA diagnostic for repeated hold-backs (D7: maintainer accepted log-only visibility).
- **Codex round 2 dispositions:**
  - **Accepted:**
    - fix compile errors before the first test run;
    - the PR-with-URL eligibility case;
    - nothing-to-send runs store their empty payload, so the read API and MCP show an empty digest instead of yesterday's cards, and the e2e helper keeps working;
    - a case-insensitive test sweep that keeps the OFF-lane unit tests;
    - Go skip counting via `jq`, without zero-match grep failures;
    - the in-process known-problems smoke;
    - live proof delegated to `/verify`, with its required shape.
  - **Declined:**
    - a filler root-cause check for on-card tickets: it predates this issue and is outside #496;
    - wrapping every other database error as retryable: those errors already failed and triggered a rewrite before this change, and D4 replaces only the degrade path;
    - dedicated SLA and scheduler tests: the scheduler's `written` → `ValidateAndPublish` path is unchanged, and the retry test asserts no writer job.
