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

func TestDispatcherReopensWaitingInquiryAtHalfAgainGrowth(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now())
	seedIdentifiedEvent(t, pool, f, time.Now())
	dispatcher := &Dispatcher{pool: pool, projectID: f.projectID}
	if _, enqueued, err := dispatcher.Tick(context.Background()); err != nil || enqueued != 1 {
		t.Fatalf("first Tick = enqueued:%d err:%v, want 1/nil", enqueued, err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_group_jobs SET status='completed'
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		f.projectID, f.episodeID); err != nil {
		t.Fatalf("complete first inquiry: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO issue_inquiry_decisions
		   (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		 VALUES ($1,$2,'wait_for_more_evidence','need another affected unit',2,'sig-1','test',$3)`,
		f.projectID, f.episodeID, InquiryPromptVersion); err != nil {
		t.Fatalf("seed waiting decision: %v", err)
	}
	seedIdentifiedEvent(t, pool, f, time.Now())

	_, enqueued, err := dispatcher.Tick(context.Background())
	if err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if enqueued != 1 {
		t.Fatalf("second Tick enqueued = %d, want 1", enqueued)
	}
	var jobs int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		f.projectID, f.episodeID).Scan(&jobs); err != nil {
		t.Fatalf("count inquiry jobs: %v", err)
	}
	if jobs != 2 {
		t.Fatalf("inquiry jobs = %d, want 2", jobs)
	}
}

func TestDispatcherDoesNotReopenInquiryBelowGrowthGate(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	for range 4 {
		seedIdentifiedEvent(t, pool, f, time.Now())
	}
	dispatcher := &Dispatcher{pool: pool, projectID: f.projectID}
	if _, enqueued, err := dispatcher.Tick(context.Background()); err != nil || enqueued != 1 {
		t.Fatalf("first Tick = enqueued:%d err:%v, want 1/nil", enqueued, err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_group_jobs SET status='completed'
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		f.projectID, f.episodeID); err != nil {
		t.Fatalf("complete first inquiry: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO issue_inquiry_decisions
		   (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		 VALUES ($1,$2,'do_not_pursue','not a product defect',4,'sig-1','test',$3)`,
		f.projectID, f.episodeID, InquiryPromptVersion); err != nil {
		t.Fatalf("seed rejected decision: %v", err)
	}
	seedIdentifiedEvent(t, pool, f, time.Now())

	_, enqueued, err := dispatcher.Tick(context.Background())
	if err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if enqueued != 0 {
		t.Fatalf("second Tick enqueued = %d, want 0", enqueued)
	}
}

func TestDispatcherPromptVersionDrainRequiresNewEvidence(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now())
	seedIdentifiedEvent(t, pool, f, time.Now())
	dispatcher := &Dispatcher{pool: pool, projectID: f.projectID}
	if _, enqueued, err := dispatcher.Tick(context.Background()); err != nil || enqueued != 1 {
		t.Fatalf("first Tick = enqueued:%d err:%v, want 1/nil", enqueued, err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE error_group_jobs SET status='completed'
		  WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		f.projectID, f.episodeID); err != nil {
		t.Fatalf("complete first inquiry: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO issue_inquiry_decisions
		   (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		 VALUES ($1,$2,'wait_for_more_evidence','old prompt',2,'sig-1','test',$3)`,
		f.projectID, f.episodeID, InquiryPromptVersion-1); err != nil {
		t.Fatalf("seed old decision: %v", err)
	}

	// A stale prompt version alone must not reopen: without a factual
	// decision newer than the last inquiry job, re-admission would re-run the
	// same review every tick (and, on a one-sided prompt bump, forever).
	_, enqueued, err := dispatcher.Tick(context.Background())
	if err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if enqueued != 0 {
		t.Fatalf("second Tick enqueued = %d, want 0 (prompt bump alone must not reopen)", enqueued)
	}

	// New settled evidence appends a fresh factual decision, and that pays
	// for one re-admission — which then reviews under the current prompt.
	seedIdentifiedEvent(t, pool, f, time.Now())
	_, enqueued, err = dispatcher.Tick(context.Background())
	if err != nil {
		t.Fatalf("third Tick: %v", err)
	}
	if enqueued != 1 {
		t.Fatalf("third Tick enqueued = %d, want 1 (new evidence drains the stale prompt)", enqueued)
	}
}
