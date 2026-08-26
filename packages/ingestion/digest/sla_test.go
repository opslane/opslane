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
				seedLedgerRow(t, pool, fixture, now, reasonIncluded)
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
		{
			name: "unknown ledger reason code",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "delivered", `{"digest":{}}`, now)
				seedLedgerRow(t, pool, fixture, now, "made_up_reason")
			},
			field: func(report SLAReport) []SLAFinding { return report.ReconciliationFailures },
		},
		{
			name: "snooze beyond the product cap",
			seed: func(t *testing.T, pool *pgxpool.Pool, fixture digestFixture) {
				insertSLARun(t, pool, fixture.ProjectID, now, "delivered", `{"digest":{}}`, now)
				var groupID string
				if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
					(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
					VALUES ($1,$2,$3,'over-snoozed','friction','awaiting_approval',$4,$4)
					RETURNING id::text`, fixture.ProjectID, fixture.EnvID, "sla-"+uuid.NewString(), now.Add(-48*time.Hour)).Scan(&groupID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `UPDATE error_groups
					SET snoozed_until=$2, actionable_since=$3 WHERE id=$1`,
					groupID, now.Add(90*24*time.Hour), now.Add(-24*time.Hour)); err != nil {
					t.Fatal(err)
				}
				// The over-cap snooze also hides the group from omitted_actionable;
				// a ledger row keeps that class quiet so this case isolates the new one.
				seedLedgerRow(t, pool, fixture, now, reasonIncluded)
			},
			field: func(report SLAReport) []SLAFinding { return report.LongSnoozes },
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


// seedLedgerRow attaches one candidate evaluation to the project's most recent
// run, proving the ledger lane was live for that run.
func seedLedgerRow(t *testing.T, pool *pgxpool.Pool, fixture digestFixture, now time.Time, reason string) {
	t.Helper()
	var runID string
	if err := pool.QueryRow(context.Background(), `SELECT id::text FROM digest_runs
		WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, fixture.ProjectID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	var groupID string
	if err := pool.QueryRow(context.Background(), `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
		VALUES ($1,$2,$3,'ledger anchor','friction','awaiting_approval',$4,$4)
		RETURNING id::text`, fixture.ProjectID, fixture.EnvID, "sla-"+uuid.NewString(), now).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	outcome := "included"
	if reason != reasonIncluded {
		outcome = "excluded"
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO digest_run_candidate_evaluations
		(digest_run_id,error_group_id,outcome,primary_reason_code) VALUES ($1,$2,$3,$4)`,
		runID, groupID, outcome, reason); err != nil {
		t.Fatal(err)
	}
}

// A run stuck longer than the lookback stops being re-reported: writer budgets
// are finite, and a permanently frozen run must not error-log every tick forever.
func TestCheckDeliverySLAStuckRunAgesOut(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	pool := testPool(t)
	fixture := seedSLAProject(t, pool, now, true)
	insertSLARun(t, pool, fixture.ProjectID, now, "written", "", now.Add(-72*time.Hour))
	insertSLARun(t, pool, fixture.ProjectID, now.Add(24*time.Hour), "delivered", `{"digest":{}}`, now)
	report, err := CheckDeliverySLA(context.Background(), pool, fixture.ProjectID, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.StuckRuns) != 0 {
		t.Fatalf("aged-out stuck run still reported: %+v", report.StuckRuns)
	}
}

// The all-projects mode is what the scheduler tick actually calls; the fixture
// must appear by membership (the shared database may hold other rows).
func TestCheckDeliverySLAAllProjectsMode(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	pool := testPool(t)
	fixture := seedSLAProject(t, pool, now, true)
	insertSLARun(t, pool, fixture.ProjectID, now, "failed", "", now.Add(-time.Hour))
	report, err := CheckDeliverySLA(context.Background(), pool, "", now)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, finding := range report.FailedRuns {
		if finding.ProjectID == fixture.ProjectID {
			found = true
		}
	}
	if !found {
		t.Fatalf("all-projects mode missed the fixture's failed run: %+v", report.FailedRuns)
	}
}

// One malformed digest_timezone must not hide other projects' diagnostics.
func TestCheckDeliverySLASkipsInvalidTimezoneOnly(t *testing.T) {
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	pool := testPool(t)
	valid := seedSLAProject(t, pool, now, true)
	broken := seedSLAProject(t, pool, now, true)
	if _, err := pool.Exec(context.Background(), `UPDATE projects SET digest_timezone='Not/AZone' WHERE id=$1`, broken.ProjectID); err != nil {
		t.Fatal(err)
	}
	report, err := CheckDeliverySLA(context.Background(), pool, "", now)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, finding := range report.MissingRuns {
		if finding.ProjectID == valid.ProjectID {
			found = true
		}
		if finding.ProjectID == broken.ProjectID {
			t.Fatalf("broken-timezone project produced a finding: %+v", finding)
		}
	}
	if !found {
		t.Fatal("valid project's missing_runs finding was not reported")
	}
}
