package identity

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestFreezeAnchorsPinsFirstThresholdAndRecentObservations(t *testing.T) {
	pool := testPool(t)
	f := seedProject(t, pool)
	ctx := context.Background()
	base := time.Now().Add(-3 * time.Hour).UTC()
	events := make([]string, 0, 3)
	for i := range 3 {
		eventID := seedResolvedEvent(t, pool, f, "anchor-"+uuid.NewString(), "src/app.ts", "handler")
		if _, err := pool.Exec(ctx,
			`UPDATE error_events SET session_id=$3,created_at=$4,timestamp=$4
			  WHERE project_id=$1 AND id=$2`,
			f.ProjectID, eventID, "anchor-session-"+uuid.NewString(), base.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatalf("stamp event: %v", err)
		}
		if _, err := Settle(ctx, pool, f.ProjectID, eventID); err != nil {
			t.Fatalf("settle event: %v", err)
		}
		events = append(events, eventID)
	}
	var episodeID string
	if err := pool.QueryRow(ctx,
		`SELECT episode_id::text FROM error_event_identities WHERE project_id=$1 AND event_id=$2`,
		f.ProjectID, events[0]).Scan(&episodeID); err != nil {
		t.Fatalf("read episode: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := FreezeAnchors(ctx, tx, f.ProjectID, episodeID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("FreezeAnchors: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	want := map[string]string{"first": events[0], "threshold": events[1], "recent": events[2]}
	rows, err := pool.Query(ctx,
		`SELECT anchor_kind,event_id::text FROM issue_evidence_anchors
		  WHERE project_id=$1 AND episode_id=$2`, f.ProjectID, episodeID)
	if err != nil {
		t.Fatalf("read anchors: %v", err)
	}
	defer rows.Close()
	got := make(map[string]string)
	for rows.Next() {
		var kind, eventID string
		if err := rows.Scan(&kind, &eventID); err != nil {
			t.Fatalf("scan anchor: %v", err)
		}
		got[kind] = eventID
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read anchors: %v", err)
	}
	for kind, eventID := range want {
		if got[kind] != eventID {
			t.Errorf("%s anchor = %q, want %q", kind, got[kind], eventID)
		}
	}
}
