package identity

import (
	"context"
	"testing"
)

func TestSettlementOpensAndStampsOneEpisode(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	seedResolvedEvent(t, pool, f, uniqueFingerprint("raw-a"), "src/A.vue", "f")
	seedResolvedEvent(t, pool, f, uniqueFingerprint("raw-b"), "src/A.vue", "f")

	if err := (&Loop{pool: pool, projectID: f.ProjectID}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	var episodes, stamped, distinctEpisodes int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issue_episodes
		  WHERE project_id=$1 AND closed_at IS NULL`, f.ProjectID).Scan(&episodes); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*),count(DISTINCT episode_id)
		   FROM error_event_identities
		  WHERE project_id=$1 AND status='settled' AND episode_id IS NOT NULL`,
		f.ProjectID).Scan(&stamped, &distinctEpisodes); err != nil {
		t.Fatal(err)
	}
	if episodes != 1 {
		t.Errorf("open episodes = %d, want 1", episodes)
	}
	if stamped != 2 || distinctEpisodes != 1 {
		t.Errorf("stamped observations=%d distinct episodes=%d, want 2 and 1", stamped, distinctEpisodes)
	}
}

func TestSettlementReopensResolvedIssueForALaterObservation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	firstEvent := seedResolvedEvent(t, pool, f, uniqueFingerprint("first"), "src/Return.vue", "submit")
	first, err := Settle(ctx, pool, f.ProjectID, firstEvent)
	if err != nil {
		t.Fatalf("settle first observation: %v", err)
	}
	var firstEpisode string
	if err := pool.QueryRow(ctx,
		`SELECT episode_id::text FROM error_event_identities
		  WHERE project_id=$1 AND event_id=$2`, f.ProjectID, firstEvent).Scan(&firstEpisode); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE issue_episodes SET closed_at=now()-interval '1 minute'
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, firstEpisode); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE error_groups SET status='resolved',resolved_at=now()-interval '1 minute'
		  WHERE project_id=$1 AND id=$2`, f.ProjectID, first.CanonicalIssueID); err != nil {
		t.Fatal(err)
	}

	secondEvent := seedResolvedEvent(t, pool, f, uniqueFingerprint("second"), "src/Return.vue", "submit")
	second, err := Settle(ctx, pool, f.ProjectID, secondEvent)
	if err != nil {
		t.Fatalf("settle recurrence: %v", err)
	}
	if second.CanonicalIssueID != first.CanonicalIssueID {
		t.Fatalf("recurrence changed issue: %s -> %s", first.CanonicalIssueID, second.CanonicalIssueID)
	}
	var status, secondEpisode string
	var sequence int
	var closed bool
	if err := pool.QueryRow(ctx,
		`SELECT g.status::text,i.episode_id::text,ep.sequence,ep.closed_at IS NOT NULL
		   FROM error_event_identities i
		   JOIN error_groups g ON g.project_id=i.project_id AND g.id=i.canonical_issue_id
		   JOIN issue_episodes ep ON ep.project_id=i.project_id AND ep.id=i.episode_id
		  WHERE i.project_id=$1 AND i.event_id=$2`, f.ProjectID, secondEvent).Scan(
		&status, &secondEpisode, &sequence, &closed); err != nil {
		t.Fatal(err)
	}
	if status != "new" || sequence != 2 || closed || secondEpisode == firstEpisode {
		t.Errorf("recurrence status=%q sequence=%d closed=%v episode=%s; want new, 2, false, new episode",
			status, sequence, closed, secondEpisode)
	}
}
