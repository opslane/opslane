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

func seedActionableGroup(t *testing.T, pool *pgxpool.Pool, projectID, environmentID, kind, status string, decidedAt time.Time) (string, string) {
	t.Helper()
	ctx := context.Background()
	var groupID, episodeID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		 occurrence_count,impact_visits,root_cause,suggested_mitigation)
		VALUES ($1,$2,$3,'Dead checkout control',$4,$5,$6,$6,17,23,
		 'The checkout control does not submit.','Repair the submit handler.')
		RETURNING id::text`, projectID, environmentID, "actionable-"+uuid.NewString(), kind, status, decidedAt).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
		(project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id::text`,
		projectID, groupID).Scan(&episodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO issue_decisions
		(project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version,decided_at)
		VALUES ($1,$2,'watch','friction is not evaluated in the error lane',2,0,1,$3)`,
		projectID, episodeID, decidedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
		(error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,model,prompt_version,decided_at)
		VALUES ($1,$2,$3,'not_actionable','validated friction finding',
		 '{"evidence":[{"path":"src/checkout.ts","detail":"click has no handler","symptomLink":"dead click"}]}'::jsonb,
		 'test','1',$4)`, groupID, projectID, episodeID, decidedAt); err != nil {
		t.Fatal(err)
	}
	return groupID, episodeID
}

func cleanupActionableDiagnoses(t *testing.T, pool *pgxpool.Pool, projectID string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("disable diagnosis immutability: %v", err)
			return
		}
		if _, err := pool.Exec(ctx, `DELETE FROM diagnosis_decisions WHERE project_id=$1`, projectID); err != nil {
			t.Errorf("delete actionable diagnoses: %v", err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("enable diagnosis immutability: %v", err)
		}
	})
}

func publishEmptyWrittenRun(t *testing.T, pool *pgxpool.Pool, projectID string, at time.Time) string {
	t.Helper()
	runID, candidates, err := FreezeCandidates(context.Background(), pool, projectID, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("unexpected frozen candidates: %+v", candidates)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE digest_runs
		SET status='written',writer_payload='{"included":[],"deferred":[]}'::jsonb WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	return runID
}

func receiptIDs(t *testing.T, pool *pgxpool.Pool, runID string) []string {
	t.Helper()
	payload := renderedEvent(t, pool, runID)
	ids := make([]string, 0, len(payload.Digest.ReceiptItems))
	for _, item := range payload.Digest.ReceiptItems {
		ids = append(ids, item.IncidentID)
	}
	return ids
}

func renderedEvent(t *testing.T, pool *pgxpool.Pool, runID string) notify.EventPayload {
	t.Helper()
	var raw []byte
	if err := pool.QueryRow(context.Background(), `SELECT rendered_payload FROM digest_runs WHERE id=$1`, runID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var payload notify.EventPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestValidateRepeatsActionableFrictionUntilHumanActs(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	groupID, _ := seedActionableGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval", now.Add(-13*24*time.Hour))
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`, groupID, now.Add(-12*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	firstRun := publishEmptyWrittenRun(t, pool, fixture.ProjectID, now)
	secondRun := publishEmptyWrittenRun(t, pool, fixture.ProjectID, now.Add(24*time.Hour))
	for name, runID := range map[string]string{"first": firstRun, "second": secondRun} {
		ids := receiptIDs(t, pool, runID)
		if len(ids) != 1 || ids[0] != groupID {
			t.Fatalf("%s digest receipts = %v, want %s", name, ids, groupID)
		}
		var outcome, reason string
		if err := pool.QueryRow(ctx, `SELECT outcome,primary_reason_code
			FROM digest_run_candidate_evaluations WHERE digest_run_id=$1 AND error_group_id=$2`,
			runID, groupID).Scan(&outcome, &reason); err != nil {
			t.Fatal(err)
		}
		if outcome != "included" || reason != "included" {
			t.Fatalf("%s ledger = %s/%s", name, outcome, reason)
		}
	}
	firstPayload := renderedEvent(t, pool, firstRun)
	slackBody, _, err := notify.FormatSlack(firstPayload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(slackBody), "waiting on you since") ||
		!strings.Contains(string(slackBody), "(12 days)") {
		t.Fatalf("first Slack digest omitted actionable age: %s", slackBody)
	}

	if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, groupID, now.Add(48*time.Hour)); err != nil {
		t.Fatal(err)
	}
	snoozedRun := publishEmptyWrittenRun(t, pool, fixture.ProjectID, now.Add(48*time.Hour))
	if ids := receiptIDs(t, pool, snoozedRun); len(ids) != 0 {
		t.Fatalf("snoozed digest receipts = %v", ids)
	}
	var reason string
	if err := pool.QueryRow(ctx, `SELECT primary_reason_code FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, snoozedRun, groupID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "snoozed" {
		t.Fatalf("snoozed ledger reason = %q", reason)
	}

	if _, err := pool.Exec(ctx, `UPDATE error_groups SET status='resolved' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	resolvedRun := publishEmptyWrittenRun(t, pool, fixture.ProjectID, now.Add(72*time.Hour))
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, resolvedRun, groupID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("resolved group has %d ledger rows", count)
	}
}

func TestValidateFrozenCardOwnsActionableDuplicateAndDeliveredRetryIsSafe(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)
	if _, err := pool.Exec(ctx, `UPDATE projects SET github_repo='acme/shop' WHERE id=$1`, fixture.ProjectID); err != nil {
		t.Fatal(err)
	}
	episodeID := seedFreezeEpisode(t, pool, fixture.ProjectID, fixture.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, fixture.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))
	var groupID string
	if err := pool.QueryRow(ctx, `SELECT canonical_issue_id::text FROM issue_episodes WHERE id=$1`, episodeID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO issue_decisions
		(project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version,decided_at)
		VALUES ($1,$2,'open_inquiry','test',2,0,1,$3)`, fixture.ProjectID, episodeID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups
		SET status='needs_human',candidate_diff='diff --git a/a b/a' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	runID, candidates, err := FreezeCandidates(ctx, pool, fixture.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze candidates=%d err=%v", len(candidates), err)
	}
	body := validWrittenPayload(candidates[0])
	if _, err := pool.Exec(ctx, `UPDATE digest_runs SET status='written',writer_payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatalf("delivered retry: %v", err)
	}
	if ids := receiptIDs(t, pool, runID); len(ids) != 0 {
		t.Fatalf("duplicate actionable receipt rendered beside frozen card: %v", ids)
	}
	var reason string
	if err := pool.QueryRow(ctx, `SELECT primary_reason_code FROM digest_run_candidate_evaluations
		WHERE digest_run_id=$1 AND error_group_id=$2`, runID, groupID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "frozen_lane_owns" {
		t.Fatalf("ledger reason = %q", reason)
	}
}

func TestLoadActionableCandidatesKeepsEveryLedgerCandidateOnce(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fixture := seedDigestFixture(t, pool, now)
	cleanupActionableDiagnoses(t, pool, fixture.ProjectID)

	var noDiagnosisID, noEpisodeID string
	for _, seed := range []struct {
		kind string
		id   *string
	}{
		{kind: "friction", id: &noDiagnosisID},
		{kind: "error", id: &noEpisodeID},
	} {
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
			VALUES ($1,$2,$3,'candidate',$4,'awaiting_approval',$5,$5) RETURNING id::text`,
			fixture.ProjectID, fixture.EnvID, "candidate-"+uuid.NewString(), seed.kind, now).Scan(seed.id); err != nil {
			t.Fatal(err)
		}
	}
	multipleID, episodeID := seedActionableGroup(t, pool, fixture.ProjectID, fixture.EnvID, "friction", "awaiting_approval", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
		(error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,model,prompt_version,decided_at)
		VALUES ($1,$2,$3,'needs_more_context','older row','{}','test','1',$4)`,
		multipleID, fixture.ProjectID, episodeID, now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	candidates, err := loadActionableCandidates(ctx, tx, fixture.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]int)
	byID := make(map[string]actionableCandidate)
	for _, candidate := range candidates {
		seen[candidate.GroupID]++
		byID[candidate.GroupID] = candidate
	}
	for _, id := range []string{noDiagnosisID, noEpisodeID, multipleID} {
		if seen[id] != 1 {
			t.Errorf("candidate %s rows = %d, all=%s", id, seen[id], fmt.Sprint(seen))
		}
	}
	if byID[noDiagnosisID].HasValidatedDiagnosis {
		t.Error("diagnosis-less friction candidate was marked validated")
	}
	if byID[noEpisodeID].ErrorLaneEligible {
		t.Error("episode-less error candidate was marked error-lane eligible")
	}
	evaluation := evaluateActionable(candidates, nil, now)
	if evaluation.Excluded[noDiagnosisID] != "not_publishable" {
		t.Errorf("diagnosis-less reason=%q", evaluation.Excluded[noDiagnosisID])
	}
	if evaluation.Excluded[noEpisodeID] != "error_lane_ineligible" {
		t.Errorf("episode-less error reason=%q", evaluation.Excluded[noEpisodeID])
	}
	if len(evaluation.Included) != 1 || evaluation.Included[0].GroupID != multipleID {
		t.Errorf("multiple-diagnosis candidate was not included exactly once: %+v", evaluation.Included)
	}
}
