package identity

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEpisodeReopensAsReturnedAfterResolution(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	issueID := seedIssue(t, pool, f, uniqueFingerprint("episode"))

	first := mustOpenEpisode(t, pool, f.ProjectID, issueID)
	same := mustOpenEpisode(t, pool, f.ProjectID, issueID)
	if first != same {
		t.Errorf("an open episode must be reused, got %s then %s", first, same)
	}
	mustCloseEpisode(t, pool, f.ProjectID, first)
	second := mustOpenEpisode(t, pool, f.ProjectID, issueID)
	if second == first {
		t.Error("a recurrence after resolution must open a new episode")
	}
	var sequence int
	if err := pool.QueryRow(ctx,
		`SELECT sequence FROM issue_episodes WHERE project_id=$1 AND id=$2`,
		f.ProjectID, second).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if sequence != 2 {
		t.Errorf("sequence = %d, want 2", sequence)
	}
}

func TestOnlyOneEpisodeOpenPerIssue(t *testing.T) {
	pool := testPool(t)
	f := seedProject(t, pool)
	issueID := seedIssue(t, pool, f, uniqueFingerprint("concurrent-episode"))

	const callers = 8
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	ids := make(chan string, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := openEpisodeRaw(pool, f.ProjectID, issueID)
			if err != nil {
				errs <- err
				return
			}
			ids <- id
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		t.Errorf("open episode concurrently: %v", err)
	}
	var first string
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Errorf("concurrent caller got episode %s, want %s", id, first)
		}
	}
	var open int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`,
		f.ProjectID, issueID).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 1 {
		t.Errorf("open episodes = %d, want 1", open)
	}
}

func TestEpisodeOperationsAreProjectScoped(t *testing.T) {
	pool := testPool(t)
	a := seedProject(t, pool)
	b := seedProject(t, pool)
	issueID := seedIssue(t, pool, a, uniqueFingerprint("scoped-episode"))

	if _, err := openEpisodeRaw(pool, b.ProjectID, issueID); err == nil {
		t.Fatal("opening an episode through the wrong project must fail")
	}
	episodeID := mustOpenEpisode(t, pool, a.ProjectID, issueID)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := CloseEpisode(context.Background(), tx, b.ProjectID, episodeID); err == nil {
		t.Fatal("closing an episode through the wrong project must fail")
	}
}

func mustOpenEpisode(t *testing.T, pool *pgxpool.Pool, projectID, issueID string) string {
	t.Helper()
	id, err := openEpisodeRaw(pool, projectID, issueID)
	if err != nil {
		t.Fatalf("open episode: %v", err)
	}
	return id
}

func openEpisodeRaw(pool *pgxpool.Pool, projectID, issueID string) (string, error) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	id, err := OpenOrGetEpisode(ctx, tx, projectID, issueID)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func mustCloseEpisode(t *testing.T, pool *pgxpool.Pool, projectID, episodeID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := CloseEpisode(ctx, tx, projectID, episodeID); err != nil {
		t.Fatalf("close episode: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// Resolution must close the open round no matter which runtime resolved the
// issue: the Go endpoint and both worker auto-resolvers all write the same
// status transition, and the migration-055 trigger owns the close.
func TestResolutionTransitionClosesOpenEpisodes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	issueID := seedIssue(t, pool, f, uniqueFingerprint("trigger"))
	episodeID := mustOpenEpisode(t, pool, f.ProjectID, issueID)

	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='resolved', resolved_at=now()
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, issueID); err != nil {
		t.Fatal(err)
	}
	var closedMatchesResolved bool
	if err := pool.QueryRow(ctx,
		`SELECT ep.closed_at IS NOT NULL AND ep.closed_at = g.resolved_at
		   FROM issue_episodes ep JOIN error_groups g ON g.id=ep.canonical_issue_id
		  WHERE ep.project_id=$1 AND ep.id=$2`,
		f.ProjectID, episodeID).Scan(&closedMatchesResolved); err != nil {
		t.Fatal(err)
	}
	if !closedMatchesResolved {
		t.Error("resolving the issue must close its open episode at resolved_at")
	}

	// The reopen transition (resolved -> new) must not fire the trigger or
	// invent rounds; the next observation opens round two through settlement.
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='new', resolved_at=NULL
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, issueID); err != nil {
		t.Fatal(err)
	}
	var episodes, open int
	if err := pool.QueryRow(ctx,
		`SELECT count(*), count(*) FILTER (WHERE closed_at IS NULL)
		   FROM issue_episodes WHERE project_id=$1 AND canonical_issue_id=$2`,
		f.ProjectID, issueID).Scan(&episodes, &open); err != nil {
		t.Fatal(err)
	}
	if episodes != 1 || open != 0 {
		t.Errorf("after reopen: episodes=%d open=%d, want 1 closed round only", episodes, open)
	}
	second := mustOpenEpisode(t, pool, f.ProjectID, issueID)
	if second == episodeID {
		t.Error("the next round after resolution must be a new episode")
	}

	// A non-resolution transition leaves rounds alone: 'merged' is closed
	// explicitly by ConfirmMerge, never by this trigger.
	otherID := seedIssue(t, pool, f, uniqueFingerprint("trigger-merged"))
	otherEpisode := mustOpenEpisode(t, pool, f.ProjectID, otherID)
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='merged', merged_at=now()
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, otherID); err != nil {
		t.Fatal(err)
	}
	var stillOpen bool
	if err := pool.QueryRow(ctx,
		`SELECT closed_at IS NULL FROM issue_episodes WHERE project_id=$1 AND id=$2`,
		f.ProjectID, otherEpisode).Scan(&stillOpen); err != nil {
		t.Fatal(err)
	}
	if !stillOpen {
		t.Error("a merged transition must not close episodes through the resolution trigger")
	}
}
