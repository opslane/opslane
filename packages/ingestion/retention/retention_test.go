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
