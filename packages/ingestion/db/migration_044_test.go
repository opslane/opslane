package db_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const migration044Path = "migrations/044_actionable_receipts_contracts.sql"

type migration044Fixture struct {
	projectID      string
	otherProjectID string
	groupID        string
	jobID          string
}

func applyMigrationsThrough044(t *testing.T) (*pgxpool.Pool, string, string) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
		if file == migration044Path {
			return pool, dsn, psql
		}
	}
	// The pre-044 red run overlays this test onto the base tree. In that tree,
	// applying every available migration intentionally leaves the old schema so
	// each contract subtest fails at the capability it proves.
	return pool, dsn, psql
}

func seedMigration044Fixture(t *testing.T, pool *pgxpool.Pool) migration044Fixture {
	t.Helper()
	ctx := context.Background()
	var orgID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ('migration-044') RETURNING id`,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}

	var fixture migration044Fixture
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, 'migration-044-primary', 'opslane/primary') RETURNING id`, orgID,
	).Scan(&fixture.projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, 'migration-044-other', 'opslane/other') RETURNING id`, orgID,
	).Scan(&fixture.otherProjectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_groups
		   (project_id, fingerprint, title, first_seen, last_seen)
		 VALUES ($1, 'migration-044-group', 'Migration 044 group', now(), now())
		 RETURNING id`, fixture.projectID,
	).Scan(&fixture.groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
		 VALUES ($1, $2, 'auto') RETURNING id`,
		fixture.groupID, fixture.projectID,
	).Scan(&fixture.jobID); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func expectMigration044ExecError(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), query, args...); err == nil {
		t.Fatalf("statement unexpectedly succeeded: %s", strings.TrimSpace(query))
	}
}

func TestMigration044Contracts(t *testing.T) {
	pool, _, _ := applyMigrationsThrough044(t)
	fixture := seedMigration044Fixture(t, pool)
	ctx := context.Background()

	t.Run("diagnosis supports incomplete outcomes", func(t *testing.T) {
		var decisionID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO diagnosis_decisions
			   (error_group_id, project_id, job_id, outcome, decision_reason, model, prompt_version)
			 VALUES ($1, $2, $3, 'incomplete', 'verification did not finish',
			         'contract-model', 'c0')
			 RETURNING id`, fixture.groupID, fixture.projectID, fixture.jobID,
		).Scan(&decisionID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("diagnosis policy fields round trip", func(t *testing.T) {
		var decisionID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO diagnosis_decisions
			   (error_group_id, project_id, outcome, decision_reason, model,
			    prompt_version, policy_eligible, policy_basis)
			 VALUES ($1, $2, 'code_fix', 'local code cause', 'contract-model',
			         'c0', true, '{"v":1,"basis":"eligible"}'::jsonb)
			 RETURNING id`, fixture.groupID, fixture.projectID,
		).Scan(&decisionID); err != nil {
			t.Fatal(err)
		}

		var eligible *bool
		var basisBytes []byte
		if err := pool.QueryRow(ctx,
			`SELECT policy_eligible, policy_basis FROM diagnosis_decisions WHERE id = $1`, decisionID,
		).Scan(&eligible, &basisBytes); err != nil {
			t.Fatal(err)
		}
		var basis map[string]any
		if err := json.Unmarshal(basisBytes, &basis); err != nil {
			t.Fatal(err)
		}
		if eligible == nil || !*eligible || basis["v"] != float64(1) || basis["basis"] != "eligible" {
			t.Fatalf("policy fields did not round trip: eligible=%v basis=%v", eligible, basis)
		}

		expectMigration044ExecError(t, pool,
			`INSERT INTO diagnosis_decisions
			   (error_group_id, project_id, outcome, decision_reason, model, prompt_version)
			 VALUES ($1, $2, 'bogus', 'invalid', 'contract-model', 'c0')`,
			fixture.groupID, fixture.projectID)
	})

	t.Run("error groups expose impact and terminal fix fields", func(t *testing.T) {
		var terminalJobID *string
		var impactClass *string
		var impactVisits, recovered *int64
		var computedAt any
		if err := pool.QueryRow(ctx,
			`SELECT terminal_fix_job_id, impact_class, impact_visits,
			        impact_visits_recovered, impact_computed_at
			 FROM error_groups WHERE id = $1`, fixture.groupID,
		).Scan(&terminalJobID, &impactClass, &impactVisits, &recovered, &computedAt); err != nil {
			t.Fatal(err)
		}
		if terminalJobID != nil || impactClass != nil || impactVisits != nil || recovered != nil || computedAt != nil {
			t.Fatal("new error-group fields must default to NULL")
		}

		expectMigration044ExecError(t, pool,
			`UPDATE error_groups SET impact_class = 'bogus' WHERE id = $1`, fixture.groupID)
		expectMigration044ExecError(t, pool,
			`UPDATE error_groups SET terminal_fix_job_id = gen_random_uuid() WHERE id = $1`, fixture.groupID)
	})

	t.Run("digest readiness enforces tenant pairs", func(t *testing.T) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO digest_readiness (incident_id, project_id, status, reason)
			 VALUES ($1, $2, 'eligible', 'ready')`, fixture.groupID, fixture.projectID,
		); err != nil {
			t.Fatal(err)
		}
		expectMigration044ExecError(t, pool,
			`UPDATE digest_readiness SET project_id = $2 WHERE incident_id = $1`,
			fixture.groupID, fixture.otherProjectID)
	})

	t.Run("ledger preserves audit constraints", func(t *testing.T) {
		var runID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO fix_run_ledger
			   (job_id, project_id, run_id, entry_seq, command, commit_sha,
			    workdir_dirty, discovered, passed, failed, skipped, not_run)
			 VALUES ($1, $2, gen_random_uuid(), 1, 'pnpm test', '0123456789abcdef',
			         false, 2, 1, 1, 0, '["browser smoke"]'::jsonb)
			 RETURNING run_id`, fixture.jobID, fixture.projectID,
		).Scan(&runID); err != nil {
			t.Fatal(err)
		}
		expectMigration044ExecError(t, pool,
			`INSERT INTO fix_run_ledger
			   (job_id, project_id, run_id, entry_seq, command, commit_sha, workdir_dirty)
			 VALUES ($1, $2, $3, 1, 'pnpm test', '0123456789abcdef', false)`,
			fixture.jobID, fixture.projectID, runID)
		expectMigration044ExecError(t, pool,
			`INSERT INTO fix_run_ledger
			   (job_id, project_id, run_id, entry_seq, command, commit_sha, workdir_dirty, not_run)
			 VALUES ($1, $2, gen_random_uuid(), 2, 'pnpm build', '0123456789abcdef', false, '{}'::jsonb)`,
			fixture.jobID, fixture.projectID)
		expectMigration044ExecError(t, pool,
			`DELETE FROM error_group_jobs WHERE id = $1`, fixture.jobID)
	})

	t.Run("terminal fix references clear when jobs are deleted", func(t *testing.T) {
		var terminalJobID string
		if err := pool.QueryRow(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
			 VALUES ($1, $2, 'human') RETURNING id`, fixture.groupID, fixture.projectID,
		).Scan(&terminalJobID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			`UPDATE error_groups SET terminal_fix_job_id = $2 WHERE id = $1`, fixture.groupID, terminalJobID,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM error_group_jobs WHERE id = $1`, terminalJobID); err != nil {
			t.Fatal(err)
		}
		var got *string
		if err := pool.QueryRow(ctx,
			`SELECT terminal_fix_job_id FROM error_groups WHERE id = $1`, fixture.groupID,
		).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != nil {
			t.Fatalf("terminal_fix_job_id = %s, want NULL", *got)
		}
	})

	t.Run("triggered by guard retains invalid-value rejection", func(t *testing.T) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
			 VALUES ($1, $2, 'reinvestigate_report_only')`, fixture.groupID, fixture.projectID,
		); err != nil {
			t.Fatal(err)
		}
		expectMigration044ExecError(t, pool,
			`INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
			 VALUES ($1, $2, 'bogus')`, fixture.groupID, fixture.projectID)
	})
}

func migrationFilesBefore044(t *testing.T) []string {
	t.Helper()
	files := migrationFiles(t)
	for i, file := range files {
		if file == migration044Path {
			return files[:i]
		}
	}
	t.Fatalf("%s not found", migration044Path)
	return nil
}

func applyMigrationList(t *testing.T, psql, dsn string, files []string) {
	t.Helper()
	for _, file := range files {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
	}
}

// migration044StatementPrefixes splits migration 044 into cumulative statement
// prefixes, derived from the file itself so they can never drift from the SQL
// they interrupt-test. The runner autocommits per statement, so a boundary is
// a line whose trailing ';' sits outside a $$ ... $$ block.
func migration044StatementPrefixes(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(migration044Path)
	if err != nil {
		t.Fatal(err)
	}
	var prefixes []string
	var b strings.Builder
	inDollarQuote := false
	for _, line := range strings.SplitAfter(string(raw), "\n") {
		b.WriteString(line)
		if strings.Count(line, "$$")%2 == 1 {
			inDollarQuote = !inDollarQuote
		}
		trimmed := strings.TrimSpace(line)
		if inDollarQuote || strings.HasPrefix(trimmed, "--") || !strings.HasSuffix(trimmed, ";") {
			continue
		}
		prefixes = append(prefixes, b.String())
	}
	if inDollarQuote {
		t.Fatalf("%s: unterminated $$ block; the prefix splitter no longer understands this file", migration044Path)
	}
	if len(prefixes) == 0 {
		t.Fatalf("%s: no statement boundaries found", migration044Path)
	}
	// Everything after the final boundary must be blank or comment, or the
	// splitter is silently under-covering the file.
	for _, line := range strings.Split(string(raw)[len(prefixes[len(prefixes)-1]):], "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "--") {
			t.Fatalf("%s: trailing content after the last statement boundary: %q", migration044Path, trimmed)
		}
	}
	return prefixes
}

func TestMigration044IsIdempotentAfterEveryStatementPrefix(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	previous := migrationFilesBefore044(t)

	canonicalPool, canonicalDSN := disposableDB(t, admin)
	applyMigrationList(t, psql, canonicalDSN, previous)
	if err := applyMigration(t, psql, canonicalDSN, migration044Path); err != nil {
		t.Fatal(err)
	}
	canonical := schemaSnapshot(t, canonicalPool)
	for i := 0; i < 2; i++ {
		if err := applyMigration(t, psql, canonicalDSN, migration044Path); err != nil {
			t.Fatalf("full replay %d failed: %v", i+2, err)
		}
	}
	if replayed := schemaSnapshot(t, canonicalPool); replayed != canonical {
		t.Fatalf("schema changed after three full applications:\n--- first ---\n%s\n--- third ---\n%s", canonical, replayed)
	}

	// The final prefix is the whole file, which the triple full replay above
	// already covers; every proper prefix is an interrupted apply.
	statements := migration044StatementPrefixes(t)
	prefixes := statements[:len(statements)-1]
	tempDir := t.TempDir()
	for i, prefix := range prefixes {
		name := fmt.Sprintf("%02d.sql", i+1)
		path := filepath.Join(tempDir, name)
		if err := os.WriteFile(path, []byte(prefix), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Run(name, func(t *testing.T) {
			pool, dsn := disposableDB(t, admin)
			applyMigrationList(t, psql, dsn, previous)
			if err := applyMigration(t, psql, dsn, path); err != nil {
				t.Fatalf("prefix failed: %v", err)
			}
			if err := applyMigration(t, psql, dsn, migration044Path); err != nil {
				t.Fatalf("full recovery failed: %v", err)
			}
			if got := schemaSnapshot(t, pool); got != canonical {
				t.Fatalf("schema differs after prefix recovery:\n--- canonical ---\n%s\n--- recovered ---\n%s", canonical, got)
			}
		})
	}
}
