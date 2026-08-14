package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func seedNotificationProject(t *testing.T, q *db.Queries, name string) (orgID, projectID, environmentID string) {
	t.Helper()
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, name+"-"+uuid.NewString())
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, name+"-project", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}
	return org.ID, project.ID, environment.ID
}

func destinationFixture(projectID, name string) db.NotificationDestination {
	return db.NotificationDestination{
		ID:                uuid.NewString(),
		ProjectID:         projectID,
		Type:              "slack",
		Name:              name,
		ConfigEncrypted:   []byte("sealed-config"),
		ConfigFingerprint: "hooks.slack.com/…/****test",
		EventTypes:        []string{"issue.created"},
		Enabled:           true,
	}
}

func TestNotificationDestinationCRUDAndTenantScope(t *testing.T) {
	pool := testPool(t)
	queries := db.New(pool)
	ctx := context.Background()
	orgA, projectA, _ := seedNotificationProject(t, queries, "notify-a")
	orgB, _, _ := seedNotificationProject(t, queries, "notify-b")
	t.Cleanup(func() {
		cleanupTenant(t, pool, orgA)
		cleanupTenant(t, pool, orgB)
	})

	fixture := destinationFixture(projectA, "Engineering alerts")
	created, err := queries.CreateNotificationDestination(ctx, orgA, projectA, fixture)
	if err != nil {
		t.Fatalf("CreateNotificationDestination: %v", err)
	}
	if created.ID != fixture.ID || created.ConfigFingerprint != fixture.ConfigFingerprint {
		t.Fatalf("created destination mismatch: %+v", created)
	}

	listed, err := queries.ListNotificationDestinations(ctx, orgA, projectA)
	if err != nil {
		t.Fatalf("ListNotificationDestinations: %v", err)
	}
	if len(listed) != 1 || listed[0].LastDeliveryStatus != nil || listed[0].RecentFailures != 0 {
		t.Fatalf("unexpected destination list: %+v", listed)
	}

	name := "Renamed alerts"
	enabled := false
	if err := queries.UpdateNotificationDestination(ctx, orgA, projectA, fixture.ID, &name, nil, nil, &enabled, nil, nil); err != nil {
		t.Fatalf("UpdateNotificationDestination: %v", err)
	}
	got, err := queries.GetNotificationDestination(ctx, orgA, projectA, fixture.ID)
	if err != nil {
		t.Fatalf("GetNotificationDestination: %v", err)
	}
	if got.Name != name || got.Enabled {
		t.Fatalf("update not persisted: %+v", got)
	}

	if _, err := queries.GetNotificationDestination(ctx, orgB, projectA, fixture.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-org get error = %v, want pgx.ErrNoRows", err)
	}
	if err := queries.UpdateNotificationDestination(ctx, orgB, projectA, fixture.ID, &name, nil, nil, nil, nil, nil); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-org update error = %v, want pgx.ErrNoRows", err)
	}
	if err := queries.DeleteNotificationDestination(ctx, orgB, projectA, fixture.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-org delete error = %v, want pgx.ErrNoRows", err)
	}

	if err := queries.DeleteNotificationDestination(ctx, orgA, projectA, fixture.ID); err != nil {
		t.Fatalf("DeleteNotificationDestination: %v", err)
	}
	if _, err := queries.GetNotificationDestination(ctx, orgA, projectA, fixture.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("get deleted error = %v, want pgx.ErrNoRows", err)
	}
}

func TestNotificationDestinationRejectsEmptyEventTypes(t *testing.T) {
	pool := testPool(t)
	queries := db.New(pool)
	orgID, projectID, _ := seedNotificationProject(t, queries, "notify-empty-events")
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })

	fixture := destinationFixture(projectID, "Invalid")
	fixture.EventTypes = []string{}
	if _, err := queries.CreateNotificationDestination(context.Background(), orgID, projectID, fixture); err == nil {
		t.Fatal("expected empty event_types to violate the database constraint")
	}
}

func TestUpdateNotificationDestinationEventTypes(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "evt-org-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "evt-proj", nil)
	if err != nil {
		t.Fatal(err)
	}
	destID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO notification_destinations
		(id, project_id, type, name, config_encrypted, config_fingerprint)
		VALUES ($1,$2,'slack','d',$3,'fp')`, destID, project.ID, []byte{0}); err != nil {
		t.Fatal(err)
	}

	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	var types []string
	if err := pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types); err != nil {
		t.Fatal(err)
	}
	if len(types) != 2 {
		t.Fatalf("expected default 2 types, got %v", types)
	}

	if err := q.UpdateNotificationDestination(ctx, org.ID, project.ID, destID, nil, nil, nil, nil, []string{"issue.created"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT event_types FROM notification_destinations WHERE id=$1`, destID).Scan(&types); err != nil {
		t.Fatal(err)
	}
	if len(types) != 1 || types[0] != "issue.created" {
		t.Fatalf("got %v", types)
	}
}
