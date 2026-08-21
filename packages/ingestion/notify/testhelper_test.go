package notify

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDSN = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultTestDSN
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping DB test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("skipping DB test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cleanupTenant(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, query := range []string{
		`DELETE FROM outbound_deliveries WHERE destination_id IN
			(SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

type seededDelivery struct {
	OrgID         string
	ProjectID     string
	DestinationID string
	EventID       string
	DeliveryID    string
}

func seedDelivery(t *testing.T, pool *pgxpool.Pool, cipher *ConfigCipher, webhookURL string) seededDelivery {
	t.Helper()
	ctx := context.Background()
	seed := seededDelivery{
		OrgID:         uuid.NewString(),
		ProjectID:     uuid.NewString(),
		DestinationID: uuid.NewString(),
		EventID:       uuid.NewString(),
		DeliveryID:    uuid.NewString(),
	}
	t.Cleanup(func() { cleanupTenant(t, pool, seed.OrgID) })

	if _, err := pool.Exec(ctx, `INSERT INTO orgs (id, name) VALUES ($1, $2)`, seed.OrgID, "notify-test-"+seed.OrgID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO projects (id, org_id, name, github_repo) VALUES ($1, $2, 'notify-project', 'owner/repo')`, seed.ProjectID, seed.OrgID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	config, err := json.Marshal(destinationConfig{WebhookURL: webhookURL})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := cipher.Seal(config, ConfigAAD(seed.DestinationID, seed.ProjectID, "slack"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO notification_destinations
		  (id, project_id, type, name, config_encrypted, config_fingerprint)
		VALUES ($1, $2, 'slack', 'test', $3, 'masked')`, seed.DestinationID, seed.ProjectID, sealed); err != nil {
		t.Fatalf("insert destination: %v", err)
	}
	payload, err := json.Marshal(samplePayload("test issue", ""))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO outbound_events (id, project_id, event_type, dedup_key, payload)
		VALUES ($1, $2, 'issue.created', $3, $4)`, seed.EventID, seed.ProjectID, "test:"+seed.EventID, payload); err != nil {
		t.Fatalf("insert outbound event: %v", err)
	}
	// Backdate next_attempt_at. claim() orders by it and takes a limited batch,
	// and `go test ./...` runs packages concurrently against one database, so
	// another package's freshly inserted delivery can crowd this row out of the
	// batch. An hour in the past sorts ahead of anything a concurrent test
	// creates while this one runs.
	if _, err := pool.Exec(ctx, `
		INSERT INTO outbound_deliveries (id, event_id, destination_id, next_attempt_at)
		VALUES ($1, $2, $3, now() - interval '1 hour')`, seed.DeliveryID, seed.EventID, seed.DestinationID); err != nil {
		t.Fatalf("insert outbound delivery: %v", err)
	}
	return seed
}

// claimFor finds one seeded delivery inside a claim batch. The dispatcher
// claims across every tenant, so a batch can carry rows a concurrently running
// package seeded. Assert on the row the test owns, never on the batch size.
func claimFor(claims []deliveryClaim, deliveryID string) (deliveryClaim, bool) {
	for _, claim := range claims {
		if claim.ID == deliveryID {
			return claim, true
		}
	}
	return deliveryClaim{}, false
}
