package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func connectJobCount(t *testing.T, projectID string) int {
	t.Helper()
	pool := testPool(t)
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'product_context'
		    AND payload->>'trigger' = 'connect'`,
		projectID,
	).Scan(&n); err != nil {
		t.Fatalf("count connect jobs: %v", err)
	}
	return n
}

func TestSetProjectGitHubConfigEnqueuesOnTransitionOnly(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "connect-trigger")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	provisioning, err := q.ProvisionProject(ctx, org.ID, "connect-app", nil, "connect-trigger")
	if err != nil {
		t.Fatal(err)
	}
	projectID := provisioning.Project.ID

	// First connect: empty -> usable repo enqueues once.
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/app", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 1 {
		t.Fatalf("expected 1 connect job after first connect, got %d", n)
	}

	// Re-saving the same repo is not a transition, even after the first job
	// completed (the active-job index no longer dedupes then).
	if _, err := pool.Exec(ctx,
		`UPDATE error_group_jobs SET status = 'completed'
		  WHERE project_id = $1 AND job_type = 'product_context'`,
		projectID,
	); err != nil {
		t.Fatal(err)
	}
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/app", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 1 {
		t.Fatalf("re-saving the same repo enqueued again: %d jobs", n)
	}

	// Switching to a different repository is a transition.
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/other", "main"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, projectID); n != 2 {
		t.Fatalf("expected 2 connect jobs after repo switch, got %d", n)
	}

	// A repo switch while a job is CLAIMED supersedes it back to pending
	// (mirrors push supersession; the fenced worker cannot write stale claims).
	if _, err := pool.Exec(ctx,
		`UPDATE error_group_jobs
		    SET status = 'claimed', worker_id = 'w-old', claimed_at = now(),
		        lease_expires_at = now() + interval '5 minutes'
		  WHERE project_id = $1 AND job_type = 'product_context' AND status = 'pending'`,
		projectID,
	); err != nil {
		t.Fatal(err)
	}
	if err := q.SetProjectGitHubConfig(ctx, org.ID, projectID, "acme/third", "main"); err != nil {
		t.Fatal(err)
	}
	var status string
	var workerID *string
	if err := pool.QueryRow(ctx,
		`SELECT status, worker_id FROM error_group_jobs
		  WHERE project_id = $1 AND job_type = 'product_context'
		    AND status IN ('pending','claimed')`,
		projectID,
	).Scan(&status, &workerID); err != nil {
		t.Fatalf("read superseded job: %v", err)
	}
	if status != "pending" || workerID != nil {
		t.Fatalf("claimed job not superseded on repo switch: status=%q worker=%v", status, workerID)
	}
}

func TestCreateProjectWithRepoEnqueuesProductContext(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "connect-create")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	withRepo, err := q.CreateProject(ctx, org.ID, "with-repo", ptrStr("acme/app"))
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, withRepo.ID); n != 1 {
		t.Fatalf("create-with-repo: expected 1 connect job, got %d", n)
	}

	withoutRepo, err := q.CreateProject(ctx, org.ID, "without-repo", nil)
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, withoutRepo.ID); n != 0 {
		t.Fatalf("create-without-repo: expected 0 connect jobs, got %d", n)
	}

	blank, err := q.CreateProject(ctx, org.ID, "blank-repo", ptrStr("   "))
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, blank.ID); n != 0 {
		t.Fatalf("whitespace repo counted as usable: %d jobs", n)
	}
}

func TestProvisionProjectWithRepoEnqueuesProductContext(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "connect-provision")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	provisioned, err := q.ProvisionProject(ctx, org.ID, "prov-repo", ptrStr("acme/app"), "prov-token-1")
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, provisioned.Project.ID); n != 1 {
		t.Fatalf("provision-with-repo: expected 1 connect job, got %d", n)
	}

	// Idempotent replay of the same provisioning must not re-enqueue.
	if _, err := q.ProvisionProject(ctx, org.ID, "prov-repo", ptrStr("acme/app"), "prov-token-1"); err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, provisioned.Project.ID); n != 1 {
		t.Fatalf("idempotent provision replay re-enqueued: %d jobs", n)
	}

	bare, err := q.ProvisionProject(ctx, org.ID, "prov-bare", nil, "prov-token-2")
	if err != nil {
		t.Fatal(err)
	}
	if n := connectJobCount(t, bare.Project.ID); n != 0 {
		t.Fatalf("provision-without-repo: expected 0 connect jobs, got %d", n)
	}
}
