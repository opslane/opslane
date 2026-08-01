package db_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

const (
	sourceMapDebugID  = "158399f3-1dad-1386-35b2-98c34317d52e"
	sourceMapDebugID2 = "197a3f87-a4f5-fd89-cb79-6c4004b83497"
)

type sourceMapFixture struct {
	q         *db.Queries
	orgID     string
	projectID string
	keyDBID   string
}

func newSourceMapFixture(t *testing.T, suffix string) sourceMapFixture {
	t.Helper()
	ctx := context.Background()
	pool := testPool(t)
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "sourcemaps-"+suffix)
	if err != nil {
		t.Fatal(err)
	}
	project, err := q.CreateProject(ctx, org.ID, "sourcemaps-"+suffix, nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := q.CreateProjectKey(ctx, project.ID, db.ScopeSourcemaps, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, org.ID)
	})
	return sourceMapFixture{
		q:         q,
		orgID:     org.ID,
		projectID: project.ID,
		keyDBID:   key.ID,
	}
}

func sourceMapFile(debugID string, rawSize int64, fill byte) db.StagedFile {
	return db.StagedFile{
		DebugID:       debugID,
		StagingKey:    "staging-" + debugID,
		RawSize:       rawSize,
		CanonicalSize: rawSize - 1,
		RawSHA256:     bytes.Repeat([]byte{fill}, 32),
		ContentSHA256: bytes.Repeat([]byte{fill + 1}, 32),
	}
}

func createSourceMapBatch(
	t *testing.T,
	fixture sourceMapFixture,
	idempotencyKey string,
	manifestFill byte,
	files ...db.ManifestFile,
) db.SourceMapBatch {
	t.Helper()
	batch, reused, err := fixture.q.CreateSourceMapBatch(
		context.Background(),
		fixture.projectID,
		fixture.keyDBID,
		idempotencyKey,
		bytes.Repeat([]byte{manifestFill}, 32),
		nil,
		nil,
		false,
		files,
	)
	if err != nil {
		t.Fatal(err)
	}
	if reused {
		t.Fatal("new source map batch reported as reused")
	}
	return batch
}

func TestSourceMapBatchCreationIsIdempotentAndProjectScoped(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "create")
	other := newSourceMapFixture(t, "create-other")
	files := []db.ManifestFile{
		{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
		{DebugID: sourceMapDebugID2, CodeFile: "assets/vendor.js", RawSize: 200},
	}
	commit := "e60b4d1e113538d40f09e31717e949aaa08659f8"
	release := "web@e60b4d1"
	manifest := bytes.Repeat([]byte{1}, 32)

	batch, reused, err := fixture.q.CreateSourceMapBatch(
		ctx,
		fixture.projectID,
		fixture.keyDBID,
		"11111111-1111-1111-1111-111111111111",
		manifest,
		&commit,
		&release,
		true,
		files,
	)
	if err != nil {
		t.Fatal(err)
	}
	if reused {
		t.Fatal("first create was reused")
	}
	if batch.ProjectID != fixture.projectID ||
		batch.Status != "pending" ||
		!batch.Probe ||
		batch.CommitSHA == nil || *batch.CommitSHA != commit ||
		batch.Release == nil || *batch.Release != release ||
		batch.ExpectedFileCount != 2 ||
		batch.ExpectedBytes != 300 ||
		batch.ReceivedFileCount != 0 ||
		batch.ReceivedBytes != 0 {
		t.Fatalf("unexpected batch: %+v", batch)
	}

	retry, reused, err := fixture.q.CreateSourceMapBatch(
		ctx,
		fixture.projectID,
		fixture.keyDBID,
		"11111111-1111-1111-1111-111111111111",
		manifest,
		&commit,
		&release,
		true,
		files,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reused || retry.ID != batch.ID {
		t.Fatalf("retry = id %q reused %v, want id %q reused", retry.ID, reused, batch.ID)
	}

	_, _, err = fixture.q.CreateSourceMapBatch(
		ctx,
		fixture.projectID,
		fixture.keyDBID,
		"11111111-1111-1111-1111-111111111111",
		bytes.Repeat([]byte{2}, 32),
		nil,
		nil,
		false,
		files,
	)
	if !errors.Is(err, db.ErrIdempotencyConflict) {
		t.Fatalf("changed manifest retry: %v, want ErrIdempotencyConflict", err)
	}

	declared, state, err := fixture.q.GetDeclaredFile(
		ctx, fixture.projectID, batch.ID, sourceMapDebugID2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if declared.CodeFile != "assets/vendor.js" || declared.RawSize != 200 || state != "pending" {
		t.Fatalf("declared file = %+v state %q", declared, state)
	}
	if _, err := fixture.q.GetSourceMapBatch(ctx, other.projectID, batch.ID); !errors.Is(err, db.ErrBatchNotFound) {
		t.Fatalf("cross-project batch lookup: %v, want ErrBatchNotFound", err)
	}
	if _, _, err := fixture.q.GetDeclaredFile(ctx, other.projectID, batch.ID, sourceMapDebugID); !errors.Is(err, db.ErrBatchNotFound) {
		t.Fatalf("cross-project declared lookup: %v, want ErrBatchNotFound", err)
	}
	if _, _, err := fixture.q.GetDeclaredFile(ctx, fixture.projectID, batch.ID, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"); !errors.Is(err, db.ErrDebugIDNotDeclared) {
		t.Fatalf("undeclared lookup: %v, want ErrDebugIDNotDeclared", err)
	}
}

func TestStageBatchFileIsIdempotentAndCountsOnlyOnce(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "stage")
	batch := createSourceMapBatch(
		t,
		fixture,
		"22222222-2222-2222-2222-222222222222",
		2,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 3)

	created, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first stage was not created")
	}
	created, err = fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("idempotent stage reported created")
	}

	got, err := fixture.q.GetSourceMapBatch(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReceivedFileCount != 1 || got.ReceivedBytes != 100 {
		t.Fatalf("received counters = %d/%d, want 1/100", got.ReceivedFileCount, got.ReceivedBytes)
	}
	listed, err := fixture.q.ListStagedFiles(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 ||
		listed[0].StagingKey != file.StagingKey ||
		listed[0].RawSize != file.RawSize ||
		listed[0].CanonicalSize != file.CanonicalSize ||
		!bytes.Equal(listed[0].RawSHA256, file.RawSHA256) ||
		!bytes.Equal(listed[0].ContentSHA256, file.ContentSHA256) {
		t.Fatalf("staged files = %+v", listed)
	}

	conflict := file
	conflict.ContentSHA256 = bytes.Repeat([]byte{99}, 32)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, conflict); !errors.Is(err, db.ErrDebugIDConflict) {
		t.Fatalf("conflicting stage: %v, want ErrDebugIDConflict", err)
	}
	undeclared := sourceMapFile(sourceMapDebugID2, 100, 4)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, undeclared); !errors.Is(err, db.ErrDebugIDNotDeclared) {
		t.Fatalf("undeclared stage: %v, want ErrDebugIDNotDeclared", err)
	}
}

func TestStageBatchFileRejectsExpiredAndCrossProjectBatches(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "stage-expired")
	other := newSourceMapFixture(t, "stage-expired-other")
	batch := createSourceMapBatch(
		t,
		fixture,
		"33333333-3333-3333-3333-333333333333",
		3,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 5)

	if _, err := fixture.q.StageBatchFile(ctx, other.projectID, batch.ID, file); !errors.Is(err, db.ErrBatchNotFound) {
		t.Fatalf("cross-project stage: %v, want ErrBatchNotFound", err)
	}
	if _, err := fixture.q.Pool().Exec(ctx, `
		UPDATE sourcemap_batches
		SET created_at = now() - interval '2 hours',
		    expires_at = now() - interval '1 hour'
		WHERE id = $1 AND project_id = $2`,
		batch.ID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); !errors.Is(err, db.ErrBatchExpired) {
		t.Fatalf("expired stage: %v, want ErrBatchExpired", err)
	}
}

func TestClaimBatchCompletionReclaimsExpiredLease(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "claim")
	batch := createSourceMapBatch(
		t,
		fixture,
		"44444444-4444-4444-4444-444444444444",
		4,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 6)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}

	first, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID); !errors.Is(err, db.ErrCompletionInProgress) {
		t.Fatalf("second claim under a live lease: %v, want ErrCompletionInProgress", err)
	}
	if _, err := fixture.q.Pool().Exec(ctx, `
		UPDATE sourcemap_batches
		SET completion_lease_expires_at = now() - interval '1 second'
		WHERE id = $1 AND project_id = $2`,
		batch.ID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	second, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatalf("reclaim after expiry: %v", err)
	}
	if second.ClaimedAt.Equal(first.ClaimedAt) {
		t.Error("reclaim must mint a new claim token")
	}

	n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, first.ClaimedAt, []db.StagedFile{file})
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("stale claim activated %d rows, want 0", n)
	}
	n, err = fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, second.ClaimedAt, []db.StagedFile{file})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("current claim activated %d rows, want 1", n)
	}
}

func TestClaimBatchCompletionClassifiesFailure(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "claim-errors")
	batch := createSourceMapBatch(
		t,
		fixture,
		"55555555-5555-5555-5555-555555555555",
		5,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID); !errors.Is(err, db.ErrBatchIncomplete) {
		t.Fatalf("incomplete claim: %v, want ErrBatchIncomplete", err)
	}
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"); !errors.Is(err, db.ErrBatchNotFound) {
		t.Fatalf("missing claim: %v, want ErrBatchNotFound", err)
	}

	file := sourceMapFile(sourceMapDebugID, 100, 7)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, claim.ClaimedAt, []db.StagedFile{file}); err != nil || n != 1 {
		t.Fatalf("activation = %d, %v", n, err)
	}
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID); !errors.Is(err, db.ErrBatchComplete) {
		t.Fatalf("complete claim: %v, want ErrBatchComplete", err)
	}
}

func TestClaimBatchCompletionRejectsFullyReceivedExpiredBatch(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "claim-expired")
	batch := createSourceMapBatch(
		t,
		fixture,
		"55555555-5555-5555-5555-555555555556",
		5,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 7)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.Pool().Exec(ctx, `
		UPDATE sourcemap_batches
		SET created_at = now() - interval '2 hours',
		    expires_at = now() - interval '1 hour'
		WHERE id = $1 AND project_id = $2`,
		batch.ID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID); !errors.Is(err, db.ErrBatchExpired) {
		t.Fatalf("expired complete claim: %v, want ErrBatchExpired", err)
	}
	got, err := fixture.q.GetSourceMapBatch(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "pending" {
		t.Fatalf("expired claim changed status to %q", got.Status)
	}
}

// expires_at bounds how long a batch may stay unfinished, so it gates 'pending'
// only (design §5.4). A 'completing' batch already received every declared byte
// before expiry; if expires_at also gated the reclaim arm, a batch whose
// claimer died would be stranded in 'completing' forever — 410 Gone on every
// retry, and invisible to a sweeper indexed on status = 'pending'.
func TestClaimBatchCompletionReclaimsStrandedLeaseAfterBatchExpiry(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "claim-stranded")
	batch := createSourceMapBatch(
		t,
		fixture,
		"55555555-5555-5555-5555-55555555555a",
		9,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 11)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID); err != nil {
		t.Fatalf("first claim: %v", err)
	}

	// That claimer dies. Its lease lapses, and the batch's own expires_at
	// passes before anyone retries.
	if _, err := fixture.q.Pool().Exec(ctx, `
		UPDATE sourcemap_batches
		SET completion_lease_expires_at = now() - interval '1 minute',
		    created_at = now() - interval '3 hours',
		    expires_at = now() - interval '1 hour'
		WHERE id = $1 AND project_id = $2`,
		batch.ID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}

	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatalf("reclaim of a fully received stranded batch: %v, want success", err)
	}
	if claim.ClaimedAt.IsZero() {
		t.Fatal("reclaim returned an empty claim token")
	}
	if _, err := fixture.q.ActivateBatch(
		ctx, fixture.projectID, batch.ID, claim.ClaimedAt,
		[]db.StagedFile{file},
	); err != nil {
		t.Fatalf("activate after reclaim: %v", err)
	}
	got, err := fixture.q.GetSourceMapBatch(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "complete" {
		t.Fatalf("status = %q, want complete: the batch is still stranded", got.Status)
	}
}

func TestActivateBatchRejectsDebugIDContentConflictAtomically(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "activate-conflict")
	batch := createSourceMapBatch(
		t,
		fixture,
		"66666666-6666-6666-6666-666666666666",
		6,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 8)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	conflictingDigest := bytes.Repeat([]byte{77}, 32)
	objectKey := fmt.Sprintf(
		"sourcemaps/v1/projects/%s/maps/%x.map",
		fixture.projectID,
		conflictingDigest,
	)
	if _, err := fixture.q.Pool().Exec(ctx, `
		INSERT INTO sourcemap_files (
			project_id, debug_id, content_sha256, size_bytes, object_key
		)
		VALUES ($1, $2, $3, $4, $5)`,
		fixture.projectID,
		sourceMapDebugID,
		conflictingDigest,
		file.CanonicalSize,
		objectKey,
	); err != nil {
		t.Fatal(err)
	}
	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.ActivateBatch(
		ctx, fixture.projectID, batch.ID, claim.ClaimedAt, []db.StagedFile{file},
	); !errors.Is(err, db.ErrDebugIDConflict) {
		t.Fatalf("activation conflict: %v, want ErrDebugIDConflict", err)
	}

	got, err := fixture.q.GetSourceMapBatch(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "completing" || got.CompletedAt != nil {
		t.Fatalf("conflicting activation changed batch: %+v", got)
	}
	_, state, err := fixture.q.GetDeclaredFile(ctx, fixture.projectID, batch.ID, sourceMapDebugID)
	if err != nil {
		t.Fatal(err)
	}
	if state != "staged" {
		t.Fatalf("conflicting activation changed manifest state to %q", state)
	}
}

func TestLinkExistingArtifactReusesOnlyIdenticalProjectArtifact(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "link")
	firstBatch := createSourceMapBatch(
		t,
		fixture,
		"77777777-7777-7777-7777-777777777777",
		7,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 9)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, firstBatch.ID, file); err != nil {
		t.Fatal(err)
	}
	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, firstBatch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, firstBatch.ID, claim.ClaimedAt, []db.StagedFile{file}); err != nil || n != 1 {
		t.Fatalf("seed activation = %d, %v", n, err)
	}

	secondBatch := createSourceMapBatch(
		t,
		fixture,
		"88888888-8888-8888-8888-888888888888",
		8,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	linked, err := fixture.q.LinkExistingArtifact(ctx, fixture.projectID, secondBatch.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	if !linked {
		t.Fatal("identical project artifact was not linked")
	}
	got, err := fixture.q.GetSourceMapBatch(ctx, fixture.projectID, secondBatch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReceivedFileCount != 1 || got.ReceivedBytes != 100 {
		t.Fatalf("linked counters = %d/%d, want 1/100", got.ReceivedFileCount, got.ReceivedBytes)
	}
	_, state, err := fixture.q.GetDeclaredFile(ctx, fixture.projectID, secondBatch.ID, sourceMapDebugID)
	if err != nil {
		t.Fatal(err)
	}
	if state != "linked" {
		t.Fatalf("linked manifest state = %q", state)
	}
	secondClaim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, secondBatch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := fixture.q.ActivateBatch(
		ctx, fixture.projectID, secondBatch.ID, secondClaim.ClaimedAt, nil,
	); err != nil || n != 1 {
		t.Fatalf("linked-only activation = %d, %v", n, err)
	}
	if _, err := fixture.q.GetResolvableMap(
		ctx, fixture.projectID, secondBatch.ID, sourceMapDebugID,
	); err != nil {
		t.Fatalf("linked-only batch is not resolvable after completion: %v", err)
	}

	thirdBatch := createSourceMapBatch(
		t,
		fixture,
		"99999999-9999-9999-9999-999999999999",
		9,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	conflict := file
	conflict.ContentSHA256 = bytes.Repeat([]byte{88}, 32)
	if _, err := fixture.q.LinkExistingArtifact(ctx, fixture.projectID, thirdBatch.ID, conflict); !errors.Is(err, db.ErrDebugIDConflict) {
		t.Fatalf("conflicting existing artifact: %v, want ErrDebugIDConflict", err)
	}
}

func TestGetResolvableMapRequiresLinkedCompleteBatch(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "resolve")
	other := newSourceMapFixture(t, "resolve-other")
	batch := createSourceMapBatch(
		t,
		fixture,
		"aaaaaaaa-1111-1111-1111-111111111111",
		10,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 11)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.GetResolvableMap(ctx, fixture.projectID, batch.ID, sourceMapDebugID); !errors.Is(err, db.ErrMapNotFound) {
		t.Fatalf("pending resolution: %v, want ErrMapNotFound", err)
	}
	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.q.GetResolvableMap(ctx, fixture.projectID, batch.ID, sourceMapDebugID); !errors.Is(err, db.ErrMapNotFound) {
		t.Fatalf("completing resolution: %v, want ErrMapNotFound", err)
	}
	if n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, claim.ClaimedAt, []db.StagedFile{file}); err != nil || n != 1 {
		t.Fatalf("activation = %d, %v", n, err)
	}
	resolved, err := fixture.q.GetResolvableMap(ctx, fixture.projectID, batch.ID, sourceMapDebugID)
	if err != nil {
		t.Fatal(err)
	}
	wantObjectKey := fmt.Sprintf(
		"sourcemaps/v1/projects/%s/maps/%x.map",
		fixture.projectID,
		file.ContentSHA256,
	)
	if resolved.ObjectKey != wantObjectKey ||
		resolved.CanonicalSize != file.CanonicalSize ||
		!bytes.Equal(resolved.ContentSHA256, file.ContentSHA256) {
		t.Fatalf("resolved map = %+v, want key %q", resolved, wantObjectKey)
	}
	if _, err := fixture.q.GetResolvableMap(ctx, fixture.projectID, batch.ID, sourceMapDebugID2); !errors.Is(err, db.ErrMapNotFound) {
		t.Fatalf("unlinked debug id resolution: %v, want ErrMapNotFound", err)
	}
	if _, err := fixture.q.GetResolvableMap(ctx, other.projectID, batch.ID, sourceMapDebugID); !errors.Is(err, db.ErrBatchNotFound) {
		t.Fatalf("cross-project resolution: %v, want ErrBatchNotFound", err)
	}
}

func TestDeleteProjectRemovesSourceMapRowsAndReturnsStoragePrefix(t *testing.T) {
	ctx := context.Background()
	fixture := newSourceMapFixture(t, "delete")
	other := newSourceMapFixture(t, "delete-other")
	batch := createSourceMapBatch(
		t,
		fixture,
		"bbbbbbbb-1111-1111-1111-111111111111",
		11,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)
	file := sourceMapFile(sourceMapDebugID, 100, 12)
	if _, err := fixture.q.StageBatchFile(ctx, fixture.projectID, batch.ID, file); err != nil {
		t.Fatal(err)
	}
	claim, err := fixture.q.ClaimBatchCompletion(ctx, fixture.projectID, batch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := fixture.q.ActivateBatch(ctx, fixture.projectID, batch.ID, claim.ClaimedAt, []db.StagedFile{file}); err != nil || n != 1 {
		t.Fatalf("activation = %d, %v", n, err)
	}
	otherBatch := createSourceMapBatch(
		t,
		other,
		"cccccccc-1111-1111-1111-111111111111",
		12,
		db.ManifestFile{DebugID: sourceMapDebugID, CodeFile: "assets/app.js", RawSize: 100},
	)

	prefix, err := fixture.q.DeleteProject(ctx, fixture.projectID)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := "sourcemaps/v1/projects/" + fixture.projectID + "/"
	if prefix != wantPrefix {
		t.Fatalf("storage prefix = %q, want %q", prefix, wantPrefix)
	}
	for _, table := range []string{
		"sourcemap_batch_files",
		"sourcemap_files",
		"sourcemap_batches",
		"project_api_keys",
		"projects",
	} {
		var count int
		query := fmt.Sprintf("SELECT count(*) FROM %s WHERE project_id = $1", table)
		if table == "projects" {
			query = "SELECT count(*) FROM projects WHERE id = $1"
		}
		if err := fixture.q.Pool().QueryRow(ctx, query, fixture.projectID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("%s retained %d deleted-project rows", table, count)
		}
	}
	if _, err := other.q.GetSourceMapBatch(ctx, other.projectID, otherBatch.ID); err != nil {
		t.Fatalf("deleting one project affected another: %v", err)
	}
}
