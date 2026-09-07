package db_test

import (
	"context"
	"testing"
)

// The migration runner replays every file on every boot, and 037 retires
// 033's unique index so a retried job can append one decision row per
// attempt. The first production database that actually held two decisions
// for one job made 033's replay — and with it every deploy — fail at
// CREATE UNIQUE INDEX. 033 is now guarded on the marker index 037 leaves
// behind; this test holds the replay to that contract.
func TestMigration033ReplaysOverADatabaseCarryingPerAttemptDecisions(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s failed: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID, groupID, jobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ('migration-037') RETURNING id`,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, github_repo)
		 VALUES ($1, 'migration-037', 'opslane/migration-037') RETURNING id`, orgID,
	).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_groups
		   (project_id, fingerprint, title, first_seen, last_seen)
		 VALUES ($1, 'migration-037-group', 'Migration 037 group', now(), now())
		 RETURNING id`, projectID,
	).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, triggered_by)
		 VALUES ($1, $2, 'auto') RETURNING id`, groupID, projectID,
	).Scan(&jobID); err != nil {
		t.Fatal(err)
	}

	// One decision per attempt for the same job: exactly the shape 037
	// legalized and the shape that broke 033's unguarded replay.
	for _, outcome := range []string{"not_actionable", "code_fix"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO diagnosis_decisions
			   (error_group_id, project_id, job_id, outcome, decision_reason,
			    model, prompt_version)
			 VALUES ($1, $2, $3, $4, 'migration-037 replay fixture', 'test', 'v0')`,
			groupID, projectID, jobID, outcome); err != nil {
			t.Fatal(err)
		}
	}

	if err := applyMigration(t, psql, dsn, "migrations/033_diagnosis_decisions.sql"); err != nil {
		t.Fatalf("replay 033 over per-attempt decisions: %v", err)
	}

	indexExists := func(name string) bool {
		var exists bool
		if err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_indexes
			  WHERE schemaname = 'public' AND indexname = $1)`, name,
		).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		return exists
	}
	if indexExists("uq_diagnosis_decisions_job") {
		t.Fatal("replaying 033 reinstalled the retired unique index")
	}
	if !indexExists("idx_diagnosis_decisions_job") {
		t.Fatal("037's per-job lookup index is missing after the replay")
	}
}
