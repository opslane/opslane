package db_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

const rawBitsDebugID = "158399f3-1dad-1386-35b2-98c34317d52e"

func seedSourceMapSchemaProject(t *testing.T) (*db.Queries, string, string) {
	t.Helper()
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "sourcemap-schema")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "sourcemap-schema", nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := q.CreateProjectKey(ctx, project.ID, db.ScopeSourcemaps, "schema", nil)
	if err != nil {
		t.Fatal(err)
	}
	var keyDBID string
	if err := pool.QueryRow(ctx,
		`SELECT id::text FROM project_api_keys WHERE key_id = $1`, key.KeyID,
	).Scan(&keyDBID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM sourcemap_files WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM sourcemap_batches WHERE project_id = $1`, project.ID)
	})
	return q, project.ID, keyDBID
}

func TestSourceMapFileIdentityImmutable(t *testing.T) {
	q, projectID, _ := seedSourceMapSchemaProject(t)
	ctx := context.Background()
	digest := bytes.Repeat([]byte{0x11}, 32)
	objectKey := "sourcemaps/v1/projects/" + projectID + "/maps/" + hex.EncodeToString(digest) + ".map"

	var id string
	if err := q.Pool().QueryRow(ctx, `
		INSERT INTO sourcemap_files
			(project_id, debug_id, content_sha256, size_bytes, object_key)
		VALUES ($1, $2, $3, 1, $4)
		RETURNING id::text
	`, projectID, rawBitsDebugID, digest, objectKey).Scan(&id); err != nil {
		t.Fatal(err)
	}

	_, err := q.Pool().Exec(ctx,
		`UPDATE sourcemap_files SET debug_id = $1 WHERE id = $2`,
		"01234567-89ab-cdef-0123-456789abcdef", id,
	)
	if err == nil || !strings.Contains(err.Error(), "identity is immutable") {
		t.Fatalf("identity update error = %v, want immutable trigger rejection", err)
	}
}

func TestDebugIDRawBitsRoundTripBothColumns(t *testing.T) {
	q, projectID, keyDBID := seedSourceMapSchemaProject(t)
	ctx := context.Background()
	digest := bytes.Repeat([]byte{0x22}, 32)
	objectKey := "sourcemaps/v1/projects/" + projectID + "/maps/" + hex.EncodeToString(digest) + ".map"

	var batchID string
	if err := q.Pool().QueryRow(ctx, `
		INSERT INTO sourcemap_batches
			(project_id, upload_key_db_id, idempotency_key, manifest_sha256,
			 expected_file_count, expected_bytes, expires_at)
		VALUES ($1, $2, gen_random_uuid(), $3, 1, 1, now() + interval '1 hour')
		RETURNING id::text
	`, projectID, keyDBID, digest).Scan(&batchID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Pool().Exec(ctx, `
		INSERT INTO sourcemap_batch_files
			(batch_id, project_id, debug_id, code_file, expected_size_bytes)
		VALUES ($1, $2, $3, 'assets/app.js', 1)
	`, batchID, projectID, rawBitsDebugID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Pool().Exec(ctx, `
		INSERT INTO sourcemap_files
			(project_id, debug_id, content_sha256, size_bytes, object_key)
		VALUES ($1, $2, $3, 1, $4)
	`, projectID, rawBitsDebugID, digest, objectKey); err != nil {
		t.Fatal(err)
	}

	var batchDebugID, fileDebugID string
	if err := q.Pool().QueryRow(ctx, `
		SELECT bf.debug_id::text, sf.debug_id::text
		FROM sourcemap_batch_files bf
		JOIN sourcemap_files sf
		  ON sf.project_id = bf.project_id AND sf.debug_id = bf.debug_id
		WHERE bf.batch_id = $1
	`, batchID).Scan(&batchDebugID, &fileDebugID); err != nil {
		t.Fatal(err)
	}
	if batchDebugID != rawBitsDebugID || fileDebugID != rawBitsDebugID {
		t.Fatalf("round trip = batch %q, file %q; want %q", batchDebugID, fileDebugID, rawBitsDebugID)
	}
}
