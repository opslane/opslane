package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedWrittenFreezeRun freezes exactly one incident in the unified lane and
// stores the writer's payload for it. The incident carries a project pull
// request, so publishable() grants it an authored card without a diagnosis
// fixture, and its PR number grounds the digits the tests below assert on.
func seedWrittenFreezeRun(t *testing.T, pool *pgxpool.Pool, payload func(Candidate) string) (string, string, Candidate) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET github_repo='acme/shop' WHERE id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	groupID := seedOnCardGroup(t, pool, f.ProjectID, f.EnvID, "error", "pr_created", false,
		"https://github.com/acme/shop/pull/42", "The checkout control does not submit.", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	runID, candidates, err := FreezeCandidates(context.Background(), pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze written run: candidates=%d err=%v", len(candidates), err)
	}
	body := payload(candidates[0])
	if _, err := pool.Exec(context.Background(), `
		UPDATE digest_runs SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	return runID, f.ProjectID, candidates[0]
}

func validWrittenPayload(candidate Candidate) string {
	return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":"Checkout is blocked","copy":"Checkout is blocked before payment.","action":%q,"label":%q,"claimedUsers":%d,"accounts":[],"prUrl":%q}],"deferred":[]}`,
		candidate.ErrorGroupID, candidate.ValidAction, candidate.Label, candidate.AffectedUsers, candidate.PRURL)
}

// unifiedLedger reads the one accounting row every frozen incident owns.
func unifiedLedger(t *testing.T, pool *pgxpool.Pool, runID, groupID string) (outcome, reason, renderMode, receiptReason string) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT outcome,primary_reason_code,
		COALESCE(render_mode,''),COALESCE(details->>'receipt_reason','')
		FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
		runID, groupID).Scan(&outcome, &reason, &renderMode, &receiptReason); err != nil {
		t.Fatal(err)
	}
	return outcome, reason, renderMode, receiptReason
}

// assertFellBackToReceipt pins the unified lane's refusal shape: a card the
// validator rejects costs that incident its card, never the whole digest, and
// nothing the model wrote reaches the reader.
func assertFellBackToReceipt(t *testing.T, pool *pgxpool.Pool, runID, groupID string) {
	t.Helper()
	payload := renderedEvent(t, pool, runID).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 {
		t.Fatalf("rejected card cards=%+v receipts=%+v", payload.GeneratedCards, payload.ReceiptItems)
	}
	if payload.ReceiptItems[0].IncidentID != groupID {
		t.Fatalf("receipt = %+v, want incident %s", payload.ReceiptItems[0], groupID)
	}
	_, _, renderMode, receiptReason := unifiedLedger(t, pool, runID, groupID)
	if renderMode != "receipt_fallback" || receiptReason != "card_validation_failed" {
		t.Fatalf("ledger render=%q receipt_reason=%q", renderMode, receiptReason)
	}
}

func TestValidateRejectsInventedLinks(t *testing.T) {
	pool := testPool(t)
	runID, _, candidate := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
		return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":"Checkout is blocked","copy":"Checkout is blocked before payment.","action":%q,"label":%q,"prUrl":"https://github.com/other/repo/pull/1"}],"deferred":[]}`,
			candidate.ErrorGroupID, candidate.ValidAction, candidate.Label)
	})
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	assertFellBackToReceipt(t, pool, runID, candidate.ErrorGroupID)
	rendered, err := json.Marshal(renderedEvent(t, pool, runID))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rendered), "other/repo") {
		t.Fatalf("an invented link reached the reader: %s", rendered)
	}
}

func TestPublishIsIdempotentAcrossConcurrentSweepers(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID, projectID, _ := seedWrittenFreezeRun(t, pool, validWrittenPayload)

	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = ValidateAndPublish(ctx, pool, runID)
		}()
	}
	wg.Wait()

	var outbox, receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events
		WHERE project_id=$1 AND payload->>'run_id'=$2`, projectID, runID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	// The unified lane repeats an incident until a human acts, so it owns no
	// one-shot publication rows: status governs repetition instead.
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1 AND channel='digest'`, projectID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if outbox != 1 {
		t.Errorf("outbox events = %d, want 1", outbox)
	}
	if receipts != 0 {
		t.Errorf("publication receipts = %d, want 0", receipts)
	}
}

func TestFailedRunDoesNotAdvanceTheWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID, projectID, candidate := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
		// A deferral with no reason is unaccountable, so the whole run fails.
		return fmt.Sprintf(`{"included":[],"deferred":[{"errorGroupId":%q,"reason":"  "}]}`,
			candidate.ErrorGroupID)
	})
	if err := ValidateAndPublish(ctx, pool, runID); err == nil {
		t.Fatal("an unaccountable writer payload must fail the run")
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Errorf("status = %q, want failed", status)
	}
	var events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events
		WHERE project_id=$1 AND payload->>'run_id'=$2`, projectID, runID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Errorf("a failed run must publish nothing, got %d outbox events", events)
	}
	// The ledger is the run's durable accounting: a failed validation leaves it
	// exactly as the freeze wrote it, so the next attempt reconsiders the same set.
	var phase string
	if err := pool.QueryRow(ctx, `SELECT phase FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, runID, candidate.ErrorGroupID).Scan(&phase); err != nil {
		t.Fatal(err)
	}
	if phase != "freeze" {
		t.Errorf("ledger phase = %q, want the untouched freeze row", phase)
	}
}

// TestValidateRejectsCandidateSupersededAfterFreeze: the frozen card describes
// facts that moved before it could ship, so the authored copy is refused and the
// incident falls back to a receipt built from its live row.
func TestValidateRejectsCandidateSupersededAfterFreeze(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID, _, candidate := seedWrittenFreezeRun(t, pool, validWrittenPayload)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET title='A different incident entirely'
		WHERE id=$1`, candidate.ErrorGroupID); err != nil {
		t.Fatal(err)
	}

	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	assertFellBackToReceipt(t, pool, runID, candidate.ErrorGroupID)
	receipt := renderedEvent(t, pool, runID).Digest.ReceiptItems[0]
	if receipt.Title != "A different incident entirely" {
		t.Fatalf("receipt title = %q, want the live title", receipt.Title)
	}
}

func TestValidatePublishesSchemaV4GroundedCard(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	t.Setenv("DASHBOARD_URL", "https://dashboard.example")
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	groupID, episodeID := seedActionableGroup(t, pool, f.ProjectID, f.EnvID, "error", "needs_human", now.Add(-2*time.Hour))
	quietBackgroundActionable(t, pool, f.ProjectID, groupID)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET occurrence_count=34 WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	// The replay anchor is deliberately ancient: ?t= is absolute epoch ms, and
	// this pin would catch a relative-offset regression. Backdate the spell
	// past it so the freeze's spell-bounded replay lookup still admits it.
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`,
		groupID, time.UnixMilli(1).UTC()); err != nil {
		t.Fatal(err)
	}
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, "sess-123", time.UnixMilli(4200).UTC())
	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze: candidates=%d err=%v", len(candidates), err)
	}
	candidate := candidates[0]
	body := fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":"Send invoice does nothing","copy":"Checkout is blocked before payment.","why":"The checkout control does not submit.","action":%q,"label":%q,"claimedOccurrences":34,"accounts":[]}],"deferred":[]}`,
		candidate.ErrorGroupID, candidate.ValidAction, candidate.Label)
	if _, err := pool.Exec(ctx, `UPDATE digest_runs SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	published := renderedEvent(t, pool, runID)
	if published.Digest == nil || published.Digest.SchemaVersion != 4 || len(published.Digest.GeneratedCards) != 1 {
		t.Fatalf("published digest: %+v", published.Digest)
	}
	card := published.Digest.GeneratedCards[0]
	if card.Outcome != "needs_human" || card.OccurrenceCount != 34 || card.Title != "Send invoice does nothing" {
		t.Fatalf("published card facts: %+v", card)
	}
	if card.ReplayURL != "https://dashboard.example/sessions/sess-123?t=4200" {
		t.Fatalf("replay URL = %q", card.ReplayURL)
	}
}

// The unified lane refuses a card the writer got wrong without failing the run:
// the incident loses its authored copy and ships its mechanical receipt instead.
func TestValidateRejectsUnsupportedOccurrenceAndTitleVocabulary(t *testing.T) {
	tests := []struct {
		name string
		card func(Candidate) string
	}{
		{"occurrence", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":"Checkout is blocked","copy":"Checkout is blocked before payment.","action":%q,"label":%q,"claimedOccurrences":%d}],"deferred":[]}`,
				candidate.ErrorGroupID, candidate.ValidAction, candidate.Label, candidate.OccurrenceCount+1)
		}},
		{"title vocabulary", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":"needs_human checkout","copy":"Checkout is blocked before payment.","action":%q,"label":%q}],"deferred":[]}`,
				candidate.ErrorGroupID, candidate.ValidAction, candidate.Label)
		}},
		{"title cap", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":%q,"copy":"Checkout is blocked before payment.","action":%q,"label":%q}],"deferred":[]}`,
				candidate.ErrorGroupID, strings.Repeat("x", 81), candidate.ValidAction, candidate.Label)
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			runID, _, candidate := seedWrittenFreezeRun(t, pool, tc.card)
			if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
				t.Fatal(err)
			}
			assertFellBackToReceipt(t, pool, runID, candidate.ErrorGroupID)
		})
	}
}

// TestValidateGroundsNumbersInCardTitles: the title is the only prose field a
// digit may legitimately reach — copy and action may carry no numeric glyph at
// all (TestValidateUnifiedDigitSmuggleFallsBackPerCard) — so grounding is
// pinned there: an invented number costs the card, a frozen fact does not.
func TestValidateGroundsNumbersInCardTitles(t *testing.T) {
	titleCard := func(title string) func(Candidate) string {
		return func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"errorGroupId":%q,"title":%q,"copy":"Checkout is blocked before payment.","action":%q,"label":%q}],"deferred":[]}`,
				candidate.ErrorGroupID, title, candidate.ValidAction, candidate.Label)
		}
	}

	t.Run("invented", func(t *testing.T) {
		pool := testPool(t)
		runID, _, candidate := seedWrittenFreezeRun(t, pool, titleCard("Checkout is blocked for 99 people"))
		if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
			t.Fatal(err)
		}
		assertFellBackToReceipt(t, pool, runID, candidate.ErrorGroupID)
	})

	t.Run("grounded in a frozen fact", func(t *testing.T) {
		pool := testPool(t)
		var frozen Candidate
		runID, _, candidate := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
			frozen = candidate
			return titleCard(fmt.Sprintf("Checkout is blocked for %d people", candidate.OccurrenceCount))(candidate)
		})
		if frozen.OccurrenceCount == 0 {
			t.Fatal("the fixture froze no occurrence count to ground the title on")
		}
		if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
			t.Fatalf("grounded frozen number rejected: %v", err)
		}
		cards := renderedEvent(t, pool, runID).Digest.GeneratedCards
		if len(cards) != 1 || cards[0].IncidentID != candidate.ErrorGroupID {
			t.Fatalf("grounded card did not ship: %+v", cards)
		}
	})
}

func TestValidateExtractsPRNumber(t *testing.T) {
	pool := testPool(t)
	runID, _, candidate := seedWrittenFreezeRun(t, pool, validWrittenPayload)
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	cards := renderedEvent(t, pool, runID).Digest.GeneratedCards
	if len(cards) != 1 {
		t.Fatalf("published cards = %+v", cards)
	}
	if cards[0].PRNumber != 42 || cards[0].PRURL != candidate.PRURL {
		t.Fatalf("PR facts = #%d %q, want #42 %q", cards[0].PRNumber, cards[0].PRURL, candidate.PRURL)
	}
}

// TestValidateRehydratesOffModeRunThroughLegacyLane pins the migration window
// this branch depends on: a run frozen under the retired DIGEST_UNIFIED_CARDS
// switch carries unified_cards_mode='off' and episode-keyed snapshots, and the
// new binary must still validate and deliver it through the legacy lane —
// episode card rendered, publication receipt written, and the >80-rune frozen
// title truncated at render. No code path can create such a run any more, so
// the fixture writes the stored rows directly, as a pre-deploy freeze left them.
func TestValidateRehydratesOffModeRunThroughLegacyLane(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, f.ProjectID)
	quietBackgroundActionable(t, pool, f.ProjectID)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))
	var groupID string
	var decidedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT ep.canonical_issue_id::text,d.decided_at
		FROM issue_episodes ep
		JOIN diagnosis_decisions d ON d.project_id=ep.project_id AND d.episode_id=ep.id
		WHERE ep.project_id=$1 AND ep.id=$2
		ORDER BY d.decided_at DESC LIMIT 1`, f.ProjectID, episodeID).Scan(&groupID, &decidedAt); err != nil {
		t.Fatal(err)
	}

	sequence := 1
	frozen := Candidate{
		EpisodeID: episodeID, EpisodeSequence: &sequence, IssueID: groupID, ErrorGroupID: groupID,
		Kind: "error", Title: strings.Repeat("界", 100), Outcome: "needs_human",
		Summary: "verified terminal result", ValidAction: "Decide how to handle this.",
		DecidedAt: decidedAt, LastSeen: now.Add(-2 * time.Hour),
		Accounts: []string{}, OccurrenceCount: 3, Label: "new",
	}
	snapshot, err := json.Marshal(frozen)
	if err != nil {
		t.Fatal(err)
	}
	legacyPayload := fmt.Sprintf(`{"included":[{"episodeId":%q,"copy":"Checkout is blocked before payment.","action":"Review the investigation.","label":"new"}],"deferred":[]}`, episodeID)
	var runID string
	if err := pool.QueryRow(ctx, `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status,unified_cards_mode,payload)
		VALUES ($1,$2,$3,$4,'written','off',$5::jsonb) RETURNING id::text`,
		f.ProjectID, now.Add(-24*time.Hour), now, now.Format("2006-01-02"), legacyPayload).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_run_items
		(project_id,run_id,episode_id,error_group_id,candidate_snapshot)
		VALUES ($1,$2,$3,$4,$5::jsonb)`, f.ProjectID, runID, episodeID, groupID, snapshot); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})

	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatalf("legacy off run failed to rehydrate: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "delivered" {
		t.Fatalf("status = %q, want delivered", status)
	}
	published := renderedEvent(t, pool, runID).Digest
	if published == nil || published.UnifiedCards {
		t.Fatalf("legacy run rendered as unified: %+v", published)
	}
	if len(published.GeneratedCards) != 1 || published.GeneratedCards[0].EpisodeID != episodeID {
		t.Fatalf("legacy episode card = %+v", published.GeneratedCards)
	}
	if got := published.GeneratedCards[0].Title; got != strings.Repeat("界", 80) {
		t.Fatalf("legacy title has %d runes, want the 80-rune truncation", len([]rune(got)))
	}
	// The OFF lane's one-shot semantics survive on the new binary: delivery
	// writes the publication receipt that keeps the episode from repeating.
	var receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1 AND episode_id=$2 AND channel='digest'`, f.ProjectID, episodeID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("publication receipts = %d, want 1", receipts)
	}
}
