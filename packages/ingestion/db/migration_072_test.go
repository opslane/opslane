package db_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// applyAllMigrationsForFixProvenance builds the full schema and returns a
// project to hang incidents from. The whole file list is applied because
// migration 072 is the last one: stopping earlier would test the rule it
// replaces.
func applyAllMigrationsForFixProvenance(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('migration-072') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id,name) VALUES ($1,'p') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	return pool, projectID
}

func seedTerminalJob(t *testing.T, pool *pgxpool.Pool, projectID, groupID, jobType string) string {
	t.Helper()
	var jobID string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_group_jobs
		(error_group_id,project_id,job_type,status) VALUES ($1,$2,$3,'completed')
		RETURNING id::text`, groupID, projectID, jobType).Scan(&jobID); err != nil {
		t.Fatalf("seed %s job: %v", jobType, err)
	}
	return jobID
}

// TestMigration072ActionClassMatchesTheDigestAsks pins the SQL twin of
// digest.digestAction. The two must agree: this function decides when the
// waiting age restarts, so a classification only Go knows about would leave the
// age stale on a day the reader's ask changed. Migration 073 collapsed the two
// jargon asks, so a fix attempt no longer changes the answer here either.
func TestMigration072ActionClassMatchesTheDigestAsks(t *testing.T) {
	pool, _ := applyAllMigrationsForFixProvenance(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name                         string
		status, candidateDiff, prURL string
		fixAttempted                 bool
		want                         string
	}{
		{name: "approval with a diff", status: "awaiting_approval", candidateDiff: "diff --git a b", want: "Approve the proposed fix."},
		{name: "approval after a fix ran", status: "awaiting_approval", fixAttempted: true, want: "Decide how to handle this."},
		{name: "approval with no fix ever run", status: "awaiting_approval", want: "Decide how to handle this."},
		{name: "needs human after a fix ran", status: "needs_human", fixAttempted: true, want: "Decide how to handle this."},
		{name: "needs human with a saved diff", status: "needs_human", candidateDiff: "diff --git a b", want: "Decide how to handle this."},
		{name: "needs human with no fix ever run", status: "needs_human", want: "Decide how to handle this."},
		{name: "pr with a url", status: "pr_created", prURL: "https://github.com/o/r/pull/1", want: "Review the fix PR."},
		{name: "pr without a url", status: "pr_draft", want: "Review the issue."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got *string
			if err := pool.QueryRow(ctx, `SELECT error_groups_action_class($1,NULLIF($2,''),NULLIF($3,''),$4)`,
				tc.status, tc.candidateDiff, tc.prURL, tc.fixAttempted).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got == nil || *got != tc.want {
				t.Fatalf("action class = %v, want %q", got, tc.want)
			}
		})
	}
	var resolved *string
	if err := pool.QueryRow(ctx, `SELECT error_groups_action_class('resolved',NULL,NULL,true)`).Scan(&resolved); err != nil {
		t.Fatal(err)
	}
	if resolved != nil {
		t.Fatalf("a status that awaits nobody classified as %q", *resolved)
	}
}

// TestMigration072FixAttemptedChecksTheJobType is the defect this migration
// exists for: reconciling a dead-lettered investigation stores that
// INVESTIGATION job's id in terminal_fix_job_id, so the id alone would report a
// fix attempt on an incident where no fix ever ran.
func TestMigration072FixAttemptedChecksTheJobType(t *testing.T) {
	pool, projectID := applyAllMigrationsForFixProvenance(t)
	ctx := context.Background()
	groupID := seedLifecycleGroup(t, pool, projectID, "072-job-type", "needs_human")

	for _, tc := range []struct {
		name, jobType string
		want          bool
	}{
		{name: "no terminal job at all", want: false},
		{name: "a dead-lettered investigation", jobType: "investigate", want: false},
		{name: "a fix job", jobType: "fix", want: true},
		{name: "an error fix job", jobType: "error_fix", want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var jobID any
			if tc.jobType != "" {
				jobID = seedTerminalJob(t, pool, projectID, groupID, tc.jobType)
			}
			if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2::uuid WHERE id=$1`,
				groupID, jobID); err != nil {
				t.Fatal(err)
			}
			var attempted bool
			if err := pool.QueryRow(ctx, `SELECT error_groups_fix_attempted(terminal_fix_job_id,project_id)
				FROM error_groups WHERE id=$1`, groupID).Scan(&attempted); err != nil {
				t.Fatal(err)
			}
			if attempted != tc.want {
				t.Fatalf("fix attempted = %v, want %v", attempted, tc.want)
			}
		})
	}
}

// TestMigration072PreservesTheWaitingAgeWhenAFixJobArrives: a fix attempt
// arriving no longer changes what the reader is asked to do — both sides of
// that split now say "Decide how to handle this." — so the waiting age must
// survive it. Restarting the clock on an incident whose ask never moved would
// hide the oldest waiter from the digest's guarantee.
func TestMigration072PreservesTheWaitingAgeWhenAFixJobArrives(t *testing.T) {
	pool, projectID := applyAllMigrationsForFixProvenance(t)
	ctx := context.Background()
	groupID := seedLifecycleGroup(t, pool, projectID, "072-reset", "needs_human")
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET actionable_since=now() - interval '9 days' WHERE id=$1`,
		groupID); err != nil {
		t.Fatal(err)
	}
	before, _ := lifecycleState(t, pool, groupID)
	if before == nil {
		t.Fatal("fixture was never stamped actionable")
	}

	jobID := seedTerminalJob(t, pool, projectID, groupID, "fix")
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2 WHERE id=$1`,
		groupID, jobID); err != nil {
		t.Fatal(err)
	}
	after, _ := lifecycleState(t, pool, groupID)
	if after == nil {
		t.Fatal("a still-waiting incident lost its waiting age")
	}
	if !after.Equal(*before) {
		t.Fatalf("waiting age = %v, want it held at %v: the ask did not change", after, before)
	}

	// The same holds when the fix attempt goes away again: replacing the fix
	// job with an investigation job leaves the ask exactly where it was.
	investigation := seedTerminalJob(t, pool, projectID, groupID, "investigate")
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET terminal_fix_job_id=$2 WHERE id=$1`,
		groupID, investigation); err != nil {
		t.Fatal(err)
	}
	settled, _ := lifecycleState(t, pool, groupID)
	if settled == nil {
		t.Fatal("a still-waiting incident lost its waiting age")
	}
	if !settled.Equal(*before) {
		t.Fatalf("waiting age = %v, want it held at %v when the fix attempt went away", settled, before)
	}
}
