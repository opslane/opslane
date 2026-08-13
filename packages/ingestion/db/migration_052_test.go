package db_test

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigration052RouteMapEnforcement(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "052_route_map_enforcement.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-052') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'route-map-052') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO route_map (project_id, pattern, name, purpose, tier, source, created_at, updated_at) VALUES
		($1, '/late', 'Late kept', 'canonical', 'customer', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://x.test/late', 'Late', 'straggler', 'standard', 'llm', '2026-02-01', '2026-05-01'),
		($1, '/hand', 'Auto', 'generated', 'standard', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://x.test/hand', 'Handmade', 'curated', 'customer', 'human', '2026-02-01', '2026-05-01'),
		($1, 'https://x.test/solo', 'Solo', '', 'admin', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'HTTPS://x.test/upper', 'Upper', '', 'standard', 'llm', '2026-01-01', '2026-04-01')`, projectID)
	if err != nil {
		t.Fatal(err)
	}

	if err := applyMigration(t, psql, dsn, "migrations/052_route_map_enforcement.sql"); err != nil {
		t.Fatalf("apply migration 052: %v", err)
	}

	type route struct{ name, purpose, tier, source string }
	loadRoute := func(pattern string) route {
		t.Helper()
		var got route
		if err := pool.QueryRow(ctx, `SELECT name,purpose,tier,source FROM route_map WHERE project_id=$1 AND pattern=$2`, projectID, pattern).Scan(
			&got.name, &got.purpose, &got.tier, &got.source,
		); err != nil {
			t.Fatalf("load %s: %v", pattern, err)
		}
		return got
	}
	late := loadRoute("/late")
	if late.name != "Late kept" || late.tier != "customer" || late.source != "llm" {
		t.Errorf("late survivor = %+v", late)
	}
	hand := loadRoute("/hand")
	if hand.name != "Handmade" || hand.purpose != "curated" || hand.tier != "customer" || hand.source != "human" {
		t.Errorf("hand survivor = %+v", hand)
	}
	if got := loadRoute("/solo"); got.name != "Solo" {
		t.Errorf("solo survivor = %+v", got)
	}
	if got := loadRoute("/upper"); got.name != "Upper" {
		t.Errorf("uppercase survivor = %+v", got)
	}
	var originRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map WHERE project_id=$1 AND pattern ~* '^https?://'`, projectID).Scan(&originRows); err != nil {
		t.Fatal(err)
	}
	if originRows != 0 {
		t.Errorf("origin-full rows after enforcement = %d, want 0", originRows)
	}
	var conflicts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map_migration_conflicts WHERE project_id=$1 AND reason='post_migration_straggler'`, projectID).Scan(&conflicts); err != nil {
		t.Fatal(err)
	}
	if conflicts != 2 {
		t.Errorf("straggler conflicts = %d, want 2", conflicts)
	}

	if err := applyMigration(t, psql, dsn, "migrations/052_route_map_enforcement.sql"); err != nil {
		t.Fatalf("reapply migration 052: %v", err)
	}
	var conflictsAfter int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map_migration_conflicts WHERE project_id=$1 AND reason='post_migration_straggler'`, projectID).Scan(&conflictsAfter); err != nil {
		t.Fatal(err)
	}
	if conflictsAfter != conflicts {
		t.Errorf("second apply added conflicts: before %d after %d", conflicts, conflictsAfter)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO route_map (project_id,pattern,name,tier) VALUES ($1,'https://x.test/nope','Nope','standard')`, projectID); err == nil {
		t.Fatal("origin-full route_map insert succeeded after CHECK enforcement")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO route_map (project_id,pattern,name,tier) VALUES ($1,'/valid','Valid','standard')`, projectID); err != nil {
		t.Fatalf("path-only route_map insert rejected: %v", err)
	}
}
