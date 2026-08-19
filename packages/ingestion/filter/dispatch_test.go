package filter

import (
	"context"
	"testing"
	"time"
)

func TestDispatcherFreezesAnchorsBeforeEnqueueingInquiry(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	for range 3 {
		seedIdentifiedEvent(t, pool, f, time.Now())
	}

	evaluated, enqueued, err := (&Dispatcher{pool: pool, projectID: f.projectID}).Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if evaluated != 1 || enqueued != 1 {
		t.Fatalf("Tick = evaluated:%d enqueued:%d, want 1/1", evaluated, enqueued)
	}
	var anchors, jobs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_evidence_anchors WHERE project_id=$1 AND episode_id=$2`,
		f.projectID, f.episodeID).Scan(&anchors); err != nil {
		t.Fatalf("count anchors: %v", err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		f.projectID, f.episodeID).Scan(&jobs); err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if anchors != 3 || jobs != 1 {
		t.Fatalf("anchors/jobs = %d/%d, want 3/1", anchors, jobs)
	}
}

func TestDispatcherDoesNotEnqueueWatchedOrDuplicateAdmittedWork(t *testing.T) {
	pool := testPool(t)
	admitted := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, admitted, time.Now())
	seedIdentifiedEvent(t, pool, admitted, time.Now())
	watched := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, watched, time.Now())
	admittedDispatcher := &Dispatcher{pool: pool, projectID: admitted.projectID}
	watchedDispatcher := &Dispatcher{pool: pool, projectID: watched.projectID}

	for range 3 {
		if _, _, err := admittedDispatcher.Tick(context.Background()); err != nil {
			t.Fatalf("admitted Tick: %v", err)
		}
		if _, _, err := watchedDispatcher.Tick(context.Background()); err != nil {
			t.Fatalf("Tick: %v", err)
		}
	}
	var admittedJobs, watchedJobs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		admitted.projectID, admitted.episodeID).Scan(&admittedJobs); err != nil {
		t.Fatalf("count admitted jobs: %v", err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		watched.projectID, watched.episodeID).Scan(&watchedJobs); err != nil {
		t.Fatalf("count watched jobs: %v", err)
	}
	if admittedJobs != 1 || watchedJobs != 0 {
		t.Fatalf("admitted/watched jobs = %d/%d, want 1/0", admittedJobs, watchedJobs)
	}
}

func TestDispatcherReevaluatesWhenEvidenceGrows(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now())
	dispatcher := &Dispatcher{pool: pool, projectID: f.projectID}
	if _, _, err := dispatcher.Tick(context.Background()); err != nil {
		t.Fatalf("first Tick: %v", err)
	}
	seedIdentifiedEvent(t, pool, f, time.Now())

	evaluated, enqueued, err := dispatcher.Tick(context.Background())
	if err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if evaluated != 1 || enqueued != 1 {
		t.Fatalf("second Tick = evaluated:%d enqueued:%d, want 1/1", evaluated, enqueued)
	}
}
