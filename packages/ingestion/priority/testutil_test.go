package priority

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Fatalf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func mustExec(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %.80s: %v", query, err)
	}
}

func seedTenant(t *testing.T, pool *pgxpool.Pool, repo *string) (orgID, projectID, envID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('priority-test') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name, github_repo) VALUES ($1, 'priority-test', $2) RETURNING id`, orgID, repo).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'priority-test') RETURNING id`, projectID).Scan(&envID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		queries := []string{
			`DELETE FROM error_group_jobs WHERE project_id = $1`,
			`DELETE FROM route_map WHERE project_id = $1`,
			`DELETE FROM friction_signals WHERE project_id = $1`,
			`DELETE FROM sessions WHERE project_id = $1`,
			`DELETE FROM error_events WHERE project_id = $1`,
			`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id = $1)`,
			`DELETE FROM error_group_environments WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id = $1)`,
			`DELETE FROM error_groups WHERE project_id = $1`,
			`DELETE FROM end_users WHERE project_id = $1`,
			`UPDATE projects SET default_environment_id = NULL WHERE id = $1`,
			`DELETE FROM environments WHERE project_id = $1`,
			`DELETE FROM projects WHERE id = $1`,
		}
		for _, query := range queries {
			_, _ = pool.Exec(context.Background(), query, projectID)
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, orgID)
	})
	return
}

func seedGroup(t *testing.T, pool *pgxpool.Pool, projectID, envID, fingerprint, kind string) string {
	t.Helper()
	var groupID string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO error_groups
		  (project_id, fingerprint, title, first_seen, last_seen, status, kind, environment_id)
		VALUES ($1, $2, $2, now() - interval '3 days', now(), 'new', $3, CASE WHEN $3 = 'friction' THEN $4::uuid ELSE NULL END)
		RETURNING id`, projectID, fingerprint, kind, envID).Scan(&groupID)
	if err != nil {
		t.Fatal(err)
	}
	return groupID
}
