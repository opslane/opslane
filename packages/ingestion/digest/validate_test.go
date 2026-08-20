package digest

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func seedWrittenFreezeRun(t *testing.T, pool *pgxpool.Pool, payload func(Candidate) string) (string, string, Candidate) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET github_repo='acme/shop' WHERE id=$1`, f.ProjectID); err != nil {
		t.Fatal(err)
	}
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", now.Add(-time.Hour))
	runID, candidates, err := FreezeCandidates(context.Background(), pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze written run: candidates=%d err=%v", len(candidates), err)
	}
	body := payload(candidates[0])
	if _, err := pool.Exec(context.Background(), `
		UPDATE digest_runs SET status='written',payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	return runID, f.ProjectID, candidates[0]
}

func validWrittenPayload(candidate Candidate) string {
	return fmt.Sprintf(`{"included":[{"episodeId":%q,"copy":"Checkout is blocked before payment.","action":"Review the verified fix","label":"new","claimedUsers":%d,"accounts":[],"prUrl":%q}],"deferred":[]}`,
		candidate.EpisodeID, candidate.AffectedUsers, candidate.PRURL)
}

func TestValidateRejectsInventedLinks(t *testing.T) {
	pool := testPool(t)
	runID, _, _ := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
		return fmt.Sprintf(`{"included":[{"episodeId":%q,"copy":"x","action":"Review","label":"new","prUrl":"https://github.com/other/repo/pull/1"}],"deferred":[]}`,
			candidate.EpisodeID)
	})
	err := ValidateAndPublish(context.Background(), pool, runID)
	if err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("expected a link rejection, got %v", err)
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
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1 AND channel='digest'`, projectID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if outbox != 1 {
		t.Errorf("outbox events = %d, want 1", outbox)
	}
	if receipts != 1 {
		t.Errorf("publication receipts = %d, want 1", receipts)
	}
}

func TestFailedRunDoesNotAdvanceTheWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	runID, projectID, _ := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
		return fmt.Sprintf(`{"included":[{"episodeId":%q,"copy":"x","action":"Review","label":"new","prUrl":"https://evil.example/pull/1"}],"deferred":[]}`,
			candidate.EpisodeID)
	})
	_ = ValidateAndPublish(ctx, pool, runID)

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Errorf("status = %q, want failed", status)
	}
	var receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM issue_publications
		WHERE project_id=$1 AND channel='digest'`, projectID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Errorf("a failed run must write no receipts, got %d", receipts)
	}
}

func TestValidateRejectsCandidateSupersededAfterFreeze(t *testing.T) {
	pool := testPool(t)
	runID, projectID, candidate := seedWrittenFreezeRun(t, pool, validWrittenPayload)
	if _, err := pool.Exec(context.Background(), `INSERT INTO issue_inquiry_decisions
		(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version,decided_at)
		VALUES ($1,$2,'do_not_pursue','new evidence changed the decision',1,$3,'test',1,$4)`,
		projectID, candidate.EpisodeID, "superseded-"+candidate.EpisodeID,
		candidate.DecidedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	err := ValidateAndPublish(context.Background(), pool, runID)
	if err == nil || !strings.Contains(err.Error(), "latest decision changed") {
		t.Fatalf("expected stale candidate rejection, got %v", err)
	}
}
