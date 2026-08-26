package digest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedSLAProject(t *testing.T, pool *pgxpool.Pool, now time.Time, withDestination bool) digestFixture {
	t.Helper()
	fixture := seedDigestFixture(t, pool, now)
	if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET status='resolved' WHERE project_id=$1`, fixture.ProjectID); err != nil {
		t.Fatal(err)
	}
	if withDestination {
		seedDestination(t, pool, fixture.ProjectID, []string{"digest.daily"})
	}
	return fixture
}

func insertSLARun(t *testing.T, pool *pgxpool.Pool, projectID string, now time.Time, status, renderedPayload string, createdAt time.Time) string {
	t.Helper()
	var runID string
	if err := pool.QueryRow(context.Background(), `INSERT INTO digest_runs
		(project_id,window_from,window_to,run_date,status,rendered_payload,created_at)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::jsonb,$7) RETURNING id::text`,
		projectID, now.Add(-24*time.Hour), now, now.Format("2006-01-02"), status, renderedPayload, createdAt).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	return runID
}

func TestCheckDeliverySLAReportsEachFailureClass(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name  string
		seed  func(*testing.T, *pgxpool.Pool, digestFixture)
		field func(SLAReport) []SLAFinding
	}{
		{
			name: "stuck run",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "written", "", now.Add(-7*time.Hour))
			},
			field: func(report SLAReport) []SLAFinding { return report.StuckRuns },
		},
		{
			name: "failed run",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "failed", "", now.Add(-time.Hour))
			},
			field: func(report SLAReport) []SLAFinding { return report.FailedRuns },
		},
		{
			name:  "missing expected run",
			seed:  func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {},
			field: func(report SLAReport) []SLAFinding { return report.MissingRuns },
		},
		{
			name: "actionable omitted from latest delivered run",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "delivered", `{"digest":{}}`, now)
				var groupID string
				if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
					(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
					VALUES ($1,$2,$3,'omitted friction','friction','awaiting_approval',$4,$4)
					RETURNING id::text`, fixture.ProjectID, fixture.EnvID, "sla-"+uuid.NewString(), now.Add(-48*time.Hour)).Scan(&groupID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `UPDATE error_groups SET actionable_since=$2 WHERE id=$1`, groupID, now.Add(-24*time.Hour)); err != nil {
					t.Fatal(err)
				}
			},
			field: func(report SLAReport) []SLAFinding { return report.OmittedActionable },
		},
		{
			name: "stored reconciliation alert",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "delivered", `{"digest":{"delivery_alert":"one item missing"}}`, now)
			},
			field: func(report SLAReport) []SLAFinding { return report.ReconciliationFailures },
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pool := testPool(t)
			fixture := seedSLAProject(t, pool, now, true)
			tc.seed(t, pool, fixture)
			report, err := CheckDeliverySLA(context.Background(), pool, fixture.ProjectID, now)
			if err != nil {
				t.Fatal(err)
			}
			if findings := tc.field(report); len(findings) != 1 || findings[0].ProjectID != fixture.ProjectID {
				t.Fatalf("findings=%+v report=%+v", findings, report)
			}
		})
	}
}

func TestCheckDeliverySLAHappyPath(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	pool := testPool(t)
	fixture := seedSLAProject(t, pool, now, true)
	insertSLARun(t, pool, fixture.ProjectID, now, "delivered", `{"digest":{}}`, now)
	report, err := CheckDeliverySLA(context.Background(), pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.StuckRuns) != 0 || len(report.FailedRuns) != 0 || len(report.MissingRuns) != 0 ||
		len(report.OmittedActionable) != 0 || len(report.ReconciliationFailures) != 0 {
		t.Fatalf("unexpected SLA findings: %+v", report)
	}
}
