package db_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestMigration053DeliveryPolicyIsIdempotentAndRecoversPartialApply(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "053_delivery_policy.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}

	path := "migrations/053_delivery_policy.sql"
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatalf("apply migration 053: %v", err)
	}
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatalf("reapply migration 053: %v", err)
	}

	ctx := context.Background()
	var defaultValue string
	if err := pool.QueryRow(ctx, `
		SELECT column_default FROM information_schema.columns
		WHERE table_name = 'notification_destinations' AND column_name = 'delivery_policy'`,
	).Scan(&defaultValue); err != nil {
		t.Fatalf("delivery_policy column missing: %v", err)
	}
	if !strings.Contains(defaultValue, "immediate") {
		t.Errorf("default must be immediate, got %q", defaultValue)
	}

	queries := db.New(pool)
	_, projectID, _ := seedNotificationProject(t, queries, "migration-053")
	destination := destinationFixture(projectID, "constraint")
	var orgID string
	if err := pool.QueryRow(ctx, `SELECT org_id FROM projects WHERE id = $1`, projectID).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := queries.CreateNotificationDestination(ctx, orgID, projectID, destination); err != nil {
		t.Fatalf("insert destination: %v", err)
	}
	_, err := pool.Exec(ctx, `UPDATE notification_destinations SET delivery_policy = 'whenever' WHERE id = $1`, destination.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != "notification_destinations_delivery_policy_check" {
		t.Fatalf("invalid policy error = %v", err)
	}

	if _, err := pool.Exec(ctx, `ALTER TABLE notification_destinations DROP CONSTRAINT notification_destinations_delivery_policy_check`); err != nil {
		t.Fatal(err)
	}
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatalf("recover partial apply: %v", err)
	}
	var constraintName string
	if err := pool.QueryRow(ctx, `
		SELECT conname FROM pg_constraint
		WHERE conrelid = 'notification_destinations'::regclass
		  AND conname = 'notification_destinations_delivery_policy_check'`,
	).Scan(&constraintName); err != nil {
		t.Fatalf("constraint not restored: %v", err)
	}
}
