package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestMigration056ProductContextQuality(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "migration-056")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	// No repo on purpose: after Task 5 lands, provisioning WITH a repo
	// enqueues a connect job, and the manual pending insert below would then
	// violate uq_product_context_job_active.
	provisioning, err := q.ProvisionProject(ctx, org.ID, "m056-app", nil, "migration-056")
	if err != nil {
		t.Fatal(err)
	}
	projectID := provisioning.Project.ID

	// New route_map columns exist with their defaults.
	if _, err := pool.Exec(ctx,
		`INSERT INTO route_map (project_id, pattern, name, tier) VALUES ($1, '/m056', 'M', 'standard')`,
		projectID,
	); err != nil {
		t.Fatalf("insert route_map row: %v", err)
	}
	var reviewStatus string
	var conflicts, declared []string
	if err := pool.QueryRow(ctx,
		`SELECT review_status, evidence_conflicts, declared_requests
		   FROM route_map WHERE project_id = $1 AND pattern = '/m056'`,
		projectID,
	).Scan(&reviewStatus, &conflicts, &declared); err != nil {
		t.Fatalf("select new route_map columns: %v", err)
	}
	if reviewStatus != "clear" || len(conflicts) != 0 || len(declared) != 0 {
		t.Fatalf("unexpected defaults: %q %v %v", reviewStatus, conflicts, declared)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE route_map SET review_status = 'bogus' WHERE project_id = $1 AND pattern = '/m056'`,
		projectID,
	); err == nil {
		t.Fatal("review_status accepted a value outside clear/needs_review")
	}

	// The runs table takes a full row keyed to a real job, and job_usage
	// accepts phase 'product_context' (its CHECK is only non-empty).
	var jobID string
	if err := pool.QueryRow(ctx,
		// Seeded 'completed' on purpose: the job_usage write below makes this row
		// permanent (insert-only ledger), and a stranded pending job would be
		// claimable by every later suite sharing this database.
		`INSERT INTO error_group_jobs (project_id, job_type, triggered_by, payload, status)
		 VALUES ($1, 'product_context', 'auto', '{"trigger":"connect"}'::jsonb, 'completed')
		 RETURNING id`,
		projectID,
	).Scan(&jobID); err != nil {
		t.Fatalf("seed job: %v", err)
	}
	// The job_usage write below is permanent: the ledger is insert-only by
	// trigger, so cleanupTenant cannot remove the job or its project. This test
	// therefore leaves its tenant rows behind by design; that is the ledger's
	// immutability contract, not a leak to "fix" here.
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 0, $2, 'abc123', 'claude-sonnet-5', 1, 4, 2, 1, 1, 0.5, 100, 50, 0, 0, 0.001, 250)`,
		jobID, projectID,
	); err != nil {
		t.Fatalf("insert product_context_runs: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 0, $2, 'abc123', 'claude-sonnet-5', 1, 4, 2, 1, 1, 0.5, 100, 50, 0, 0, 0.001, 250)`,
		jobID, projectID,
	); err == nil {
		t.Fatal("duplicate (job_id, execution) run row was accepted")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO product_context_runs
		   (job_id, execution, project_id, commit_sha, model, prompt_version,
		    route_count, unknown_count, conflict_count, human_route_count, coverage,
		    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		    cost_usd, latency_ms)
		 VALUES ($1, 1, $2, 'abc123', 'claude-sonnet-5', 1, 2, 3, 0, 0, 0, 1, 1, 0, 0, 0, 1)`,
		jobID, projectID,
	); err == nil {
		t.Fatal("unknown_count above route_count was accepted")
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO job_usage
		   (job_id, execution, phase, model, input_tokens, output_tokens,
		    cache_read_tokens, cache_write_tokens, cost_usd)
		 VALUES ($1, 0, 'product_context', 'claude-sonnet-5', 100, 50, 0, 0, 0.001)`,
		jobID,
	); err != nil {
		t.Fatalf("job_usage rejected phase product_context: %v", err)
	}
}
