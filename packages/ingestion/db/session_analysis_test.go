package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func migratedAnalysisDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	admin := testPool(t)
	pool, dsn := disposableDB(t, admin)
	psql := findPsql(t)
	for _, migration := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, migration); err != nil {
			t.Fatalf("apply %s: %v", migration, err)
		}
	}
	return pool
}

func seedAnalysisTenant(t *testing.T, label string) (*db.Queries, string, string, func(string, time.Time, string)) {
	t.Helper()
	pool := migratedAnalysisDB(t)
	ctx := context.Background()
	queries := db.New(pool)
	org, err := queries.CreateOrg(ctx, label)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	project, err := queries.CreateProject(ctx, org.ID, label, ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	environment, err := queries.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM error_group_jobs WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id = $1`, project.ID)
		cleanupTenant(t, pool, org.ID)
	})
	seed := func(id string, started time.Time, status string) {
		if _, insertErr := pool.Exec(ctx, `INSERT INTO sessions
			(id, project_id, environment_id, started_at, status)
			VALUES ($1,$2,$3,$4,$5)`, id, project.ID, environment.ID, started, status); insertErr != nil {
			t.Fatalf("seed session: %v", insertErr)
		}
	}
	return queries, project.ID, environment.ID, seed
}

func TestSessionAnalysisUpsertRoundTrip(t *testing.T) {
	pool := migratedAnalysisDB(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, fmt.Sprintf("analysis-roundtrip-%d", time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "analysis", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id = $1`, project.ID)
		cleanupTenant(t, pool, org.ID)
	})
	for _, id := range []string{"sa-roundtrip-1", "sa-roundtrip-2"} {
		if _, err = pool.Exec(ctx, `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
			VALUES ($1,$2,$3,now(),'analyzed')`, id, project.ID, environment.ID); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}
	_, err = pool.Exec(ctx, `INSERT INTO session_analysis
		(session_id, project_id, session_started_at, coverage, activity_class, entry_path, click_count, rule_version)
		VALUES ($1,$2,now()-interval '1 day','complete','active','/assets',5,2)
		ON CONFLICT (session_id) DO UPDATE SET coverage=EXCLUDED.coverage,
		activity_class=EXCLUDED.activity_class,click_count=EXCLUDED.click_count,
		rule_version=EXCLUDED.rule_version,analyzed_at=now()`, "sa-roundtrip-1", project.ID)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var coverage string
	var clicks int
	if err = pool.QueryRow(ctx, `SELECT coverage, click_count FROM session_analysis WHERE session_id=$1`, "sa-roundtrip-1").Scan(&coverage, &clicks); err != nil {
		t.Fatalf("read: %v", err)
	}
	if coverage != "complete" || clicks != 5 {
		t.Fatalf("coverage=%q clicks=%d", coverage, clicks)
	}
	_, err = pool.Exec(ctx, `INSERT INTO session_analysis
		(session_id,project_id,session_started_at,coverage,activity_class,rule_version)
		VALUES ($1,$2,now(),'bogus','active',2)`, "sa-roundtrip-2", project.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("expected check violation, got %v", err)
	}
}

func TestSessionAnalysisDailyRollupAndBackfill(t *testing.T) {
	label := fmt.Sprintf("analysis-rollup-%d", time.Now().UnixNano())
	q, projectID, environmentID, seed := seedAnalysisTenant(t, label)
	ctx := context.Background()
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(-24 * time.Hour)
	seed("sa-roll-active", day.Add(time.Hour), "analyzed")
	seed("sa-roll-idle", day.Add(2*time.Hour), "analyzed")
	seed("sa-roll-partial", day.Add(3*time.Hour), "analyzed")
	seed("sa-backfill", time.Now().Add(-time.Hour), "analyzed")
	pool := q.Pool()
	for _, values := range []struct {
		id, coverage, activity string
		writes, failures       int
	}{
		{"sa-roll-active", "complete", "active", 2, 0},
		{"sa-roll-idle", "complete", "idle_tab", 0, 1},
		{"sa-roll-partial", "partial", "active", 99, 99},
	} {
		_, err := pool.Exec(ctx, `INSERT INTO session_analysis
			(session_id,project_id,environment_id,session_started_at,coverage,activity_class,
			successful_write_count,failed_request_4xx_count,rule_version)
			SELECT $1,$2,$3,started_at,$4,$5,$6,$7,2 FROM sessions WHERE id=$1`,
			values.id, projectID, environmentID, values.coverage, values.activity, values.writes, values.failures)
		if err != nil {
			t.Fatalf("seed analysis: %v", err)
		}
	}
	rollup, err := q.SessionAnalysisDailyRollup(ctx, projectID, day)
	if err != nil {
		t.Fatalf("rollup: %v", err)
	}
	if rollup.TotalSessions != 3 || rollup.PartialSessions != 1 || rollup.ActiveSessions != 1 ||
		rollup.IdleTabSessions != 1 || rollup.SuccessfulWrites != 2 || rollup.SessionsWithFailures != 1 {
		t.Fatalf("unexpected rollup: %+v", rollup)
	}
	enqueued, err := q.EnqueueAnalysisBackfillBatch(ctx, 2, 10)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if enqueued != 1 {
		t.Fatalf("enqueued=%d want 1", enqueued)
	}
}
