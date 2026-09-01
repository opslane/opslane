package db_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// applyMigrationsThrough068 builds a schema at exactly migration 068 — the
// state a production database is in the moment before 069 lands — and returns
// the pool, its DSN, and a project to hang friction incidents from.
func applyMigrationsThrough068(t *testing.T) (*pgxpool.Pool, string, string) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "069_verdict_gated_investigation.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-069') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	return pool, dsn, projectID
}

// seedParkedFrictionGroup plants a friction incident in the exact shape the old
// severity gate left behind: awaiting_approval, with whatever investigation
// output the caller wants to claim it already has.
func seedParkedFrictionGroup(t *testing.T, pool *pgxpool.Pool, projectID, fingerprint string, rootCause, diff *string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status,kind,root_cause,candidate_diff)
		VALUES ($1,$2,'x',now(),now(),'awaiting_approval','friction',$3,$4) RETURNING id`,
		projectID, fingerprint, rootCause, diff).Scan(&id); err != nil {
		t.Fatalf("seed parked friction group %s: %v", fingerprint, err)
	}
	return id
}

func investigateJobCount(t *testing.T, pool *pgxpool.Pool, groupID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*)::int FROM error_group_jobs
		  WHERE error_group_id=$1 AND job_type='investigate'`, groupID).Scan(&n); err != nil {
		t.Fatalf("count investigate jobs: %v", err)
	}
	return n
}

// TestMigration069Backfill: the old severity gate parked medium/low promotions
// as awaiting_approval without ever investigating them, so the digest asked a
// reader to "Review the investigation." with nothing investigated. 069 returns
// exactly those rows to the queue with one investigation job, and — because the
// runner replays every file on every boot — does so idempotently.
func TestMigration069Backfill(t *testing.T) {
	pool, dsn, projectID := applyMigrationsThrough068(t)
	psql := findPsql(t)

	rootCause := "already diagnosed"
	diff := "--- a/x\n+++ b/x\n"
	parked := seedParkedFrictionGroup(t, pool, projectID, "069-parked", nil, nil)
	diagnosed := seedParkedFrictionGroup(t, pool, projectID, "069-diagnosed", &rootCause, nil)
	withDiff := seedParkedFrictionGroup(t, pool, projectID, "069-with-diff", nil, &diff)

	path := filepath.Join("migrations", "069_verdict_gated_investigation.sql")
	for boot := 0; boot < 2; boot++ {
		if err := applyMigration(t, psql, dsn, path); err != nil {
			t.Fatalf("boot %d apply 069: %v", boot, err)
		}
		if status := groupStatus(t, pool, parked); status != "queued" {
			t.Fatalf("boot %d: uninvestigated parked incident is %q, want queued", boot, status)
		}
		if n := investigateJobCount(t, pool, parked); n != 1 {
			t.Fatalf("boot %d: uninvestigated parked incident has %d investigate jobs, want exactly 1", boot, n)
		}
		if status := groupStatus(t, pool, diagnosed); status != "awaiting_approval" {
			t.Fatalf("boot %d: already-diagnosed incident moved to %q", boot, status)
		}
		if n := investigateJobCount(t, pool, diagnosed); n != 0 {
			t.Fatalf("boot %d: already-diagnosed incident gained %d investigate jobs", boot, n)
		}
		if status := groupStatus(t, pool, withDiff); status != "awaiting_approval" {
			t.Fatalf("boot %d: incident with a saved diff moved to %q", boot, status)
		}
		if n := investigateJobCount(t, pool, withDiff); n != 0 {
			t.Fatalf("boot %d: incident with a saved diff gained %d investigate jobs", boot, n)
		}
	}
}

// TestMigration069AddsVerificationReason: the frames-verification reason needs
// its own column because 068's verification_iff_ok CHECK forbids a non-null
// `verification` payload on any non-ok state.
func TestMigration069AddsVerificationReason(t *testing.T) {
	pool, dsn, _ := applyMigrationsThrough068(t)
	psql := findPsql(t)
	path := filepath.Join("migrations", "069_verdict_gated_investigation.sql")
	for boot := 0; boot < 2; boot++ {
		if err := applyMigration(t, psql, dsn, path); err != nil {
			t.Fatalf("boot %d apply 069: %v", boot, err)
		}
	}
	var dataType string
	if err := pool.QueryRow(context.Background(), `
		SELECT data_type FROM information_schema.columns
		 WHERE table_name='session_narratives' AND column_name='verification_reason'`).Scan(&dataType); err != nil {
		t.Fatalf("verification_reason column missing: %v", err)
	}
	if dataType != "text" {
		t.Fatalf("verification_reason is %q, want text", dataType)
	}
}
