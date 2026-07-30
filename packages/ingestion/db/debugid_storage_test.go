package db_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDebugIDStorage(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to disposable postgres: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("disposable postgres is required for this test: %v", err)
	}

	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer func() {
		if err := tx.Rollback(ctx); err != nil {
			t.Errorf("roll back transaction: %v", err)
		}
	}()

	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE debug_id_storage (id uuid NOT NULL) ON COMMIT DROP`); err != nil {
		t.Fatalf("create temporary table: %v", err)
	}

	const debugID = "158399f3-1dad-1386-35b2-98c34317d52e"
	var stored string
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO debug_id_storage (id) VALUES ($1::uuid) RETURNING id::text`,
		debugID,
	).Scan(&stored); err != nil {
		t.Fatalf("round-trip debug ID: %v", err)
	}
	if stored != debugID {
		t.Fatalf("stored debug ID = %q, want %q", stored, debugID)
	}
}
