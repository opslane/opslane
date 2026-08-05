package db_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProjectDefaultScansAndAPIKeyLookup(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "phase5-project-scans-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil {
		t.Fatal(err)
	}
	if project.DefaultEnvironmentID == nil {
		t.Fatal("created project has a null default")
	}
	listed, err := q.ListProjectsByOrg(ctx, org.ID)
	if err != nil || len(listed) != 1 || listed[0].DefaultEnvironmentID == nil || *listed[0].DefaultEnvironmentID != *project.DefaultEnvironmentID {
		t.Fatalf("listed = %#v, err=%v", listed, err)
	}
	got, err := q.GetProjectByOrgID(ctx, org.ID, project.ID)
	if err != nil || got == nil || got.DefaultEnvironmentID == nil || *got.DefaultEnvironmentID != *project.DefaultEnvironmentID {
		t.Fatalf("get = %#v, err=%v", got, err)
	}
	key, err := q.CreateProjectKey(ctx, project.ID, db.ScopeIngest, "test", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := q.LookupProjectKey(ctx, key.Raw)
	if err != nil || lookup.DefaultEnvironmentID == nil || *lookup.DefaultEnvironmentID != *project.DefaultEnvironmentID {
		t.Fatalf("lookup = %#v, err=%v", lookup, err)
	}
}

func TestEventEnvironmentResolutionDiscoversAndFallsBack(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-resolution-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}

	tests := []struct {
		label string
		want  db.EnvironmentOutcome
		name  string
	}{
		{"", db.EnvironmentOutcomeDefault, "production"},
		{"bad label", db.EnvironmentOutcomeInvalidLabel, "production"},
		{"staging", db.EnvironmentOutcomeCreated, "staging"},
		{"staging", db.EnvironmentOutcomeExisting, "staging"},
		{"Staging", db.EnvironmentOutcomeCreated, "Staging"},
	}
	for i, test := range tests {
		result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID: project.ID, DefaultEnvironmentID: *project.DefaultEnvironmentID,
			EnvironmentLabel: test.label, Fingerprint: fmt.Sprintf("resolution-%s-%d", uuid.NewString(), i),
			ErrorType: "Error", ErrorMessage: "message", Title: "Error: message",
		})
		if err != nil {
			t.Fatalf("label %q: %v", test.label, err)
		}
		if result.EnvironmentOutcome != test.want {
			t.Errorf("label %q outcome = %q, want %q", test.label, result.EnvironmentOutcome, test.want)
		}
		var name string
		if err := pool.QueryRow(ctx, `SELECT e.name FROM error_events ee JOIN environments e ON e.id = ee.environment_id WHERE ee.id = $1`, result.EventID).Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name != test.name {
			t.Errorf("label %q stored in %q, want %q", test.label, name, test.name)
		}
	}
}

func TestEventEnvironmentDiscoveryRollsBackWithRejectedEvent(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-event-rollback-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	label := "rollback-" + uuid.NewString()
	_, err = q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: project.ID, DefaultEnvironmentID: *project.DefaultEnvironmentID,
		EnvironmentLabel: label, Fingerprint: uuid.NewString(), ErrorType: "Error",
		ErrorMessage: "reject me", Title: "Error: reject me", Breadcrumbs: `{`,
	})
	if err == nil {
		t.Fatal("invalid event JSON unexpectedly committed")
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM environments WHERE project_id = $1 AND name = $2`,
		project.ID, label,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled-back discovery left %d environment rows", count)
	}
}

func TestConcurrentEventEnvironmentDiscoveryCreatesOneRow(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-event-race-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	label := "race-" + uuid.NewString()
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
				ProjectID: project.ID, DefaultEnvironmentID: *project.DefaultEnvironmentID,
				EnvironmentLabel: label, Fingerprint: fmt.Sprintf("race-%d-%s", i, uuid.NewString()),
				ErrorType: "Error", ErrorMessage: "race", Title: "Error: race",
			})
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM environments WHERE project_id = $1 AND name = $2`,
		project.ID, label,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("concurrent discovery created %d rows, want 1", count)
	}
}

func TestSessionEnvironmentDiscoveryRollsBackWithRejectedInsert(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-session-rollback-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	label := "rollback-" + uuid.NewString()
	unknownEndUserID := uuid.NewString()
	_, err = q.RegisterSession(ctx, "sess_"+uuid.NewString(), project.ID,
		*project.DefaultEnvironmentID, label, &unknownEndUserID, time.Now(), "", nil)
	if err == nil {
		t.Fatal("session with unknown end user unexpectedly committed")
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM environments WHERE project_id = $1 AND name = $2`,
		project.ID, label,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled-back session discovery left %d environment rows", count)
	}
}

func TestConcurrentSessionRegistrationCreatesOnlyWinningEnvironment(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-session-race-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	sessionID := "sess_" + uuid.NewString()
	labels := []string{"race-a-" + uuid.NewString(), "race-b-" + uuid.NewString()}
	start := make(chan struct{})
	results := make(chan *db.SessionRegistration, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, label := range labels {
		wg.Add(1)
		go func(label string) {
			defer wg.Done()
			<-start
			result, err := q.RegisterSession(ctx, sessionID, project.ID,
				*project.DefaultEnvironmentID, label, nil, time.Now(), "", nil)
			results <- result
			errs <- err
		}(label)
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var environmentID string
	for result := range results {
		if result == nil {
			t.Fatal("registration returned nil result")
		}
		if environmentID == "" {
			environmentID = result.EnvironmentID
		} else if result.EnvironmentID != environmentID {
			t.Fatalf("registrations selected %s and %s", environmentID, result.EnvironmentID)
		}
	}
	var environmentCount, sessionCount int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM environments WHERE project_id = $1 AND name = ANY($2)`,
		project.ID, labels,
	).Scan(&environmentCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sessions WHERE id = $1 AND project_id = $2`,
		sessionID, project.ID,
	).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if environmentCount != 1 || sessionCount != 1 {
		t.Fatalf("environment/session counts = %d/%d, want 1/1", environmentCount, sessionCount)
	}
}

func TestExistingSessionSkipsRetryLabelDiscovery(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "environment-session-retry-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	project, err := q.CreateProject(ctx, org.ID, "project", nil)
	if err != nil || project.DefaultEnvironmentID == nil {
		t.Fatalf("project = %#v, err=%v", project, err)
	}
	sessionID := "sess_" + uuid.NewString()
	if _, err := q.RegisterSession(ctx, sessionID, project.ID, *project.DefaultEnvironmentID,
		"", nil, time.Now(), "", nil); err != nil {
		t.Fatal(err)
	}
	retryLabel := "unused-" + uuid.NewString()
	retry, err := q.RegisterSession(ctx, sessionID, project.ID, *project.DefaultEnvironmentID,
		retryLabel, nil, time.Now(), "", nil)
	if err != nil || retry.EnvironmentOutcome != db.EnvironmentOutcomeSession {
		t.Fatalf("retry = %#v, err=%v", retry, err)
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM environments WHERE project_id = $1 AND name = $2`,
		project.ID, retryLabel,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("retry created %d unused environment rows", count)
	}
}

func TestRegisterSessionClassifiesTenantConflictAndDivergence(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "phase5-sessions-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	p1, _ := q.CreateProject(ctx, org.ID, "p1", nil)
	p2, _ := q.CreateProject(ctx, org.ID, "p2", nil)
	prod, _ := q.CreateEnvironment(ctx, p1.ID, "production")
	_, _ = q.CreateEnvironment(ctx, p1.ID, "staging")
	p2env, _ := q.CreateEnvironment(ctx, p2.ID, "production")
	sessionID := "sess_" + uuid.NewString()

	first, err := q.RegisterSession(ctx, sessionID, p1.ID, prod.ID, "", nil, time.Now(), "", nil)
	if err != nil || first.Diverged || first.EnvironmentID != prod.ID {
		t.Fatalf("first = %#v, err=%v", first, err)
	}
	retry, err := q.RegisterSession(ctx, sessionID, p1.ID, prod.ID, "staging", nil, time.Now(), "", nil)
	if err != nil || !retry.Diverged || retry.EnvironmentID != prod.ID {
		t.Fatalf("retry = %#v, err=%v", retry, err)
	}
	if _, err := q.RegisterSession(ctx, sessionID, p2.ID, p2env.ID, "", nil, time.Now(), "", nil); !errors.Is(err, db.ErrSessionProjectConflict) {
		t.Fatalf("cross-project err = %v", err)
	}
}

func TestRegisterSessionDetectsOutOfOrderEventDivergence(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "phase5-out-of-order-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, org.ID)
		cleanupTenant(t, pool, org.ID)
	})
	project, _ := q.CreateProject(ctx, org.ID, "p", nil)
	prod, _ := q.CreateEnvironment(ctx, project.ID, "production")
	staging, _ := q.CreateEnvironment(ctx, project.ID, "staging")
	sessionID := "sess_" + uuid.NewString()
	_, err = q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: project.ID, DefaultEnvironmentID: staging.ID, SessionID: sessionID,
		Fingerprint: "phase5-" + uuid.NewString(), ErrorType: "Error", ErrorMessage: "out of order", Title: "Error: out of order",
	})
	if err != nil {
		t.Fatal(err)
	}
	registration, err := q.RegisterSession(ctx, sessionID, project.ID, prod.ID, "", nil, time.Now(), "", nil)
	if err != nil || !registration.Diverged {
		t.Fatalf("registration = %#v, err=%v", registration, err)
	}
}
