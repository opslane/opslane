package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProjectFlagScansAndAPIKeyLookup(t *testing.T) {
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
	allow := true
	project, err = q.UpdateProject(ctx, org.ID, project.ID, nil, nil, nil, &allow)
	if err != nil {
		t.Fatal(err)
	}
	if !project.AllowPayloadEnvironment {
		t.Fatal("updated project flag = false")
	}
	listed, err := q.ListProjectsByOrg(ctx, org.ID)
	if err != nil || len(listed) != 1 || !listed[0].AllowPayloadEnvironment {
		t.Fatalf("listed = %#v, err=%v", listed, err)
	}
	got, err := q.GetProjectByOrgID(ctx, org.ID, project.ID)
	if err != nil || got == nil || !got.AllowPayloadEnvironment {
		t.Fatalf("get = %#v, err=%v", got, err)
	}
	_, err = q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatal(err)
	}
	key, err := q.CreateProjectKey(ctx, project.ID, db.ScopeIngest, "test", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := q.LookupProjectKey(ctx, key.Raw)
	if err != nil || !lookup.AllowPayloadEnvironment {
		t.Fatalf("lookup = %#v, err=%v", lookup, err)
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
	staging, _ := q.CreateEnvironment(ctx, p1.ID, "staging")
	p2env, _ := q.CreateEnvironment(ctx, p2.ID, "production")
	sessionID := "sess_" + uuid.NewString()

	first, err := q.RegisterSession(ctx, sessionID, p1.ID, prod.ID, nil, time.Now(), "", nil)
	if err != nil || first.Diverged || first.EnvironmentID != prod.ID {
		t.Fatalf("first = %#v, err=%v", first, err)
	}
	retry, err := q.RegisterSession(ctx, sessionID, p1.ID, staging.ID, nil, time.Now(), "", nil)
	if err != nil || !retry.Diverged || retry.EnvironmentID != prod.ID {
		t.Fatalf("retry = %#v, err=%v", retry, err)
	}
	if _, err := q.RegisterSession(ctx, sessionID, p2.ID, p2env.ID, nil, time.Now(), "", nil); !errors.Is(err, db.ErrSessionProjectConflict) {
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
		ProjectID: project.ID, EnvironmentID: staging.ID, SessionID: sessionID,
		Fingerprint: "phase5-" + uuid.NewString(), ErrorType: "Error", ErrorMessage: "out of order", Title: "Error: out of order",
	})
	if err != nil {
		t.Fatal(err)
	}
	registration, err := q.RegisterSession(ctx, sessionID, project.ID, prod.ID, nil, time.Now(), "", nil)
	if err != nil || !registration.Diverged {
		t.Fatalf("registration = %#v, err=%v", registration, err)
	}
}
