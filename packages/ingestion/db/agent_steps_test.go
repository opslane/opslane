package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// newPendingSession creates a pending session with the given project name and
// returns it with the raw poll token. Shared by the approve and steps tests.
func newPendingSession(t *testing.T, q *db.Queries, name string) (*db.AgentSession, string) {
	t.Helper()
	raw, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	s, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		ProjectName: &name, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { q.Pool().Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, s.ID) })
	return s, raw
}

func TestAgentSteps_UpsertListAndEnum(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	s, _ := newPendingSession(t, q, "steps")
	if err := q.UpsertAgentStep(ctx, s.ID, "install_sdk", "running", ""); err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "install_sdk", "done", "vite + vue"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "mcp", "skipped", "headless"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "pull_request", "done", "https://github.com/acme/web/pull/12"); err != nil {
		t.Fatal(err)
	}
	steps, err := q.ListAgentSteps(ctx, s.ID)
	if err != nil || len(steps) != 3 {
		t.Fatalf("list: %v %+v", err, steps)
	}
	if steps[0].Step != "install_sdk" || steps[0].Status != "done" || steps[0].Note != "vite + vue" || steps[1].Step != "mcp" || steps[2].Step != "pull_request" {
		t.Fatalf("upsert/order wrong: %+v", steps)
	}
	if err := q.UpsertAgentStep(ctx, s.ID, "mcp", "bogus", ""); err == nil {
		t.Fatal("expected CHECK violation for unknown status")
	}
}

func TestHasSourcemapUploads(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	var orgID, projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('sm-fact') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'sm-fact') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM sourcemap_files WHERE project_id = $1`, projectID)
		pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
		pool.Exec(ctx, `DELETE FROM orgs WHERE id = $1`, orgID)
	})
	if ok, err := q.HasSourcemapUploads(ctx, projectID); err != nil || ok {
		t.Fatalf("fresh project: %v %v", ok, err)
	}
	_, _, err := q.UpsertSourceMapFile(ctx, db.SourceMapFile{
		ProjectID: projectID, DebugID: "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f",
		ContentSHA256:     "0000000000000000000000000000000000000000000000000000000000000000",
		HasSourcesContent: true, SizeBytes: 12, ObjectKey: "sourcemaps/test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := q.HasSourcemapUploads(ctx, projectID); err != nil || !ok {
		t.Fatalf("after upload: %v %v", ok, err)
	}
}
