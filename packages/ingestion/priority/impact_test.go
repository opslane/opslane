package priority

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type impactStamp struct {
	class     *string
	visits    *int64
	recovered *int64
	computed  *time.Time
}

func seedImpactSession(t *testing.T, pool *pgxpool.Pool, projectID, envID, sessionID string) {
	t.Helper()
	mustExec(t, pool, `INSERT INTO sessions
		(id, project_id, environment_id, started_at, status)
		VALUES ($1, $2, $3, now(), 'recording')`, sessionID, projectID, envID)
}

func seedImpactChunk(t *testing.T, pool *pgxpool.Pool, projectID, sessionID string, seq int, firstMs, lastMs *int64) {
	t.Helper()
	mustExec(t, pool, `INSERT INTO session_chunks
		(session_id, seq, project_id, object_key, has_full_snapshot, scrubbed_at, first_event_ms, last_event_ms)
		VALUES ($1, $2, $3, $4, true, now(), $5, $6)`,
		sessionID, seq, projectID, sessionID, firstMs, lastMs)
}

func seedImpactEvent(t *testing.T, pool *pgxpool.Pool, projectID, envID, groupID, sessionID string, at time.Time) {
	t.Helper()
	mustExec(t, pool, `INSERT INTO error_events
		(project_id, environment_id, error_group_id, session_id, "timestamp", error_type, error_message, stack_trace_raw)
		VALUES ($1, $2, $3, $4, $5, 'TypeError', 'boom', 'at test')`,
		projectID, envID, groupID, sessionID, at)
}

func seedImpactSignal(t *testing.T, pool *pgxpool.Pool, projectID, envID, groupID, sessionID, fingerprint string, at time.Time, accepted bool) string {
	t.Helper()
	status := "accepted"
	if !accepted {
		status = "pending"
	}
	var id string
	if err := pool.QueryRow(context.Background(), `INSERT INTO friction_signals
		(session_id, project_id, environment_id, rule_version, signal_type, fingerprint,
		 page_url_normalized, occurred_at, adjudication_status, incident_id)
		VALUES ($1, $2, $3, 1, 'dead_click', $4, '/impact', $5, $6, $7)
		RETURNING id`, sessionID, projectID, envID, fingerprint, at, status, groupID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func readImpactStamp(t *testing.T, pool *pgxpool.Pool, groupID string) impactStamp {
	t.Helper()
	var got impactStamp
	if err := pool.QueryRow(context.Background(), `SELECT impact_class, impact_visits,
		impact_visits_recovered, impact_computed_at FROM error_groups WHERE id = $1`, groupID).
		Scan(&got.class, &got.visits, &got.recovered, &got.computed); err != nil {
		t.Fatal(err)
	}
	return got
}

func assertImpact(t *testing.T, got impactStamp, class string, visits, recovered int64) {
	t.Helper()
	if got.class == nil || *got.class != class || got.visits == nil || *got.visits != visits ||
		got.recovered == nil || *got.recovered != recovered || got.computed == nil {
		t.Fatalf("impact = %#v, want %s %d/%d with computed_at", got, class, visits, recovered)
	}
}

func assertUnknownImpact(t *testing.T, got impactStamp) {
	t.Helper()
	if got.class != nil || got.visits != nil || got.recovered != nil || got.computed != nil {
		t.Fatalf("impact = %#v, want all NULL", got)
	}
}

func TestImpactPassErrorLane(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	now := time.Now().UTC().Truncate(time.Millisecond)

	blockedID := seedGroup(t, pool, projectID, envID, "impact-blocked", "error")
	degradedID := seedGroup(t, pool, projectID, envID, "impact-degraded", "error")
	invisibleID := seedGroup(t, pool, projectID, envID, "impact-invisible", "error")
	unknownID := seedGroup(t, pool, projectID, envID, "impact-unknown", "error")
	halfNullID := seedGroup(t, pool, projectID, envID, "impact-half-null", "error")
	oldID := seedGroup(t, pool, projectID, envID, "impact-old", "error")
	resolvedID := seedGroup(t, pool, projectID, envID, "impact-resolved", "error")
	mustExec(t, pool, `UPDATE error_groups SET status='resolved' WHERE id=$1`, resolvedID)

	seed := func(groupID, label string, lastOffsets ...time.Duration) {
		for i, lastOffset := range lastOffsets {
			sessionID := label + "-" + string(rune('a'+i)) + "-" + groupID
			seedImpactSession(t, pool, projectID, envID, sessionID)
			first, last := now.Add(-time.Minute).UnixMilli(), now.Add(lastOffset).UnixMilli()
			seedImpactChunk(t, pool, projectID, sessionID, 0, &first, &last)
			seedImpactEvent(t, pool, projectID, envID, groupID, sessionID, now)
		}
	}
	seed(blockedID, "blocked", 5*time.Second, 10*time.Second)
	seed(degradedID, "degraded", 5*time.Second, 17*time.Minute)
	seed(invisibleID, "invisible", 2*time.Minute)

	unknownSession := "unknown-" + unknownID
	seedImpactSession(t, pool, projectID, envID, unknownSession)
	seedImpactChunk(t, pool, projectID, unknownSession, 0, nil, nil)
	seedImpactEvent(t, pool, projectID, envID, unknownID, unknownSession, now)

	halfNullSession := "half-null-" + halfNullID
	seedImpactSession(t, pool, projectID, envID, halfNullSession)
	first, last := now.Add(-time.Minute).UnixMilli(), now.Add(2*time.Minute).UnixMilli()
	seedImpactChunk(t, pool, projectID, halfNullSession, 0, nil, &last)
	seedImpactChunk(t, pool, projectID, halfNullSession, 1, &first, nil)
	seedImpactEvent(t, pool, projectID, envID, halfNullID, halfNullSession, now)

	oldSession := "old-" + oldID
	seedImpactSession(t, pool, projectID, envID, oldSession)
	seedImpactChunk(t, pool, projectID, oldSession, 0, &first, &last)
	seedImpactEvent(t, pool, projectID, envID, oldID, oldSession, now.Add(-31*24*time.Hour))

	resolvedSession := "resolved-" + resolvedID
	seedImpactSession(t, pool, projectID, envID, resolvedSession)
	seedImpactChunk(t, pool, projectID, resolvedSession, 0, &first, &last)
	seedImpactEvent(t, pool, projectID, envID, resolvedID, resolvedSession, now)

	if _, err := (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertImpact(t, readImpactStamp(t, pool, blockedID), "blocked", 2, 0)
	assertImpact(t, readImpactStamp(t, pool, degradedID), "degraded", 2, 1)
	assertImpact(t, readImpactStamp(t, pool, invisibleID), "invisible", 1, 1)
	assertUnknownImpact(t, readImpactStamp(t, pool, unknownID))
	assertUnknownImpact(t, readImpactStamp(t, pool, halfNullID))
	assertUnknownImpact(t, readImpactStamp(t, pool, oldID))
	assertUnknownImpact(t, readImpactStamp(t, pool, resolvedID))
}

func TestImpactPassFrictionLaneAndFoldGuard(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	now := time.Now().UTC().Truncate(time.Millisecond)
	frictionID := seedGroup(t, pool, projectID, envID, "impact-friction", "friction")
	errorID := seedGroup(t, pool, projectID, envID, "impact-fold-guard", "error")

	for i, offset := range []time.Duration{5 * time.Second, 10 * time.Minute} {
		sessionID := "friction-" + string(rune('a'+i)) + "-" + frictionID
		seedImpactSession(t, pool, projectID, envID, sessionID)
		first, last := now.Add(-time.Minute).UnixMilli(), now.Add(offset).UnixMilli()
		seedImpactChunk(t, pool, projectID, sessionID, 0, &first, &last)
		seedImpactSignal(t, pool, projectID, envID, frictionID, sessionID, "fric-"+string(rune('a'+i)), now, true)
	}

	ignoredSession := "folded-" + errorID
	seedImpactSession(t, pool, projectID, envID, ignoredSession)
	first, last := now.Add(-time.Minute).UnixMilli(), now.Add(10*time.Minute).UnixMilli()
	seedImpactChunk(t, pool, projectID, ignoredSession, 0, &first, &last)
	seedImpactSignal(t, pool, projectID, envID, errorID, ignoredSession, "folded", now, true)
	crashSession := "crash-" + errorID
	seedImpactSession(t, pool, projectID, envID, crashSession)
	deadLast := now.Add(5 * time.Second).UnixMilli()
	seedImpactChunk(t, pool, projectID, crashSession, 0, &first, &deadLast)
	seedImpactEvent(t, pool, projectID, envID, errorID, crashSession, now)

	if _, err := (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertImpact(t, readImpactStamp(t, pool, frictionID), "degraded", 2, 1)
	assertImpact(t, readImpactStamp(t, pool, errorID), "blocked", 1, 0)

	// Pending and retracted signals are excluded from the active accepted set.
	secondSession := "friction-b-" + frictionID
	mustExec(t, pool, `UPDATE friction_signals SET retracted_at=now() WHERE incident_id=$1 AND session_id=$2`, frictionID, secondSession)
	pendingSession := "pending-" + frictionID
	seedImpactSession(t, pool, projectID, envID, pendingSession)
	seedImpactChunk(t, pool, projectID, pendingSession, 0, &first, &last)
	seedImpactSignal(t, pool, projectID, envID, frictionID, pendingSession, "pending", now, false)
	if _, err := (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertImpact(t, readImpactStamp(t, pool, frictionID), "blocked", 1, 0)
}

func TestImpactPassClearsAgedStampOnce(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	groupID := seedGroup(t, pool, projectID, envID, "impact-clear", "error")
	now := time.Now().UTC().Truncate(time.Millisecond)
	sessionID := "clear-" + groupID
	seedImpactSession(t, pool, projectID, envID, sessionID)
	first, last := now.Add(-time.Minute).UnixMilli(), now.Add(2*time.Minute).UnixMilli()
	seedImpactChunk(t, pool, projectID, sessionID, 0, &first, &last)
	seedImpactEvent(t, pool, projectID, envID, groupID, sessionID, now)

	sweeper := &Sweeper{Pool: pool}
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if err := sweeper.stampImpact(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	assertImpact(t, readImpactStamp(t, pool, groupID), "invisible", 1, 1)
	mustExec(t, pool, `UPDATE error_events SET "timestamp"=now()-interval '31 days' WHERE error_group_id=$1`, groupID)
	if err := sweeper.stampImpact(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	assertUnknownImpact(t, readImpactStamp(t, pool, groupID))

	var before, after string
	if err := conn.QueryRow(context.Background(), `SELECT xmin::text FROM error_groups WHERE id=$1`, groupID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := sweeper.stampImpact(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(context.Background(), `SELECT xmin::text FROM error_groups WHERE id=$1`, groupID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("second unknown-impact pass rewrote row: xmin %s -> %s", before, after)
	}
}
