package digest

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SLAFinding identifies durable state that violated one delivery diagnostic.
// Diagnostics are structured logs only; no page or Slack alert is emitted
// until an operator separately configures routing and deduplication.
type SLAFinding struct {
	ProjectID    string
	RunID        string
	ErrorGroupID string
	Diagnostic   string
}

type SLAReport struct {
	StuckRuns              []SLAFinding
	FailedRuns             []SLAFinding
	MissingRuns            []SLAFinding
	OmittedActionable      []SLAFinding
	ReconciliationFailures []SLAFinding
	LongSnoozes            []SLAFinding
}

// slaLookback bounds every run-scoped diagnostic. Without a floor, a run that
// can never reach a terminal status (the writer budget is finite) or a project
// whose digests stopped would be re-logged every scheduler tick forever,
// burying fresh failures under stale ones.
const slaLookback = "48 hours"

// scheduledProjectSQL scopes a diagnostic to projects that can actually
// deliver a digest. Diagnosing projects with no enabled digest destination
// only produces findings nobody can act on.
const scheduledProjectSQL = `EXISTS (
	SELECT 1 FROM notification_destinations destination
	 WHERE destination.project_id=%s AND destination.enabled
	   AND 'digest.daily'=ANY(destination.event_types))`

// queryFindings runs one diagnostic query returning (project_id, run_id,
// error_group_id, diagnostic) columns and collects the rows. Queries with
// fewer columns select constant placeholders so every diagnostic shares one
// scan shape and one close-on-error path.
func queryFindings(ctx context.Context, pool *pgxpool.Pool, name, query string, args ...any) ([]SLAFinding, error) {
	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("delivery SLA %s query: %w", name, err)
	}
	defer rows.Close()
	findings := []SLAFinding{}
	for rows.Next() {
		var finding SLAFinding
		if err := rows.Scan(&finding.ProjectID, &finding.RunID, &finding.ErrorGroupID, &finding.Diagnostic); err != nil {
			return nil, fmt.Errorf("delivery SLA %s scan: %w", name, err)
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("delivery SLA %s rows: %w", name, err)
	}
	return findings, nil
}

// CheckDeliverySLA classifies delivery failures for one project. An empty
// projectID checks every project, which is what the scheduler tick does.
func CheckDeliverySLA(ctx context.Context, pool *pgxpool.Pool, projectID string, now time.Time) (SLAReport, error) {
	if pool == nil {
		return SLAReport{}, fmt.Errorf("delivery SLA pool is not configured")
	}
	report := SLAReport{}
	var err error

	// Class 1 — stuck: a run neither delivered nor failed 6h+ after creation.
	// The lookback floor matters: writer attempts are budgeted (maxWritesPerRun),
	// so a budget-exhausted run stays 'frozen' forever and would otherwise be
	// re-logged every tick for the rest of time.
	report.StuckRuns, err = queryFindings(ctx, pool, "stuck_runs", `
		SELECT project_id::text,id::text,'','stuck_runs'
		  FROM digest_runs
		 WHERE status NOT IN ('delivered','failed')
		   AND created_at < $2::timestamptz-interval '6 hours'
		   AND created_at >= $2::timestamptz-interval '`+slaLookback+`'
		   AND ($1='' OR project_id::text=$1)
		 ORDER BY project_id,created_at,id`, projectID, now)
	if err != nil {
		return SLAReport{}, err
	}

	// Class 2 — failed runs inside the lookback.
	report.FailedRuns, err = queryFindings(ctx, pool, "failed_runs", `
		SELECT project_id::text,id::text,'','failed_runs'
		  FROM digest_runs
		 WHERE status='failed'
		   AND created_at >= $2::timestamptz-interval '`+slaLookback+`'
		   AND created_at <= $2
		   AND ($1='' OR project_id::text=$1)
		 ORDER BY project_id,created_at,id`, projectID, now)
	if err != nil {
		return SLAReport{}, err
	}

	// Class 3 — delivered-but-omitted. Scoped three ways: the project must be
	// able to deliver at all, the latest delivered run must be recent, and that
	// run must carry at least one ledger row. The last guard keeps the deploy
	// day quiet: runs delivered before migration 062 predate the ledger, and
	// flagging the whole backfilled actionable backlog against them every tick
	// would bury the real omissions this diagnostic exists to catch.
	report.OmittedActionable, err = queryFindings(ctx, pool, "omitted_actionable", `
		WITH latest AS (
			SELECT DISTINCT ON (project_id) id,project_id,window_to
			  FROM digest_runs r
			 WHERE status='delivered' AND ($1='' OR project_id::text=$1)
			   AND created_at >= $2::timestamptz-interval '`+slaLookback+`'
			   AND `+fmt.Sprintf(scheduledProjectSQL, "r.project_id")+`
			 ORDER BY project_id,window_to DESC,id DESC
		)
		SELECT latest.project_id::text,latest.id::text,g.id::text,'omitted_actionable'
		  FROM latest
		  JOIN error_groups g ON g.project_id=latest.project_id
		 WHERE g.status IN `+actionableStatusSQL+`
		   AND g.actionable_since < latest.window_to
		   AND (g.snoozed_until IS NULL OR g.snoozed_until <= $2)
		   AND EXISTS (
		     SELECT 1 FROM digest_run_candidate_evaluations lane
		      WHERE lane.digest_run_id=latest.id
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM digest_run_candidate_evaluations evaluation
		      WHERE evaluation.digest_run_id=latest.id AND evaluation.error_group_id=g.id
		   )
		 ORDER BY latest.project_id,g.id`, projectID, now)
	if err != nil {
		return SLAReport{}, err
	}

	// Class 4 — reconciliation: a delivered run that had to publish a delivery
	// alert, or a ledger row carrying a reason outside knownReasonCodes.
	reasonList := "'" + strings.Join(knownReasonCodes, "','") + "'"
	report.ReconciliationFailures, err = queryFindings(ctx, pool, "reconciliation_failures", `
		WITH latest AS (
			SELECT DISTINCT ON (project_id) id,project_id,rendered_payload
			  FROM digest_runs r
			 WHERE status='delivered' AND ($1='' OR project_id::text=$1)
			   AND created_at >= $2::timestamptz-interval '`+slaLookback+`'
			   AND `+fmt.Sprintf(scheduledProjectSQL, "r.project_id")+`
			 ORDER BY project_id,window_to DESC,id DESC
		), failures AS (
			-- rendered_payload->'digest'->>'delivery_alert' follows the json tag
			-- on notify.DigestPayload.DeliveryAlert; renaming that field disables
			-- this arm, which its test pins.
			SELECT project_id,id,NULL::uuid AS error_group_id,'stored_delivery_alert'::text AS diagnostic
			  FROM latest
			 WHERE NULLIF(btrim(rendered_payload->'digest'->>'delivery_alert'),'') IS NOT NULL
			UNION ALL
			SELECT latest.project_id,latest.id,evaluation.error_group_id,'unknown_reason_code:'||evaluation.primary_reason_code
			  FROM latest
			  JOIN digest_run_candidate_evaluations evaluation ON evaluation.digest_run_id=latest.id
			 WHERE evaluation.primary_reason_code NOT IN (`+reasonList+`)
		)
		SELECT project_id::text,id::text,COALESCE(error_group_id::text,''),diagnostic
		  FROM failures ORDER BY project_id,id,error_group_id NULLS FIRST`, projectID, now)
	if err != nil {
		return SLAReport{}, err
	}

	// Class 5 — snoozes beyond the product cap. The 30-day limit lives only in
	// the snooze endpoint; a direct database write can exceed it and silently
	// suppress an incident from every digest AND from the omitted_actionable
	// diagnostic above. This is the tripwire for that channel.
	report.LongSnoozes, err = queryFindings(ctx, pool, "long_snoozes", `
		SELECT project_id::text,'',id::text,'long_snoozes'
		  FROM error_groups
		 WHERE status IN `+actionableStatusSQL+`
		   AND snoozed_until > $2::timestamptz + interval '31 days'
		   AND ($1='' OR project_id::text=$1)
		 ORDER BY project_id,id`, projectID, now)
	if err != nil {
		return SLAReport{}, err
	}

	// Class 6 — missing scheduled run for the expected local run date.
	type scheduled struct{ id, timezone string }
	rows, err := pool.Query(ctx, `SELECT p.id::text,p.digest_timezone
		FROM projects p
		WHERE ($1='' OR p.id::text=$1)
		  AND `+fmt.Sprintf(scheduledProjectSQL, "p.id")+`
		ORDER BY p.id`, projectID)
	if err != nil {
		return SLAReport{}, fmt.Errorf("delivery SLA missing_runs projects query: %w", err)
	}
	projects := make([]scheduled, 0)
	for rows.Next() {
		var project scheduled
		if err := rows.Scan(&project.id, &project.timezone); err != nil {
			rows.Close()
			return SLAReport{}, fmt.Errorf("delivery SLA missing_runs projects scan: %w", err)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SLAReport{}, fmt.Errorf("delivery SLA missing_runs projects rows: %w", err)
	}
	rows.Close()
	report.MissingRuns = []SLAFinding{}
	for _, project := range projects {
		location, err := time.LoadLocation(project.timezone)
		if err != nil {
			// The scheduler already logs invalid project timezones. Do not let one
			// malformed setting hide every other project's delivery diagnostics.
			continue
		}
		expectedDate := expectedRunDate(now, location)
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM digest_runs WHERE project_id=$1 AND run_date=$2::date
		)`, project.id, expectedDate).Scan(&exists); err != nil {
			return SLAReport{}, fmt.Errorf("delivery SLA missing_runs query: %w", err)
		}
		if !exists {
			report.MissingRuns = append(report.MissingRuns, SLAFinding{ProjectID: project.id, Diagnostic: "missing_runs:" + expectedDate})
		}
	}

	return report, nil
}

// expectedRunDate is the run_date a healthy scheduler should have created by
// now: today once the local send hour has passed, otherwise yesterday. It
// mirrors the boundary math in Scheduler.Tick, which computes the same
// send-hour cutoff as a timestamp rather than a date.
func expectedRunDate(now time.Time, location *time.Location) string {
	local := now.In(location)
	expected := local
	if local.Hour() < sendHourLocal {
		expected = local.AddDate(0, 0, -1)
	}
	return expected.Format("2006-01-02")
}
