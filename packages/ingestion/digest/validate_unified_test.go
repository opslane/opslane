package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func freezeUnifiedFriction(t *testing.T, mode string, now time.Time) (*pgxpool.Pool, digestFixture, string, Candidate) {
	t.Helper()
	t.Setenv("DIGEST_UNIFIED_CARDS", mode)
	pool := testPool(t)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)
	groupID, _ := seedActionableGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval", now.Add(-48*time.Hour))
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups
		SET signal_type='dead_click',candidate_diff='diff --git a/a b/a' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, fixture.ProjectID, groupID)
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
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
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

func TestValidateUnifiedDigitSmuggleFallsBackPerCard(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	writeUnifiedPayload(t, pool, runID, candidate, "People clicked save 17 times.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID)
	if len(payload.Digest.GeneratedCards) != 0 || len(payload.Digest.ReceiptItems) != 1 {
		t.Fatalf("digit fallback cards=%d receipts=%d", len(payload.Digest.GeneratedCards), len(payload.Digest.ReceiptItems))
	}
	var renderMode string
	if err := pool.QueryRow(context.Background(), `SELECT render_mode
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, candidate.ErrorGroupID).Scan(&renderMode); err != nil {
		t.Fatal(err)
	}
	if renderMode != "receipt_fallback" {
		t.Fatalf("render mode = %q", renderMode)
	}
}

func TestValidateWriterFailureFallsBackForZeroDiagnosisFriction(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	t.Setenv("DIGEST_UNIFIED_CARDS", "on")
	pool := testPool(t)
	fixture := seedDigestFixture(t, pool, now)
	var groupID string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		 occurrence_count,affected_users_count,signal_type,root_cause)
		VALUES ($1,$2,$3,'Save control does nothing','friction','needs_human',$4,$4,9,0,'dead_click',
		        'Unverified text left by an earlier attempt')
		RETURNING id::text`, fixture.ProjectID, fixture.EnvID, "zero-diagnosis-"+uuid.NewString(), now.Add(-time.Hour)).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	quietBackgroundActionable(t, pool, fixture.ProjectID, groupID)
	runID, candidates, err := FreezeCandidates(context.Background(), pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 || candidates[0].ErrorGroupID != groupID {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	body := fmt.Sprintf(`{"included":[],"deferred":[{"errorGroupId":%q,"reason":"writer unavailable"}]}`, groupID)
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 {
		t.Fatalf("zero-diagnosis fallback cards=%d receipts=%d", len(payload.GeneratedCards), len(payload.ReceiptItems))
	}
	if payload.ReceiptItems[0].HasValidatedDiagnosis {
		t.Fatalf("zero-diagnosis fallback overclaimed a diagnosis: %+v", payload.ReceiptItems[0])
	}
}

func TestValidateSnoozedUnifiedFallbackIsExcludedNotDelivered(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`,
		candidate.ErrorGroupID, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	writeUnifiedPayload(t, pool, runID, candidate, "People cannot save because the control never submits.")
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 0 {
		t.Fatalf("snoozed fallback was delivered: %+v", payload)
	}
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
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if candidate.SpellStartedAt == nil {
		t.Fatal("candidate has no actionable spell")
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,$2,'concurrent-fingerprint','Concurrent title','Concurrent copy','Concurrent action','test',4)`,
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
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if candidate.SpellStartedAt == nil {
		t.Fatal("candidate has no actionable spell")
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,$2,$3,'Concurrent winner','Winner copy.','Use the winner.','test',4)`,
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
		generated, receipts, 0, 0,
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

func TestValidateUnifiedLedgerFailureRollsBackCacheAndDeliversReceipts(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, runID, candidate := freezeUnifiedFriction(t, "on", now)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	functionName := "fail_unified_ledger_" + strings.ReplaceAll(runID, "-", "")
	triggerName := functionName + "_trigger"
	ddl := fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.digest_run_id = '%s'::uuid AND NEW.phase = 'validation' THEN
				RAISE EXCEPTION 'injected unified ledger failure';
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
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 || payload.DeliveryAlert == "" {
		t.Fatalf("section did not degrade to receipts: %+v", payload)
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
		t.Fatalf("ledger phase after degraded section = %q, want freeze", phase)
	}
}
