package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestAdminOverviewHourlyBucketsAreZeroFilledAndBoundarySafe(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply migration %s: %v", file, err)
		}
	}
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "admin-overview-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	repo := "example/admin-overview"
	project, err := q.CreateProject(ctx, org.ID, "Admin Overview", &repo)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	env, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}

	before, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview before inserts: %v", err)
	}
	if len(before.Events.Hourly) != 48 {
		t.Fatalf("got %d hourly buckets, want 48", len(before.Events.Hourly))
	}
	if _, ok := before.Jobs.ByType["ci_watch"]; !ok {
		t.Fatal("admin job overview omitted ci_watch")
	}
	if _, ok := before.Jobs.ByType["route_map"]; !ok {
		t.Fatal("admin job overview omitted route_map")
	}
	if _, ok := before.Jobs.ByType["score_sync"]; !ok {
		t.Fatal("admin job overview omitted score_sync")
	}
	for i := 1; i < len(before.Events.Hourly); i++ {
		if before.Events.Hourly[i].Hour.Sub(before.Events.Hourly[i-1].Hour) != time.Hour {
			t.Fatalf("buckets %d and %d are not one hour apart", i-1, i)
		}
	}
	for _, bucket := range before.Events.Hourly {
		if bucket.Count != 0 {
			t.Fatalf("empty database bucket %s count = %d, want 0", bucket.Hour, bucket.Count)
		}
	}

	currentHour := time.Now().UTC().Truncate(time.Hour)
	createdTimes := []time.Time{currentHour, currentHour.Add(-time.Hour), currentHour.Add(-3 * time.Hour)}
	for i, createdAt := range createdTimes {
		if _, err := pool.Exec(ctx, `
			INSERT INTO error_events
				(project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, created_at)
			VALUES ($1, $2, $3, 'AdminTest', $4, 'stack', $3)`,
			project.ID, env.ID, createdAt, fmt.Sprintf("admin event %d", i)); err != nil {
			t.Fatalf("insert event %d: %v", i, err)
		}
	}

	after, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview after inserts: %v", err)
	}
	if len(after.Events.Hourly) != 48 {
		t.Fatalf("got %d hourly buckets after inserts, want 48", len(after.Events.Hourly))
	}
	beforeCounts := make(map[int64]int64, len(before.Events.Hourly))
	for _, bucket := range before.Events.Hourly {
		beforeCounts[bucket.Hour.Unix()] = bucket.Count
	}
	for _, createdAt := range createdTimes {
		var got *db.AdminHourlyEventBucket
		for i := range after.Events.Hourly {
			if after.Events.Hourly[i].Hour.Equal(createdAt) {
				got = &after.Events.Hourly[i]
				break
			}
		}
		if got == nil {
			t.Fatalf("missing bucket at %s", createdAt)
		}
		if delta := got.Count - beforeCounts[createdAt.Unix()]; delta != 1 {
			t.Fatalf("bucket %s delta = %d, want 1", createdAt, delta)
		}
	}
	// The deliberately skipped -2h bucket proves gaps remain present.
	gap := currentHour.Add(-2 * time.Hour)
	if _, ok := beforeCounts[gap.Unix()]; !ok {
		t.Fatalf("missing zero-fill gap bucket at %s", gap)
	}
	for _, bucket := range after.Events.Hourly {
		if bucket.Hour.Equal(gap) && bucket.Count != 0 {
			t.Fatalf("gap bucket %s count = %d, want 0", gap, bucket.Count)
		}
	}
}

func TestAdminOverviewSpendAggregates(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply migration %s: %v", file, err)
		}
	}

	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "admin-spend-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	repo := "example/admin-spend"
	project, err := q.CreateProject(ctx, org.ID, "Admin Spend", &repo)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	inserted, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "AdminSpendError",
		ErrorMessage:         "spend fixture",
		Fingerprint:          "fp-admin-spend",
		Title:                "Admin spend fixture",
	})
	if err != nil {
		t.Fatalf("insert error fixture: %v", err)
	}

	var jobID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM error_group_jobs WHERE error_group_id = $1 ORDER BY created_at LIMIT 1`,
		inserted.GroupID,
	).Scan(&jobID); err != nil {
		t.Fatalf("load fixture job: %v", err)
	}
	for execution, cost := range []string{"0.5000", "0.2500"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO job_usage
			   (job_id, execution, phase, model, input_tokens, output_tokens,
			    cache_read_tokens, cache_write_tokens, cost_usd)
			 VALUES ($1, $2, 'investigation', $3, 1, 1, 0, 0, $4)`,
			jobID, execution, fmt.Sprintf("model-%d", execution), cost,
		); err != nil {
			t.Fatalf("insert usage row %d: %v", execution, err)
		}
	}

	withoutMerge, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview without merge: %v", err)
	}
	if withoutMerge.Outcomes.SpendUSD7D != 0.75 {
		t.Fatalf("spend without merge = %v, want 0.75", withoutMerge.Outcomes.SpendUSD7D)
	}
	if withoutMerge.Outcomes.CostPerMergedPR7D != nil {
		t.Fatalf("cost per merged PR without merge = %v, want nil", *withoutMerge.Outcomes.CostPerMergedPR7D)
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, occurred_at)
		 VALUES ($1, $2, 1, 'merged', 'admin-spend-merged', now())`,
		inserted.GroupID, project.ID,
	); err != nil {
		t.Fatalf("insert merged outcome: %v", err)
	}
	withMerge, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview with merge: %v", err)
	}
	if withMerge.Outcomes.SpendUSD7D != 0.75 {
		t.Fatalf("spend with merge = %v, want 0.75", withMerge.Outcomes.SpendUSD7D)
	}
	if withMerge.Outcomes.CostPerMergedPR7D == nil || *withMerge.Outcomes.CostPerMergedPR7D != 0.75 {
		t.Fatalf("cost per merged PR = %v, want 0.75", withMerge.Outcomes.CostPerMergedPR7D)
	}

	// Window boundary: a row older than 7 days must not count. Inserts may set
	// created_at freely; only UPDATE/DELETE are trigger-blocked.
	if _, err := pool.Exec(ctx,
		`INSERT INTO job_usage
		   (job_id, execution, phase, model, input_tokens, output_tokens,
		    cache_read_tokens, cache_write_tokens, cost_usd, created_at)
		 VALUES ($1, 9, 'investigation', 'model-old', 1, 1, 0, 0, 100.0000, now() - interval '8 days')`,
		jobID,
	); err != nil {
		t.Fatalf("insert stale usage row: %v", err)
	}
	stale, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview with stale row: %v", err)
	}
	if stale.Outcomes.SpendUSD7D != 0.75 {
		t.Fatalf("spend includes >7d row: got %v, want 0.75", stale.Outcomes.SpendUSD7D)
	}
	if stale.Outcomes.CostPerMergedPR7D == nil || *stale.Outcomes.CostPerMergedPR7D != 0.75 {
		t.Fatalf("cost per merged PR with stale row = %v, want 0.75", stale.Outcomes.CostPerMergedPR7D)
	}
}

func TestAdminRecentJobsDurationAndNullableIncident(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "admin-jobs-"+fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	repo := "example/admin-jobs"
	project, err := q.CreateProject(ctx, org.ID, "Admin Jobs", &repo)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	ids := make(map[string]string)
	for _, tc := range []struct {
		name   string
		status string
		setup  string
	}{
		{name: "pending", status: "pending", setup: "created_at = now() - interval '10 minutes'"},
		{name: "claimed", status: "claimed", setup: "claimed_at = now() - interval '30 seconds', lease_expires_at = now() + interval '1 minute', worker_id = 'admin-test-worker'"},
		{name: "completed", status: "completed", setup: "claimed_at = now() - interval '2 minutes', updated_at = now() - interval '1 minute'"},
	} {
		query := `INSERT INTO error_group_jobs (project_id, job_type, status) VALUES ($1, 'setup_pr', $2) RETURNING id`
		var id string
		if err := pool.QueryRow(ctx, query, project.ID, tc.status).Scan(&id); err != nil {
			t.Fatalf("insert %s job: %v", tc.name, err)
		}
		if _, err := pool.Exec(ctx, "UPDATE error_group_jobs SET "+tc.setup+" WHERE id = $1", id); err != nil {
			t.Fatalf("configure %s job: %v", tc.name, err)
		}
		ids[tc.name] = id
	}

	jobs, err := q.AdminRecentJobs(ctx, 200, "", "setup_pr")
	if err != nil {
		t.Fatalf("admin recent jobs: %v", err)
	}
	found := make(map[string]db.AdminJob)
	for _, job := range jobs {
		for name, id := range ids {
			if job.ID == id {
				found[name] = job
			}
		}
	}
	if len(found) != len(ids) {
		t.Fatalf("found %d test jobs, want %d", len(found), len(ids))
	}
	if found["pending"].DurationSeconds != nil {
		t.Errorf("pending duration = %v, want nil", *found["pending"].DurationSeconds)
	}
	if duration := found["claimed"].DurationSeconds; duration == nil || *duration < 29 || *duration > 40 {
		t.Errorf("claimed duration = %v, want about 30 seconds", duration)
	}
	if duration := found["completed"].DurationSeconds; duration == nil || *duration < 59 || *duration > 61 {
		t.Errorf("completed duration = %v, want 60 seconds", duration)
	}
	for name, job := range found {
		if job.ProjectName != project.Name || job.IncidentTitle != nil || job.PRURL != nil {
			t.Errorf("%s nullable-incident job fields = %+v", name, job)
		}
	}
}
