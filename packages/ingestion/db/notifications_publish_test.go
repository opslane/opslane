package db_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func ingestNotificationIssue(t *testing.T, queries *db.Queries, projectID, environmentID, fingerprint, title string, eventTime time.Time) *db.IngestResult {
	t.Helper()
	result, err := queries.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID:            projectID,
		DefaultEnvironmentID: environmentID,
		ErrorType:            "TypeError",
		ErrorMessage:         title,
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          fingerprint,
		Title:                title,
		EventTime:            eventTime,
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}
	return result
}

func TestPublishIssueCreatedFanoutAndIncrementBehavior(t *testing.T) {
	pool := testPool(t)
	queries := db.New(pool)
	queries.DashboardURL = "https://app.example.com/base"
	ctx := context.Background()
	orgID, projectID, environmentID := seedNotificationProject(t, queries, "notify-publish")
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })

	first := destinationFixture(projectID, "Primary")
	if _, err := queries.CreateNotificationDestination(ctx, orgID, projectID, first); err != nil {
		t.Fatal(err)
	}
	when := time.Date(2026, 7, 19, 12, 30, 0, 0, time.FixedZone("offset", -7*60*60))
	result := ingestNotificationIssue(t, queries, projectID, environmentID, "notify-fp-1", "TypeError: x is not a function", when)
	if !result.IsNew {
		t.Fatal("expected a new group")
	}

	var eventType, dedupKey, status string
	var rawPayload []byte
	if err := pool.QueryRow(ctx, `
		SELECT e.event_type, e.dedup_key, e.payload, d.status
		FROM outbound_events e
		JOIN outbound_deliveries d ON d.event_id = e.id
		WHERE e.project_id = $1`, projectID).Scan(&eventType, &dedupKey, &rawPayload, &status); err != nil {
		t.Fatal(err)
	}
	if eventType != "issue.created" || dedupKey != "issue.created:"+result.GroupID || status != "pending" {
		t.Fatalf("unexpected outbox row: type=%s dedup=%s status=%s", eventType, dedupKey, status)
	}
	var payload notify.EventPayload
	if err := json.Unmarshal(rawPayload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Version != 1 || payload.Project.ID != projectID || payload.Project.Name == "" || payload.Environment != "production" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	if payload.Issue.FirstSeen != when.UTC().Format(time.RFC3339) || payload.DashboardURL == "" {
		t.Fatalf("unexpected time/link payload: %+v", payload)
	}
	var document map[string]any
	if err := json.Unmarshal(rawPayload, &document); err != nil {
		t.Fatal(err)
	}
	if _, exists := document["status"]; exists {
		t.Fatal("payload must not contain status")
	}

	ingestNotificationIssue(t, queries, projectID, environmentID, "notify-fp-1", "same group", when.Add(time.Minute))
	assertOutboundCounts(t, pool, projectID, 1, 1)

	second := destinationFixture(projectID, "Secondary")
	if _, err := queries.CreateNotificationDestination(ctx, orgID, projectID, second); err != nil {
		t.Fatal(err)
	}
	ingestNotificationIssue(t, queries, projectID, environmentID, "notify-fp-2", "another issue", when.Add(2*time.Minute))
	assertOutboundCounts(t, pool, projectID, 2, 3)

	disabled := false
	if err := queries.UpdateNotificationDestination(ctx, orgID, projectID, first.ID, nil, nil, nil, &disabled, nil); err != nil {
		t.Fatal(err)
	}
	if err := queries.UpdateNotificationDestination(ctx, orgID, projectID, second.ID, nil, nil, nil, &disabled, nil); err != nil {
		t.Fatal(err)
	}
	ingestNotificationIssue(t, queries, projectID, environmentID, "notify-fp-3", "no subscribers", when.Add(3*time.Minute))
	assertOutboundCounts(t, pool, projectID, 2, 3)
}

func TestPublishIssueCreatedNoDestinationWritesNoEvent(t *testing.T) {
	pool := testPool(t)
	queries := db.New(pool)
	orgID, projectID, environmentID := seedNotificationProject(t, queries, "notify-none")
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })

	ingestNotificationIssue(t, queries, projectID, environmentID, "notify-none-fp", "quiet issue", time.Now())
	assertOutboundCounts(t, pool, projectID, 0, 0)
}

func assertOutboundCounts(t *testing.T, pool *pgxpool.Pool, projectID string, wantEvents, wantDeliveries int) {
	t.Helper()
	var events, deliveries int
	if err := pool.QueryRow(context.Background(), `
		SELECT COUNT(DISTINCT e.id), COUNT(d.id)
		FROM outbound_events e
		LEFT JOIN outbound_deliveries d ON d.event_id = e.id
		WHERE e.project_id = $1`, projectID).Scan(&events, &deliveries); err != nil {
		t.Fatal(err)
	}
	if events != wantEvents || deliveries != wantDeliveries {
		t.Fatalf("outbound counts events=%d deliveries=%d, want %d/%d", events, deliveries, wantEvents, wantDeliveries)
	}
}
