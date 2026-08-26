package db_test

import (
	"context"
	"sync"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestCaptureErrorClaimsFirstEvent(t *testing.T) {
	q, projectID, environmentID := seedCaptureProject(t)
	ctx := context.Background()
	capture := func(environmentID, message string) (*db.CaptureReceipt, error) {
		return q.CaptureError(ctx, db.IngestParams{
			ProjectID: projectID, DefaultEnvironmentID: environmentID,
			ErrorType: "TypeError", ErrorMessage: message, Platform: "javascript",
			StackTraceRaw: "at f (app.js:1:1)",
		})
	}
	first, err := capture(environmentID, "first")
	if err != nil {
		t.Fatal(err)
	}
	if !first.FirstEvent || first.EnvironmentID != environmentID || first.EnvironmentAgeSeconds < 0 {
		t.Fatalf("first receipt = %+v", first)
	}
	var firstEventSet bool
	if err := q.Pool().QueryRow(ctx,
		`SELECT first_event_at IS NOT NULL FROM environments WHERE id=$1`, environmentID,
	).Scan(&firstEventSet); err != nil || !firstEventSet {
		t.Fatalf("stored first_event_at set=%v err=%v", firstEventSet, err)
	}
	second, err := capture(environmentID, "second")
	if err != nil {
		t.Fatal(err)
	}
	if second.FirstEvent {
		t.Fatal("second capture reclaimed first_event_at")
	}

	var concurrentEnvironmentID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'concurrent-first-event') RETURNING id`,
		projectID,
	).Scan(&concurrentEnvironmentID); err != nil {
		t.Fatal(err)
	}
	results := make(chan *db.CaptureReceipt, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, captureErr := capture(concurrentEnvironmentID, string(rune('a'+i)))
			results <- receipt
			errs <- captureErr
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	claims := 0
	for receipt := range results {
		if receipt.FirstEvent {
			claims++
		}
	}
	if claims != 1 {
		t.Fatalf("concurrent first-event claims = %d, want 1", claims)
	}
}
