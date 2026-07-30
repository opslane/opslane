package db_test

import (
	"context"
	"sync"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProvisionProjectIsIdempotentAndRotatesTheOneTimeKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "project-provision-idempotent")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	first, err := q.ProvisionProject(ctx, org.ID, "Checkout", ptrStr("acme/checkout"), "attempt-1")
	if err != nil {
		t.Fatalf("first ProvisionProject: %v", err)
	}
	second, err := q.ProvisionProject(ctx, org.ID, "ignored retry name", nil, "attempt-1")
	if err != nil {
		t.Fatalf("second ProvisionProject: %v", err)
	}

	if first.Project.ID != second.Project.ID || first.Environment.ID != second.Environment.ID {
		t.Fatalf("retry changed provisioned identity: first=%+v second=%+v", first, second)
	}
	if second.Project.Name != "Checkout" || second.Project.GithubRepo == nil || *second.Project.GithubRepo != "acme/checkout" {
		t.Fatalf("retry overwrote original project fields: %+v", second.Project)
	}
	if first.APIKey.ID == second.APIKey.ID || first.APIKey.Raw == second.APIKey.Raw {
		t.Fatalf("retry did not mint a fresh one-time key: first=%+v second=%+v", first.APIKey, second.APIKey)
	}
	if lookup, err := q.LookupProjectKey(ctx, first.APIKey.Raw); err != nil || lookup.ProjectID != second.Project.ID {
		t.Fatalf("prior provisioning key stopped working after retry: (%+v, %v)", lookup, err)
	}
	if lookup, err := q.LookupProjectKey(ctx, second.APIKey.Raw); err != nil || lookup.ProjectID != second.Project.ID {
		t.Fatalf("fresh key lookup = (%+v, %v)", lookup, err)
	}

	var projectCount, activeKeyCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND idempotency_token = 'attempt-1'`, org.ID,
	).Scan(&projectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM project_api_keys
		WHERE project_id = $1 AND revoked_at IS NULL`, second.Project.ID,
	).Scan(&activeKeyCount); err != nil {
		t.Fatal(err)
	}
	if projectCount != 1 || activeKeyCount != 2 {
		t.Fatalf("project_count=%d active_keys=%d want 1,2", projectCount, activeKeyCount)
	}
}

func TestProvisionProjectConcurrentSameTokenCreatesOneProject(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "project-provision-concurrent")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	const callers = 8
	results := make(chan *db.ProjectProvisioning, callers)
	errors := make(chan error, callers)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, callErr := q.ProvisionProject(context.Background(), org.ID,
				"Concurrent", nil, "same-concurrent-attempt")
			if callErr != nil {
				errors <- callErr
				return
			}
			results <- result
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errors)
	for callErr := range errors {
		t.Errorf("ProvisionProject: %v", callErr)
	}

	projectIDs := map[string]struct{}{}
	successfulCalls := 0
	for result := range results {
		projectIDs[result.Project.ID] = struct{}{}
		successfulCalls++
	}
	if len(projectIDs) != 1 {
		t.Fatalf("concurrent project ids = %#v, want one", projectIDs)
	}
	var projectCount, environmentCount, activeKeyCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND idempotency_token = 'same-concurrent-attempt'`, org.ID,
	).Scan(&projectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM environments e
		JOIN projects p ON p.id = e.project_id
		WHERE p.org_id = $1 AND p.idempotency_token = 'same-concurrent-attempt'`, org.ID,
	).Scan(&environmentCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM project_api_keys k
		JOIN projects p ON p.id = k.project_id
		WHERE p.org_id = $1 AND p.idempotency_token = 'same-concurrent-attempt'
		  AND k.revoked_at IS NULL`, org.ID,
	).Scan(&activeKeyCount); err != nil {
		t.Fatal(err)
	}
	if projectCount != 1 || environmentCount != 1 || activeKeyCount != successfulCalls {
		t.Fatalf("projects=%d environments=%d active_keys=%d, want 1/1/%d",
			projectCount, environmentCount, activeKeyCount, successfulCalls)
	}
}
