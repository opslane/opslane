package filter

import (
	"context"
	"testing"
	"time"
)

func TestReplayDayIsReadOnly(t *testing.T) {
	pool := testPool(t)
	f := seedEpisode(t, pool)
	seedIdentifiedEvent(t, pool, f, time.Now().Add(-time.Hour))
	seedIdentifiedEvent(t, pool, f, time.Now())

	replay, err := ReplayDay(context.Background(), pool, f.projectID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ReplayDay: %v", err)
	}
	if replay.Admit != 1 || replay.Watch != 0 || replay.Inactive != 0 {
		t.Fatalf("replay counts = admit:%d watch:%d inactive:%d, want 1/0/0",
			replay.Admit, replay.Watch, replay.Inactive)
	}
	var decisions int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue_decisions WHERE project_id=$1 AND episode_id=$2`,
		f.projectID, f.episodeID).Scan(&decisions); err != nil {
		t.Fatalf("count decisions: %v", err)
	}
	if decisions != 0 {
		t.Fatalf("replay wrote %d decisions", decisions)
	}
}
