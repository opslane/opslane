package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// Issue #27: error_events.timestamp must be the client event time, not server
// arrival time. created_at keeps arrival time.

func seedTimestampTenant(t *testing.T, pool *pgxpool.Pool, q *db.Queries, slug string) (projID, envID string) {
	t.Helper()
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, slug)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	proj, err := q.CreateProject(ctx, org.ID, slug, ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, proj.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}
	return proj.ID, env.ID
}

func TestInsertErrorEventAndGroup_UsesClientEventTime(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	projID, envID := seedTimestampTenant(t, pool, q, "test-client-ts")

	eventTime := time.Now().UTC().Add(-90 * time.Second).Truncate(time.Millisecond)

	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projID,
		DefaultEnvironmentID: envID,
		ErrorType:            "TypeError",
		ErrorMessage:         "boom",
		Fingerprint:          "fp-client-ts",
		Title:                "TypeError: boom",
		EventTime:            eventTime,
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	var stored, createdAt time.Time
	if err := pool.QueryRow(ctx,
		`SELECT "timestamp", created_at FROM error_events WHERE id = $1`,
		result.EventID,
	).Scan(&stored, &createdAt); err != nil {
		t.Fatalf("query event: %v", err)
	}
	if !stored.Equal(eventTime) {
		t.Errorf("error_events.timestamp = %v, want client time %v", stored, eventTime)
	}
	if createdAt.Sub(time.Now()) > time.Minute || time.Since(createdAt) > time.Minute {
		t.Errorf("created_at should remain server arrival time, got %v", createdAt)
	}

	// Group impact times follow the client event time.
	var firstSeen, lastSeen time.Time
	if err := pool.QueryRow(ctx,
		`SELECT first_seen, last_seen FROM error_groups WHERE id = $1`,
		result.GroupID,
	).Scan(&firstSeen, &lastSeen); err != nil {
		t.Fatalf("query group: %v", err)
	}
	if !firstSeen.Equal(eventTime) || !lastSeen.Equal(eventTime) {
		t.Errorf("group first/last_seen = %v/%v, want %v", firstSeen, lastSeen, eventTime)
	}
}

func TestInsertErrorEventAndGroup_ZeroEventTimeFallsBackToServerTime(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	projID, envID := seedTimestampTenant(t, pool, q, "test-client-ts-zero")

	before := time.Now().Add(-5 * time.Second)
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projID,
		DefaultEnvironmentID: envID,
		ErrorMessage:         "no timestamp",
		Fingerprint:          "fp-zero-ts",
		Title:                "no timestamp",
		// EventTime deliberately zero
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	after := time.Now().Add(5 * time.Second)

	var stored time.Time
	if err := pool.QueryRow(ctx,
		`SELECT "timestamp" FROM error_events WHERE id = $1`, result.EventID,
	).Scan(&stored); err != nil {
		t.Fatalf("query event: %v", err)
	}
	if stored.Before(before) || stored.After(after) {
		t.Errorf("zero EventTime should store server time, got %v", stored)
	}
}

// A late-arriving older event (offline buffer flush) must not move last_seen
// backwards, and must pull first_seen back to the true earliest occurrence,
// on both the group and the affected-user junction.
func TestInsertErrorEventAndGroup_LastSeenDoesNotRegress(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	projID, envID := seedTimestampTenant(t, pool, q, "test-client-ts-order")

	newer := time.Now().UTC().Add(-1 * time.Minute).Truncate(time.Millisecond)
	older := newer.Add(-1 * time.Hour)

	ingest := func(ts time.Time) *db.IngestResult {
		res, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            projID,
			DefaultEnvironmentID: envID,
			ErrorMessage:         "boom",
			Fingerprint:          "fp-order",
			Title:                "boom",
			EventTime:            ts,
			EndUserID:            "user-1",
		})
		if err != nil {
			t.Fatalf("InsertErrorEventAndGroup(%v): %v", ts, err)
		}
		return res
	}

	first := ingest(newer)
	ingest(older) // out-of-order late delivery

	var firstSeen, lastSeen time.Time
	var occurrences int
	if err := pool.QueryRow(ctx,
		`SELECT first_seen, last_seen, occurrence_count FROM error_groups WHERE id = $1`, first.GroupID,
	).Scan(&firstSeen, &lastSeen, &occurrences); err != nil {
		t.Fatalf("query group: %v", err)
	}
	if !lastSeen.Equal(newer) {
		t.Errorf("group last_seen regressed to %v, want %v", lastSeen, newer)
	}
	if !firstSeen.Equal(older) {
		t.Errorf("group first_seen = %v, want the true earliest occurrence %v", firstSeen, older)
	}
	if occurrences != 2 {
		t.Errorf("occurrence_count = %d, want 2", occurrences)
	}

	var junctionFirstSeen, junctionLastSeen time.Time
	if err := pool.QueryRow(ctx,
		`SELECT eau.first_seen, eau.last_seen FROM error_group_affected_users eau
		  JOIN end_users eu ON eu.id = eau.end_user_id
		 WHERE eau.error_group_id = $1 AND eu.external_user_id = 'user-1'`,
		first.GroupID,
	).Scan(&junctionFirstSeen, &junctionLastSeen); err != nil {
		t.Fatalf("query junction: %v", err)
	}
	if !junctionLastSeen.Equal(newer) {
		t.Errorf("junction last_seen regressed to %v, want %v", junctionLastSeen, newer)
	}
	if !junctionFirstSeen.Equal(older) {
		t.Errorf("junction first_seen = %v, want the true earliest occurrence %v", junctionFirstSeen, older)
	}
}
