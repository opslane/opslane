package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestMigration064CreatesActionableLifecycleAndCandidateLedger(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "064_actionable_delivery.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-062') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join("migrations", "064_actionable_delivery.sql")
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}

	for _, column := range []string{"actionable_since", "snoozed_until"} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='error_groups' AND column_name=$1
		)`, column).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Errorf("error_groups.%s is missing", column)
		}
	}
	var primaryKeyColumns []string
	if err := pool.QueryRow(ctx, `
		SELECT array_agg(a.attname ORDER BY k.ordinality)
		FROM pg_constraint c
		JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
		JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
		WHERE c.conrelid='digest_run_candidate_evaluations'::regclass AND c.contype='p'
	`).Scan(&primaryKeyColumns); err != nil {
		t.Fatal(err)
	}
	if len(primaryKeyColumns) != 2 || primaryKeyColumns[0] != "digest_run_id" || primaryKeyColumns[1] != "error_group_id" {
		t.Fatalf("ledger primary key = %v", primaryKeyColumns)
	}

	var insertedID string
	var insertedStamp *time.Time
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status)
		VALUES ($1,'insert-actionable','x',now(),now(),'awaiting_approval')
		RETURNING id,actionable_since`, projectID).Scan(&insertedID, &insertedStamp); err != nil {
		t.Fatal(err)
	}
	if insertedStamp == nil {
		t.Fatal("actionable insert did not stamp actionable_since")
	}

	var groupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status)
		VALUES ($1,'lifecycle','x',now(),now(),'new') RETURNING id`, projectID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	staleSnooze := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
	var firstStamp, snooze *time.Time
	if err := pool.QueryRow(ctx, `UPDATE error_groups
		SET status='awaiting_approval',snoozed_until=$2 WHERE id=$1
		RETURNING actionable_since,snoozed_until`, groupID, staleSnooze).Scan(&firstStamp, &snooze); err != nil {
		t.Fatal(err)
	}
	if firstStamp == nil || snooze != nil {
		t.Fatalf("enter actionable: stamp=%v snooze=%v", firstStamp, snooze)
	}

	wantedSnooze := time.Now().Add(3 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, groupID, wantedSnooze); err != nil {
		t.Fatal(err)
	}
	var preservedStamp, preservedSnooze *time.Time
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='needs_human' WHERE id=$1
		RETURNING actionable_since,snoozed_until`, groupID).Scan(&preservedStamp, &preservedSnooze); err != nil {
		t.Fatal(err)
	}
	if preservedStamp == nil || !preservedStamp.Equal(*firstStamp) || preservedSnooze == nil || !preservedSnooze.Equal(wantedSnooze) {
		t.Fatalf("actionable transition changed lifecycle: stamp=%v snooze=%v", preservedStamp, preservedSnooze)
	}

	var clearedStamp, clearedSnooze *time.Time
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='resolved' WHERE id=$1
		RETURNING actionable_since,snoozed_until`, groupID).Scan(&clearedStamp, &clearedSnooze); err != nil {
		t.Fatal(err)
	}
	if clearedStamp != nil || clearedSnooze != nil {
		t.Fatalf("leaving actionable retained lifecycle: stamp=%v snooze=%v", clearedStamp, clearedSnooze)
	}
	if _, err := pool.Exec(ctx, `SELECT pg_sleep(0.01)`); err != nil {
		t.Fatal(err)
	}
	var restamped *time.Time
	if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='awaiting_approval' WHERE id=$1
		RETURNING actionable_since,snoozed_until`, groupID).Scan(&restamped, &clearedSnooze); err != nil {
		t.Fatal(err)
	}
	if restamped == nil || !restamped.After(*firstStamp) || clearedSnooze != nil {
		t.Fatalf("re-enter actionable: stamp=%v first=%v snooze=%v", restamped, firstStamp, clearedSnooze)
	}

	var runID string
	if err := pool.QueryRow(ctx, `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status)
		VALUES ($1,now()-interval '1 day',now(),current_date,'frozen') RETURNING id`, projectID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code)
		VALUES ($1,'00000000-0000-0000-0000-000000000000','excluded','snoozed')`, runID); err == nil {
		t.Fatal("ledger accepted a bogus error_group_id")
	}
}
