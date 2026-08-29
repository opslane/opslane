package db_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// applyMigrationsThrough066 builds a schema at exactly migration 066 and
// returns the pool plus a project to hang error groups from.
func applyMigrationsThrough066(t *testing.T) (*pgxpool.Pool, string, string) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
		if filepath.Base(file) == "066_pr_actionable.sql" {
			break
		}
	}
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-066') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	return pool, dsn, projectID
}

func seedLifecycleGroup(t *testing.T, pool *pgxpool.Pool, projectID, fingerprint, status string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status)
		VALUES ($1,$2,'x',now(),now(),$3::error_group_status) RETURNING id`,
		projectID, fingerprint, status).Scan(&id); err != nil {
		t.Fatalf("seed lifecycle group %s: %v", fingerprint, err)
	}
	return id
}

func lifecycleState(t *testing.T, pool *pgxpool.Pool, groupID string) (*time.Time, *time.Time) {
	t.Helper()
	var since, snooze *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT actionable_since,snoozed_until FROM error_groups WHERE id=$1`, groupID).Scan(&since, &snooze); err != nil {
		t.Fatalf("read lifecycle state: %v", err)
	}
	return since, snooze
}

// TestMigration066PRStatusesEnterTheActionableLifecycle pins the action-class
// semantics: the waiting age resets exactly when the ask a reader would see
// changes, and is preserved when it does not.
func TestMigration066PRStatusesEnterTheActionableLifecycle(t *testing.T) {
	pool, _, projectID := applyMigrationsThrough066(t)
	ctx := context.Background()

	t.Run("insert into pr_created stamps", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-insert-pr", "pr_created")
		since, snooze := lifecycleState(t, pool, id)
		if since == nil || snooze != nil {
			t.Fatalf("pr_created insert: since=%v snooze=%v", since, snooze)
		}
	})

	t.Run("awaiting_approval to pr_created resets and clears the snooze", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-approve-to-pr", "new")
		snoozeUntil := time.Now().Add(6 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET status='awaiting_approval',candidate_diff='--- a/x' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, id, snoozeUntil); err != nil {
			t.Fatal(err)
		}
		before, _ := lifecycleState(t, pool, id)
		if _, err := pool.Exec(ctx, `SELECT pg_sleep(0.01)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET status='pr_created',pr_url='https://github.com/o/r/pull/1' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, snooze := lifecycleState(t, pool, id)
		if since == nil || before == nil || !since.After(*before) || snooze != nil {
			t.Fatalf("entering PR review: since=%v before=%v snooze=%v", since, before, snooze)
		}
	})

	t.Run("pr_draft to pr_created preserves both", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-draft-to-open", "new")
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET status='pr_draft',pr_url='https://github.com/o/r/pull/2' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		snoozeUntil := time.Now().Add(2 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, id, snoozeUntil); err != nil {
			t.Fatal(err)
		}
		before, _ := lifecycleState(t, pool, id)
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET status='pr_created' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, snooze := lifecycleState(t, pool, id)
		if since == nil || before == nil || !since.Equal(*before) {
			t.Fatalf("draft flip changed the waiting age: since=%v before=%v", since, before)
		}
		if snooze == nil || !snooze.Equal(snoozeUntil) {
			t.Fatalf("draft flip cleared the snooze: %v", snooze)
		}
	})

	t.Run("awaiting_approval gaining a saved diff resets", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-diff-appears", "new")
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET status='awaiting_approval' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		before, _ := lifecycleState(t, pool, id)
		if _, err := pool.Exec(ctx, `SELECT pg_sleep(0.01)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET candidate_diff='--- a/x' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, _ := lifecycleState(t, pool, id)
		if since == nil || before == nil || !since.After(*before) {
			t.Fatalf("saved diff did not reset the ask: since=%v before=%v", since, before)
		}
	})

	t.Run("pr_created gaining a pr_url resets", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-url-appears", "pr_created")
		before, _ := lifecycleState(t, pool, id)
		if _, err := pool.Exec(ctx, `SELECT pg_sleep(0.01)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET pr_url='https://github.com/o/r/pull/3' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, _ := lifecycleState(t, pool, id)
		if since == nil || before == nil || !since.After(*before) {
			t.Fatalf("pr_url arrival did not reset the ask: since=%v before=%v", since, before)
		}
	})

	t.Run("same-class rewrite preserves an explicit actionable_since", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-explicit-stamp", "pr_created")
		pinned := time.Now().Add(-9 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET pr_url='https://github.com/o/r/pull/4' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`, id, pinned); err != nil {
			t.Fatal(err)
		}
		since, _ := lifecycleState(t, pool, id)
		if since == nil || !since.Equal(pinned) {
			t.Fatalf("explicit actionable_since was overwritten: %v want %v", since, pinned)
		}
		// A same-class column rewrite must not disturb the pinned stamp either.
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET pr_url='https://github.com/o/r/pull/5' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, _ = lifecycleState(t, pool, id)
		if since == nil || !since.Equal(pinned) {
			t.Fatalf("same-class rewrite reset the stamp: %v want %v", since, pinned)
		}
	})

	t.Run("leaving the extended set clears", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-leaves", "pr_created")
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET status='merged' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		since, snooze := lifecycleState(t, pool, id)
		if since != nil || snooze != nil {
			t.Fatalf("merged retained lifecycle: since=%v snooze=%v", since, snooze)
		}
	})

	t.Run("M1 statuses keep migration 064 semantics", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-m1-parity", "new")
		staleSnooze := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
		var first, snooze *time.Time
		if err := pool.QueryRow(ctx, `UPDATE error_groups
			SET status='awaiting_approval',snoozed_until=$2 WHERE id=$1
			RETURNING actionable_since,snoozed_until`, id, staleSnooze).Scan(&first, &snooze); err != nil {
			t.Fatal(err)
		}
		if first == nil || snooze != nil {
			t.Fatalf("enter actionable: stamp=%v snooze=%v", first, snooze)
		}
		wanted := time.Now().Add(3 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
		if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, id, wanted); err != nil {
			t.Fatal(err)
		}
		var preserved, preservedSnooze *time.Time
		if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='needs_human' WHERE id=$1
			RETURNING actionable_since,snoozed_until`, id).Scan(&preserved, &preservedSnooze); err != nil {
			t.Fatal(err)
		}
		if preserved == nil || !preserved.Equal(*first) || preservedSnooze == nil || !preservedSnooze.Equal(wanted) {
			t.Fatalf("M1 transition changed lifecycle: stamp=%v snooze=%v", preserved, preservedSnooze)
		}
		var cleared, clearedSnooze *time.Time
		if err := pool.QueryRow(ctx, `UPDATE error_groups SET status='resolved' WHERE id=$1
			RETURNING actionable_since,snoozed_until`, id).Scan(&cleared, &clearedSnooze); err != nil {
			t.Fatal(err)
		}
		if cleared != nil || clearedSnooze != nil {
			t.Fatalf("leaving actionable retained lifecycle: stamp=%v snooze=%v", cleared, clearedSnooze)
		}
	})

	t.Run("old binary insert shape still works", func(t *testing.T) {
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,fingerprint,title,first_seen,last_seen,status)
			VALUES ($1,'066-old-binary','x',now(),now(),'new') RETURNING id`, projectID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		since, snooze := lifecycleState(t, pool, id)
		if since != nil || snooze != nil {
			t.Fatalf("non-actionable insert stamped: since=%v snooze=%v", since, snooze)
		}
	})
}

// TestMigration066BackfillsFromUpdatedAt proves a PR that has been waiting for
// a month does not present as a fresh ask on the day 066 lands.
func TestMigration066BackfillsFromUpdatedAt(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if filepath.Base(file) == "066_pr_actionable.sql" {
			break
		}
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-066-backfill') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-30 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
	var groupID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,fingerprint,title,first_seen,last_seen,status,pr_url,updated_at)
		VALUES ($1,'066-backfill','x',now(),now(),'pr_created','https://github.com/o/r/pull/9',$2)
		RETURNING id`, projectID, stale).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	// The 064 trigger does not know PR statuses, so this row reaches 066 with a
	// NULL stamp — exactly the production shape the backfill must repair.
	if since, _ := lifecycleState(t, pool, groupID); since != nil {
		t.Fatalf("pre-066 pr_created was already stamped: %v", since)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET updated_at=$2 WHERE id=$1`, groupID, stale); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join("migrations", "066_pr_actionable.sql")
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatal(err)
	}
	since, _ := lifecycleState(t, pool, groupID)
	if since == nil || !since.Equal(stale) {
		t.Fatalf("backfilled actionable_since = %v, want updated_at %v", since, stale)
	}

	// Reapply-safe: a second run neither errors nor re-dates the backfilled row.
	if err := applyMigration(t, psql, dsn, path); err != nil {
		t.Fatalf("reapply 066: %v", err)
	}
	after, _ := lifecycleState(t, pool, groupID)
	if after == nil || !after.Equal(stale) {
		t.Fatalf("reapply moved the backfilled stamp: %v want %v", after, stale)
	}
}

// TestMigration066WatchesEveryActionClassInput pins the trigger's UPDATE OF
// list. A column the action class reads but the trigger does not watch would
// silently skip a reset.
func TestMigration066WatchesEveryActionClassInput(t *testing.T) {
	pool, _, _ := applyMigrationsThrough066(t)
	var columns []string
	if err := pool.QueryRow(context.Background(), `
		SELECT array_agg(a.attname ORDER BY a.attname)
		  FROM pg_trigger tg
		  JOIN LATERAL unnest(tg.tgattr::int[]) AS k(attnum) ON true
		  JOIN pg_attribute a ON a.attrelid=tg.tgrelid AND a.attnum=k.attnum
		 WHERE tg.tgrelid='error_groups'::regclass
		   AND tg.tgname='error_groups_actionable_lifecycle_upd'`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"status": true, "candidate_diff": true, "pr_url": true,
		"actionable_since": true, "snoozed_until": true,
	}
	for _, column := range columns {
		delete(want, column)
	}
	if len(want) != 0 {
		t.Fatalf("trigger UPDATE OF list %v is missing %v", columns, want)
	}
}

// migration064RepairSweep is the final statement of the SHIPPED migration 064,
// verbatim. The runner has no ledger (scripts/run-migrations.sh replays every
// file on every boot), so this statement runs against production data at each
// ingestion start with its pre-PR status list — and it matches every
// pr_created/pr_draft row.
const migration064RepairSweep = `UPDATE error_groups
   SET actionable_since = NULL, snoozed_until = NULL
 WHERE status NOT IN ('awaiting_approval','needs_human')
   AND (actionable_since IS NOT NULL OR snoozed_until IS NOT NULL)`

// TestMigration066SnoozeSurvivesTheStale064Sweep pins the lifecycle rule that a
// bulk statement cannot strip a row that is still waiting on a human, while a
// row that genuinely left the action set is still cleared.
func TestMigration066SnoozeSurvivesTheStale064Sweep(t *testing.T) {
	pool, _, projectID := applyMigrationsThrough066(t)
	ctx := context.Background()

	for _, status := range []string{"pr_created", "pr_draft"} {
		t.Run(status+" keeps its snooze and waiting age", func(t *testing.T) {
			id := seedLifecycleGroup(t, pool, projectID, "066-sweep-"+status, status)
			if _, err := pool.Exec(ctx, `UPDATE error_groups
				SET pr_url='https://github.com/o/r/pull/7' WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			snoozeUntil := time.Now().Add(5 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
			if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, id, snoozeUntil); err != nil {
				t.Fatal(err)
			}
			before, beforeSnooze := lifecycleState(t, pool, id)
			if before == nil || beforeSnooze == nil {
				t.Fatalf("setup: since=%v snooze=%v", before, beforeSnooze)
			}

			if _, err := pool.Exec(ctx, migration064RepairSweep); err != nil {
				t.Fatal(err)
			}

			since, snooze := lifecycleState(t, pool, id)
			if since == nil || !since.Equal(*before) {
				t.Fatalf("sweep moved the waiting age: since=%v want %v", since, before)
			}
			if snooze == nil || !snooze.Equal(*beforeSnooze) {
				t.Fatalf("sweep cleared the snooze: %v want %v", snooze, beforeSnooze)
			}
		})
	}

	t.Run("a row that left the action set is still cleared", func(t *testing.T) {
		id := seedLifecycleGroup(t, pool, projectID, "066-sweep-merged", "pr_created")
		// Plant exactly the pre-trigger drift 064's repair sweep exists to fix:
		// stamps left behind on a row that is no longer waiting on anyone.
		if _, err := pool.Exec(ctx, `ALTER TABLE error_groups DISABLE TRIGGER USER`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET status='merged',actionable_since=now(),snoozed_until=now()+interval '3 days'
			WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE error_groups ENABLE TRIGGER USER`); err != nil {
			t.Fatal(err)
		}

		if _, err := pool.Exec(ctx, migration064RepairSweep); err != nil {
			t.Fatal(err)
		}

		since, snooze := lifecycleState(t, pool, id)
		if since != nil || snooze != nil {
			t.Fatalf("merged row kept lifecycle stamps: since=%v snooze=%v", since, snooze)
		}
	})
}

// TestMigrationReplayKeepsPRSnoozes is the boot path itself: every ingestion
// start replays the whole migration directory, so 064's stale sweep runs again
// under 064's own trigger body. A user's snooze must survive that.
func TestMigrationReplayKeepsPRSnoozes(t *testing.T) {
	pool, dsn, projectID := applyMigrationsThrough066(t)
	psql := findPsql(t)
	ctx := context.Background()

	id := seedLifecycleGroup(t, pool, projectID, "066-replay-snooze", "pr_created")
	if _, err := pool.Exec(ctx, `UPDATE error_groups
		SET pr_url='https://github.com/o/r/pull/8' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	snoozeUntil := time.Now().Add(4 * 24 * time.Hour).UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET snoozed_until=$2 WHERE id=$1`, id, snoozeUntil); err != nil {
		t.Fatal(err)
	}
	before, beforeSnooze := lifecycleState(t, pool, id)
	if before == nil || beforeSnooze == nil {
		t.Fatalf("setup: since=%v snooze=%v", before, beforeSnooze)
	}

	for boot := 0; boot < 2; boot++ {
		for _, file := range migrationFiles(t) {
			if err := applyMigration(t, psql, dsn, file); err != nil {
				t.Fatalf("boot %d apply %s: %v", boot, file, err)
			}
		}
	}

	since, snooze := lifecycleState(t, pool, id)
	if since == nil || !since.Equal(*before) {
		t.Fatalf("replay moved the waiting age: since=%v want %v", since, before)
	}
	if snooze == nil || !snooze.Equal(*beforeSnooze) {
		t.Fatalf("replay cleared the snooze: %v want %v", snooze, beforeSnooze)
	}
}
