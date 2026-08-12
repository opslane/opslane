package db_test

import (
	"context"
	"testing"
)

func TestMigration046JobEventAnchor(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}
	ctx := context.Background()

	var dataType, isNullable string
	if err := pool.QueryRow(ctx,
		`SELECT data_type, is_nullable FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = 'error_group_jobs' AND column_name = 'event_id'`,
	).Scan(&dataType, &isNullable); err != nil {
		t.Fatalf("event_id column missing: %v", err)
	}
	if dataType != "uuid" || isNullable != "YES" {
		t.Fatalf("event_id = %s nullable=%s, want uuid nullable", dataType, isNullable)
	}

	var deleteRule string
	if err := pool.QueryRow(ctx,
		`SELECT rc.delete_rule
		 FROM information_schema.referential_constraints rc
		 JOIN information_schema.key_column_usage kcu
		   ON kcu.constraint_catalog = rc.constraint_catalog
		  AND kcu.constraint_schema = rc.constraint_schema
		  AND kcu.constraint_name = rc.constraint_name
		 WHERE kcu.table_schema = 'public'
		   AND kcu.table_name = 'error_group_jobs' AND kcu.column_name = 'event_id'`,
	).Scan(&deleteRule); err != nil {
		t.Fatalf("event_id FK missing: %v", err)
	}
	if deleteRule != "SET NULL" {
		t.Fatalf("delete_rule = %s, want SET NULL", deleteRule)
	}

	// Reapply through the same psql path the runner uses: CONCURRENTLY is only
	// legal outside a transaction block, which pool.Exec's implicit transaction
	// around a multi-statement script would violate.
	if err := applyMigration(t, psql, dsn, "migrations/046_job_event_anchor.sql"); err != nil {
		t.Fatalf("migration 046 is not idempotent on reapply: %v", err)
	}
}
