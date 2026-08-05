package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestCreatesOrgProjectEnvironmentHierarchy(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	// Create org
	org, err := q.CreateOrg(ctx, "test-org")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	if org.Name != "test-org" {
		t.Errorf("org name = %q, want %q", org.Name, "test-org")
	}

	// Create project under org
	project, err := q.CreateProject(ctx, org.ID, "test-project", ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	if project.OrgID != org.ID {
		t.Errorf("project.org_id = %q, want %q", project.OrgID, org.ID)
	}

	// Create environment under project
	env, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}
	if env.ProjectID != project.ID {
		t.Errorf("env.project_id = %q, want %q", env.ProjectID, project.ID)
	}

	// Create a project-scoped ingest key.
	key, err := q.CreateProjectKey(ctx, project.ID, db.ScopeIngest, "test", nil, "")
	if err != nil {
		t.Fatalf("CreateProjectKey: %v", err)
	}
	if key.Raw == "" {
		t.Error("expected non-empty raw key")
	}
	if key.TokenPrefix == "" {
		t.Error("expected non-empty key prefix")
	}

	if _, err := pool.Exec(ctx, `UPDATE projects SET allowed_origins = ARRAY['https://app.example.com', 'https://admin.example.com'] WHERE id = $1`, project.ID); err != nil {
		t.Fatalf("set allowed origins: %v", err)
	}

	// Lookup API key resolves to correct tenant chain
	lookup, err := q.LookupProjectKey(ctx, key.Raw)
	if err != nil {
		t.Fatalf("LookupProjectKey: %v", err)
	}
	if lookup.ProjectID != project.ID {
		t.Errorf("lookup.project_id = %q, want %q", lookup.ProjectID, project.ID)
	}
	if lookup.OrgID != org.ID {
		t.Errorf("lookup.org_id = %q, want %q", lookup.OrgID, org.ID)
	}
	if len(lookup.AllowedOrigins) != 2 || lookup.AllowedOrigins[0] != "https://app.example.com" || lookup.AllowedOrigins[1] != "https://admin.example.com" {
		t.Errorf("lookup.allowed_origins = %v, want app/admin origins", lookup.AllowedOrigins)
	}
}

func TestCrossProjectLookupDeniedWithoutTenantScope(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	// Create two orgs with projects
	org1, err := q.CreateOrg(ctx, "org-1")
	if err != nil {
		t.Fatalf("CreateOrg org-1: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org1.ID) })

	org2, err := q.CreateOrg(ctx, "org-2")
	if err != nil {
		t.Fatalf("CreateOrg org-2: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org2.ID) })

	proj1, err := q.CreateProject(ctx, org1.ID, "proj-1", ptrStr("org1/repo"))
	if err != nil {
		t.Fatalf("CreateProject proj-1: %v", err)
	}

	proj2, err := q.CreateProject(ctx, org2.ID, "proj-2", ptrStr("org2/repo"))
	if err != nil {
		t.Fatalf("CreateProject proj-2: %v", err)
	}

	// Insert error group in project 1
	env1, err := q.CreateEnvironment(ctx, proj1.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}

	_, err = q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            proj1.ID,
		DefaultEnvironmentID: env1.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "Cannot read properties of undefined",
		StackTraceRaw:        "at foo.js:1:1",
		Fingerprint:          "fp-isolation-test",
		Title:                "TypeError: Cannot read properties of undefined",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	// List error groups for project 2 — must NOT see project 1's data
	groups, err := q.ListErrorGroups(ctx, proj2.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups: %v", err)
	}
	if len(groups) != 0 {
		t.Errorf("project 2 sees %d error groups from project 1, want 0", len(groups))
	}

	// List error groups for project 1 — must see the group
	groups1, err := q.ListErrorGroups(ctx, proj1.ID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups proj1: %v", err)
	}
	if len(groups1) != 1 {
		t.Errorf("project 1 sees %d error groups, want 1", len(groups1))
	}
}
