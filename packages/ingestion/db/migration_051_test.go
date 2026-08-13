package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestMigration051RouteMapCanonicalization(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "051_route_map_canonicalization.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-051') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'route-map-051') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO route_map (project_id, pattern, name, purpose, tier, source, created_at, updated_at) VALUES
		($1, '/assets', 'Assets home', 'assets', 'standard', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/assets', 'Assets home', 'assets old', 'customer', 'llm', '2026-02-01', '2026-05-01'),
		($1, '/reports', 'Reports', 'kept purpose', 'standard', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/reports', 'Weekly report screen', 'dropped purpose', 'customer', 'llm', '2026-02-01', '2026-05-01'),
		($1, '/checkout', 'checkout', 'unknown', 'admin', 'llm-unresolved', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/checkout', 'Checkout', 'purchase', 'standard', 'llm', '2026-02-01', '2026-05-01'),
		($1, '/billing', 'Billing v1', 'auto', 'admin', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/billing', 'Billing', 'hand-authored', 'standard', 'human', '2026-02-01', '2026-05-01'),
		($1, 'https://a.cdn.test/settings', 'Settings', 'old', 'standard', 'llm', '2026-03-02', '2026-04-02'),
		($1, 'https://b.cdn.test/settings', 'Settings page', 'new', 'customer', 'llm', '2026-03-01', '2026-04-01'),
		($1, '/profile', 'profile', '', 'standard', 'llm', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/profile', 'Profile', '', 'customer', 'llm', '2026-02-01', '2026-05-01'),
		($1, 'HTTPS://app.test/shouty', 'Shouty', '', 'standard', 'llm', '2026-01-01', '2026-04-01'),
		($1, '/admin-area', 'Admin area', 'operator call', 'admin', 'human', '2026-01-01', '2026-04-01'),
		($1, 'https://app.test/admin-area', 'Admin area', 'llm guess', 'customer', 'llm', '2026-02-01', '2026-05-01'),
		($1, '/untouched', 'Untouched', 'same', 'admin', 'human', '2025-01-01', '2025-02-01')`, projectID)
	if err != nil {
		t.Fatal(err)
	}

	if err := applyMigration(t, psql, dsn, "migrations/051_route_map_canonicalization.sql"); err != nil {
		t.Fatalf("apply migration 051: %v", err)
	}

	var originRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map WHERE project_id=$1 AND pattern ~* '^https?://'`, projectID).Scan(&originRows); err != nil {
		t.Fatal(err)
	}
	if originRows != 0 {
		t.Fatalf("origin-full rows after migration = %d, want 0", originRows)
	}

	type route struct {
		name, purpose, tier, source string
		createdAt, updatedAt        time.Time
	}
	loadRoute := func(pattern string) route {
		t.Helper()
		var got route
		if err := pool.QueryRow(ctx, `SELECT name,purpose,tier,source,created_at,updated_at FROM route_map WHERE project_id=$1 AND pattern=$2`, projectID, pattern).Scan(
			&got.name, &got.purpose, &got.tier, &got.source, &got.createdAt, &got.updatedAt,
		); err != nil {
			t.Fatalf("load %s: %v", pattern, err)
		}
		return got
	}

	assets := loadRoute("/assets")
	if assets.name != "Assets home" || assets.tier != "customer" || !assets.createdAt.Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("assets survivor = %+v", assets)
	}
	reports := loadRoute("/reports")
	if reports.name != "Reports" || reports.tier != "customer" || !reports.updatedAt.Equal(time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("reports survivor = %+v", reports)
	}
	checkout := loadRoute("/checkout")
	if checkout.name != "Checkout" || checkout.source != "llm" || checkout.tier != "standard" {
		t.Errorf("checkout survivor = %+v", checkout)
	}
	billing := loadRoute("/billing")
	if billing.name != "Billing" || billing.source != "human" || billing.tier != "standard" {
		t.Errorf("billing survivor = %+v", billing)
	}
	settings := loadRoute("/settings")
	if settings.name != "Settings page" || settings.tier != "customer" {
		t.Errorf("settings survivor = %+v", settings)
	}
	if got := loadRoute("/shouty"); got.name != "Shouty" {
		t.Errorf("uppercase scheme survivor = %+v", got)
	}
	// Conservative reach must not reverse an operator's own classification:
	// the human row is 'admin', its llm twin guessed 'customer'.
	adminArea := loadRoute("/admin-area")
	if adminArea.source != "human" || adminArea.tier != "admin" {
		t.Errorf("human tier overridden by llm twin: %+v", adminArea)
	}
	untouched := loadRoute("/untouched")
	if untouched.name != "Untouched" || untouched.source != "human" || !untouched.updatedAt.Equal(time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("untouched row changed = %+v", untouched)
	}

	var conflicts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map_migration_conflicts WHERE project_id=$1`, projectID).Scan(&conflicts); err != nil {
		t.Fatal(err)
	}
	if conflicts != 3 {
		t.Errorf("conflicts = %d, want 3", conflicts)
	}
	var droppedSource, droppedPurpose string
	if err := pool.QueryRow(ctx, `SELECT dropped_source,dropped_purpose FROM route_map_migration_conflicts WHERE project_id=$1 AND canonical_pattern='/reports'`, projectID).Scan(&droppedSource, &droppedPurpose); err != nil {
		t.Fatal(err)
	}
	if droppedSource != "llm" || droppedPurpose != "dropped purpose" {
		t.Errorf("reports audit source/purpose = %q/%q", droppedSource, droppedPurpose)
	}
	var profileConflicts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM route_map_migration_conflicts WHERE project_id=$1 AND canonical_pattern IN ('/profile','/checkout')`, projectID).Scan(&profileConflicts); err != nil {
		t.Fatal(err)
	}
	if profileConflicts != 0 {
		t.Errorf("case-only conflicts = %d, want 0", profileConflicts)
	}

	var routesBefore, conflictsBefore string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(rm) ORDER BY pattern)::text, '[]') FROM route_map rm WHERE project_id=$1`, projectID).Scan(&routesBefore); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text, '[]') FROM route_map_migration_conflicts c WHERE project_id=$1`, projectID).Scan(&conflictsBefore); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, "migrations/051_route_map_canonicalization.sql"); err != nil {
		t.Fatalf("reapply migration 051: %v", err)
	}
	var routesAfter, conflictsAfter string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(rm) ORDER BY pattern)::text, '[]') FROM route_map rm WHERE project_id=$1`, projectID).Scan(&routesAfter); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text, '[]') FROM route_map_migration_conflicts c WHERE project_id=$1`, projectID).Scan(&conflictsAfter); err != nil {
		t.Fatal(err)
	}
	if routesBefore != routesAfter || conflictsBefore != conflictsAfter {
		t.Error("second application changed route-map data or conflict audit")
	}
}
