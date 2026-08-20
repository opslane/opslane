package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

type actionScopeFixture struct {
	pool       *pgxpool.Pool
	queries    *db.Queries
	orgID      string
	projectID  string
	production string
	staging    string
}

func newActionScopeFixture(t *testing.T) actionScopeFixture {
	t.Helper()
	pool := testPool(t)
	queries := db.New(pool)
	orgID, projectID, production := seedNotificationProject(t, queries, "action-scope")
	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })
	staging, err := queries.CreateEnvironment(context.Background(), projectID, "staging")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.CreateNotificationDestination(
		context.Background(), orgID, projectID, destinationFixture(projectID, "Action scope"),
	); err != nil {
		t.Fatal(err)
	}
	return actionScopeFixture{
		pool: pool, queries: queries, orgID: orgID, projectID: projectID,
		production: production, staging: staging.ID,
	}
}

func (f actionScopeFixture) setScope(t *testing.T, environmentIDs *[]string) {
	t.Helper()
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := db.SetProjectActionScope(context.Background(), tx, f.orgID, f.projectID, environmentIDs); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (f actionScopeFixture) ingest(t *testing.T, fingerprint, environment, release string) *db.IngestResult {
	t.Helper()
	result, err := f.queries.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
		ProjectID:            f.projectID,
		DefaultEnvironmentID: f.production,
		EnvironmentLabel:     environment,
		ErrorType:            "TypeError",
		ErrorMessage:         "scope",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          fingerprint,
		Title:                "TypeError: scope",
		Release:              release,
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f actionScopeFixture) assertState(t *testing.T, groupID, status string, jobs, created int) {
	t.Helper()
	var gotStatus string
	var gotJobs, gotCreated int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM error_groups WHERE id = $1 AND project_id = $2`, groupID, f.projectID,
	).Scan(&gotStatus); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM error_group_jobs WHERE error_group_id = $1 AND project_id = $2`, groupID, f.projectID,
	).Scan(&gotJobs); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbound_events
		 WHERE project_id = $1 AND event_type = 'issue.created' AND dedup_key = $2`,
		f.projectID, "issue.created:"+groupID,
	).Scan(&gotCreated); err != nil {
		t.Fatal(err)
	}
	if gotStatus != status || gotJobs != jobs || gotCreated != created {
		t.Fatalf("state status/jobs/created = %s/%d/%d, want %s/%d/%d", gotStatus, gotJobs, gotCreated, status, jobs, created)
	}
}

func TestActionScopeGate(t *testing.T) {
	t.Run("unscoped project is unchanged", func(t *testing.T) {
		fixture := newActionScopeFixture(t)
		result := fixture.ingest(t, "unscoped", "staging", "")
		fixture.assertState(t, result.GroupID, "queued", 1, 1)
	})

	t.Run("out of scope groups stay dormant until an allowed event", func(t *testing.T) {
		fixture := newActionScopeFixture(t)
		allowed := []string{fixture.production}
		fixture.setScope(t, &allowed)
		first := fixture.ingest(t, "dormant", "staging", "")
		fixture.assertState(t, first.GroupID, "new", 0, 0)
		second := fixture.ingest(t, "dormant", "staging", "")
		fixture.assertState(t, second.GroupID, "new", 0, 0)
		activated := fixture.ingest(t, "dormant", "production", "")
		fixture.assertState(t, activated.GroupID, "queued", 1, 1)
		assertJobAnchor(t, fixture.pool, activated.JobID, activated.EventID)
	})

	t.Run("enabled empty scope fails closed", func(t *testing.T) {
		fixture := newActionScopeFixture(t)
		empty := []string{}
		fixture.setScope(t, &empty)
		result := fixture.ingest(t, "empty", "production", "")
		fixture.assertState(t, result.GroupID, "new", 0, 0)
	})

	t.Run("in scope older release does not requeue a resolved group", func(t *testing.T) {
		fixture := newActionScopeFixture(t)
		allowed := []string{fixture.production}
		fixture.setScope(t, &allowed)
		fixture.ingest(t, "release-order-seed", "production", "v1")
		resolved := fixture.ingest(t, "release-order-target", "production", "v2")
		if _, err := fixture.pool.Exec(context.Background(),
			`UPDATE error_groups
			 SET status = 'resolved', resolved_in_release = 'v2'
			 WHERE id = $1 AND project_id = $2`,
			resolved.GroupID, fixture.projectID,
		); err != nil {
			t.Fatal(err)
		}
		fixture.ingest(t, "release-order-target", "production", "v1")
		fixture.assertState(t, resolved.GroupID, "resolved", 1, 1)
	})

	for _, status := range []string{"resolved", "needs_human", "merged"} {
		status := status
		t.Run("out of scope cannot requeue "+status, func(t *testing.T) {
			fixture := newActionScopeFixture(t)
			allowed := []string{fixture.production}
			fixture.setScope(t, &allowed)
			first := fixture.ingest(t, "blocked-requeue-"+status, "production", "")
			if _, err := fixture.pool.Exec(context.Background(),
				`UPDATE error_groups SET status = $2::error_group_status WHERE id = $1 AND project_id = $3`,
				first.GroupID, status, fixture.projectID,
			); err != nil {
				t.Fatal(err)
			}
			fixture.ingest(t, "blocked-requeue-"+status, "staging", "")
			fixture.assertState(t, first.GroupID, status, 1, 1)
		})

		t.Run("in scope requeues "+status, func(t *testing.T) {
			fixture := newActionScopeFixture(t)
			allowed := []string{fixture.production}
			fixture.setScope(t, &allowed)
			first := fixture.ingest(t, "allowed-requeue-"+status, "production", "")
			if _, err := fixture.pool.Exec(context.Background(),
				`UPDATE error_groups SET status = $2::error_group_status WHERE id = $1 AND project_id = $3`,
				first.GroupID, status, fixture.projectID,
			); err != nil {
				t.Fatal(err)
			}
			second := fixture.ingest(t, "allowed-requeue-"+status, "production", "")
			fixture.assertState(t, first.GroupID, "queued", 2, 1)
			assertJobAnchor(t, fixture.pool, second.JobID, second.EventID)
		})
	}
}

func TestActionScopeTenantIsolation(t *testing.T) {
	fixture := newActionScopeFixture(t)
	otherOrg, err := fixture.queries.CreateOrg(context.Background(), "scope-intruder-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, fixture.pool, otherOrg.ID) })

	allowed := []string{fixture.production}
	fixture.setScope(t, &allowed)

	tx, err := fixture.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	intruderList := []string{fixture.staging}
	if err := db.SetProjectActionScope(context.Background(), tx, otherOrg.ID, fixture.projectID, &intruderList); !errors.Is(err, db.ErrProjectNotFound) {
		t.Fatalf("cross-org SetProjectActionScope = %v, want ErrProjectNotFound", err)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, _, err := fixture.queries.GetProjectActionScope(context.Background(), otherOrg.ID, fixture.projectID); !errors.Is(err, db.ErrProjectNotFound) {
		t.Fatalf("cross-org GetProjectActionScope = %v, want ErrProjectNotFound", err)
	}
	enabled, ids, err := fixture.queries.GetProjectActionScope(context.Background(), fixture.orgID, fixture.projectID)
	if err != nil || !enabled || len(ids) != 1 || ids[0] != fixture.production {
		t.Fatalf("stored scope changed by cross-org attempt: enabled=%v ids=%v err=%v", enabled, ids, err)
	}
}

func TestGuidedJobBypassesActionScope(t *testing.T) {
	fixture := newActionScopeFixture(t)
	result := fixture.ingest(t, "guided-bypass-"+uuid.NewString(), "production", "")
	if _, err := fixture.pool.Exec(context.Background(),
		`UPDATE error_groups SET status = 'investigated' WHERE id = $1 AND project_id = $2`,
		result.GroupID, fixture.projectID,
	); err != nil {
		t.Fatal(err)
	}
	seedEpisodeBackedInvestigation(t, fixture.pool, fixture.projectID, result.GroupID, result.EventID)
	empty := []string{}
	fixture.setScope(t, &empty)
	jobID, err := fixture.queries.TriggerFixJob(context.Background(), fixture.projectID, result.GroupID, "human guidance")
	if err != nil {
		t.Fatal(err)
	}
	assertJobAnchor(t, fixture.pool, jobID, result.EventID)
}
