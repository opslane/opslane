package retention_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
	"github.com/opslane/opslane/packages/ingestion/retention"
)

func setup(t *testing.T) (*retention.Sweeper, *db.Queries, *minioPkg.Client, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	endpoint := os.Getenv("REPLAY_STORE_ENDPOINT")
	if dsn == "" || endpoint == "" {
		t.Skip("DATABASE_URL / REPLAY_STORE_ENDPOINT not set; skipping integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	q := db.New(pool)
	mc, err := minioPkg.New(endpoint, os.Getenv("REPLAY_STORE_PUBLIC_ENDPOINT"),
		os.Getenv("REPLAY_STORE_ACCESS_KEY"), os.Getenv("REPLAY_STORE_SECRET_KEY"),
		os.Getenv("REPLAY_STORE_BUCKET"), os.Getenv("REPLAY_STORE_REGION"))
	if err != nil {
		t.Fatalf("minio: %v", err)
	}
	return &retention.Sweeper{Q: q, MinIO: mc}, q, mc, pool
}

type seededSession struct {
	id, projectID, key string
}

func seedSession(t *testing.T, q *db.Queries, pool *pgxpool.Pool, mc *minioPkg.Client, ageDays, retentionDays int, retainUntil *time.Time) seededSession {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("retain-%d", time.Now().UnixNano())
	var orgID, projectID, envID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, name).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name, session_retention_days) VALUES ($1, $2, $3) RETURNING id`, orgID, name, retentionDays).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectID).Scan(&envID); err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	sid := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	started := time.Now().AddDate(0, 0, -ageDays)
	if err := q.InsertSession(ctx, sid, projectID, envID, nil, started, "https://example.test"); err != nil {
		t.Fatalf("insert session: %v", err)
	}
	if retainUntil != nil {
		if _, err := pool.Exec(ctx, `UPDATE sessions SET retain_until=$2 WHERE id=$1`, sid, *retainUntil); err != nil {
			t.Fatalf("pin session: %v", err)
		}
	}
	key := fmt.Sprintf("sessions/%s/%s/chunk-000000.json.gz", projectID, sid)
	if err := q.ReserveChunkSeq(ctx, sid, projectID, 0, key, true); err != nil {
		t.Fatalf("reserve chunk: %v", err)
	}
	payload := []byte("stored-chunk")
	if err := mc.PutObject(ctx, key, payload, "application/gzip"); err != nil {
		t.Fatalf("seed object: %v", err)
	}
	if err := q.CommitChunk(ctx, sid, projectID, 0, int64(len(payload))); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return seededSession{id: sid, projectID: projectID, key: key}
}

func assertDeleted(t *testing.T, pool *pgxpool.Pool, mc *minioPkg.Client, session seededSession) {
	t.Helper()
	ctx := context.Background()
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, session.id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("session count=%d err=%v, want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_chunks WHERE session_id=$1`, session.id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("chunk count=%d err=%v, want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_tombstones WHERE session_id=$1`, session.id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("tombstone count=%d err=%v, want 1", count, err)
	}
	if _, err := mc.StatObject(ctx, session.key); err == nil {
		t.Fatal("retained object still exists")
	}
}

func runThroughGrace(t *testing.T, sweeper *retention.Sweeper, pool *pgxpool.Pool, session seededSession) {
	t.Helper()
	if _, err := sweeper.RunOnce(context.Background()); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE sessions SET deletion_started_at = now() - interval '2 minutes' WHERE id = $1`, session.id); err != nil {
		t.Fatalf("age deletion grace: %v", err)
	}
	if _, err := sweeper.RunOnce(context.Background()); err != nil {
		t.Fatalf("purge: %v", err)
	}
}

func TestSweep_DeletesExpiredSessionAndItsObjects(t *testing.T) {
	s, q, mc, pool := setup(t)
	session := seedSession(t, q, pool, mc, 40, 30, nil)
	runThroughGrace(t, s, pool, session)
	assertDeleted(t, pool, mc, session)
}

func TestSweep_SkipsPinnedSessionInsideHardCap(t *testing.T) {
	s, q, mc, pool := setup(t)
	pinnedUntil := time.Now().AddDate(0, 0, 30)
	session := seedSession(t, q, pool, mc, 40, 30, &pinnedUntil)
	t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), session.key) })
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1`, session.id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("pinned session count=%d err=%v, want 1", count, err)
	}
	if _, err := mc.StatObject(context.Background(), session.key); err != nil {
		t.Fatalf("pinned object removed: %v", err)
	}
}

func TestSweep_DeletesPinnedSessionPastHardCap(t *testing.T) {
	s, q, mc, pool := setup(t)
	pinnedUntil := time.Now().AddDate(1, 0, 0)
	session := seedSession(t, q, pool, mc, 100, 30, &pinnedUntil)
	runThroughGrace(t, s, pool, session)
	assertDeleted(t, pool, mc, session)
}

func TestSweep_RespectsPerProjectRetentionDays(t *testing.T) {
	s, q, mc, pool := setup(t)
	expired := seedSession(t, q, pool, mc, 20, 14, nil)
	live := seedSession(t, q, pool, mc, 20, 30, nil)
	t.Cleanup(func() { _ = mc.RemoveObject(context.Background(), live.key) })
	runThroughGrace(t, s, pool, expired)
	assertDeleted(t, pool, mc, expired)
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1`, live.id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("live session count=%d err=%v, want 1", count, err)
	}
}

func TestSweep_IsIdempotent(t *testing.T) {
	s, q, mc, pool := setup(t)
	session := seedSession(t, q, pool, mc, 40, 30, nil)
	if err := mc.RemoveObject(context.Background(), session.key); err != nil {
		t.Fatalf("pre-delete object: %v", err)
	}
	runThroughGrace(t, s, pool, session)
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	assertDeleted(t, pool, mc, session)
}

func TestSweep_RemovesObjectThatArrivesAfterSessionDeletion(t *testing.T) {
	s, q, mc, pool := setup(t)
	session := seedSession(t, q, pool, mc, 40, 30, nil)
	runThroughGrace(t, s, pool, session)
	if err := mc.PutObject(context.Background(), session.key, []byte("late-inflight-upload"), "application/gzip"); err != nil {
		t.Fatalf("simulate late upload: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE session_tombstones SET storage_swept_at = NULL WHERE session_id = $1`, session.id); err != nil {
		t.Fatalf("queue tombstone re-sweep: %v", err)
	}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatalf("late-object sweep: %v", err)
	}
	if _, err := mc.StatObject(context.Background(), session.key); err == nil {
		t.Fatal("object uploaded after row deletion remained orphaned")
	}
}

func seedRetentionProject(t *testing.T, pool *pgxpool.Pool, retentionDays int) string {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("runlog-%d", time.Now().UnixNano())
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, name).Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name, session_retention_days) VALUES ($1, $2, $3) RETURNING id`, orgID, name, retentionDays).Scan(&projectID); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	return projectID
}

func seedAgentRun(t *testing.T, pool *pgxpool.Pool, mc *minioPkg.Client, projectID string, recordedAt time.Time) (runID, key string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&runID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	prefix := fmt.Sprintf("agent-runs/%s/%s/%s/", projectID, recordedAt.UTC().Format("2006-01-02"), runID)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_run_started (run_id, job_id, job_type, project_id, phase, entry_point, attempts,
		lease_generation, object_prefix, worker_build_sha, bundle_written, bundle_bytes, recorded_at)
		VALUES ($1, gen_random_uuid(), 'session_narrate', $2, 'narrate', 'narrative/job#processNarration', 0, 1, $3, 'sha', true, 2, $4)`,
		runID, projectID, prefix, recordedAt); err != nil {
		t.Fatalf("seed run row: %v", err)
	}
	key = prefix + "input.json"
	if err := mc.PutObject(ctx, key, []byte("{}"), "application/json"); err != nil {
		t.Fatalf("seed run object: %v", err)
	}
	return runID, key
}

func TestSweep_DeletesExpiredAgentRunDaysIncludingOrphans(t *testing.T) {
	s, _, mc, pool := setup(t)
	ctx := context.Background()
	projectID := seedRetentionProject(t, pool, 30)
	oldRun, oldKey := seedAgentRun(t, pool, mc, projectID, time.Now().AddDate(0, 0, -40))
	recentRun, recentKey := seedAgentRun(t, pool, mc, projectID, time.Now().AddDate(0, 0, -2))
	orphanKey := fmt.Sprintf("agent-runs/%s/%s/orphan-run/transcript.jsonl", projectID, time.Now().AddDate(0, 0, -40).UTC().Format("2006-01-02"))
	if err := mc.PutObject(ctx, orphanKey, []byte("x"), "application/x-ndjson"); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}
	t.Cleanup(func() {
		_ = mc.RemoveObject(ctx, recentKey)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_run_started WHERE project_id = $1`, projectID)
	})

	if _, err := s.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	for _, key := range []string{oldKey, orphanKey} {
		if _, err := mc.StatObject(ctx, key); err == nil {
			t.Fatalf("expired run object %s still exists", key)
		}
	}
	if _, err := mc.StatObject(ctx, recentKey); err != nil {
		t.Fatalf("recent run object removed: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_started WHERE run_id = $1`, oldRun).Scan(&count); err != nil || count != 0 {
		t.Fatalf("old run rows=%d err=%v, want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_started WHERE run_id = $1`, recentRun).Scan(&count); err != nil || count != 1 {
		t.Fatalf("recent run rows=%d err=%v, want 1", count, err)
	}
}

func TestSweep_UsesProjectRunRetentionAndDeletesRowsWithoutObjects(t *testing.T) {
	s, _, mc, pool := setup(t)
	ctx := context.Background()
	shortProject := seedRetentionProject(t, pool, 7)
	longProject := seedRetentionProject(t, pool, 30)
	age := time.Now().AddDate(0, 0, -15)
	oldRun, oldKey := seedAgentRun(t, pool, mc, shortProject, age)
	recentRun, recentKey := seedAgentRun(t, pool, mc, longProject, age)
	// A failed bundle write leaves no folder for the storage listing to discover.
	if err := mc.RemoveObject(ctx, oldKey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_run_finished
   (run_id, stop, model_requests, turns, usage, cost_usd, transcript_written, transcript_bytes, finished_at)
   VALUES ($1, 'completed', 0, 0, '{}', 0, false, 0, $2)`, oldRun, age); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = mc.RemoveObject(ctx, recentKey)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_run_started WHERE project_id IN ($1, $2)`, shortProject, longProject)
	})
	if _, err := s.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var oldCount, finishedCount, recentCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_started WHERE run_id = $1`, oldRun).Scan(&oldCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_finished WHERE run_id = $1`, oldRun).Scan(&finishedCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_started WHERE run_id = $1`, recentRun).Scan(&recentCount); err != nil {
		t.Fatal(err)
	}
	if oldCount != 0 || finishedCount != 0 || recentCount != 1 {
		t.Fatalf("old=%d finished=%d recent=%d", oldCount, finishedCount, recentCount)
	}
	if _, err := mc.StatObject(ctx, recentKey); err != nil {
		t.Fatalf("longer retention object removed: %v", err)
	}
}
