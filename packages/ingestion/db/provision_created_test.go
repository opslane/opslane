package db_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProvisionFromIdentityCreated(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	identity := auth.Identity{
		Provider: "workos", ProviderSubject: uuid.NewString(),
		Email: uuid.NewString() + "@example.com", EmailVerified: true,
		Name: "Created Flag",
	}
	userID, orgID, created, err := q.ProvisionFromIdentity(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })
	if !created {
		t.Fatal("first provisioning did not report created")
	}
	replayedUser, replayedOrg, replayedCreated, err := q.ProvisionFromIdentity(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	if replayedCreated || replayedUser != userID || replayedOrg != orgID {
		t.Fatalf("replay got user=%q org=%q created=%v", replayedUser, replayedOrg, replayedCreated)
	}
}
