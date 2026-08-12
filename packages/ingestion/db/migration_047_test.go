package db_test

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigration047ActionScope(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "047_action_scope.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, projectA, projectB, environmentA, environmentB string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-047') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'a') RETURNING id`, orgID).Scan(&projectA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'b') RETURNING id`, orgID).Scan(&projectB); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectA).Scan(&environmentA); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectB).Scan(&environmentB); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, "migrations/047_action_scope.sql"); err != nil {
		t.Fatal(err)
	}

	var enabled bool
	if err := pool.QueryRow(ctx, `SELECT action_scope_enabled FROM projects WHERE id = $1`, projectA).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("action_scope_enabled must default to false")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO project_action_environments (project_id, environment_id) VALUES ($1, $2)`,
		projectA, environmentB,
	); err == nil {
		t.Fatal("cross-project environment accepted; composite FK missing")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO project_action_environments (project_id, environment_id) VALUES ($1, $2)`,
		projectA, environmentA,
	); err != nil {
		t.Fatalf("valid allowlist row rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE projects SET action_scope_enabled = true WHERE id = $1`, projectA); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM environments WHERE id = $1`, environmentA); err != nil {
		t.Fatal(err)
	}
	var members int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_action_environments WHERE project_id = $1`, projectA).Scan(&members); err != nil {
		t.Fatal(err)
	}
	if members != 0 {
		t.Fatalf("membership not cascaded: %d rows", members)
	}
	if err := pool.QueryRow(ctx, `SELECT action_scope_enabled FROM projects WHERE id = $1`, projectA).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("flag must survive environment deletion")
	}

	// Reapply through the same psql path the runner uses: CONCURRENTLY is only
	// legal outside a transaction block, which pool.Exec's implicit transaction
	// around a multi-statement script would violate.
	if err := applyMigration(t, psql, dsn, "migrations/047_action_scope.sql"); err != nil {
		t.Fatalf("migration 047 is not idempotent on reapply: %v", err)
	}
}
