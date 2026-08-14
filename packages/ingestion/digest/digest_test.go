package digest

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedPriorDigest writes a published digest whose stored window ends at
// windowEnd, which is the watermark the next run must resume from.
func seedPriorDigest(t *testing.T, pool *pgxpool.Pool, projectID string, windowEnd time.Time, dedupSuffix string) {
	t.Helper()
	payload := fmt.Sprintf(`{"digest":{"window":{"from":%q,"to":%q}}}`,
		windowEnd.Add(-24*time.Hour).Format(time.RFC3339Nano),
		windowEnd.Format(time.RFC3339Nano))
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
		 VALUES ($1,'digest.daily',$2,$3::jsonb)`,
		projectID, "digest.daily:"+projectID+":"+dedupSuffix, payload); err != nil {
		t.Fatalf("seed prior digest: %v", err)
	}
}

func clearDigestEvents(t *testing.T, pool *pgxpool.Pool, projectID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM outbound_events WHERE project_id=$1 AND event_type='digest.daily'`, projectID); err != nil {
		t.Fatalf("clear digest events: %v", err)
	}
}

// The window must resume from the previous digest's end rather than a fixed
// trailing 24h. Anchoring on run time both drops and repeats items whenever the
// send time moves, which prod showed on 2026-08-13.
func TestWindowForResumesFromPreviousDigest(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	s := New(pool, "https://dash.example")

	t.Run("first digest falls back to a trailing 24h", func(t *testing.T) {
		from, to := s.windowFor(ctx, f.ProjectID, now)
		if !to.Equal(now) || !from.Equal(now.Add(-24*time.Hour)) {
			t.Fatalf("window = %s..%s; want %s..%s", from, to, now.Add(-24*time.Hour), now)
		}
	})

	t.Run("closes the gap a late run would leave", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		// The real 2026-08-13 shape: previous digest ended 7h35m ago, so a
		// trailing 24h would re-report 16h and a shorter window would drop time.
		previousEnd := now.Add(-7*time.Hour - 35*time.Minute)
		seedPriorDigest(t, pool, f.ProjectID, previousEnd, "gap-case")
		from, to := s.windowFor(ctx, f.ProjectID, now)
		if !from.Equal(previousEnd) || !to.Equal(now) {
			t.Fatalf("window = %s..%s; want %s..%s", from, to, previousEnd, now)
		}
	})

	t.Run("does not re-report an already covered span", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		// Previous digest ended 30h ago. A trailing 24h would start *after* it,
		// silently skipping 6h; resuming from the watermark covers them.
		previousEnd := now.Add(-30 * time.Hour)
		seedPriorDigest(t, pool, f.ProjectID, previousEnd, "overlap-case")
		from, _ := s.windowFor(ctx, f.ProjectID, now)
		if !from.Equal(previousEnd) {
			t.Fatalf("from = %s; want %s", from, previousEnd)
		}
	})

	t.Run("caps an unbounded catch-up after a long outage", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		seedPriorDigest(t, pool, f.ProjectID, now.Add(-60*24*time.Hour), "cap-case")
		from, _ := s.windowFor(ctx, f.ProjectID, now)
		if want := now.Add(-maxWindowLookback); !from.Equal(want) {
			t.Fatalf("from = %s; want the cap %s", from, want)
		}
	})

	t.Run("ignores a watermark that is not in the past", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		seedPriorDigest(t, pool, f.ProjectID, now.Add(2*time.Hour), "future-case")
		from, _ := s.windowFor(ctx, f.ProjectID, now)
		if want := now.Add(-24 * time.Hour); !from.Equal(want) {
			t.Fatalf("from = %s; want the 24h fallback %s", from, want)
		}
	})

	t.Run("ignores an unparseable watermark", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		if _, err := pool.Exec(ctx,
			`INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
			 VALUES ($1,'digest.daily',$2,'{"digest":{"window":{"to":"not-a-time"}}}'::jsonb)`,
			f.ProjectID, "digest.daily:"+f.ProjectID+":junk-case"); err != nil {
			t.Fatal(err)
		}
		from, _ := s.windowFor(ctx, f.ProjectID, now)
		if want := now.Add(-24 * time.Hour); !from.Equal(want) {
			t.Fatalf("from = %s; want the 24h fallback %s", from, want)
		}
	})

	t.Run("is scoped to the project", func(t *testing.T) {
		clearDigestEvents(t, pool, f.ProjectID)
		other := seedDigestFixture(t, pool, now)
		seedPriorDigest(t, pool, other.ProjectID, now.Add(-3*time.Hour), "other-project")
		from, _ := s.windowFor(ctx, f.ProjectID, now)
		if want := now.Add(-24 * time.Hour); !from.Equal(want) {
			t.Fatalf("from = %s; another project's watermark leaked in", from)
		}
	})
}

func seedDestination(t *testing.T, pool *pgxpool.Pool, projectID string, eventTypes []string) string {
	t.Helper()
	destID := uuid.NewString()
	if _, err := pool.Exec(context.Background(), `INSERT INTO notification_destinations
		(id, project_id, type, name, config_encrypted, config_fingerprint, event_types)
		VALUES ($1,$2,'slack','digest-test',E'\\x00',$3,$4)`,
		destID, projectID, "fp-"+destID, eventTypes); err != nil {
		t.Fatalf("seed destination: %v", err)
	}
	return destID
}

// digestEvents counts one project's published digests.
//
// RunOnce sweeps EVERY project in the database, so its return value also counts
// digests published for unrelated projects — including leftovers from a live
// smoke. Assert on this instead of on that global counter, or the sweep tests
// fail depending on what else happens to be in the test database.
func digestEvents(t *testing.T, pool *pgxpool.Pool, projectID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbound_events WHERE project_id=$1 AND event_type='digest.daily'`,
		projectID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRunOnceFirstDigestAndIdempotency(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")

	if _, err := s.RunOnce(ctx, now); err != nil {
		t.Fatalf("first RunOnce: %v", err)
	}
	var deliveries int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbound_deliveries d JOIN outbound_events e ON e.id=d.event_id WHERE e.project_id=$1`, f.ProjectID).Scan(&deliveries); err != nil {
		t.Fatal(err)
	}
	if events := digestEvents(t, pool, f.ProjectID); events != 1 || deliveries != 1 {
		t.Fatalf("events=%d deliveries=%d", events, deliveries)
	}
	if _, err := s.RunOnce(ctx, now); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	if events := digestEvents(t, pool, f.ProjectID); events != 1 {
		t.Fatalf("second RunOnce was not idempotent: events=%d", events)
	}
}

func TestPublishReturnsFalseOnDedupConflict(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")
	payload, err := s.Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	key := "digest.daily:" + f.ProjectID + ":" + now.Format("2006-01-02")
	if _, err := pool.Exec(ctx, `INSERT INTO outbound_events (project_id,event_type,dedup_key,payload)
		VALUES ($1,'digest.daily',$2,'{}')`, f.ProjectID, key); err != nil {
		t.Fatal(err)
	}
	inserted, err := s.publish(ctx, f.ProjectID, key, payload)
	if err != nil || inserted {
		t.Fatalf("publish = %v, %v; want false, nil", inserted, err)
	}
}

func TestPublishSkipsWhenDestinationsVanished(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	f := seedDigestFixture(t, pool, now)
	destID := seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	s := New(pool, "https://dash.example")
	payload, err := s.Build(ctx, f.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE notification_destinations SET enabled=false WHERE id=$1`, destID); err != nil {
		t.Fatal(err)
	}
	key := "digest.daily:" + f.ProjectID + ":" + now.Format("2006-01-02")
	inserted, err := s.publish(ctx, f.ProjectID, key, payload)
	if err != nil || inserted {
		t.Fatalf("publish = %v, %v; want false, nil", inserted, err)
	}
	var events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbound_events WHERE project_id=$1`, f.ProjectID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("zero-delivery event was written: %d", events)
	}
}

func TestRunOnceFirstDigestBoundaryAndCreatedAtAnchor(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fa := seedDigestFixtureWithSessionAge(t, pool, now, 24*time.Hour)
	seedDestination(t, pool, fa.ProjectID, []string{"digest.daily"})
	fb := seedDigestFixtureWithSessionAge(t, pool, now, 24*time.Hour-time.Minute)
	seedDestination(t, pool, fb.ProjectID, []string{"digest.daily"})
	fc := seedDigestFixture(t, pool, now)
	if _, err := pool.Exec(ctx, `DELETE FROM friction_signals WHERE project_id=$1`, fc.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE project_id=$1`, fc.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET created_at=$2 WHERE id=$1`, fc.ProjectID, now.Add(-25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	seedDestination(t, pool, fc.ProjectID, []string{"digest.daily"})

	if _, err := New(pool, "https://dash.example").RunOnce(ctx, now); err != nil {
		t.Fatal(err)
	}
	if got := digestEvents(t, pool, fa.ProjectID); got != 1 {
		t.Errorf("project at the 24h anchor published %d digests, want 1", got)
	}
	if got := digestEvents(t, pool, fc.ProjectID); got != 1 {
		t.Errorf("session-less project anchored on created_at published %d digests, want 1", got)
	}
	if got := digestEvents(t, pool, fb.ProjectID); got != 0 {
		t.Errorf("project with a 23h59m anchor was published (%d digests)", got)
	}
}

func TestRunOnceSkipsIneligibleProjects(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	fa := seedDigestFixtureWithSessionAge(t, pool, now, time.Hour)
	seedDestination(t, pool, fa.ProjectID, []string{"digest.daily"})
	fb := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, fb.ProjectID, []string{"issue.created"})
	fc := seedDigestFixture(t, pool, now)
	seedDestination(t, pool, fc.ProjectID, []string{"digest.daily"})
	if _, err := pool.Exec(ctx, `UPDATE projects SET digest_timezone='Not/AZone' WHERE id=$1`, fc.ProjectID); err != nil {
		t.Fatal(err)
	}

	if _, err := New(pool, "https://dash.example").RunOnce(ctx, now); err != nil {
		t.Fatal(err)
	}
	for name, projectID := range map[string]string{
		"project with under 24h of data": fa.ProjectID,
		"project not subscribed":         fb.ProjectID,
		"project with an invalid zone":   fc.ProjectID,
	} {
		if got := digestEvents(t, pool, projectID); got != 0 {
			t.Errorf("%s published %d digests, want 0", name, got)
		}
	}
}

func TestRunOnceSubsequentWaitsForNineLocal(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(24 * time.Hour).Add(8 * time.Hour)
	f := seedDigestFixture(t, pool, base)
	seedDestination(t, pool, f.ProjectID, []string{"digest.daily"})
	yesterday := base.Add(-24 * time.Hour).Format("2006-01-02")
	if _, err := pool.Exec(ctx, `INSERT INTO outbound_events (project_id,event_type,dedup_key,payload)
		VALUES ($1::uuid,'digest.daily','digest.daily:'||($1::uuid)::text||':'||$2,'{}')`, f.ProjectID, yesterday); err != nil {
		t.Fatal(err)
	}
	s := New(pool, "https://dash.example")
	// Only yesterday's seeded event exists; 08:00 is before the 09:00 slot.
	if _, err := s.RunOnce(ctx, base); err != nil {
		t.Fatalf("08:00 RunOnce: %v", err)
	}
	if got := digestEvents(t, pool, f.ProjectID); got != 1 {
		t.Fatalf("08:00 published early: events=%d, want 1 (yesterday's only)", got)
	}
	if _, err := s.RunOnce(ctx, base.Add(65*time.Minute)); err != nil {
		t.Fatalf("09:05 RunOnce: %v", err)
	}
	if got := digestEvents(t, pool, f.ProjectID); got != 2 {
		t.Fatalf("09:05 did not publish: events=%d, want 2", got)
	}
}
