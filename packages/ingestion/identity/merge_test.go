package identity

import (
	"context"
	"testing"
)

func TestConfirmMergeRedirectsAliasesAndRebuildsCounters(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 3)
	loser := seedIssueWithEvents(t, pool, f, 2)

	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("ConfirmMerge: %v", err)
	}
	var pointing int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM canonical_issue_fingerprints
		  WHERE project_id=$1 AND canonical_issue_id=$2`, f.ProjectID, winner).Scan(&pointing); err != nil {
		t.Fatal(err)
	}
	if pointing < 2 {
		t.Errorf("winner holds %d aliases, want at least 2", pointing)
	}
	var occurrences int
	if err := pool.QueryRow(ctx,
		`SELECT occurrence_count FROM error_groups WHERE project_id=$1 AND id=$2`,
		f.ProjectID, winner).Scan(&occurrences); err != nil {
		t.Fatal(err)
	}
	if occurrences != 5 {
		t.Errorf("occurrence_count = %d, want 5", occurrences)
	}
	var environmentOccurrences int
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(sum(occurrence_count),0) FROM error_group_environments
		  WHERE error_group_id=$1`, winner).Scan(&environmentOccurrences); err != nil {
		t.Fatal(err)
	}
	if environmentOccurrences != 5 {
		t.Errorf("environment occurrence_count = %d, want 5", environmentOccurrences)
	}
	var loserStatus string
	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM error_groups WHERE project_id=$1 AND id=$2`,
		f.ProjectID, loser).Scan(&loserStatus); err != nil {
		t.Fatal(err)
	}
	if loserStatus != "merged" {
		t.Errorf("loser status = %q, want merged", loserStatus)
	}
	var audited, openLoserEpisodes int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_merges
		  WHERE project_id=$1 AND winner_id=$2 AND loser_id=$3`,
		f.ProjectID, winner, loser).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`,
		f.ProjectID, loser).Scan(&openLoserEpisodes); err != nil {
		t.Fatal(err)
	}
	if audited != 1 || openLoserEpisodes != 0 {
		t.Errorf("audit rows=%d open loser episodes=%d, want 1 and 0", audited, openLoserEpisodes)
	}
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("idempotent ConfirmMerge retry: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_merges
		  WHERE project_id=$1 AND winner_id=$2 AND loser_id=$3`,
		f.ProjectID, winner, loser).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Errorf("merge retry wrote %d audit rows, want 1", audited)
	}
}

func TestConfirmMergeRefusesAutomaticMergeAfterInvestigationOrPublication(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	for _, blocker := range []string{"investigation", "publication"} {
		t.Run(blocker, func(t *testing.T) {
			winner := seedIssueWithEvents(t, pool, f, 2)
			loser := seedIssueWithEvents(t, pool, f, 2)
			seedMergeBlocker(t, pool, f, loser, blocker)
			if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "model", "inquiry"); err == nil {
				t.Errorf("%s should block an automatic merge", blocker)
			}
		})
	}
}

func TestRebuiltCountersMatchAbsoluteReconstruction(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 7)
	loser := seedIssueWithEvents(t, pool, f, 4)
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("ConfirmMerge: %v", err)
	}
	var stored, absolute int
	if err := pool.QueryRow(ctx,
		`SELECT occurrence_count FROM error_groups WHERE project_id=$1 AND id=$2`,
		f.ProjectID, winner).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_events e
		   JOIN error_event_identities i
		     ON i.project_id=e.project_id AND i.event_id=e.id
		  WHERE i.project_id=$1 AND i.canonical_issue_id=$2 AND i.status='settled'`,
		f.ProjectID, winner).Scan(&absolute); err != nil {
		t.Fatal(err)
	}
	if stored != absolute {
		t.Errorf("counter drift: stored %d, reconstructed %d", stored, absolute)
	}
}

func TestConfirmMergeRejectsSelfAndCrossProjectMerges(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	a := seedProject(t, pool)
	b := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, a, 1)
	otherProjectIssue := seedIssueWithEvents(t, pool, b, 1)
	if err := ConfirmMerge(ctx, pool, a.ProjectID, winner, winner, "human", "operator"); err == nil {
		t.Error("self merge must fail")
	}
	if err := ConfirmMerge(ctx, pool, a.ProjectID, winner, otherProjectIssue, "human", "operator"); err == nil {
		t.Error("cross-project merge must fail")
	}
}

// The worker's silent-merged sweep relabels quiet losers 'resolved'; a retried
// merge must still recognize its receipt instead of re-running or erroring.
func TestConfirmMergeStaysIdempotentAfterLoserRelabeledResolved(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 1)
	loser := seedIssueWithEvents(t, pool, f, 1)
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("first merge: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='resolved', resolved_at=now()
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, loser); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("retried merge after relabel: %v", err)
	}
	var receipts int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_merges WHERE project_id=$1 AND loser_id=$2`,
		f.ProjectID, loser).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Errorf("receipts = %d, want 1", receipts)
	}
	var otherWinner string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&otherWinner); err != nil {
		t.Fatal(err)
	}
	_ = otherWinner
	third := seedIssueWithEvents(t, pool, f, 1)
	if err := ConfirmMerge(ctx, pool, f.ProjectID, third, loser, "human", "operator"); err == nil {
		t.Error("merging an already-merged loser into a different winner must be refused")
	}
}

// Merging into a resolved winner must not leave an open round under it: the
// merged-in observations join the already-told story.
func TestConfirmMergeIntoResolvedWinnerLeavesNoOpenRound(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 1)
	loser := seedIssueWithEvents(t, pool, f, 1)
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='resolved', resolved_at=now()
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, winner); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("merge into resolved winner: %v", err)
	}
	var open int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`,
		f.ProjectID, winner).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 0 {
		t.Errorf("open rounds under resolved winner = %d, want 0", open)
	}
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM error_groups WHERE project_id=$1 AND id=$2`,
		f.ProjectID, winner).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "resolved" {
		t.Errorf("winner status = %q, want resolved", status)
	}
}

// Once a merge moots a recorded disagreement, the parked observations re-enter
// settlement instead of staying orphaned in the conflict state.
func TestConfirmMergeRequeuesConflictedObservations(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 1)
	loser := seedIssueWithEvents(t, pool, f, 1)
	var eventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id,environment_id,timestamp,error_type,error_message,stack_trace_raw,platform)
		 VALUES ($1,$2,now(),'TypeError','conflicted','at c.js:1:1','javascript')
		 RETURNING id`, f.ProjectID, f.EnvironmentID).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_identities
		   (project_id,event_id,status,raw_fingerprint,identity_version)
		 VALUES ($1,$2,'conflict',$3,$4)`,
		f.ProjectID, eventID, uniqueFingerprint("confl"), IdentityVersion); err != nil {
		t.Fatal(err)
	}
	left, right := winner, loser
	if left > right {
		left, right = right, left
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO issue_alias_conflicts (project_id,event_id,left_issue_id,right_issue_id)
		 VALUES ($1,$2,$3,$4)`, f.ProjectID, eventID, left, right); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err != nil {
		t.Fatalf("merge: %v", err)
	}
	var identityStatus, conflictStatus string
	if err := pool.QueryRow(ctx,
		`SELECT i.status, c.status FROM error_event_identities i
		   JOIN issue_alias_conflicts c ON c.project_id=i.project_id AND c.event_id=i.event_id
		  WHERE i.project_id=$1 AND i.event_id=$2`,
		f.ProjectID, eventID).Scan(&identityStatus, &conflictStatus); err != nil {
		t.Fatal(err)
	}
	if conflictStatus != "resolved" {
		t.Errorf("conflict status = %q, want resolved", conflictStatus)
	}
	if identityStatus != "pending" {
		t.Errorf("identity status = %q, want pending (requeued for settlement)", identityStatus)
	}
}

// The absolute rebuild only understands settled identities, so a merge over a
// population it would silently miscount is refused loudly.
func TestConfirmMergeRefusesUnsettledPopulations(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	winner := seedIssueWithEvents(t, pool, f, 1)
	loser := seedIssueWithEvents(t, pool, f, 1)
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_events
		   (project_id,environment_id,error_group_id,timestamp,error_type,error_message,stack_trace_raw,platform)
		 VALUES ($1,$2,$3,now(),'TypeError','legacy event','at l.js:1:1','javascript')`,
		f.ProjectID, f.EnvironmentID, loser); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmMerge(ctx, pool, f.ProjectID, winner, loser, "human", "operator"); err == nil {
		t.Error("merge over an event without settled identity must be refused")
	}
	var receipts int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_merges WHERE project_id=$1 AND loser_id=$2`,
		f.ProjectID, loser).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Errorf("receipts = %d, want 0", receipts)
	}
}
