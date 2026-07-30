package db_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}

	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping DB test: cannot connect to postgres: %v", err)
	}

	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("skipping DB test: postgres not reachable: %v", err)
	}

	t.Cleanup(func() {
		pool.Close()
	})

	return pool
}

// ptrStr returns a pointer to a string literal (helper for *string params in tests).
func ptrStr(s string) *string { return &s }

// cleanupTenant removes all data created during a test, scoped by org ID.
func cleanupTenant(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()

	// Delete in dependency order
	queries := []string{
		`DELETE FROM oauth_login_states WHERE target_org_id = $1 OR initiating_user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM installation_landed WHERE org_id = $1`,
		`DELETE FROM github_app_installations WHERE org_id = $1`,
		`DELETE FROM outbound_deliveries WHERE destination_id IN (SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM memberships WHERE org_id = $1 OR user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	}

	for _, q := range queries {
		if _, err := pool.Exec(ctx, q, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}
