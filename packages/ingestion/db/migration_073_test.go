package db_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migration073File is the one file under test; the upgrade-path case applies
// everything before it, then it, exactly as a running deployment would.
const migration073File = "migrations/073_fix_provenance_scope.sql"

// seedFixProvenanceProject creates an org, a project and one waiting incident.
func seedFixProvenanceProject(t *testing.T, pool *pgxpool.Pool, name string) (string, string) {
	t.Helper()
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ($1) RETURNING id`, name).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`,
		orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	return projectID, seedLifecycleGroup(t, pool, projectID, "073-"+name, "needs_human")
}

// TestMigration073FixAttemptedHonorsTheProjectArgument is the defect 073
// exists for: 072's body compared error_group_jobs.project_id with itself, so
// one tenant's fix job answered every other tenant's question.
func TestMigration073FixAttemptedHonorsTheProjectArgument(t *testing.T) {
	pool, _ := applyAllMigrationsForFixProvenance(t)
	ctx := context.Background()
	projectA, groupA := seedFixProvenanceProject(t, pool, "073-tenant-a")
	projectB, _ := seedFixProvenanceProject(t, pool, "073-tenant-b")
	jobID := seedTerminalJob(t, pool, projectA, groupA, "fix")

	var owner, stranger bool
	if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted($1::uuid,$2::uuid)`,
		jobID, projectA).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted($1::uuid,$2::uuid)`,
		jobID, projectB).Scan(&stranger); err != nil {
		t.Fatal(err)
	}
	if !owner {
		t.Fatal("the project that owns the fix job saw no fix attempt")
	}
	if stranger {
		t.Fatal("another project's id reported a fix attempt on a job it does not own")
	}
}

// TestMigration073AppliesOverADatabaseCarrying072AndReapplies walks the
// upgrade path every existing deployment takes, then replays the file the way
// the compose migrate service does on every boot. Both cases share one
// database: building the whole schema is the expensive part of this suite.
func TestMigration073AppliesOverADatabaseCarrying072AndReapplies(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	ctx := context.Background()

	for _, file := range migrationFiles(t) {
		if filepath.ToSlash(file) == migration073File {
			continue
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	projectA, groupA := seedFixProvenanceProject(t, pool, "073-upgrade-a")
	projectB, _ := seedFixProvenanceProject(t, pool, "073-upgrade-b")
	jobID := seedTerminalJob(t, pool, projectA, groupA, "fix")

	// The state 072 leaves behind: every project answers yes.
	var beforeUpgrade bool
	if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted($1::uuid,$2::uuid)`,
		jobID, projectB).Scan(&beforeUpgrade); err != nil {
		t.Fatal(err)
	}
	if !beforeUpgrade {
		t.Fatal("072 already scoped by project; this migration would be a no-op")
	}

	if err := applyMigration(t, psql, dsn, migration073File); err != nil {
		t.Fatalf("apply 073 over 072: %v", err)
	}
	assertScoped := func(stage string) {
		t.Helper()
		var stranger, owner bool
		if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted($1::uuid,$2::uuid)`,
			jobID, projectB).Scan(&stranger); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted($1::uuid,$2::uuid)`,
			jobID, projectA).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if stranger {
			t.Fatalf("%s: the wrong-project answer is still true", stage)
		}
		if !owner {
			t.Fatalf("%s: the owning project's answer broke", stage)
		}
	}
	assertScoped("after the upgrade")

	// The parameter names 072 declared are still the parameter names, or a
	// replay of 072 after 073 would fail with a rename error on every boot.
	var definition string
	if err := pool.QueryRow(ctx,
		`SELECT pg_get_functiondef('error_groups_fix_attempted(uuid,uuid)'::regprocedure)`).Scan(&definition); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(definition, "terminal_fix_job_id uuid, project_id uuid") {
		t.Fatalf("073 renamed the function's parameters:\n%s", definition)
	}

	// Reapply, which is what every boot does, and prove nothing moved.
	first := schemaSnapshot(t, pool)
	for range 2 {
		if err := applyMigration(t, psql, dsn, migration073File); err != nil {
			t.Fatalf("reapply 073: %v", err)
		}
	}
	if second := schemaSnapshot(t, pool); second != first {
		t.Errorf("reapplying 073 changed the schema:\n--- before ---\n%s\n--- after ---\n%s", first, second)
	}
	assertScoped("after two reapplications")
}
