package digest

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

// authorOneOnCardRun freezes, authors and delivers a single actionable
// incident, leaving exactly one current cached card behind.
func authorOneOnCardRun(t *testing.T, now time.Time) (*pgxpool.Pool, digestFixture, string) {
	t.Helper()
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction",
		"awaiting_approval", true, "", "The checkout control does not submit.", now.Add(-time.Hour))
	seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))

	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%+v err=%v", candidates, err)
	}
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	var cached int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID).Scan(&cached); err != nil {
		t.Fatal(err)
	}
	if cached != 1 {
		t.Fatalf("current cached cards after authoring = %d, want 1", cached)
	}
	return pool, fixture, groupID
}

func echoCachedPayload(t *testing.T, pool *pgxpool.Pool, runID string, candidate Candidate) {
	t.Helper()
	if candidate.CachedCard == nil {
		t.Fatal("candidate carries no cached card to echo")
	}
	payload := writtenDigestPayload{Included: []writtenDigestCard{{
		ErrorGroupID: candidate.ErrorGroupID, Title: candidate.CachedCard.Title,
		Copy: candidate.CachedCard.Copy, Why: candidate.CachedCard.Why,
		Action: candidate.CachedCard.Action, Label: candidate.Label,
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

// TestValidateInvalidatesRejectedCachedRow is G5: without it a cached copy the
// validator refuses stays current and demotes its card to a receipt every day,
// forever.
func TestValidateInvalidatesRejectedCachedRow(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, groupID := authorOneOnCardRun(t, now)
	ctx := context.Background()

	// A digit smuggled into the stored copy: the exact shape verification found.
	if _, err := pool.Exec(ctx, `UPDATE digest_card_copy
		SET copy='People clicked save 17 times.'
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID); err != nil {
		t.Fatal(err)
	}

	secondRun, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil || len(second) != 1 || second[0].CachedCard == nil {
		t.Fatalf("second freeze candidates=%+v err=%v", second, err)
	}
	echoCachedPayload(t, pool, secondRun, second[0])
	if err := ValidateAndPublish(ctx, pool, secondRun); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, secondRun).Digest
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 {
		t.Fatalf("tampered cache still rendered a card: %+v", payload.GeneratedCards)
	}
	var current int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != 0 {
		t.Fatalf("rejected cached row is still current (%d rows); the card would demote forever", current)
	}

	// Day three re-authors instead of serving the rejected copy again.
	_, third, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(48*time.Hour))
	if err != nil || len(third) != 1 {
		t.Fatalf("third freeze candidates=%+v err=%v", third, err)
	}
	if third[0].CachedCard != nil {
		t.Fatalf("rejected copy was served again: %+v", third[0].CachedCard)
	}
}

// TestValidateLeavesConcurrentReplacementCacheRowAlone: the invalidation is
// keyed by primary key, so a slow validator cannot clobber a newer row that
// another writer already made current.
func TestValidateLeavesConcurrentReplacementCacheRowAlone(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, groupID := authorOneOnCardRun(t, now)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE digest_card_copy
		SET copy='People clicked save 17 times.'
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID); err != nil {
		t.Fatal(err)
	}
	secondRun, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil || len(second) != 1 || second[0].CachedCard == nil {
		t.Fatalf("second freeze candidates=%+v err=%v", second, err)
	}
	echoCachedPayload(t, pool, secondRun, second[0])

	// A concurrent writer retires the consumed row and makes a newer one current.
	if _, err := pool.Exec(ctx, `UPDATE digest_card_copy SET invalidated_at=now()
		WHERE error_group_id=$1 AND authored_at=$2`, groupID, second[0].CachedCard.AuthoredAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_card_copy
		(error_group_id,spell_started_at,authored_at,input_fingerprint,title,copy,action,model,prompt_version)
		VALUES ($1,$2,now(),$3,'Newer title','Newer copy.','Review the investigation.','test',5)`,
		groupID, *second[0].SpellStartedAt, second[0].Fingerprint); err != nil {
		t.Fatal(err)
	}

	if err := ValidateAndPublish(ctx, pool, secondRun); err != nil {
		t.Fatal(err)
	}
	var survivingCopy string
	if err := pool.QueryRow(ctx, `SELECT copy FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID).Scan(&survivingCopy); err != nil {
		t.Fatalf("the newer concurrent row did not survive: %v", err)
	}
	if survivingCopy != "Newer copy." {
		t.Fatalf("surviving current copy = %q, want the newer row", survivingCopy)
	}
}

// TestValidateKeepsCappedRowsInFreezePhase: a capped incident was never
// validated, so claiming it reached the validation phase would misreport the
// run — and the SLA sweep must stay quiet either way.
func TestValidateKeepsCappedRowsInFreezePhase(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture := onCardFixture(t, now)
	ctx := context.Background()
	// Past the ON lane's cap (the renderer's), so the capped branch below is
	// exercised rather than vacuously skipped.
	seeded := make([]string, 0, notify.DigestV4CardCap+2)
	for i := 0; i < notify.DigestV4CardCap+2; i++ {
		groupID := seedOnCardGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction",
			"awaiting_approval", true, "", "The checkout control does not submit.",
			now.Add(-time.Duration(i+1)*time.Hour))
		seedValidatedDiagnosis(t, pool, fixture.ProjectID, groupID, now.Add(-time.Hour))
		seeded = append(seeded, groupID)
	}
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	writeOnCardPayload(t, pool, runID, candidates)
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	selected := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		selected[candidate.ErrorGroupID] = true
	}
	for _, groupID := range seeded {
		var outcome, reason, phase string
		if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code,phase
			FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
			runID, groupID).Scan(&outcome, &reason, &phase); err != nil {
			t.Fatalf("incident %s has no ledger row: %v", groupID, err)
		}
		if selected[groupID] {
			if outcome != "included" || phase != "validation" {
				t.Fatalf("selected incident %s ledger = %s/%s/%s", groupID, outcome, reason, phase)
			}
			continue
		}
		if outcome != "excluded" || reason != reasonCappedOverflow || phase != "freeze" {
			t.Fatalf("capped incident %s ledger = %s/%s/%s, want excluded/capped_overflow/freeze",
				groupID, outcome, reason, phase)
		}
	}
	report, err := CheckDeliverySLA(ctx, pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.ReconciliationFailures) != 0 {
		t.Fatalf("SLA reported the capped run: %+v", report.ReconciliationFailures)
	}
}

// TestValidateGroundsCachedCardTitleAgainstMovedCounts: the fingerprint
// deliberately excludes counts, so nothing retires a cached card when the count
// moves. A count baked into the cached TITLE therefore survived forever beside a
// context line showing the live number. Grounding runs for cached cards too.
func TestValidateGroundsCachedCardTitleAgainstMovedCounts(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	pool, fixture, groupID := authorOneOnCardRun(t, now)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `UPDATE digest_card_copy
		SET title='Saving is blocked for 2 people'
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID); err != nil {
		t.Fatal(err)
	}
	// The day the count moves, the cached "2" stops being a fact.
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET affected_users_count=5 WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}

	secondRun, second, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now.Add(24*time.Hour))
	if err != nil || len(second) != 1 || second[0].CachedCard == nil {
		t.Fatalf("second freeze candidates=%+v err=%v", second, err)
	}
	if second[0].AffectedUsers != 5 {
		t.Fatalf("frozen affected users = %d, want the moved count 5", second[0].AffectedUsers)
	}
	echoCachedPayload(t, pool, secondRun, second[0])
	if err := ValidateAndPublish(ctx, pool, secondRun); err != nil {
		t.Fatal(err)
	}
	payload := renderedEvent(t, pool, secondRun).Digest
	for _, card := range payload.GeneratedCards {
		if strings.Contains(card.Title, "2 people") {
			t.Fatalf("stale count in a cached title was delivered: %+v", card)
		}
	}
	if len(payload.GeneratedCards) != 0 || len(payload.ReceiptItems) != 1 {
		t.Fatalf("stale cached card was not demoted to its receipt: %+v", payload.GeneratedCards)
	}
	var current int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_card_copy
		WHERE error_group_id=$1 AND invalidated_at IS NULL`, groupID).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != 0 {
		t.Fatalf("stale cached row is still current (%d rows); the title repeats forever", current)
	}
}
