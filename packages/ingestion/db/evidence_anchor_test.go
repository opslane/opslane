package db_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type anchorFixture struct {
	pool          *pgxpool.Pool
	queries       *db.Queries
	projectID     string
	environmentID string
}

func newAnchorFixture(t *testing.T) anchorFixture {
	t.Helper()
	pool := testPool(t)
	queries := db.New(pool)
	org, err := queries.CreateOrg(context.Background(), "anchor-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := queries.CreateProject(context.Background(), org.ID, "anchor-project", nil)
	if err != nil {
		t.Fatal(err)
	}
	environment, err := queries.CreateEnvironment(context.Background(), project.ID, "production")
	if err != nil {
		t.Fatal(err)
	}
	return anchorFixture{pool: pool, queries: queries, projectID: project.ID, environmentID: environment.ID}
}

func (f anchorFixture) ingest(t *testing.T, fingerprint string) *db.IngestResult {
	t.Helper()
	result, err := f.queries.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID:            f.projectID,
		DefaultEnvironmentID: f.environmentID,
		ErrorType:            "TypeError",
		ErrorMessage:         "anchor",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: anchor",
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertJobAnchor(t *testing.T, pool *pgxpool.Pool, jobID, eventID string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(),
		`SELECT event_id FROM error_group_jobs WHERE id = $1`, jobID,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != eventID {
		t.Fatalf("job event_id = %s, want %s", got, eventID)
	}
}

func TestEnqueueStampsTriggeringEvent(t *testing.T) {
	fixture := newAnchorFixture(t)
	result := fixture.ingest(t, "anchor-new")
	assertJobAnchor(t, fixture.pool, result.JobID, result.EventID)
}

func TestRequeueStampsTriggeringEvent(t *testing.T) {
	fixture := newAnchorFixture(t)
	first := fixture.ingest(t, "anchor-requeue")
	if _, err := fixture.pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'resolved' WHERE id = $1 AND project_id = $2`,
		first.GroupID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	second := fixture.ingest(t, "anchor-requeue")
	if second.JobID == "" {
		t.Fatal("expected recurrence to enqueue")
	}
	assertJobAnchor(t, fixture.pool, second.JobID, second.EventID)
}

func TestAnchorSurvivesSampleOverwrite(t *testing.T) {
	fixture := newAnchorFixture(t)
	first := fixture.ingest(t, "anchor-immutable")
	second := fixture.ingest(t, "anchor-immutable")
	var jobEventID, sampleEventID string
	if err := fixture.pool.QueryRow(context.Background(),
		`SELECT j.event_id, g.sample_event_id
		 FROM error_group_jobs j JOIN error_groups g ON g.id = j.error_group_id
		 WHERE j.id = $1 AND j.project_id = $2`,
		first.JobID, fixture.projectID,
	).Scan(&jobEventID, &sampleEventID); err != nil {
		t.Fatal(err)
	}
	if jobEventID != first.EventID || sampleEventID != second.EventID {
		t.Fatalf("job/sample = %s/%s, want %s/%s", jobEventID, sampleEventID, first.EventID, second.EventID)
	}
}

func TestGuidedErrorJobInheritsInvestigationEpisode(t *testing.T) {
	fixture := newAnchorFixture(t)
	result := fixture.ingest(t, "anchor-guided")
	if _, err := fixture.pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'investigated' WHERE id = $1 AND project_id = $2`,
		result.GroupID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	episodeID, investigationJobID := seedEpisodeBackedInvestigation(
		t, fixture.pool, fixture.projectID, result.GroupID, result.EventID,
	)
	jobID, err := fixture.queries.TriggerFixJob(context.Background(), fixture.projectID, result.GroupID, "try this")
	if err != nil {
		t.Fatal(err)
	}
	assertJobAnchor(t, fixture.pool, jobID, result.EventID)
	var gotEpisodeID, gotSourceJobID string
	if err := fixture.pool.QueryRow(context.Background(),
		`SELECT episode_id::text,source_job_id::text FROM error_group_jobs WHERE id=$1`,
		jobID,
	).Scan(&gotEpisodeID, &gotSourceJobID); err != nil {
		t.Fatal(err)
	}
	if gotEpisodeID != episodeID || gotSourceJobID != investigationJobID {
		t.Fatalf("job episode/source = %s/%s, want %s/%s", gotEpisodeID, gotSourceJobID, episodeID, investigationJobID)
	}
}
