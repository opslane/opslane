package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// Races N goroutines through the real completion path on ONE batch.
// Invariant: exactly one activation, counts never doubled, no torn state.
func TestQAConcurrentCompletionExactlyOneWinner(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "qarace")
	batch := createSourceMapBatch(t, fixture, "99999999-9999-9999-9999-999999999999", 9,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100})
	file := sourceMapFile(sourceMapDebugID, 100, 7)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}

	const N = 12
	var wg sync.WaitGroup
	claimed := make([]bool, N)
	loser := make([]error, N)
	activated := make([]int, N)
	errs := make([]error, N)
	start := make(chan struct{})

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // release all at once
			c, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
			if err != nil {
				// Two legitimate loser outcomes:
				//   ErrCompletionInProgress - the winner still holds a live lease
				//   ErrBatchComplete        - the winner already finished; the
				//                             handler returns the original receipt
				if !errors.Is(err, db.ErrCompletionInProgress) &&
					!errors.Is(err, db.ErrBatchComplete) {
					errs[i] = err
				}
				loser[i] = err
				return
			}
			claimed[i] = true
			staged, err := fixture.q.ListStagedFiles(ctx, fixture.projectID, batch.ID)
			if err != nil {
				errs[i] = err
				return
			}
			n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, c.ClaimedAt, staged)
			if err != nil {
				errs[i] = err
				return
			}
			activated[i] = n
		}(i)
	}
	close(start)
	wg.Wait()

	nClaimed, nActivated := 0, 0
	for i := 0; i < N; i++ {
		if errs[i] != nil {
			t.Errorf("goroutine %d unexpected error: %v", i, errs[i])
		}
		if claimed[i] {
			nClaimed++
		}
		if activated[i] > 0 {
			nActivated++
		}
	}
	inProgress, alreadyComplete := 0, 0
	for i := 0; i < N; i++ {
		switch {
		case errors.Is(loser[i], db.ErrCompletionInProgress):
			inProgress++
		case errors.Is(loser[i], db.ErrBatchComplete):
			alreadyComplete++
		}
	}
	t.Logf("goroutines=%d claimed=%d activated=%d losers(in_progress=%d already_complete=%d)",
		N, nClaimed, nActivated, inProgress, alreadyComplete)
	if inProgress+alreadyComplete != N-nClaimed {
		t.Errorf("some loser returned an unclassified outcome")
	}
	if nActivated != 1 {
		t.Errorf("activations = %d, want exactly 1", nActivated)
	}

	// The batch must be complete exactly once, with untouched counts.
	var status string
	var recvFiles int
	var recvBytes int64
	var artifacts int
	if err := fixture.q.Pool().QueryRow(ctx, `
		SELECT b.status, b.received_file_count, b.received_bytes,
		       (SELECT count(*) FROM sourcemap_files f WHERE f.project_id=b.project_id)
		FROM sourcemap_batches b WHERE b.id=$1`, batch.ID).
		Scan(&status, &recvFiles, &recvBytes, &artifacts); err != nil {
		t.Fatal(err)
	}
	t.Logf("batch status=%s received=%d/%d bytes=%d artifacts=%d", status, recvFiles, 1, recvBytes, artifacts)
	if status != "complete" {
		t.Errorf("status = %q, want complete", status)
	}
	if recvFiles != 1 || recvBytes != 100 {
		t.Errorf("counts doubled: files=%d bytes=%d, want 1/100", recvFiles, recvBytes)
	}
	if artifacts != 1 {
		t.Errorf("artifacts = %d, want 1 (no duplicate sourcemap_files row)", artifacts)
	}
}
