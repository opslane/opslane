package digest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedFreezeEpisode(t *testing.T, pool *pgxpool.Pool, projectID, environmentID string, lastSeen time.Time, sequence int) string {
	t.Helper()
	ctx := context.Background()
	var groupID, episodeID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups
		  (project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,
		   occurrence_count,affected_users_count,page_url_normalized,pr_url,remediation)
		VALUES ($1,$2,$3,'Checkout failed','error','investigated',$4,$4,3,0,'/checkout',
		        'https://github.com/acme/shop/pull/42','Decide whether to ship the documented follow-up.')
		RETURNING id::text`, projectID, environmentID, "freeze-"+uuid.NewString(), lastSeen,
	).Scan(&groupID); err != nil {
		t.Fatalf("seed freeze group: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		VALUES ($1,$2,$3) RETURNING id::text`, projectID, groupID, sequence,
	).Scan(&episodeID); err != nil {
		t.Fatalf("seed freeze episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_inquiry_decisions
		  (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,
		   model,prompt_version,decided_at)
		VALUES ($1,$2,'investigate','customer checkout is blocked',1,$3,'test',1,$4)`,
		projectID, episodeID, "freeze-"+uuid.NewString(), lastSeen); err != nil {
		t.Fatalf("seed inquiry: %v", err)
	}
	return episodeID
}

func seedFreezeDiagnosis(t *testing.T, pool *pgxpool.Pool, projectID, episodeID, outcome string, decidedAt time.Time) {
	t.Helper()
	var decisionID string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO diagnosis_decisions
		  (error_group_id,project_id,episode_id,outcome,decision_reason,diagnosis,
		   model,prompt_version,decided_at)
		SELECT canonical_issue_id,$1,id,$3,'verified terminal result',
		       '{"summary":"The checkout request fails before payment."}'::jsonb,
		       'test','1',$4
		  FROM issue_episodes WHERE project_id=$1 AND id=$2
		RETURNING id::text`, projectID, episodeID, outcome, decidedAt).Scan(&decisionID); err != nil {
		t.Fatalf("seed diagnosis: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions DISABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("disable diagnosis immutability: %v", err)
			return
		}
		if _, err := pool.Exec(ctx, `DELETE FROM diagnosis_decisions WHERE id=$1`, decisionID); err != nil {
			t.Errorf("delete diagnosis fixture: %v", err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE diagnosis_decisions ENABLE TRIGGER diagnosis_decisions_immutable_row`); err != nil {
			t.Errorf("enable diagnosis immutability: %v", err)
		}
	})
}

func TestFreezeAllowsANewlyReadyActionOnAQuietProblem(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	quiet := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-9*24*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, quiet, "verified_fix", now.Add(-time.Hour))

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	for _, candidate := range candidates {
		if candidate.EpisodeID == quiet {
			return
		}
	}
	t.Error("a newly ready fix must be publishable even when the problem went quiet")
}

func TestFreezeExcludesStaleAndAlreadyPublished(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	fresh := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	stale := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-9*24*time.Hour), 1)
	already := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 1)
	seedFreezeDiagnosis(t, pool, f.ProjectID, fresh, "needs_human", now.Add(-time.Hour))
	seedFreezeDiagnosis(t, pool, f.ProjectID, stale, "needs_human", now.Add(-9*24*time.Hour))
	seedFreezeDiagnosis(t, pool, f.ProjectID, already, "verified_fix", now.Add(-time.Hour))
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_publications (project_id,episode_id,channel)
		VALUES ($1,$2,'digest')`, f.ProjectID, already); err != nil {
		t.Fatal(err)
	}

	_, candidates, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatalf("FreezeCandidates: %v", err)
	}
	got := make(map[string]bool)
	for _, candidate := range candidates {
		got[candidate.EpisodeID] = true
	}
	if !got[fresh] {
		t.Error("a fresh terminal result must be a candidate")
	}
	if got[stale] {
		t.Error("a problem last seen nine days ago must not be a candidate")
	}
	if got[already] {
		t.Error("an episode with a digest receipt must not repeat")
	}
}

func TestFreezeIsIdempotentPerWindowAndPreservesSnapshot(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	episodeID := seedFreezeEpisode(t, pool, f.ProjectID, f.EnvID, now.Add(-2*time.Hour), 2)
	seedFreezeDiagnosis(t, pool, f.ProjectID, episodeID, "verified_fix", now.Add(-time.Hour))

	firstID, first, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET title='mutated after freeze'
		WHERE id=(SELECT canonical_issue_id FROM issue_episodes WHERE id=$1)`, episodeID); err != nil {
		t.Fatal(err)
	}
	secondID, second, err := FreezeCandidates(ctx, pool, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if firstID != secondID {
		t.Fatalf("two freezes in one window must reuse the run: %s != %s", firstID, secondID)
	}
	if len(first) != 1 || len(second) != 1 || second[0].Title != first[0].Title {
		t.Fatalf("frozen snapshot changed: first=%+v second=%+v", first, second)
	}
	if second[0].Label != "returned" {
		t.Errorf("sequence two label = %q, want returned", second[0].Label)
	}
}
