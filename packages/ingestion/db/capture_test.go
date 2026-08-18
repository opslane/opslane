package db_test

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func seedCaptureProject(t *testing.T) (*db.Queries, string, string) {
	t.Helper()
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "capture-"+uuid.NewString())
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "capture", nil)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if project.DefaultEnvironmentID == nil {
		t.Fatal("capture project has no default environment")
	}
	return q, project.ID, *project.DefaultEnvironmentID
}

func TestCaptureCreatesNoIssueOrInvestigationOrOutbox(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()

	receipt, err := q.CaptureError(ctx, db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: environmentID,
		ErrorType: "TypeError", ErrorMessage: "boom", Platform: "javascript",
		StackTraceRaw: "at f (entry-index.CaWHNXv4.js:1:1)",
	})
	if err != nil {
		t.Fatalf("CaptureError: %v", err)
	}
	if receipt.EventID == "" {
		t.Fatal("expected an event id")
	}
	if receipt.CaptureHandle == "" {
		t.Fatal("expected a provisional capture handle")
	}

	pool := q.Pool()
	var resolveJobs int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_group_jobs
		  WHERE project_id=$1 AND job_type='stack_resolve'`, projectID).Scan(&resolveJobs); err != nil {
		t.Fatalf("resolve jobs: %v", err)
	}
	if resolveJobs != 1 {
		t.Errorf("stack_resolve jobs = %d, want 1", resolveJobs)
	}

	for _, check := range []struct {
		name, query string
	}{
		{"investigation jobs", `SELECT count(*) FROM error_group_jobs
		                          WHERE project_id=$1 AND job_type='investigate'`},
		{"outbox events", `SELECT count(*) FROM outbound_events WHERE project_id=$1`},
		{"stable issues", `SELECT count(*) FROM error_groups WHERE project_id=$1`},
		{"readiness rows", `SELECT count(*) FROM digest_readiness WHERE project_id=$1`},
		// error_event_resolutions belongs to the Slice 3 resolution job, which
		// inserts its own pending row on first touch.
		{"resolution rows", `SELECT count(*) FROM error_event_resolutions WHERE project_id=$1`},
	} {
		var n int
		if err := pool.QueryRow(ctx, check.query, projectID).Scan(&n); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		if n != 0 {
			t.Errorf("capture created %d %s, want 0", n, check.name)
		}
	}

	var pending int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM error_event_identities WHERE project_id=$1 AND status='pending'`,
		projectID).Scan(&pending); err != nil {
		t.Fatalf("identities: %v", err)
	}
	if pending != 1 {
		t.Errorf("pending identities = %d, want 1", pending)
	}
}

func TestCaptureSharesBucketAcrossConcurrentIdenticalEvents(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()

	const eventCount = 8
	errCh := make(chan error, eventCount)
	var wg sync.WaitGroup
	for range eventCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := q.CaptureError(ctx, db.IngestParams{
				ProjectID: projectID, DefaultEnvironmentID: environmentID,
				ErrorType: "TypeError", ErrorMessage: "boom", Platform: "javascript",
				StackTraceRaw: "at f (entry-index.CaWHNXv4.js:1:1)",
			})
			errCh <- err
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("CaptureError: %v", err)
		}
	}

	pool := q.Pool()
	var buckets, events int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_capture_buckets WHERE project_id=$1`, projectID).Scan(&buckets); err != nil {
		t.Fatalf("count buckets: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_events WHERE project_id=$1`, projectID).Scan(&events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if buckets != 1 {
		t.Errorf("buckets = %d, want 1", buckets)
	}
	if events != eventCount {
		t.Errorf("events = %d, want %d", events, eventCount)
	}
}

func TestCaptureFailureRollsBackEveryWrite(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()

	_, err := q.CaptureError(ctx, db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: environmentID,
		ErrorType: "TypeError", ErrorMessage: "rollback", Platform: "javascript",
		StackTraceRaw: "at f (app.js:1:1)", Breadcrumbs: `{`, EndUserID: "rollback-user",
	})
	if err == nil {
		t.Fatal("CaptureError accepted invalid breadcrumbs JSON")
	}

	pool := q.Pool()
	for _, check := range []struct {
		name, query string
	}{
		{"capture buckets", `SELECT count(*) FROM error_capture_buckets WHERE project_id=$1`},
		{"events", `SELECT count(*) FROM error_events WHERE project_id=$1`},
		{"identities", `SELECT count(*) FROM error_event_identities WHERE project_id=$1`},
		{"resolutions", `SELECT count(*) FROM error_event_resolutions WHERE project_id=$1`},
		{"jobs", `SELECT count(*) FROM error_group_jobs WHERE project_id=$1`},
		{"end users", `SELECT count(*) FROM end_users WHERE project_id=$1`},
	} {
		var n int
		if scanErr := pool.QueryRow(ctx, check.query, projectID).Scan(&n); scanErr != nil {
			t.Fatalf("count %s: %v", check.name, scanErr)
		}
		if n != 0 {
			t.Errorf("failed capture left %d %s, want 0", n, check.name)
		}
	}
}

func TestCaptureStoresRawFallbackForUnresolvableEvents(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()

	for _, test := range []struct {
		name     string
		platform string
		stack    string
	}{
		{name: "python", platform: "python", stack: "Traceback\nValueError: boom"},
		{name: "stackless javascript", platform: "javascript"},
	} {
		t.Run(test.name, func(t *testing.T) {
			receipt, err := q.CaptureError(ctx, db.IngestParams{
				ProjectID: projectID, DefaultEnvironmentID: environmentID,
				ErrorType: "Error", ErrorMessage: test.name, Platform: test.platform,
				StackTraceRaw: test.stack,
			})
			if err != nil {
				t.Fatalf("CaptureError: %v", err)
			}

			var rawFingerprint, status string
			if err := q.Pool().QueryRow(ctx,
				`SELECT raw_fingerprint, status
				 FROM error_event_identities
				 WHERE project_id=$1 AND event_id=$2`,
				projectID, receipt.EventID,
			).Scan(&rawFingerprint, &status); err != nil {
				t.Fatalf("read identity fallback: %v", err)
			}
			if rawFingerprint == "" || rawFingerprint != receipt.CaptureHandle {
				t.Errorf("raw fallback = %q, capture handle = %q", rawFingerprint, receipt.CaptureHandle)
			}
			if status != "pending" {
				t.Errorf("identity status = %q, want pending", status)
			}
		})
	}
}

func TestCapturePreservesCuratedFamilyFingerprint(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()

	handles := make([]string, 0, 2)
	for _, asset := range []string{"chunk.AAA111.js", "chunk.BBB222.js"} {
		receipt, err := q.CaptureError(ctx, db.IngestParams{
			ProjectID: projectID, DefaultEnvironmentID: environmentID,
			ErrorType: "TypeError", Platform: "javascript",
			ErrorMessage: "Failed to fetch dynamically imported module: https://a.com/assets/" + asset,
		})
		if err != nil {
			t.Fatalf("CaptureError(%s): %v", asset, err)
		}
		handles = append(handles, receipt.CaptureHandle)
	}
	if handles[0] != handles[1] {
		t.Fatalf("curated family handles differ: %q != %q", handles[0], handles[1])
	}

	var buckets int
	if err := q.Pool().QueryRow(ctx,
		`SELECT count(*) FROM error_capture_buckets WHERE project_id=$1`, projectID,
	).Scan(&buckets); err != nil {
		t.Fatalf("count family buckets: %v", err)
	}
	if buckets != 1 {
		t.Errorf("family buckets = %d, want 1", buckets)
	}
}
