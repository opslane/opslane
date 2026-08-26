package db_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestProvisionFromIdentityIsIdempotentAndConcurrentSafe(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	identity := auth.Identity{
		Provider: "workos", ProviderSubject: fmt.Sprintf("user_%d", time.Now().UnixNano()),
		Email: fmt.Sprintf("Cloud-%d@Example.com", time.Now().UnixNano()), EmailVerified: true,
		Name: "Cloud User",
	}

	type result struct {
		userID, orgID string
		created       bool
		err           error
	}
	results := make(chan result, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				results <- result{err: err}
				return
			}
			defer tx.Rollback(ctx)
			ready.Done()
			<-start
			userID, orgID, created, err := q.ProvisionFromIdentityTx(ctx, tx, identity)
			if err == nil {
				err = tx.Commit(ctx)
			}
			results <- result{userID: userID, orgID: orgID, created: created, err: err}
		}()
	}
	ready.Wait()
	close(start)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent provisioning errors: %v / %v", first.err, second.err)
	}
	if first.userID != second.userID || first.orgID != second.orgID {
		t.Fatalf("different results: %+v / %+v", first, second)
	}
	if first.created == second.created {
		t.Fatalf("exactly one concurrent provision should create the user: %+v / %+v", first, second)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, first.orgID) })

	replayedUser, replayedOrg, replayCreated, err := q.ProvisionFromIdentity(ctx, identity)
	if err != nil || replayedUser != first.userID || replayedOrg != first.orgID {
		t.Fatalf("replay got (%q,%q) err=%v", replayedUser, replayedOrg, err)
	}
	if replayCreated {
		t.Fatal("replayed provisioning reported a newly created user")
	}
	role, err := q.GetMembership(ctx, first.userID, first.orgID)
	if err != nil || role != "owner" {
		t.Fatalf("owner membership role=%q err=%v", role, err)
	}
}

func TestProvisionFromIdentityVerifiedEmailGate(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "link-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	email := fmt.Sprintf("Link-%d@Example.com", time.Now().UnixNano())
	user, err := q.CreateUserGitHub(ctx, org.ID, email, "Existing", time.Now().UnixNano(), "existing", "")
	if err != nil {
		t.Fatal(err)
	}

	if _, _, _, err := q.ProvisionFromIdentity(ctx, auth.Identity{
		Provider: "workos", ProviderSubject: "unverified-" + user.ID,
		Email: db.NormalizeEmail(email), EmailVerified: false,
	}); err == nil {
		t.Fatal("unverified identity unexpectedly linked existing email")
	}
	linkedUser, linkedOrg, created, err := q.ProvisionFromIdentity(ctx, auth.Identity{
		Provider: "workos", ProviderSubject: "verified-" + user.ID,
		Email: db.NormalizeEmail(email), EmailVerified: true,
	})
	if err != nil || linkedUser != user.ID || linkedOrg != org.ID {
		t.Fatalf("verified link got (%q,%q) err=%v", linkedUser, linkedOrg, err)
	}
	if created {
		t.Fatal("linking a verified identity to an existing user reported created")
	}
	role, _ := q.GetMembership(ctx, user.ID, org.ID)
	if role != "owner" {
		t.Fatalf("linked user role=%q, want owner", role)
	}
}
