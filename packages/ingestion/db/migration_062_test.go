package db_test

import (
	"context"
	"testing"
	"time"
)

func TestMigration062BackfillsDurableEvidenceAndConverges(t *testing.T) {
	admin := testPool(t)
	pool, dsn := disposableDB(t, admin)
	psql := findPsql(t)
	files := migrationFiles(t)
	for _, path := range files {
		if path == "migrations/062_environment_first_event.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, path); err != nil {
			t.Fatalf("apply prerequisite %s: %v", path, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID, evidenceEnvID, emptyEnvID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-062') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'migration-062') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id,name) VALUES ($1,'evidence') RETURNING id`, projectID).Scan(&evidenceEnvID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id,name) VALUES ($1,'empty') RETURNING id`, projectID).Scan(&emptyEnvID); err != nil {
		t.Fatal(err)
	}
	errorAt := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	frictionAt := errorAt.Add(-24 * time.Hour)
	var groupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups (project_id,fingerprint,title,first_seen,last_seen,created_at)
		VALUES ($1,'migration-062-error','Error evidence',$2,$2,$2) RETURNING id`,
		projectID, errorAt,
	).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO error_group_environments
		  (error_group_id,environment_id,first_seen,last_seen,occurrence_count)
		VALUES ($1,$2,$3,$3,1)`, groupID, evidenceEnvID, errorAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO friction_groups
		  (project_id,environment_id,fingerprint,signal_type,page_url,title,first_seen_at,last_seen_at)
		VALUES ($1,$2,'migration-062-friction','rage_click','/checkout','Friction evidence',$3,$3)`,
		projectID, evidenceEnvID, frictionAt); err != nil {
		t.Fatal(err)
	}

	const path = "migrations/062_environment_first_event.sql"
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	var first time.Time
	var emptyIsNull bool
	if err := pool.QueryRow(ctx, `SELECT first_event_at FROM environments WHERE id=$1`, evidenceEnvID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if !first.Equal(frictionAt) {
		t.Fatalf("first_event_at=%s want earliest durable evidence %s", first, frictionAt)
	}
	if err := pool.QueryRow(ctx, `SELECT first_event_at IS NULL FROM environments WHERE id=$1`, emptyEnvID).Scan(&emptyIsNull); err != nil || !emptyIsNull {
		t.Fatalf("empty environment null=%v err=%v", emptyIsNull, err)
	}

	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	var replayed time.Time
	if err := pool.QueryRow(ctx, `SELECT first_event_at FROM environments WHERE id=$1`, evidenceEnvID).Scan(&replayed); err != nil {
		t.Fatal(err)
	}
	if !replayed.Equal(first) {
		t.Fatalf("replay changed first_event_at from %s to %s", first, replayed)
	}
}
