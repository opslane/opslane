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
	"github.com/opslane/opslane/packages/ingestion/notify"
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

func TestValidatePublishesSchemaV4GroundedCard(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	t.Setenv("DASHBOARD_URL", "https://dashboard.example")
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET occurrence_count=34,pr_url=''
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1)`, episodeID); err != nil {
		t.Fatal(err)
	}
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "needs_human", now.Add(-time.Hour))
	seedFreezeReplay(t, pool, f.ProjectID, f.EnvID, episodeID, "sess-123", time.UnixMilli(4200).UTC())
	runID, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("freeze: candidates=%d err=%v", len(candidates), err)
	}
	candidate := candidates[0]
	body := fmt.Sprintf(`{"included":[{"episodeId":%q,"title":"Send invoice does nothing","copy":"Checkout is blocked before payment.","action":"Watch the replay and decide whether to ship.","label":"new","claimedOccurrences":34,"accounts":[]}],"deferred":[]}`, candidate.EpisodeID)
	if _, err := pool.Exec(ctx, `UPDATE digest_runs SET status='written',payload=$2::jsonb WHERE id=$1`, runID, body); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	if err := ValidateAndPublish(ctx, pool, runID); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT rendered_payload FROM digest_runs WHERE id=$1`, runID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var published notify.EventPayload
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatal(err)
	}
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

func TestValidateRejectsUnsupportedOccurrenceAndTitleVocabulary(t *testing.T) {
	tests := []struct {
		name string
		card func(Candidate) string
		want string
	}{
		{"occurrence", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"episodeId":%q,"title":"Checkout is blocked","copy":"x","action":"Review","label":"new","claimedOccurrences":%d}],"deferred":[]}`,
				candidate.EpisodeID, candidate.OccurrenceCount+1)
		}, "unsupported occurrence count"},
		{"title vocabulary", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"episodeId":%q,"title":"needs_human checkout","copy":"x","action":"Review","label":"new"}],"deferred":[]}`, candidate.EpisodeID)
		}, "internal vocabulary"},
		{"title cap", func(candidate Candidate) string {
			return fmt.Sprintf(`{"included":[{"episodeId":%q,"title":%q,"copy":"x","action":"Review","label":"new"}],"deferred":[]}`,
				candidate.EpisodeID, strings.Repeat("x", 81))
		}, "exceeds 80 characters"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			runID, _, _ := seedWrittenFreezeRun(t, pool, tc.card)
			err := ValidateAndPublish(context.Background(), pool, runID)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q error, got %v", tc.want, err)
			}
		})
	}
}

func TestValidateGroundsNumbersInAllProseFields(t *testing.T) {
	for _, field := range []string{"title", "copy", "action"} {
		t.Run(field, func(t *testing.T) {
			pool := testPool(t)
			runID, _, _ := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
				title, copy, action := "Checkout is blocked", "Payment stopped", "Review it"
				switch field {
				case "title":
					title += " 99"
				case "copy":
					copy += " 99"
				case "action":
					action += " 99"
				}
				return fmt.Sprintf(`{"included":[{"episodeId":%q,"title":%q,"copy":%q,"action":%q,"label":"new"}],"deferred":[]}`,
					candidate.EpisodeID, title, copy, action)
			})
			err := ValidateAndPublish(context.Background(), pool, runID)
			if err == nil || !strings.Contains(err.Error(), "ungrounded number 99") {
				t.Fatalf("got %v", err)
			}
		})
	}

	pool := testPool(t)
	runID, _, _ := seedWrittenFreezeRun(t, pool, func(candidate Candidate) string {
		return fmt.Sprintf(`{"included":[{"episodeId":%q,"title":"Server 500 blocked checkout","copy":"The server returned 500","action":"Review it","label":"new"}],"deferred":[]}`, candidate.EpisodeID)
	})
	if _, err := pool.Exec(context.Background(), `UPDATE digest_run_items
		SET candidate_snapshot=jsonb_set(candidate_snapshot,'{summary}',to_jsonb('The server returned 500'::text))
		WHERE run_id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatalf("grounded frozen number rejected: %v", err)
	}
}

func TestValidateExtractsPRNumberAndSupportsLegacyTitle(t *testing.T) {
	pool := testPool(t)
	runID, _, _ := seedWrittenFreezeRun(t, pool, validWrittenPayload)
	if _, err := pool.Exec(context.Background(), `UPDATE digest_run_items
		SET candidate_snapshot=jsonb_set(candidate_snapshot,'{title}',to_jsonb($2::text))
		WHERE run_id=$1`, runID, strings.Repeat("界", 100)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAndPublish(context.Background(), pool, runID); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := pool.QueryRow(context.Background(), `SELECT rendered_payload FROM digest_runs WHERE id=$1`, runID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var published notify.EventPayload
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatal(err)
	}
	card := published.Digest.GeneratedCards[0]
	if card.PRNumber != 42 {
		t.Fatalf("PR number = %d", card.PRNumber)
	}
	if card.Title != strings.Repeat("界", 80) {
		t.Fatalf("legacy title has %d runes, want 80", len([]rune(card.Title)))
	}
}
