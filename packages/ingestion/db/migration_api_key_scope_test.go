package db_test

import (
	"context"
	"testing"
)

func TestMigrationAddsAPIScope(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	ctx := context.Background()
	const (
		orgID     = "11111111-1111-1111-1111-111111111111"
		projectID = "22222222-2222-2222-2222-222222222222"
	)
	if _, err := pool.Exec(ctx,
		`INSERT INTO orgs (id, name) VALUES ($1, 'api-key migration')`, orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO projects (id, org_id, name, github_repo)
		VALUES ($1, $2, 'app', 'acme/app')`, projectID, orgID); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO project_api_keys
		  (key_id, project_id, scope, token_prefix, secret_hash, label)
		VALUES
		  ('aaaaaaaaaaaaaaaaaaaaaaaaaa', $1, 'api', 'opslane_ak',
		   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'api')`,
		projectID); err != nil {
		t.Fatalf("api-scoped key insert failed: %v", err)
	}

	for _, tc := range []struct {
		keyID, scope, prefix, hash string
	}{
		{"bbbbbbbbbbbbbbbbbbbbbbbbbb", "ingest", "opslane_pk", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		{"cccccccccccccccccccccccccc", "sourcemaps", "opslane_sk", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO project_api_keys
			  (key_id, project_id, scope, token_prefix, secret_hash, label)
			VALUES ($1, $2, $3, $4, $5, 'existing')`,
			tc.keyID, projectID, tc.scope, tc.prefix, tc.hash); err != nil {
			t.Fatalf("%s scope no longer valid: %v", tc.scope, err)
		}
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO project_api_keys
		  (key_id, project_id, scope, token_prefix, secret_hash, label)
		VALUES
		  ('dddddddddddddddddddddddddd', $1, 'api', 'opslane_pk',
		   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'bad')`,
		projectID); err == nil {
		t.Fatal("expected scope/prefix mismatch to be rejected")
	}

	if _, err := pool.Exec(ctx,
		`UPDATE project_api_keys SET expires_at = now() + interval '1 day'`); err != nil {
		t.Fatalf("expires_at column missing: %v", err)
	}
}
