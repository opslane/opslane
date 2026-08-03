package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestUpsertSourceMapFileIdempotentAndProjectScoped(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "source-map-files")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	first, err := q.ProvisionProject(ctx, org.ID, "source-map-a", nil, "source-map-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.ProvisionProject(ctx, org.ID, "source-map-b", nil, "source-map-b")
	if err != nil {
		t.Fatal(err)
	}

	f := db.SourceMapFile{
		ProjectID:         first.Project.ID,
		DebugID:           "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		ContentSHA256:     "1111111111111111111111111111111111111111111111111111111111111111",
		HasSourcesContent: true,
		SizeBytes:         10,
		ObjectKey:         "sourcemaps/a/map",
	}
	if _, inserted, err := q.UpsertSourceMapFile(ctx, f); err != nil || !inserted {
		t.Fatalf("first insert: inserted=%v err=%v", inserted, err)
	}
	stored, inserted, err := q.UpsertSourceMapFile(ctx, f)
	if err != nil || inserted {
		t.Fatalf("second insert: inserted=%v err=%v", inserted, err)
	}
	if stored.ContentSHA256 != f.ContentSHA256 {
		t.Fatalf("stored digest = %q, want %q", stored.ContentSHA256, f.ContentSHA256)
	}

	other := f
	other.ProjectID = second.Project.ID
	other.ObjectKey = "sourcemaps/b/map"
	if _, inserted, err := q.UpsertSourceMapFile(ctx, other); err != nil || !inserted {
		t.Fatalf("second project insert: inserted=%v err=%v", inserted, err)
	}
}
