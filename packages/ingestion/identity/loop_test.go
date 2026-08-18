package identity

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLoopSkipsObservationsWhoseResolutionIsStillPending(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	eventID := seedEventWithResolutionStatus(t, pool, f, "pending")

	if err := (&Loop{pool: pool, projectID: f.ProjectID}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	assertIdentityStatus(t, pool, f.ProjectID, eventID, "pending")
}

func TestLoopSkipsRetryableFailedResolutions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	eventID := seedEventWithResolutionStatus(t, pool, f, "failed")

	if err := (&Loop{pool: pool, projectID: f.ProjectID}).Tick(ctx); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	assertIdentityStatus(t, pool, f.ProjectID, eventID, "pending")
}

func TestLoopSettlesEachObservationExactlyOnceUnderConcurrency(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	for i := 0; i < 40; i++ {
		seedResolvedEvent(t, pool, f,
			fmt.Sprintf("raw-%d-%d", i%4, i), fmt.Sprintf("src/F%d.vue", i%4), "f")
	}

	const replicas = 4
	var wg sync.WaitGroup
	errs := make(chan error, replicas)
	for i := 0; i < replicas; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := (&Loop{pool: pool, projectID: f.ProjectID}).Tick(ctx); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent Tick: %v", err)
	}

	var pending, settling, settled int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE status='pending'),
		        count(*) FILTER (WHERE status='settling'),
		        count(*) FILTER (WHERE status='settled')
		   FROM error_event_identities WHERE project_id=$1`, f.ProjectID).Scan(
		&pending, &settling, &settled); err != nil {
		t.Fatal(err)
	}
	if pending != 0 || settling != 0 || settled != 40 {
		t.Errorf("pending=%d settling=%d settled=%d, want 0, 0, 40", pending, settling, settled)
	}
	var issues, occurrences int
	if err := pool.QueryRow(ctx,
		`SELECT count(*),COALESCE(sum(occurrence_count),0)
		   FROM error_groups WHERE project_id=$1`, f.ProjectID).Scan(&issues, &occurrences); err != nil {
		t.Fatal(err)
	}
	if issues != 4 || occurrences != 40 {
		t.Errorf("issues=%d occurrences=%d, want 4 and 40", issues, occurrences)
	}
}

func TestAbandonedClaimsReturnToTheQueue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	f := seedProject(t, pool)
	eventID := seedStuckSettlingIdentity(t, pool, f, time.Now().Add(-10*time.Minute))

	if err := (&Loop{pool: pool, projectID: f.ProjectID}).resetAbandoned(ctx); err != nil {
		t.Fatalf("resetAbandoned: %v", err)
	}
	assertIdentityStatus(t, pool, f.ProjectID, eventID, "pending")
}

func assertIdentityStatus(t *testing.T, pool *pgxpool.Pool, projectID, eventID, want string) {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM error_event_identities WHERE project_id=$1 AND event_id=$2`,
		projectID, eventID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != want {
		t.Errorf("status = %q, want %q", status, want)
	}
}
