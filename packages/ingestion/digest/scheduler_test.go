package digest

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func scheduledRunFixture(t *testing.T, at time.Time) (*Scheduler, string, string) {
	t.Helper()
	pool := testPool(t)
	f := seedDigestFixture(t, pool, at)
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET github_repo='acme/shop',digest_timezone='UTC' WHERE id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, at.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", at.Add(-time.Hour))
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM error_group_jobs WHERE project_id=$1`, f.ProjectID); err != nil {
			t.Errorf("delete scheduler jobs: %v", err)
		}
	})
	return &Scheduler{pool: pool, now: func() time.Time { return at }}, f.ProjectID, episodeID
}

func TestSchedulerFreezesOncePerDailyBoundary(t *testing.T) {
	at := time.Now().UTC().Truncate(24 * time.Hour).Add(9*time.Hour + time.Minute)
	s, projectID, _ := scheduledRunFixture(t, at)
	for i := range 3 {
		if err := s.Tick(context.Background()); err != nil {
			t.Fatalf("Tick %d: %v", i, err)
		}
	}
	var runs, jobs int
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM digest_runs WHERE project_id=$1`, projectID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM error_group_jobs
		WHERE project_id=$1 AND job_type='digest_write'`, projectID).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || jobs != 1 {
		t.Errorf("runs=%d jobs=%d, want one of each", runs, jobs)
	}
}

func TestSchedulerPublishesAWrittenRun(t *testing.T) {
	at := time.Now().UTC().Truncate(24 * time.Hour).Add(9*time.Hour + time.Minute)
	s, projectID, _ := scheduledRunFixture(t, at)
	runID, candidates, err := FreezeCandidates(context.Background(), s.pool, projectID, at)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze: candidates=%d err=%v", len(candidates), err)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE digest_runs SET status='written',payload=$2::jsonb WHERE id=$1`,
		runID, validWrittenPayload(candidates[0])); err != nil {
		t.Fatal(err)
	}
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := s.pool.QueryRow(context.Background(), `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "delivered" {
		t.Errorf("status=%q, want delivered", status)
	}
}

func TestSchedulerRetriesTheSameFrozenSet(t *testing.T) {
	at := time.Now().UTC().Truncate(24 * time.Hour).Add(9*time.Hour + time.Minute)
	s, projectID, _ := scheduledRunFixture(t, at)
	runID, candidates, err := FreezeCandidates(context.Background(), s.pool, projectID, at)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze: candidates=%d err=%v", len(candidates), err)
	}
	bad := fmt.Sprintf(`{"included":[{"episodeId":%q,"copy":"x","action":"Review","label":"new","prUrl":"https://evil.example/pull/1"}],"deferred":[]}`,
		candidates[0].EpisodeID)
	if _, err := s.pool.Exec(context.Background(), `UPDATE digest_runs SET status='written',payload=$2::jsonb WHERE id=$1`, runID, bad); err != nil {
		t.Fatal(err)
	}
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Work arriving later cannot join this run.
	fresh := seedFreezeEpisode(t, s.pool, projectID, func() string {
		var id string
		if err := s.pool.QueryRow(context.Background(), `SELECT default_environment_id::text FROM projects WHERE id=$1`, projectID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}(), at, 1)
	seedFreezeDiagnosis(t, s.pool, projectID, fresh, "needs_human", at)
	if _, err := s.pool.Exec(context.Background(), `UPDATE digest_runs SET status='written',payload=$2::jsonb WHERE id=$1`,
		runID, validWrittenPayload(candidates[0])); err != nil {
		t.Fatal(err)
	}
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	var items int
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM digest_run_items WHERE run_id=$1`, runID).Scan(&items); err != nil {
		t.Fatal(err)
	}
	if items != 1 {
		t.Errorf("frozen items=%d, want 1", items)
	}
}
