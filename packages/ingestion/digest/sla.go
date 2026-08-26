package digest

import (
	"context"
	"fmt"
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
}

// CheckDeliverySLA classifies delivery failures for one project. An empty
// projectID checks every project, which is useful for operator diagnostics.
func CheckDeliverySLA(ctx context.Context, pool *pgxpool.Pool, projectID string, now time.Time) (SLAReport, error) {
	if pool == nil {
		return SLAReport{}, fmt.Errorf("delivery SLA pool is not configured")
	}
	report := SLAReport{
		StuckRuns:              []SLAFinding{},
		FailedRuns:             []SLAFinding{},
		MissingRuns:            []SLAFinding{},
		OmittedActionable:      []SLAFinding{},
		ReconciliationFailures: []SLAFinding{},
	}

	rows, err := pool.Query(ctx, `SELECT project_id::text,id::text
		FROM digest_runs
		WHERE status NOT IN ('delivered','failed')
		  AND created_at < $2::timestamptz-interval '6 hours'
		  AND ($1='' OR project_id::text=$1)
		ORDER BY project_id,created_at,id`, projectID, now)
	if err != nil {
		return SLAReport{}, fmt.Errorf("delivery SLA stuck_runs query: %w", err)
	}
	for rows.Next() {
		var finding SLAFinding
		if err := rows.Scan(&finding.ProjectID, &finding.RunID); err != nil {
			rows.Close()
			return SLAReport{}, fmt.Errorf("delivery SLA stuck_runs scan: %w", err)
		}
		finding.Diagnostic = "stuck_runs"
		report.StuckRuns = append(report.StuckRuns, finding)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SLAReport{}, fmt.Errorf("delivery SLA stuck_runs rows: %w", err)
	}
	rows.Close()

	rows, err = pool.Query(ctx, `SELECT project_id::text,id::text
		FROM digest_runs
		WHERE status='failed'
		  AND created_at >= $2::timestamptz-interval '48 hours'
		  AND created_at <= $2
		  AND ($1='' OR project_id::text=$1)
		ORDER BY project_id,created_at,id`, projectID, now)
	if err != nil {
		return SLAReport{}, fmt.Errorf("delivery SLA failed_runs query: %w", err)
	}
	for rows.Next() {
		var finding SLAFinding
		if err := rows.Scan(&finding.ProjectID, &finding.RunID); err != nil {
			rows.Close()
			return SLAReport{}, fmt.Errorf("delivery SLA failed_runs scan: %w", err)
		}
		finding.Diagnostic = "failed_runs"
		report.FailedRuns = append(report.FailedRuns, finding)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SLAReport{}, fmt.Errorf("delivery SLA failed_runs rows: %w", err)
	}
	rows.Close()

	rows, err = pool.Query(ctx, `WITH latest AS (
		SELECT DISTINCT ON (project_id) id,project_id,window_to
		  FROM digest_runs
		 WHERE status='delivered' AND ($1='' OR project_id::text=$1)
		 ORDER BY project_id,window_to DESC,id DESC
	)
	SELECT latest.project_id::text,latest.id::text,g.id::text
	  FROM latest
	  JOIN error_groups g ON g.project_id=latest.project_id
	 WHERE g.status IN ('awaiting_approval','needs_human')
	   AND g.actionable_since < latest.window_to
	   AND (g.snoozed_until IS NULL OR g.snoozed_until <= $2)
	   AND NOT EXISTS (
	     SELECT 1 FROM digest_run_candidate_evaluations evaluation
	      WHERE evaluation.digest_run_id=latest.id AND evaluation.error_group_id=g.id
	   )
	 ORDER BY latest.project_id,g.id`, projectID, now)
	if err != nil {
		return SLAReport{}, fmt.Errorf("delivery SLA omitted_actionable query: %w", err)
	}
	for rows.Next() {
		var finding SLAFinding
		if err := rows.Scan(&finding.ProjectID, &finding.RunID, &finding.ErrorGroupID); err != nil {
			rows.Close()
			return SLAReport{}, fmt.Errorf("delivery SLA omitted_actionable scan: %w", err)
		}
		finding.Diagnostic = "omitted_actionable"
		report.OmittedActionable = append(report.OmittedActionable, finding)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SLAReport{}, fmt.Errorf("delivery SLA omitted_actionable rows: %w", err)
	}
	rows.Close()

	rows, err = pool.Query(ctx, `WITH latest AS (
		SELECT DISTINCT ON (project_id) id,project_id,rendered_payload
		  FROM digest_runs
		 WHERE status='delivered' AND ($1='' OR project_id::text=$1)
		 ORDER BY project_id,window_to DESC,id DESC
	), failures AS (
		SELECT project_id,id,NULL::uuid AS error_group_id,'stored_delivery_alert'::text AS diagnostic
		  FROM latest
		 WHERE NULLIF(btrim(rendered_payload->'digest'->>'delivery_alert'),'') IS NOT NULL
		UNION ALL
		SELECT latest.project_id,latest.id,evaluation.error_group_id,'unknown_reason_code:'||evaluation.primary_reason_code
		  FROM latest
		  JOIN digest_run_candidate_evaluations evaluation ON evaluation.digest_run_id=latest.id
		 WHERE evaluation.primary_reason_code NOT IN (
		   'included','snoozed','error_lane_ineligible','not_publishable','frozen_lane_owns','capped_overflow'
		 )
	)
	SELECT project_id::text,id::text,COALESCE(error_group_id::text,''),diagnostic
	  FROM failures ORDER BY project_id,id,error_group_id NULLS FIRST`, projectID)
	if err != nil {
		return SLAReport{}, fmt.Errorf("delivery SLA reconciliation_failures query: %w", err)
	}
	for rows.Next() {
		var finding SLAFinding
		if err := rows.Scan(&finding.ProjectID, &finding.RunID, &finding.ErrorGroupID, &finding.Diagnostic); err != nil {
			rows.Close()
			return SLAReport{}, fmt.Errorf("delivery SLA reconciliation_failures scan: %w", err)
		}
		report.ReconciliationFailures = append(report.ReconciliationFailures, finding)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SLAReport{}, fmt.Errorf("delivery SLA reconciliation_failures rows: %w", err)
	}
	rows.Close()

	type scheduled struct{ id, timezone string }
	rows, err = pool.Query(ctx, `SELECT p.id::text,p.digest_timezone
		FROM projects p
		WHERE ($1='' OR p.id::text=$1)
		  AND EXISTS (
		    SELECT 1 FROM notification_destinations destination
		     WHERE destination.project_id=p.id AND destination.enabled
		       AND 'digest.daily'=ANY(destination.event_types)
		  ) ORDER BY p.id`, projectID)
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
	for _, project := range projects {
		location, err := time.LoadLocation(project.timezone)
		if err != nil {
			// The scheduler already logs invalid project timezones. Do not let one
			// malformed setting hide every other project's delivery diagnostics.
			continue
		}
		local := now.In(location)
		expected := local
		if local.Hour() < sendHourLocal {
			expected = local.AddDate(0, 0, -1)
		}
		expectedDate := expected.Format("2006-01-02")
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
