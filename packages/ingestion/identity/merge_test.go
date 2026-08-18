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
