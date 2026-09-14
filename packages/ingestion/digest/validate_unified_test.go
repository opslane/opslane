package digest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// seedUnifiedFrictionIncident builds the one waiting friction incident the
// unified-lane tests validate against, and stops short of freezing it so a
// caller can set the facts a freeze will capture.
func seedUnifiedFrictionIncident(t *testing.T, now time.Time) (*pgxpool.Pool, digestFixture, string) {
	t.Helper()
	pool := testPool(t)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval", now.Add(-48*time.Hour))
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups
		SET signal_type='dead_click',candidate_diff='diff --git a/a b/a' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, fixture.ProjectID, groupID)
	return pool, fixture, groupID
}

func freezeUnifiedFriction(t *testing.T, now time.Time) (*pgxpool.Pool, digestFixture, string, Candidate) {
	t.Helper()
	pool, fixture, groupID := seedUnifiedFrictionIncident(t, now)
	runID, candidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range candidates {
		if candidate.ErrorGroupID == groupID {
			return pool, fixture, runID, candidate
		}
	}
	t.Fatalf("friction group %s was not frozen: %+v", groupID, candidates)
	return nil, digestFixture{}, "", Candidate{}
}

func writeUnifiedPayload(t *testing.T, pool *pgxpool.Pool, runID string, candidate Candidate, copy string) {
	t.Helper()
	payload := writtenDigestPayload{Included: []writtenDigestCard{{
		ErrorGroupID: candidate.ErrorGroupID, Title: "Saving is blocked", Copy: copy,
		Why:    "The checkout control does not submit.",
		Action: "Review the proposed repair.", Label: candidate.Label,
	}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
}

func TestValidateOnPublishesAuthoredFrictionAndCachesCopy(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID)
	if len(payload.Digest.GeneratedCards) != 1 || payload.Digest.GeneratedCards[0].Kind != "friction" {
		t.Fatalf("generated cards = %+v", payload.Digest.GeneratedCards)
	}
	if len(payload.Digest.ReceiptItems) != 0 {
		t.Fatalf("authored friction also rendered receipts: %+v", payload.Digest.ReceiptItems)
	}
	var phase, renderMode string
	var cacheRows, publications int
	if err := pool.QueryRow(context.Background(), `SELECT phase,render_mode
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, candidate.ErrorGroupID).Scan(&phase, &renderMode); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, candidate.ErrorGroupID).Scan(&cacheRows); err != nil {
		t.Fatal(err)
	}
	// The cached row records the contract it was written under. A card written
	// to one prompt and replayed against another is what the version stamp
	// exists to prevent.
	var cachedPromptVersion int
	if err := pool.QueryRow(context.Background(), `SELECT prompt_version FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, candidate.ErrorGroupID).Scan(&cachedPromptVersion); err != nil {
		t.Fatal(err)
	}
	if cachedPromptVersion != digestPromptVersion || digestPromptVersion != 7 {
		t.Fatalf("cached prompt version = %d, live = %d, want 7", cachedPromptVersion, digestPromptVersion)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM issue_publications
		WHERE project_id=$1 AND channel='digest'`, fixture.ProjectID).Scan(&publications); err != nil {
		t.Fatal(err)
	}
	if phase != "validation" || renderMode != "authored" || cacheRows != 1 || publications != 0 {
		t.Fatalf("phase=%s render=%s cache=%d publications=%d", phase, renderMode, cacheRows, publications)
	}

	secondRun, secondCandidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var cached Candidate
	for _, item := range secondCandidates {
		if item.ErrorGroupID == candidate.ErrorGroupID {
			cached = item
		}
	}
	if cached.CachedCard == nil {
		t.Fatal("second run did not freeze cached authored copy")
	}
	writeUnifiedPayload(t, pool, secondRun, cached, cached.CachedCard.Copy)
	if err := ValidateAndPublish(context.Background(), pool, secondRun); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT render_mode
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		secondRun, candidate.ErrorGroupID).Scan(&renderMode); err != nil {
		t.Fatal(err)
	}
	if renderMode != "cached" {
		t.Fatalf("second run render mode = %q", renderMode)
	}
}

// Yesterday's prose, today's numbers. The cache stores copy only, so a card
// replayed the morning after its impact moved must still print what the
// incident measures now.
func TestValidateUnifiedCachedCardCarriesTodaysImpact(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, groupID := seedUnifiedFrictionIncident(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	setImpactVisits(t, pool, groupID, 17)

	// Day one authors and caches the prose beside a visit count of 17.
	firstRun, firstCandidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	first := candidateByGroup(t, firstCandidates, groupID)
	writeUnifiedPayload(t, pool, firstRun, first, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, firstRun); err != nil {
		t.Fatal(err)
	}
	if visits := renderedEvent(t, pool, firstRun).Digest.GeneratedCards[0].ImpactVisits; visits == nil || *visits != 17 {
		t.Fatalf("day one impact = %v, want 17", visits)
	}

	// Overnight the incident is hit more often.
	setImpactVisits(t, pool, groupID, 23)
	secondRun, secondCandidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	cached := candidateByGroup(t, secondCandidates, groupID)
	if cached.CachedCard == nil {
		t.Fatal("second run did not freeze cached authored copy")
	}
	writeUnifiedPayload(t, pool, secondRun, cached, cached.CachedCard.Copy)
	if err := ValidateAndPublish(context.Background(), pool, secondRun); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, secondRun)
	if len(payload.Digest.GeneratedCards) != 1 {
		t.Fatalf("cached replay lost its card: %+v", payload.Digest.GeneratedCards)
	}
	if visits := payload.Digest.GeneratedCards[0].ImpactVisits; visits == nil || *visits != 23 {
		t.Fatalf("day two payload impact = %v, want 23", visits)
	}
	body, _, err := notify.FormatSlack(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "17 signals") {
		t.Fatalf("message does not accurately label existing signal count: %s", body)
	}
	if strings.Contains(string(body), "visits") || strings.Contains(string(body), "recovered") {
		t.Fatalf("day two message replayed yesterday's impact: %s", body)
	}
}

func setImpactVisits(t *testing.T, pool *pgxpool.Pool, groupID string, visits int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_groups SET impact_visits=$2 WHERE id=$1`, groupID, visits); err != nil {
		t.Fatal(err)
	}
}

func candidateByGroup(t *testing.T, candidates []Candidate, groupID string) Candidate {
	t.Helper()
	for _, candidate := range candidates {
		if candidate.ErrorGroupID == groupID {
			return candidate
		}
	}
	t.Fatalf("group %s was not frozen: %+v", groupID, candidates)
	return Candidate{}
}

// Grounded or not, a digit in the copy costs the card. The number the reader
// needs is printed under it from today's facts, so prose that states one is
// duplicating that line or replaying a stale value from cached copy.
func TestValidateUnifiedGroundedDigitInCopyIsHeldBack(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	writeUnifiedPayload(t, pool, runID, candidate,
		fmt.Sprintf("People clicked save %d times.", candidate.OccurrenceCount))
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	assertHeldBack(t, pool, fixture.ProjectID, runID, candidate.ErrorGroupID)
}

func TestValidateSnoozedCandidateIsExcludedAsSnoozed(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`,
		candidate.ErrorGroupID, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	assertNothingSent(t, pool, fixture.ProjectID, runID)
	var outcome, reason, phase string
	if err := pool.QueryRow(context.Background(), `SELECT outcome,primary_reason_code,phase
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, candidate.ErrorGroupID).Scan(&outcome, &reason, &phase); err != nil {
		t.Fatal(err)
	}
	if outcome != "excluded" || reason != reasonSnoozed || phase != "validation" {
		t.Fatalf("snoozed ledger = %s/%s/%s", outcome, reason, phase)
	}
}

func TestValidateCacheConflictDoesNotOverwriteConcurrentWinner(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if candidate.SpellStartedAt == nil {
		t.Fatal("candidate has no actionable spell")
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,$2,'concurrent-fingerprint','Concurrent title','Concurrent copy','Concurrent action','test',5)`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt); err != nil {
		t.Fatal(err)
	}
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	var fingerprint string
	if err := pool.QueryRow(context.Background(), `SELECT input_fingerprint FROM digest_card_copy
		WHERE error_group_id=$1 AND spell_started_at=$2 AND invalidated_at IS NULL`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt).Scan(&fingerprint); err != nil {
		t.Fatal(err)
	}
	if fingerprint != "concurrent-fingerprint" {
		t.Fatalf("concurrent cache winner was overwritten: %q", fingerprint)
	}
	if cards := renderedEvent(t, pool, runID).Digest.GeneratedCards; len(cards) != 1 {
		t.Fatalf("validated run copy was not delivered: %+v", cards)
	}
}

func TestValidateCacheConflictAdoptsMatchingConcurrentWinner(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if candidate.SpellStartedAt == nil {
		t.Fatal("candidate has no actionable spell")
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,why,action,model,prompt_version)
		VALUES ($1,$2,$3,'Concurrent winner','Winner copy.','Winner cause.','Use the winner.','test',5)`,
		candidate.ErrorGroupID, *candidate.SpellStartedAt, candidate.Fingerprint); err != nil {
		t.Fatal(err)
	}
	writeUnifiedPayload(t, pool, runID, candidate, "Losing copy should not ship.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	cards := renderedEvent(t, pool, runID).Digest.GeneratedCards
	if len(cards) != 1 || cards[0].Title != "Concurrent winner" || cards[0].Copy != "Winner copy." || cards[0].Action != "Use the winner." {
		t.Fatalf("cache winner was not adopted: %+v", cards)
	}
	var renderMode string
	if err := pool.QueryRow(context.Background(), `SELECT render_mode
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, candidate.ErrorGroupID).Scan(&renderMode); err != nil {
		t.Fatal(err)
	}
	if renderMode != "cached" {
		t.Fatalf("matching concurrent cache winner render mode = %q, want cached", renderMode)
	}
}

func TestCapDigestDeliverySharesOneDecisionReceiptFixBudget(t *testing.T) {
	generated := make([]notify.GeneratedDigestCard, 0, 8)
	for index := range 8 {
		generated = append(generated, notify.GeneratedDigestCard{
			IncidentID: fmt.Sprintf("fix-%d", index), Outcome: "verified_fix",
		})
	}
	receipts := make([]notify.ReceiptItem, 0, 5)
	for index := range 5 {
		receipts = append(receipts, notify.ReceiptItem{IncidentID: fmt.Sprintf("receipt-%d", index)})
	}

	cards, keptReceipts, generatedOverflow, receiptOverflow, dropped := capDigestDelivery(
		UnifiedCardsOn, generated, receipts, 0, 0,
	)
	if len(cards) != 4 || len(keptReceipts) != 5 {
		t.Fatalf("capped delivery has %d fixes + %d receipts, want 4 + 5", len(cards), len(keptReceipts))
	}
	if generatedOverflow != 4 || receiptOverflow != 0 {
		t.Fatalf("overflow = generated %d receipt %d, want 4/0", generatedOverflow, receiptOverflow)
	}
	if strings.Join(dropped, ",") != "fix-4,fix-5,fix-6,fix-7" {
		t.Fatalf("dropped identities = %v", dropped)
	}
}

func TestValidateUnifiedLedgerFailureLeavesTheRunWritten(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	functionName := "fail_unified_ledger_" + strings.ReplaceAll(runID, "-", "")
	triggerName := functionName + "_trigger"
	ddl := fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.digest_run_id = '%s'::uuid AND NEW.phase = 'validation' THEN
				RAISE EXCEPTION 'injected unified ledger failure' USING ERRCODE = '40001';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER %s BEFORE UPDATE ON digest_run_candidate_evaluations
		FOR EACH ROW EXECUTE FUNCTION %s()`, functionName, runID, triggerName, functionName)
	if _, err := pool.Exec(context.Background(), ddl); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), fmt.Sprintf(
			`DROP TRIGGER IF EXISTS %s ON digest_run_candidate_evaluations; DROP FUNCTION IF EXISTS %s()`,
			triggerName, functionName))
	})
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err == nil {
		t.Fatal("ValidateAndPublish succeeded during a ledger failure")
	}
	if status := runStatus(t, pool, runID); status != "written" {
		t.Fatalf("run status = %q, want written so the scheduler revalidates it", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}
	var cacheRows int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, candidate.ErrorGroupID).Scan(&cacheRows); err != nil {
		t.Fatal(err)
	}
	if cacheRows != 0 {
		t.Fatalf("cache rows after ledger rollback = %d, want 0", cacheRows)
	}
	var phase string
	if err := pool.QueryRow(context.Background(), `SELECT phase FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, runID, candidate.ErrorGroupID).Scan(&phase); err != nil {
		t.Fatal(err)
	}
	if phase != "freeze" {
		t.Fatalf("ledger phase after a failed finalize = %q, want freeze", phase)
	}
}

// TestCapDigestDeliveryOffSpendsTheBudgetOnCardsOnly pins OFF parity with
// origin/main: receipts do not compete with generated cards for the render
// budget, and none of them is dropped or counted as overflow.
func TestCapDigestDeliveryOffSpendsTheBudgetOnCardsOnly(t *testing.T) {
	generated := make([]notify.GeneratedDigestCard, 0, 12)
	for index := range 12 {
		generated = append(generated, notify.GeneratedDigestCard{
			IncidentID: fmt.Sprintf("card-%d", index), Outcome: "needs_human",
		})
	}
	receipts := make([]notify.ReceiptItem, 0, 5)
	for index := range 5 {
		receipts = append(receipts, notify.ReceiptItem{IncidentID: fmt.Sprintf("receipt-%d", index)})
	}

	cards, keptReceipts, generatedOverflow, receiptOverflow, dropped := capDigestDelivery(
		UnifiedCardsOff, generated, receipts, 0, 4,
	)
	if len(cards) != notify.DigestV4CardCap || len(keptReceipts) != 5 {
		t.Fatalf("OFF delivery has %d cards + %d receipts, want %d + 5",
			len(cards), len(keptReceipts), notify.DigestV4CardCap)
	}
	if generatedOverflow != 3 || receiptOverflow != 4 {
		t.Fatalf("OFF overflow = generated %d receipt %d, want 3/4", generatedOverflow, receiptOverflow)
	}
	if strings.Join(dropped, ",") != "card-9,card-10,card-11" {
		t.Fatalf("OFF dropped identities = %v, want only cards past the cap", dropped)
	}
}

// TestValidateStampsActionSoWriterDigitsNeverShip pins the action trust
// boundary for unified candidates: the instruction line has exactly one correct
// value, so whatever the model wrote — digits included — is replaced by the
// state function's output before any check runs, and nothing the writer put in
// the action field can reach a reader.
func TestValidateStampsActionSoWriterDigitsNeverShip(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	payload := writtenDigestPayload{Included: []writtenDigestCard{{
		ErrorGroupID: candidate.ErrorGroupID, Title: "Saving is blocked",
		Copy: "People cannot save their work.", Why: "The checkout control does not submit.",
		Action: "Retry the save 99 times.", Label: candidate.Label,
	}}}
	encoded, err := json.Marshal(payload)
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
	cards := renderedEvent(t, pool, runID).Digest.GeneratedCards
	if len(cards) != 1 || cards[0].IncidentID != candidate.ErrorGroupID {
		t.Fatalf("stamped card did not ship: %+v", cards)
	}
	if cards[0].Action != candidate.ValidAction {
		t.Fatalf("action = %q, want the stamped %q", cards[0].Action, candidate.ValidAction)
	}
	// Every field the writer owns, and only those: a random run or incident uuid
	// carrying the digits "99" is not a writer digit, and scanning the whole
	// encoded payload for them failed this test on roughly one run in ten.
	for _, authored := range []string{cards[0].Title, cards[0].Copy, cards[0].Why, cards[0].Action} {
		if strings.Contains(authored, "99") {
			t.Fatalf("a writer digit reached the reader: %q", authored)
		}
	}
}

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
	if len(stored.MergedThisWeek) != 0 || stored.OverflowCount != 0 || stored.ReceiptOverflow != 0 || stored.DeliveryAlert != "" {
		t.Fatalf("stored digest merged=%+v overflow=%d+%d alert=%q, want none",
			stored.MergedThisWeek, stored.OverflowCount, stored.ReceiptOverflow, stored.DeliveryAlert)
	}
	if !notify.BuildDigestView(stored).Empty() {
		t.Fatalf("stored digest does not read as empty: %+v", stored)
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
	assertHeldBack(t, pool, fixture.ProjectID, runID, candidate.ErrorGroupID)
	if _, _, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID); held == "" {
		t.Fatal("held-back card ledger carries no held reason")
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
	assertHeldBack(t, pool, fixture.ProjectID, runID, candidate.ErrorGroupID)
	if _, _, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID); held != reason {
		t.Fatalf("held reason = %q, want %q", held, reason)
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
			Copy:   "People cannot save because the control never submits.",
			Why:    "The submit handler is never wired to the control.",
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
		return nil, &pgconn.PgError{Code: "08006", Message: "injected connection failure"}
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
}

func storeWriterPayload(t *testing.T, pool *pgxpool.Pool, runID string, payload writtenDigestPayload) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, encoded); err != nil {
		t.Fatal(err)
	}
}

// Only a transient database failure buys a retry of the same writer payload. A
// deterministic one would fail identically on every tick, so it fails the run
// and the scheduler re-enqueues the writer.
func TestValidateOnFailsTheRunAfterADeterministicReloadError(t *testing.T) {
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
		return nil, errors.New("boom")
	}
	if err := ValidateAndPublish(ctx, pool, runID); err == nil {
		t.Fatal("ValidateAndPublish succeeded during a reload failure")
	}
	if status := runStatus(t, pool, runID); status != "failed" {
		t.Fatalf("run status = %q, want failed so the writer runs again", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}
}

// A database failure while validating one card is not that card's fault: the
// attempt fails as a whole, the run stays written for the next tick, and the
// card is not ledgered as held back.
func TestValidateOnCardDatabaseFailureLeavesTheRunWritten(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	functionName := "fail_card_cache_" + strings.ReplaceAll(runID, "-", "")
	triggerName := functionName + "_trigger"
	ddl := fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.error_group_id::text = '%s' THEN
				RAISE EXCEPTION 'injected card cache failure' USING ERRCODE = '40001';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER %s BEFORE INSERT ON digest_card_copy
		FOR EACH ROW EXECUTE FUNCTION %s()`, functionName, candidate.ErrorGroupID, triggerName, functionName)
	if _, err := pool.Exec(context.Background(), ddl); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), fmt.Sprintf(
			`DROP TRIGGER IF EXISTS %s ON digest_card_copy; DROP FUNCTION IF EXISTS %s()`,
			triggerName, functionName))
	})
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	err := ValidateAndPublish(context.Background(), pool, runID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "40001" {
		t.Fatalf("ValidateAndPublish error = %v, want the injected serialization failure", err)
	}
	if status := runStatus(t, pool, runID); status != "written" {
		t.Fatalf("run status = %q, want written so the scheduler revalidates it", status)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 0 {
		t.Fatalf("outbox events = %d, want 0", events)
	}
	if outcome, reason, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID); reason == reasonCardHeldBack || held != "" {
		t.Fatalf("ledger after a database failure = %s/%s/%q, want no hold-back", outcome, reason, held)
	}
}

// A writer payload that silently drops a frozen incident holds that card back,
// records why in both ledgers, and still ships the sibling.
func TestValidateOnHoldsBackACandidateTheWriterOmitted(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	good := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The save request never leaves the page.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, good, now.Add(-time.Hour))
	omitted := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "error", "awaiting_approval",
		true, "", "The export request never leaves the page.", now.Add(-2*time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, omitted, now.Add(-time.Hour))
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	writeOnCardPayload(t, pool, runID, []Candidate{candidateByGroup(t, candidates, good)})
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	delivered := renderedEvent(t, pool, runID).Digest
	if len(delivered.GeneratedCards) != 1 || delivered.GeneratedCards[0].IncidentID != good {
		t.Fatalf("cards=%+v, want only the accounted card", delivered.GeneratedCards)
	}
	if events := digestOutboxEvents(t, pool, fixture.ProjectID, runID); events != 1 {
		t.Fatalf("outbox events = %d, want 1", events)
	}
	const want = "the writer did not account for this incident"
	if outcome, reason, held := heldBackLedger(t, pool, runID, omitted); outcome != "excluded" || reason != reasonCardHeldBack || held != want {
		t.Fatalf("omitted incident ledger = %s/%s/%q, want excluded/%s/%q", outcome, reason, held, reasonCardHeldBack, want)
	}
	var itemOutcome, itemReason string
	if err := pool.QueryRow(ctx, `SELECT outcome,COALESCE(reason,'') FROM digest_unified_run_items
		WHERE project_id=$1 AND run_id=$2 AND error_group_id=$3`, fixture.ProjectID, runID, omitted).Scan(&itemOutcome, &itemReason); err != nil {
		t.Fatal(err)
	}
	if itemOutcome != "deferred" || itemReason != want {
		t.Fatalf("omitted incident item = %s/%q, want deferred/%q", itemOutcome, itemReason, want)
	}
}

// card_held_back means the incident is still waiting and only its card failed.
// One that left the waiting set between freeze and validation is ledgered as
// that move, whatever happened to its card.
func TestValidateOnLedgersAFailedCardThatStoppedWaitingAsNotPublishable(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	// The title fails the vocabulary check before validation reloads the incident.
	storeWriterPayload(t, pool, runID, writtenDigestPayload{Included: []writtenDigestCard{{
		ErrorGroupID: candidate.ErrorGroupID, Title: "needs_human checkout",
		Copy: "People cannot save their work.", Why: "The checkout control does not submit.",
		Action: candidate.ValidAction, Label: candidate.Label,
	}}})
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET status='resolved' WHERE id=$1`,
		candidate.ErrorGroupID); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	assertNothingSent(t, pool, fixture.ProjectID, runID)
	if outcome, reason, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID); outcome != "excluded" || reason != reasonNotPublishable || held != "" {
		t.Fatalf("ledger = %s/%s/%q, want excluded/%s with no held reason", outcome, reason, held, reasonNotPublishable)
	}
}

// A leaked pipeline word in one deferral reason is the writer's slip about one
// card. In ON it holds that card back instead of failing every sibling.
func TestValidateOnHoldsBackADeferralWhoseReasonLeaksInternalVocabulary(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	storeWriterPayload(t, pool, runID, writtenDigestPayload{Deferred: []deferredDigestItem{{
		ErrorGroupID: candidate.ErrorGroupID, Reason: "card check: the incident is needs_human",
	}}})
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatalf("a leaked word in one deferral reason failed the run: %v", err)
	}
	assertHeldBack(t, pool, fixture.ProjectID, runID, candidate.ErrorGroupID)
	if _, _, held := heldBackLedger(t, pool, runID, candidate.ErrorGroupID); held != "the writer's deferral reason used internal vocabulary" {
		t.Fatalf("held reason = %q", held)
	}
}

// The merged-PR footer only accompanies cards. A zero-card run that stored it
// would read as a non-empty digest to the read API and MCP.
func TestValidateOnZeroCardRunStoresNoMergedFooter(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, groupID := seedUnifiedFrictionIncident(t, now)
	ctx := context.Background()
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	var mergedGroup string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,pr_url,pr_number)
		VALUES ($1,$2,$3,'Checkout repaired','error','merged',$4,$4,'https://github.com/acme/shop/pull/31',31)
		RETURNING id::text`, fixture.ProjectID, fixture.EnvID, fmt.Sprintf("merged-%d", time.Now().UnixNano()),
		now.Add(-2*time.Hour)).Scan(&mergedGroup); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pr_outcomes
		(project_id,error_group_id,pr_number,outcome,github_delivery_id,github_repo,occurred_at)
		VALUES ($1,$2,31,'merged',$2::uuid::text,'acme/shop',$3)`,
		fixture.ProjectID, mergedGroup, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	candidate := candidateByGroup(t, candidates, groupID)

	// Prove the footer exists for this run's window, or the test proves nothing.
	var windowTo time.Time
	if err := pool.QueryRow(ctx, `SELECT window_to FROM digest_runs WHERE id=$1`, runID).Scan(&windowTo); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	merged, mergedErr := mergedThisWeek(ctx, tx, fixture.ProjectID, windowTo)
	_ = tx.Rollback(ctx)
	if mergedErr != nil || len(merged) == 0 {
		t.Fatalf("merged this week = %+v err=%v, want the seeded PR", merged, mergedErr)
	}

	writeUnifiedPayload(t, pool, runID, candidate, "People clicked save 987 times.")
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	if version := renderedEvent(t, pool, runID).Digest.SchemaVersion; version != 5 {
		t.Fatalf("stored schema version = %d, want 5 so the footer was loaded", version)
	}
	assertHeldBack(t, pool, fixture.ProjectID, runID, groupID)
}
