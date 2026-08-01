package handler_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/handler"
)

// The three seams on Dependencies are the only way to reach batch expiry, the
// completion-wait loop, and copy failure. Until they were exported, no test
// could set them and all three paths ran unexercised.

func TestExpiredBatchRejectsUploadAndCompletion(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)

	// Batches live one hour. Push the handler's clock past that.
	handler.SetSourceMapNowForTest(f.deps, func() time.Time {
		return time.Now().Add(2 * time.Hour)
	})

	upload := f.upload(t, batchID, f.debugID, f.raw)
	if upload.Code != http.StatusGone {
		t.Fatalf("upload to expired batch status = %d, want 410; body=%s", upload.Code, upload.Body.String())
	}
	if code := responseCode(t, upload); code != "batch_expired" {
		t.Errorf("upload code = %q, want batch_expired", code)
	}

	complete := f.complete(t, batchID)
	if complete.Code != http.StatusGone {
		t.Fatalf("complete of expired batch status = %d, want 410; body=%s", complete.Code, complete.Body.String())
	}
	if code := responseCode(t, complete); code != "batch_expired" {
		t.Errorf("complete code = %q, want batch_expired", code)
	}
}

func TestCompletionWaitTimesOutWithRetryAfter(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	if response := f.upload(t, batchID, f.debugID, f.raw); response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", response.Code, response.Body.String())
	}

	// Simulate a claimer that took the lease and died: the batch sits in
	// 'completing' with a live lease, so this request can only wait.
	if _, err := f.pool.Exec(context.Background(), `
		UPDATE sourcemap_batches
		SET status = 'completing',
		    completion_claimed_at = now(),
		    completion_lease_expires_at = now() + interval '5 minutes'
		WHERE id = $1`, batchID); err != nil {
		t.Fatal(err)
	}
	handler.SetCompletionWaitForTest(f.deps, 250*time.Millisecond)

	start := time.Now()
	response := f.complete(t, batchID)
	elapsed := time.Since(start)

	if response.Code != http.StatusConflict {
		t.Fatalf("complete status = %d, want 409; body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Retry-After"); got != "2" {
		t.Errorf("Retry-After = %q, want %q", got, "2")
	}
	if code := responseCode(t, response); code != "batch_completion_in_progress" {
		t.Errorf("code = %q, want batch_completion_in_progress", code)
	}
	if elapsed < 200*time.Millisecond {
		t.Errorf("returned after %v; the wait loop did not run", elapsed)
	}
}

func TestCompletionWaitReturnsReceiptWhenTheOtherClaimerFinishes(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	if response := f.upload(t, batchID, f.debugID, f.raw); response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", response.Code, response.Body.String())
	}
	if _, err := f.pool.Exec(context.Background(), `
		UPDATE sourcemap_batches
		SET status = 'completing',
		    completion_claimed_at = now(),
		    completion_lease_expires_at = now() + interval '5 minutes'
		WHERE id = $1`, batchID); err != nil {
		t.Fatal(err)
	}
	handler.SetCompletionWaitForTest(f.deps, 5*time.Second)

	// The "other claimer" lands while this request is polling.
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = f.pool.Exec(context.Background(), `
			UPDATE sourcemap_batches
			SET status = 'complete',
			    completed_at = now(),
			    completion_claimed_at = NULL,
			    completion_lease_expires_at = NULL
			WHERE id = $1`, batchID)
	}()

	response := f.complete(t, batchID)
	if response.Code != http.StatusOK {
		t.Fatalf("complete status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
}

func TestObjectCopyFailureReportsStorageUnavailable(t *testing.T) {
	f := newSourceMapHandlerFixture(t)
	batchID := f.createDefaultBatch(t)
	if response := f.upload(t, batchID, f.debugID, f.raw); response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", response.Code, response.Body.String())
	}
	handler.SetSourceMapCopierForTest(f.deps,
		func(context.Context, string, string) error { return errors.New("object store down") })

	response := f.complete(t, batchID)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("complete status = %d, want 503; body=%s", response.Code, response.Body.String())
	}
	if code := responseCode(t, response); code != "storage_unavailable" {
		t.Errorf("code = %q, want storage_unavailable", code)
	}

	// The batch must not have been activated by a failed promotion.
	var status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM sourcemap_batches WHERE id = $1`, batchID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status == "complete" {
		t.Fatalf("batch reached %q despite the copy failing", status)
	}
}
