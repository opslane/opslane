package db

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrBatchNotFound        = errors.New("source map batch not found")
	ErrBatchExpired         = errors.New("source map batch expired")
	ErrBatchComplete        = errors.New("source map batch complete")
	ErrBatchIncomplete      = errors.New("source map batch incomplete")
	ErrDebugIDNotDeclared   = errors.New("debug id not declared")
	ErrDebugIDConflict      = errors.New("debug id content conflict")
	ErrIdempotencyConflict  = errors.New("idempotency key reused")
	ErrCompletionInProgress = errors.New("completion in progress")
	ErrMapNotFound          = errors.New("source map not resolvable")
)

type ManifestFile struct {
	DebugID  string
	CodeFile string
	RawSize  int64
}

type SourceMapBatch struct {
	ID                string
	ProjectID         string
	Status            string
	Probe             bool
	CommitSHA         *string
	Release           *string
	ExpectedFileCount int
	ExpectedBytes     int64
	ReceivedFileCount int
	ReceivedBytes     int64
	ExpiresAt         time.Time
	CompletedAt       *time.Time
}

type BatchClaim struct {
	ClaimedAt time.Time
}

type StagedFile struct {
	DebugID       string
	StagingKey    string
	RawSize       int64
	CanonicalSize int64
	RawSHA256     []byte
	ContentSHA256 []byte
}

type ResolvableMap struct {
	ObjectKey     string
	ContentSHA256 []byte
	CanonicalSize int64
}

const sourceMapBatchColumns = `
	id, project_id, status, probe, commit_sha, release,
	expected_file_count, expected_bytes, received_file_count, received_bytes,
	expires_at, completed_at`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSourceMapBatch(row rowScanner) (SourceMapBatch, error) {
	var batch SourceMapBatch
	err := row.Scan(
		&batch.ID,
		&batch.ProjectID,
		&batch.Status,
		&batch.Probe,
		&batch.CommitSHA,
		&batch.Release,
		&batch.ExpectedFileCount,
		&batch.ExpectedBytes,
		&batch.ReceivedFileCount,
		&batch.ReceivedBytes,
		&batch.ExpiresAt,
		&batch.CompletedAt,
	)
	return batch, err
}

func (q *Queries) CreateSourceMapBatch(
	ctx context.Context,
	projectID, keyDBID, idempotencyKey string,
	manifestSHA256 []byte,
	commitSHA, release *string,
	probe bool,
	files []ManifestFile,
) (batch SourceMapBatch, reused bool, err error) {
	var expectedBytes int64
	for _, file := range files {
		expectedBytes += file.RawSize
	}

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return SourceMapBatch{}, false, fmt.Errorf("create source map batch: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	batch, err = scanSourceMapBatch(tx.QueryRow(ctx, `
		INSERT INTO sourcemap_batches (
			project_id, upload_key_db_id, idempotency_key, manifest_sha256,
			commit_sha, release, probe, expected_file_count, expected_bytes,
			expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '1 hour')
		ON CONFLICT (project_id, upload_key_db_id, idempotency_key) DO NOTHING
		RETURNING `+sourceMapBatchColumns,
		projectID,
		keyDBID,
		idempotencyKey,
		manifestSHA256,
		commitSHA,
		release,
		probe,
		len(files),
		expectedBytes,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		var storedManifest []byte
		batch, err = scanSourceMapBatch(tx.QueryRow(ctx, `
			SELECT `+sourceMapBatchColumns+`
			FROM sourcemap_batches
			WHERE project_id = $1
			  AND upload_key_db_id = $2
			  AND idempotency_key = $3`,
			projectID, keyDBID, idempotencyKey,
		))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return SourceMapBatch{}, false, ErrBatchNotFound
			}
			return SourceMapBatch{}, false, fmt.Errorf("read idempotent source map batch: %w", err)
		}
		if err := tx.QueryRow(ctx, `
			SELECT manifest_sha256
			FROM sourcemap_batches
			WHERE id = $1 AND project_id = $2`,
			batch.ID, projectID,
		).Scan(&storedManifest); err != nil {
			return SourceMapBatch{}, false, fmt.Errorf("read source map manifest digest: %w", err)
		}
		if !bytes.Equal(storedManifest, manifestSHA256) {
			return SourceMapBatch{}, false, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return SourceMapBatch{}, false, fmt.Errorf("reuse source map batch: commit: %w", err)
		}
		return batch, true, nil
	}
	if err != nil {
		return SourceMapBatch{}, false, fmt.Errorf("insert source map batch: %w", err)
	}

	for _, file := range files {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sourcemap_batch_files (
				batch_id, project_id, debug_id, code_file, expected_size_bytes
			)
			VALUES ($1, $2, $3, $4, $5)`,
			batch.ID, projectID, file.DebugID, file.CodeFile, file.RawSize,
		); err != nil {
			return SourceMapBatch{}, false, fmt.Errorf("insert source map manifest file: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return SourceMapBatch{}, false, fmt.Errorf("create source map batch: commit: %w", err)
	}
	return batch, false, nil
}

func (q *Queries) GetSourceMapBatch(
	ctx context.Context,
	projectID, batchID string,
) (SourceMapBatch, error) {
	batch, err := scanSourceMapBatch(q.pool.QueryRow(ctx, `
		SELECT `+sourceMapBatchColumns+`
		FROM sourcemap_batches
		WHERE id = $1 AND project_id = $2`,
		batchID, projectID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceMapBatch{}, ErrBatchNotFound
	}
	if err != nil {
		return SourceMapBatch{}, fmt.Errorf("get source map batch: %w", err)
	}
	return batch, nil
}

func (q *Queries) GetDeclaredFile(
	ctx context.Context,
	projectID, batchID, debugID string,
) (ManifestFile, string, error) {
	if _, err := q.GetSourceMapBatch(ctx, projectID, batchID); err != nil {
		return ManifestFile{}, "", err
	}

	var file ManifestFile
	var state string
	err := q.pool.QueryRow(ctx, `
		SELECT debug_id, code_file, expected_size_bytes, state
		FROM sourcemap_batch_files
		WHERE batch_id = $1 AND project_id = $2 AND debug_id = $3`,
		batchID, projectID, debugID,
	).Scan(&file.DebugID, &file.CodeFile, &file.RawSize, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManifestFile{}, "", ErrDebugIDNotDeclared
	}
	if err != nil {
		return ManifestFile{}, "", fmt.Errorf("get declared source map file: %w", err)
	}
	return file, state, nil
}

type lockedManifestFile struct {
	State           string
	ExpectedRawSize int64
	StagingKey      *string
	RawSize         *int64
	CanonicalSize   *int64
	RawSHA256       []byte
	ContentSHA256   []byte
	SourceMapID     *string
}

func lockBatchForUpload(
	ctx context.Context,
	tx pgx.Tx,
	projectID, batchID string,
) (SourceMapBatch, error) {
	var batch SourceMapBatch
	var unexpired bool
	err := tx.QueryRow(ctx, `
		SELECT `+sourceMapBatchColumns+`, expires_at > now()
		FROM sourcemap_batches
		WHERE id = $1 AND project_id = $2
		FOR UPDATE`,
		batchID, projectID,
	).Scan(
		&batch.ID,
		&batch.ProjectID,
		&batch.Status,
		&batch.Probe,
		&batch.CommitSHA,
		&batch.Release,
		&batch.ExpectedFileCount,
		&batch.ExpectedBytes,
		&batch.ReceivedFileCount,
		&batch.ReceivedBytes,
		&batch.ExpiresAt,
		&batch.CompletedAt,
		&unexpired,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceMapBatch{}, ErrBatchNotFound
	}
	if err != nil {
		return SourceMapBatch{}, fmt.Errorf("lock source map batch: %w", err)
	}

	switch batch.Status {
	case "pending":
		if !unexpired {
			return SourceMapBatch{}, ErrBatchExpired
		}
	case "completing":
		return SourceMapBatch{}, ErrCompletionInProgress
	case "complete":
		return SourceMapBatch{}, ErrBatchComplete
	case "expired":
		return SourceMapBatch{}, ErrBatchExpired
	default:
		return SourceMapBatch{}, fmt.Errorf("unknown source map batch status %q", batch.Status)
	}
	return batch, nil
}

func lockManifestFile(
	ctx context.Context,
	tx pgx.Tx,
	projectID, batchID, debugID string,
) (lockedManifestFile, error) {
	var file lockedManifestFile
	err := tx.QueryRow(ctx, `
		SELECT state, expected_size_bytes, staging_object_key,
		       received_size_bytes, canonical_size_bytes,
		       raw_sha256, content_sha256, source_map_id
		FROM sourcemap_batch_files
		WHERE batch_id = $1 AND project_id = $2 AND debug_id = $3
		FOR UPDATE`,
		batchID, projectID, debugID,
	).Scan(
		&file.State,
		&file.ExpectedRawSize,
		&file.StagingKey,
		&file.RawSize,
		&file.CanonicalSize,
		&file.RawSHA256,
		&file.ContentSHA256,
		&file.SourceMapID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedManifestFile{}, ErrDebugIDNotDeclared
	}
	if err != nil {
		return lockedManifestFile{}, fmt.Errorf("lock source map manifest file: %w", err)
	}
	return file, nil
}

func sameStagedIdentity(stored lockedManifestFile, incoming StagedFile) bool {
	return stored.RawSize != nil &&
		stored.CanonicalSize != nil &&
		*stored.RawSize == incoming.RawSize &&
		*stored.CanonicalSize == incoming.CanonicalSize &&
		bytes.Equal(stored.ContentSHA256, incoming.ContentSHA256)
}

func validatePendingUpload(file lockedManifestFile, incoming StagedFile) error {
	if incoming.RawSize != file.ExpectedRawSize {
		return fmt.Errorf("received source map size %d does not match declared size %d",
			incoming.RawSize, file.ExpectedRawSize)
	}
	if len(incoming.RawSHA256) != 32 || len(incoming.ContentSHA256) != 32 {
		return fmt.Errorf("source map digests must be 32 bytes")
	}
	if incoming.CanonicalSize < 1 {
		return fmt.Errorf("canonical source map size must be positive")
	}
	return nil
}

func incrementBatchReceived(
	ctx context.Context,
	tx pgx.Tx,
	projectID, batchID string,
	rawSize int64,
) error {
	tag, err := tx.Exec(ctx, `
		UPDATE sourcemap_batches
		SET received_file_count = received_file_count + 1,
		    received_bytes = received_bytes + $3
		WHERE id = $1 AND project_id = $2`,
		batchID, projectID, rawSize,
	)
	if err != nil {
		return fmt.Errorf("increment source map batch counters: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrBatchNotFound
	}
	return nil
}

func (q *Queries) LinkExistingArtifact(
	ctx context.Context,
	projectID, batchID string,
	incoming StagedFile,
) (linked bool, err error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("link existing source map: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := lockBatchForUpload(ctx, tx, projectID, batchID); err != nil {
		return false, err
	}
	manifest, err := lockManifestFile(ctx, tx, projectID, batchID, incoming.DebugID)
	if err != nil {
		return false, err
	}
	if err := validatePendingUpload(manifest, incoming); err != nil {
		return false, err
	}
	if manifest.State == "linked" {
		if !sameStagedIdentity(manifest, incoming) {
			return false, ErrDebugIDConflict
		}
		return true, nil
	}
	if manifest.State == "staged" && !sameStagedIdentity(manifest, incoming) {
		return false, ErrDebugIDConflict
	}

	var sourceMapID string
	var storedDigest []byte
	var storedSize int64
	err = tx.QueryRow(ctx, `
		SELECT id, content_sha256, size_bytes
		FROM sourcemap_files
		WHERE project_id = $1 AND debug_id = $2`,
		projectID, incoming.DebugID,
	).Scan(&sourceMapID, &storedDigest, &storedSize)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("link existing source map: commit no-op: %w", err)
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find existing source map artifact: %w", err)
	}
	if !bytes.Equal(storedDigest, incoming.ContentSHA256) ||
		storedSize != incoming.CanonicalSize {
		return false, ErrDebugIDConflict
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sourcemap_batch_files
		SET state = 'linked',
		    staging_object_key = CASE
		      WHEN state = 'staged' THEN staging_object_key
		      ELSE NULL
		    END,
		    received_size_bytes = $4,
		    canonical_size_bytes = $5,
		    raw_sha256 = $6,
		    content_sha256 = $7,
		    source_map_id = $8,
		    uploaded_at = COALESCE(uploaded_at, now())
		WHERE batch_id = $1 AND project_id = $2 AND debug_id = $3`,
		batchID,
		projectID,
		incoming.DebugID,
		incoming.RawSize,
		incoming.CanonicalSize,
		incoming.RawSHA256,
		incoming.ContentSHA256,
		sourceMapID,
	)
	if err != nil {
		return false, fmt.Errorf("link existing source map artifact: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return false, ErrDebugIDNotDeclared
	}
	if manifest.State == "pending" {
		if err := incrementBatchReceived(ctx, tx, projectID, batchID, incoming.RawSize); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("link existing source map: commit: %w", err)
	}
	return true, nil
}

func (q *Queries) StageBatchFile(
	ctx context.Context,
	projectID, batchID string,
	incoming StagedFile,
) (created bool, err error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("stage source map: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := lockBatchForUpload(ctx, tx, projectID, batchID); err != nil {
		return false, err
	}
	manifest, err := lockManifestFile(ctx, tx, projectID, batchID, incoming.DebugID)
	if err != nil {
		return false, err
	}
	if err := validatePendingUpload(manifest, incoming); err != nil {
		return false, err
	}
	if manifest.State != "pending" {
		if !sameStagedIdentity(manifest, incoming) {
			return false, ErrDebugIDConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("reuse staged source map: commit: %w", err)
		}
		return false, nil
	}
	if incoming.StagingKey == "" {
		return false, fmt.Errorf("staging object key is required")
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sourcemap_batch_files
		SET state = 'staged',
		    staging_object_key = $4,
		    received_size_bytes = $5,
		    canonical_size_bytes = $6,
		    raw_sha256 = $7,
		    content_sha256 = $8,
		    uploaded_at = now()
		WHERE batch_id = $1 AND project_id = $2 AND debug_id = $3
		  AND state = 'pending'`,
		batchID,
		projectID,
		incoming.DebugID,
		incoming.StagingKey,
		incoming.RawSize,
		incoming.CanonicalSize,
		incoming.RawSHA256,
		incoming.ContentSHA256,
	)
	if err != nil {
		return false, fmt.Errorf("stage source map manifest file: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return false, fmt.Errorf("stage source map manifest file: state changed while locked")
	}
	if err := incrementBatchReceived(ctx, tx, projectID, batchID, incoming.RawSize); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("stage source map: commit: %w", err)
	}
	return true, nil
}

func (q *Queries) ClaimBatchCompletion(
	ctx context.Context,
	projectID, batchID string,
) (BatchClaim, error) {
	var claim BatchClaim
	err := q.pool.QueryRow(ctx, `
		UPDATE sourcemap_batches
		SET status = 'completing',
		    completion_claimed_at = now(),
		    completion_lease_expires_at = now() + interval '5 minutes'
		WHERE id = $1 AND project_id = $2
		  AND received_file_count = expected_file_count
		  AND received_bytes = expected_bytes
		  AND (
		    (status = 'pending' AND expires_at > now())
		    OR (
		      -- expires_at bounds how long a batch may stay unfinished, so it
		      -- gates 'pending' only. A 'completing' batch already received
		      -- every declared byte before expiry; letting expires_at gate the
		      -- reclaim arm too would strand it in 'completing' forever, which
		      -- is the failure the reclaim arm exists to prevent.
		      status = 'completing'
		      AND completion_lease_expires_at <= now()
		    )
		  )
		RETURNING completion_claimed_at`,
		batchID, projectID,
	).Scan(&claim.ClaimedAt)
	if err == nil {
		return claim, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return BatchClaim{}, fmt.Errorf("claim source map batch completion: %w", err)
	}

	var status string
	var expectedFiles, receivedFiles int
	var expectedBytes, receivedBytes int64
	var expiresAt time.Time
	var leaseExpiresAt *time.Time
	var expired, leaseIsLive bool
	err = q.pool.QueryRow(ctx, `
		SELECT status, expected_file_count, received_file_count,
		       expected_bytes, received_bytes, expires_at,
		       completion_lease_expires_at, expires_at <= now(),
		       COALESCE(completion_lease_expires_at > now(), false)
		FROM sourcemap_batches
		WHERE id = $1 AND project_id = $2`,
		batchID, projectID,
	).Scan(
		&status,
		&expectedFiles,
		&receivedFiles,
		&expectedBytes,
		&receivedBytes,
		&expiresAt,
		&leaseExpiresAt,
		&expired,
		&leaseIsLive,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return BatchClaim{}, ErrBatchNotFound
	}
	if err != nil {
		return BatchClaim{}, fmt.Errorf("classify source map completion claim: %w", err)
	}

	if status == "complete" {
		return BatchClaim{}, ErrBatchComplete
	}
	// Mirror the claim predicate: expiry classifies a 'pending' batch only.
	if status == "expired" || (status == "pending" && expired) {
		return BatchClaim{}, ErrBatchExpired
	}
	if receivedFiles != expectedFiles || receivedBytes != expectedBytes {
		return BatchClaim{}, ErrBatchIncomplete
	}
	if status == "completing" && leaseExpiresAt != nil && leaseIsLive {
		return BatchClaim{}, ErrCompletionInProgress
	}
	return BatchClaim{}, ErrCompletionInProgress
}

func (q *Queries) ListStagedFiles(
	ctx context.Context,
	projectID, batchID string,
) ([]StagedFile, error) {
	if _, err := q.GetSourceMapBatch(ctx, projectID, batchID); err != nil {
		return nil, err
	}

	rows, err := q.pool.Query(ctx, `
		SELECT debug_id, staging_object_key, received_size_bytes,
		       canonical_size_bytes, raw_sha256, content_sha256
		FROM sourcemap_batch_files
		WHERE batch_id = $1 AND project_id = $2 AND state = 'staged'
		ORDER BY debug_id`,
		batchID, projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list staged source maps: %w", err)
	}
	defer rows.Close()

	var files []StagedFile
	for rows.Next() {
		var file StagedFile
		if err := rows.Scan(
			&file.DebugID,
			&file.StagingKey,
			&file.RawSize,
			&file.CanonicalSize,
			&file.RawSHA256,
			&file.ContentSHA256,
		); err != nil {
			return nil, fmt.Errorf("scan staged source map: %w", err)
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list staged source maps: %w", err)
	}
	return files, nil
}

func sameStagedFile(a, b StagedFile) bool {
	return a.DebugID == b.DebugID &&
		a.StagingKey == b.StagingKey &&
		a.RawSize == b.RawSize &&
		a.CanonicalSize == b.CanonicalSize &&
		bytes.Equal(a.RawSHA256, b.RawSHA256) &&
		bytes.Equal(a.ContentSHA256, b.ContentSHA256)
}

type artifactIdentity struct {
	ID            string
	ContentSHA256 []byte
	CanonicalSize int64
}

func (q *Queries) ActivateBatch(
	ctx context.Context,
	projectID, batchID string,
	claimedAt time.Time,
	staged []StagedFile,
) (rowsChanged int, err error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("activate source map batch: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		status        string
		storedClaim   *time.Time
		leaseIsLive   bool
		expectedFiles int
		receivedFiles int
		expectedBytes int64
		receivedBytes int64
	)
	err = tx.QueryRow(ctx, `
		SELECT status, completion_claimed_at,
		       COALESCE(completion_lease_expires_at > now(), false),
		       expected_file_count, received_file_count,
		       expected_bytes, received_bytes
		FROM sourcemap_batches
		WHERE id = $1 AND project_id = $2
		FOR UPDATE`,
		batchID, projectID,
	).Scan(
		&status,
		&storedClaim,
		&leaseIsLive,
		&expectedFiles,
		&receivedFiles,
		&expectedBytes,
		&receivedBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrBatchNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("lock source map batch for activation: %w", err)
	}
	if status != "completing" ||
		storedClaim == nil ||
		!storedClaim.Equal(claimedAt) ||
		!leaseIsLive ||
		expectedFiles != receivedFiles ||
		expectedBytes != receivedBytes {
		return 0, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT debug_id, staging_object_key, received_size_bytes,
		       canonical_size_bytes, raw_sha256, content_sha256
		FROM sourcemap_batch_files
		WHERE batch_id = $1 AND project_id = $2 AND state = 'staged'
		ORDER BY debug_id
		FOR UPDATE`,
		batchID, projectID,
	)
	if err != nil {
		return 0, fmt.Errorf("lock staged source map files: %w", err)
	}
	var storedStaged []StagedFile
	for rows.Next() {
		var file StagedFile
		if err := rows.Scan(
			&file.DebugID,
			&file.StagingKey,
			&file.RawSize,
			&file.CanonicalSize,
			&file.RawSHA256,
			&file.ContentSHA256,
		); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan staged source map for activation: %w", err)
		}
		storedStaged = append(storedStaged, file)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("read staged source maps for activation: %w", err)
	}
	rows.Close()

	if len(storedStaged) != len(staged) {
		return 0, fmt.Errorf("activate source map batch: staged file set changed")
	}
	incomingByDebugID := make(map[string]StagedFile, len(staged))
	for _, file := range staged {
		if _, duplicate := incomingByDebugID[file.DebugID]; duplicate {
			return 0, fmt.Errorf("activate source map batch: duplicate staged debug id %s", file.DebugID)
		}
		incomingByDebugID[file.DebugID] = file
	}
	for _, stored := range storedStaged {
		incoming, ok := incomingByDebugID[stored.DebugID]
		if !ok || !sameStagedFile(stored, incoming) {
			return 0, fmt.Errorf("activate source map batch: staged file identity changed")
		}
	}

	artifacts := make(map[string]artifactIdentity, len(staged))
	for _, file := range staged {
		var artifact artifactIdentity
		err := tx.QueryRow(ctx, `
			SELECT id, content_sha256, size_bytes
			FROM sourcemap_files
			WHERE project_id = $1 AND debug_id = $2`,
			projectID, file.DebugID,
		).Scan(&artifact.ID, &artifact.ContentSHA256, &artifact.CanonicalSize)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("validate source map artifact: %w", err)
		}
		if !bytes.Equal(artifact.ContentSHA256, file.ContentSHA256) ||
			artifact.CanonicalSize != file.CanonicalSize {
			return 0, ErrDebugIDConflict
		}
		artifacts[file.DebugID] = artifact
	}

	for _, file := range staged {
		artifact, exists := artifacts[file.DebugID]
		if !exists {
			objectKey := "sourcemaps/v1/projects/" + projectID +
				"/maps/" + hex.EncodeToString(file.ContentSHA256) + ".map"
			err := tx.QueryRow(ctx, `
				INSERT INTO sourcemap_files (
					project_id, debug_id, content_sha256, size_bytes, object_key
				)
				VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (project_id, debug_id) DO NOTHING
				RETURNING id, content_sha256, size_bytes`,
				projectID,
				file.DebugID,
				file.ContentSHA256,
				file.CanonicalSize,
				objectKey,
			).Scan(&artifact.ID, &artifact.ContentSHA256, &artifact.CanonicalSize)
			if errors.Is(err, pgx.ErrNoRows) {
				err = tx.QueryRow(ctx, `
					SELECT id, content_sha256, size_bytes
					FROM sourcemap_files
					WHERE project_id = $1 AND debug_id = $2`,
					projectID, file.DebugID,
				).Scan(&artifact.ID, &artifact.ContentSHA256, &artifact.CanonicalSize)
			}
			if err != nil {
				return 0, fmt.Errorf("insert source map artifact: %w", err)
			}
			if !bytes.Equal(artifact.ContentSHA256, file.ContentSHA256) ||
				artifact.CanonicalSize != file.CanonicalSize {
				return 0, ErrDebugIDConflict
			}
		}

		tag, err := tx.Exec(ctx, `
			UPDATE sourcemap_batch_files
			SET state = 'linked', source_map_id = $4
			WHERE batch_id = $1 AND project_id = $2 AND debug_id = $3
			  AND state = 'staged'
			  AND staging_object_key = $5
			  AND received_size_bytes = $6
			  AND canonical_size_bytes = $7
			  AND raw_sha256 = $8
			  AND content_sha256 = $9`,
			batchID,
			projectID,
			file.DebugID,
			artifact.ID,
			file.StagingKey,
			file.RawSize,
			file.CanonicalSize,
			file.RawSHA256,
			file.ContentSHA256,
		)
		if err != nil {
			return 0, fmt.Errorf("link staged source map artifact: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return 0, fmt.Errorf("link staged source map artifact: state changed")
		}
	}

	tag, err := tx.Exec(ctx, `
		UPDATE sourcemap_batches
		SET status = 'complete',
		    completed_at = now(),
		    completion_claimed_at = NULL,
		    completion_lease_expires_at = NULL
		WHERE id = $1 AND project_id = $2
		  AND status = 'completing'
		  AND completion_claimed_at = $3
		  AND completion_lease_expires_at > now()
		  AND received_file_count = expected_file_count
		  AND received_bytes = expected_bytes`,
		batchID, projectID, claimedAt,
	)
	if err != nil {
		return 0, fmt.Errorf("complete source map batch activation: %w", err)
	}
	rowsChanged = int(tag.RowsAffected())
	if rowsChanged == 0 {
		return 0, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("activate source map batch: commit: %w", err)
	}
	return rowsChanged, nil
}

func (q *Queries) GetResolvableMap(
	ctx context.Context,
	projectID, batchID, debugID string,
) (ResolvableMap, error) {
	if _, err := q.GetSourceMapBatch(ctx, projectID, batchID); err != nil {
		return ResolvableMap{}, err
	}

	var result ResolvableMap
	err := q.pool.QueryRow(ctx, `
		SELECT sf.object_key, sf.content_sha256, sf.size_bytes
		FROM sourcemap_batch_files bf
		JOIN sourcemap_batches b
		  ON b.id = bf.batch_id AND b.project_id = bf.project_id
		JOIN sourcemap_files sf
		  ON sf.id = bf.source_map_id AND sf.project_id = bf.project_id
		WHERE bf.batch_id = $1
		  AND bf.project_id = $2
		  AND bf.debug_id = $3
		  AND bf.state = 'linked'
		  AND b.status = 'complete'`,
		batchID, projectID, debugID,
	).Scan(&result.ObjectKey, &result.ContentSHA256, &result.CanonicalSize)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResolvableMap{}, ErrMapNotFound
	}
	if err != nil {
		return ResolvableMap{}, fmt.Errorf("get resolvable source map: %w", err)
	}
	return result, nil
}

func (q *Queries) DeleteProject(
	ctx context.Context,
	projectID string,
) (storagePrefix string, err error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("delete project: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Keep this order explicit: most historic project foreign keys do not
	// cascade, and source-map manifest rows also reference project artifacts.
	queries := []string{
		`DELETE FROM outbound_deliveries WHERE destination_id IN (SELECT id FROM notification_destinations WHERE project_id = $1) OR event_id IN (SELECT id FROM outbound_events WHERE project_id = $1)`,
		`DELETE FROM outbound_events WHERE project_id = $1`,
		`DELETE FROM notification_destinations WHERE project_id = $1`,
		`DELETE FROM pr_outcomes WHERE project_id = $1`,
		`DELETE FROM error_group_jobs WHERE project_id = $1`,
		`DELETE FROM error_events WHERE project_id = $1`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id = $1)`,
		`DELETE FROM error_groups WHERE project_id = $1`,
		`DELETE FROM end_users WHERE project_id = $1`,
		`DELETE FROM sourcemap_batch_files WHERE project_id = $1`,
		`DELETE FROM sourcemap_files WHERE project_id = $1`,
		`DELETE FROM sourcemap_batches WHERE project_id = $1`,
		`DELETE FROM project_api_keys WHERE project_id = $1`,
		`DELETE FROM environments WHERE project_id = $1`,
	}
	for _, query := range queries {
		if _, err := tx.Exec(ctx, query, projectID); err != nil {
			return "", fmt.Errorf("delete project dependencies: %w", err)
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
	if err != nil {
		return "", fmt.Errorf("delete project row: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", fmt.Errorf("delete project: project not found")
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("delete project: commit: %w", err)
	}
	return "sourcemaps/v1/projects/" + projectID + "/", nil
}
