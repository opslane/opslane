package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestOrgHasEvents(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	org, err := q.CreateOrg(ctx, "org-has-events-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	older, err := q.CreateProject(ctx, org.ID, "older", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateProject(ctx, org.ID, "newer", nil); err != nil {
		t.Fatal(err)
	}
	olderEnv, err := q.CreateEnvironment(ctx, older.ID, "production")
	if err != nil {
		t.Fatal(err)
	}

	otherOrg, err := q.CreateOrg(ctx, "org-has-events-other-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, otherOrg.ID) })
	otherProject, err := q.CreateProject(ctx, otherOrg.ID, "other", nil)
	if err != nil {
		t.Fatal(err)
	}
	otherEnv, err := q.CreateEnvironment(ctx, otherProject.ID, "production")
	if err != nil {
		t.Fatal(err)
	}

	insertEvent := func(projectID, environmentID string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO error_events
				(project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw, created_at)
			VALUES ($1, $2, now(), 'OrgHasEventsTest', 'org has events', 'stack', now())`,
			projectID, environmentID); err != nil {
			t.Fatalf("insert event: %v", err)
		}
	}

	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || has {
		t.Fatalf("no events: got (%v, %v), want (false, nil)", has, err)
	}
	insertEvent(otherProject.ID, otherEnv.ID)
	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || has {
		t.Fatalf("another org's event must not count: got (%v, %v)", has, err)
	}
	insertEvent(older.ID, olderEnv.ID)
	if has, err := q.OrgHasEvents(ctx, org.ID); err != nil || !has {
		t.Fatalf("event on the older project: got (%v, %v), want (true, nil)", has, err)
	}
}
