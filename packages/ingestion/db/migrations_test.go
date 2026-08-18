package db_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationFiles returns the ordered list of migration file paths.
func migrationFiles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no migration files found under db/migrations")
	}
	sort.Strings(files)
	return files
}

// findPsql locates the psql binary; migrations must be applied exactly the way
// scripts/run-migrations.sh applies them in production (per-statement
// autocommit), so the harness shells out instead of re-implementing that.
func findPsql(t *testing.T) string {
	t.Helper()
	if path, err := exec.LookPath("psql"); err == nil {
		return path
	}
	for _, candidate := range []string{
		"/opt/homebrew/opt/libpq/bin/psql",
		"/usr/local/opt/libpq/bin/psql",
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	t.Skip("skipping migration test: psql not found")
	return ""
}

// disposableDB creates a throwaway database on the same server as the test
// pool and returns a pool connected to it plus its DSN. It is dropped on
// cleanup, so the retained development database is never mutated.
func disposableDB(t *testing.T, admin *pgxpool.Pool) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()

	name := fmt.Sprintf("opslane_migtest_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Logf("drop disposable database: %v", err)
		}
	})

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	cfg.ConnConfig.Database = name

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect to disposable database: %v", err)
	}
	t.Cleanup(pool.Close)

	cc := cfg.ConnConfig
	dbDSN := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=disable",
		cc.User, cc.Password, cc.Host, cc.Port, name)
	return pool, dbDSN
}

// applyMigration runs one migration file through psql, mirroring
// scripts/run-migrations.sh (per-statement autocommit, stop on first error).
func applyMigration(t *testing.T, psql, dsn, path string) error {
	t.Helper()
	cmd := exec.Command(psql, "-v", "ON_ERROR_STOP=1", "-q", "-f", path, dsn)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// schemaSnapshot captures columns, indexes, constraints, and enum values so
// two applications of the migrations can be compared structurally.
func schemaSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	var b strings.Builder

	snapshotQuery := func(header, query string) {
		b.WriteString("== " + header + "\n")
		rows, err := pool.Query(ctx, query)
		if err != nil {
			t.Fatalf("snapshot %s: %v", header, err)
		}
		defer rows.Close()
		for rows.Next() {
			values, err := rows.Values()
			if err != nil {
				t.Fatalf("snapshot %s values: %v", header, err)
			}
			parts := make([]string, len(values))
			for i, v := range values {
				parts[i] = fmt.Sprintf("%v", v)
			}
			b.WriteString(strings.Join(parts, " | ") + "\n")
		}
		if rows.Err() != nil {
			t.Fatalf("snapshot %s rows: %v", header, rows.Err())
		}
	}

	snapshotQuery("columns", `
		SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, column_name`)
	snapshotQuery("indexes", `
		SELECT indexname, indexdef FROM pg_indexes
		WHERE schemaname = 'public'
		ORDER BY indexname`)
	snapshotQuery("constraints", `
		SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace
		ORDER BY 1, 2`)
	snapshotQuery("enums", `
		SELECT t.typname, e.enumlabel
		FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
		ORDER BY t.typname, e.enumsortorder`)

	return b.String()
}

// TestMigrations_ApplyCleanlyToFreshDatabase proves every migration applies in
// filename order on an empty database — the roll-forward contract.
func TestMigrations_ApplyCleanlyToFreshDatabase(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	_, dsn := disposableDB(t, admin)

	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed on fresh database: %v", file, err)
		}
	}
}

// TestMigrations_AreIdempotent proves re-applying every migration (what the
// compose migrate service does on every boot) neither errors nor changes the
// schema. Migration files document "IDEMPOTENCY IS MANDATORY"; this enforces it.
func TestMigrations_AreIdempotent(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	files := migrationFiles(t)

	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed on first apply: %v", file, err)
		}
	}
	first := schemaSnapshot(t, pool)

	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed on re-apply: %v", file, err)
		}
	}
	second := schemaSnapshot(t, pool)

	if first != second {
		t.Errorf("schema changed on re-apply:\n--- first apply ---\n%s\n--- second apply ---\n%s", first, second)
	}
}

// TestMigrations_RollForwardFromPreviousSchema proves the latest migration
// applies on top of a database that stopped at the previous one — the state
// every existing deployment is in when it upgrades.
func TestMigrations_RollForwardFromPreviousSchema(t *testing.T) {
	admin := testPool(t)
	files := migrationFiles(t)
	if len(files) < 2 {
		t.Skip("only one migration; nothing to roll forward")
	}

	psql := findPsql(t)
	_, dsn := disposableDB(t, admin)
	for _, file := range files[:len(files)-1] {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed while building previous schema: %v", file, err)
		}
	}
	last := files[len(files)-1]
	if err := applyMigration(t, psql, dsn, last); err != nil {
		t.Fatalf("latest migration %s failed to roll forward from previous schema: %v", last, err)
	}
}

func TestMigration054CreatesPipelineTables(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	want := []string{
		"error_capture_buckets", "error_event_resolutions", "sourcemap_position_cache",
		"error_event_identities", "canonical_issue_fingerprints", "issue_episodes",
		"issue_alias_conflicts", "issue_merges",
		"issue_decisions", "issue_inquiry_decisions", "issue_evidence_anchors",
		"issue_publications", "digest_runs", "digest_run_items",
		"session_request_failures", "session_write_rollups",
	}
	for _, table := range want {
		var exists bool
		err := pool.QueryRow(context.Background(),
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			  WHERE table_schema = 'public' AND table_name = $1)`, table).Scan(&exists)
		if err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestMigration054IsReapplySafe(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	_, dsn := disposableDB(t, admin)
	files := migrationFiles(t)
	for _, file := range files {
		if filepath.Base(file) == "054_pipeline_quality.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	path := "migrations/054_pipeline_quality.sql"
	for i := 0; i < 2; i++ {
		if err := applyMigration(t, psql, dsn, path); err != nil {
			t.Fatalf("apply %d: %v", i+1, err)
		}
	}
}

func TestDefaultBranchNullableMigrationPreservesExistingRows(t *testing.T) {
	admin := testPool(t)
	files := migrationFiles(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)

	for _, file := range files[:len(files)-1] {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ('migration-default-branch') RETURNING id`,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO projects (org_id, name, github_repo, default_branch)
		 VALUES ($1, 'existing', 'o/existing', 'master')`,
		orgID); err != nil {
		t.Fatal(err)
	}

	last := files[len(files)-1]
	if err := applyMigration(t, psql, dsn, last); err != nil {
		t.Fatalf("latest migration %s failed: %v", last, err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, 'new', 'o/new')`,
		orgID); err != nil {
		t.Fatal(err)
	}

	var existing, created *string
	if err := pool.QueryRow(ctx,
		`SELECT default_branch FROM projects WHERE name = 'existing'`,
	).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT default_branch FROM projects WHERE name = 'new'`,
	).Scan(&created); err != nil {
		t.Fatal(err)
	}
	if existing == nil || *existing != "master" {
		t.Fatalf("existing default_branch = %v, want master", existing)
	}
	if created != nil {
		t.Fatalf("new default_branch = %q, want NULL", *created)
	}
}

func TestMigrations_PreserveSelectedProjectDefaultOnReplay(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	files := migrationFiles(t)

	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed on first apply: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ('project-default-replay') RETURNING id`,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	var projectID, productionID, stagingID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name) VALUES ($1, 'default-replay') RETURNING id`,
		orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
		projectID).Scan(&productionID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'staging') RETURNING id`,
		projectID).Scan(&stagingID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE projects SET default_environment_id = $2 WHERE id = $1`, projectID, stagingID); err != nil {
		t.Fatal(err)
	}

	// Every subsequent boot replays all migrations.
	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed on re-apply: %v", file, err)
		}
	}

	var got string
	if err := pool.QueryRow(ctx,
		`SELECT default_environment_id FROM projects WHERE id = $1`, projectID,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != stagingID || got == productionID {
		t.Fatalf("default after replay = %s, want staging %s", got, stagingID)
	}
}

func TestProjectDefaultCompositeForeignKeyRejectsCrossProjectEnvironment(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, firstProjectID, secondProjectID, secondEnvironmentID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('cross-default') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'first') RETURNING id`, orgID).Scan(&firstProjectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'second') RETURNING id`, orgID).Scan(&secondProjectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, secondProjectID).Scan(&secondEnvironmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET default_environment_id = $2 WHERE id = $1`, firstProjectID, secondEnvironmentID); err == nil {
		t.Fatal("cross-project default update succeeded")
	}
}
