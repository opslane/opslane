package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// SourceMapFile is one immutable, debug-ID-addressed source-map row.
type SourceMapFile struct {
	ProjectID         string
	DebugID           string
	ContentSHA256     string
	HasSourcesContent bool
	SizeBytes         int64
	ObjectKey         string
}

// UpsertSourceMapFile inserts f, or returns the existing row for the same
// project and debug ID. inserted=false distinguishes an idempotent retry or a
// lost race so the caller can compare the immutable content digest.
func (q *Queries) UpsertSourceMapFile(ctx context.Context, f SourceMapFile) (SourceMapFile, bool, error) {
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO sourcemap_files
		  (project_id, debug_id, content_sha256, has_sources_content, size_bytes, object_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (project_id, debug_id) DO NOTHING`,
		f.ProjectID, f.DebugID, f.ContentSHA256, f.HasSourcesContent, f.SizeBytes, f.ObjectKey,
	)
	if err != nil {
		return SourceMapFile{}, false, err
	}
	if tag.RowsAffected() == 1 {
		return f, true, nil
	}
	stored, found, err := q.GetSourceMapFile(ctx, f.ProjectID, f.DebugID)
	if err != nil {
		return SourceMapFile{}, false, err
	}
	if !found {
		return SourceMapFile{}, false, pgx.ErrNoRows
	}
	return stored, false, nil
}

// GetSourceMapFile reads one project-scoped row. found is false when absent.
func (q *Queries) GetSourceMapFile(ctx context.Context, projectID, debugID string) (SourceMapFile, bool, error) {
	var stored SourceMapFile
	err := q.pool.QueryRow(ctx, `
		SELECT project_id, debug_id, content_sha256, has_sources_content, size_bytes, object_key
		FROM sourcemap_files WHERE project_id = $1 AND debug_id = $2`,
		projectID, debugID,
	).Scan(&stored.ProjectID, &stored.DebugID, &stored.ContentSHA256,
		&stored.HasSourcesContent, &stored.SizeBytes, &stored.ObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceMapFile{}, false, nil
	}
	if err != nil {
		return SourceMapFile{}, false, err
	}
	return stored, true, nil
}

// WakePendingStackResolutions enqueues a fresh resolver job for observations
// that were parked before this debug ID's map arrived. A claimed job does not
// suppress the wake-up: it may already have observed the map as missing, and
// the extra idempotent resolution closes that race.
func (q *Queries) WakePendingStackResolutions(ctx context.Context, projectID, debugID string) (int64, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		projectID+"/"+debugID,
	); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO error_group_jobs (project_id, event_id, job_type, status)
		SELECT r.project_id, r.event_id, 'stack_resolve', 'pending'
		FROM error_event_resolutions r
		JOIN error_events e
		  ON e.project_id = r.project_id AND e.id = r.event_id
		WHERE r.project_id = $1
		  AND r.status = 'pending'
		  AND EXISTS (
		    SELECT 1
		    FROM jsonb_array_elements(COALESCE(e.debug_meta->'images', '[]'::jsonb)) image
		    WHERE image->>'debug_id' = $2
		  )
		  AND NOT EXISTS (
		    SELECT 1
		    FROM error_group_jobs pending
		    WHERE pending.project_id = r.project_id
		      AND pending.event_id = r.event_id
		      AND pending.job_type = 'stack_resolve'
		      AND pending.status = 'pending'
		  )`, projectID, debugID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
