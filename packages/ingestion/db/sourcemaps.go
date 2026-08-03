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
