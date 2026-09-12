package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// TicketIncidentState is the current admission state, derived from confirmed
// evidence rather than the investigation's historical coverage.
type TicketIncidentState struct {
	TicketID            string
	Generation          int
	FixSubstate         string
	InvestigationStatus string
	CauseCoverage       float64
	TicketStatus        string
	GroupStatus         string
	LiveGeneration      int
	Cause               string
	Brief               string
	SourceJobID         *string
	Diagnosis           json.RawMessage
}

type ticketQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func ticketIncidentState(ctx context.Context, q ticketQuerier, projectID, groupID string) (*TicketIncidentState, error) {
	var s TicketIncidentState
	err := q.QueryRow(ctx, `SELECT t.id,g.publication_generation,g.fix_substate,g.investigation_status,
		coverage.value,t.status,g.status,t.live_generation,coalesce(nullif(btrim(g.root_cause),''),''),coalesce(d.brief,''),d.job_id,d.diagnosis
		FROM error_groups g JOIN friction_tickets t ON t.id=g.ticket_id AND t.project_id=g.project_id
		LEFT JOIN LATERAL (
		 SELECT NULLIF(btrim(diagnosis->>'agentTaskBrief'),'') AS brief,job_id,diagnosis FROM diagnosis_decisions
		 WHERE error_group_id=g.id AND project_id=g.project_id AND outcome IN ('code_fix','not_actionable')
		 ORDER BY decided_at DESC,id DESC LIMIT 1
		) d ON true
		CROSS JOIN LATERAL (
		 SELECT CASE WHEN count(*)=0 THEN 0::float8
		 ELSE count(*) FILTER (WHERE coalesce(g.explained_signal_ids,'[]'::jsonb) ? verified.id::text)::float8/count(*) END AS value
		 FROM (
		  SELECT DISTINCT f.id FROM friction_checks c
		  JOIN friction_check_attempts a ON a.id=c.attempt_id AND a.ticket_id=c.ticket_id AND a.session_id=c.session_id
		  JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized'
		  JOIN friction_ticket_matches m ON m.ticket_id=c.ticket_id AND m.session_id=c.session_id
		  JOIN friction_ticket_match_observations o ON o.ticket_id=m.ticket_id AND o.session_id=m.session_id
		  JOIN friction_signals f ON f.id=o.signal_id AND f.session_id=m.session_id AND f.project_id=g.project_id AND f.environment_id=t.environment_id
		  WHERE c.ticket_id=t.id AND c.outcome='confirmed' AND a.signal_ids ? f.id::text
		    AND m.project_id=g.project_id AND m.environment_id=t.environment_id
		    AND m.occurred_at>=now()-interval '7 days' AND m.occurred_at<=now()
		    AND (t.cohort_cutoff IS NULL OR m.occurred_at>t.cohort_cutoff)
		 ) verified
		) coverage
		WHERE g.id=$1 AND g.project_id=$2`, groupID, projectID).Scan(&s.TicketID, &s.Generation, &s.FixSubstate, &s.InvestigationStatus,
		&s.CauseCoverage, &s.TicketStatus, &s.GroupStatus, &s.LiveGeneration, &s.Cause, &s.Brief, &s.SourceJobID, &s.Diagnosis)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read ticket incident state: %w", err)
	}
	return &s, nil
}

func (q *Queries) GetTicketIncidentState(ctx context.Context, projectID, groupID string) (*TicketIncidentState, error) {
	return ticketIncidentState(ctx, q.pool, projectID, groupID)
}

func lockTicketIncident(ctx context.Context, tx pgx.Tx, projectID, groupID string) (*TicketIncidentState, error) {
	var id string
	if err := tx.QueryRow(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, projectID).Scan(&id); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotInvestigated
		}
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT t.id FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id
		WHERE g.id=$1 AND g.project_id=$2 AND t.project_id=$2 FOR UPDATE OF t`, groupID, projectID).Scan(&id); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotInvestigated
		}
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM error_groups WHERE id=$1 AND project_id=$2 FOR UPDATE`, groupID, projectID).Scan(&id); err != nil {
		return nil, err
	}
	s, err := ticketIncidentState(ctx, tx, projectID, groupID)
	if err != nil {
		return nil, err
	}
	if s == nil || s.TicketStatus != "published" || s.GroupStatus == "archived" || s.Generation != s.LiveGeneration || s.FixSubstate == "resolved" {
		return nil, ErrNotInvestigated
	}
	return s, nil
}

func enqueueTicketInvestigation(ctx context.Context, tx pgx.Tx, projectID, groupID string, s *TicketIncidentState) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM error_group_jobs WHERE error_group_id=$1 AND project_id=$2
		AND job_type='investigate' AND status IN ('pending','claimed') ORDER BY created_at,id LIMIT 1`, groupID, projectID).Scan(&id)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `INSERT INTO error_group_jobs(error_group_id,project_id,job_type,ticket_id,publication_generation,source_id,triggered_by)
			VALUES($1,$2,'investigate',$3,$4,$1,'human') RETURNING id`, groupID, projectID, s.TicketID, s.Generation).Scan(&id)
	}
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE error_groups SET investigation_status='pending',updated_at=now() WHERE id=$1 AND project_id=$2`, groupID, projectID)
	return id, err
}

// ReinvestigateTicket preserves the fix workflow while requesting a new cause.
func (q *Queries) ReinvestigateTicket(ctx context.Context, projectID, groupID string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	s, err := lockTicketIncident(ctx, tx, projectID, groupID)
	if err != nil {
		return "", err
	}
	id, err := enqueueTicketInvestigation(ctx, tx, projectID, groupID, s)
	if err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func (q *Queries) requestTicketFix(ctx context.Context, projectID, groupID, guidance string) (string, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	s, err := lockTicketIncident(ctx, tx, projectID, groupID)
	if err != nil {
		return "", err
	}
	var outstanding bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM friction_fix_attempts WHERE ticket_id=$1 AND generation=$2 AND status IN ('active','pr_open'))
		OR EXISTS(SELECT 1 FROM error_group_jobs WHERE error_group_id=$3 AND project_id=$4 AND job_type='fix' AND status IN ('pending','claimed'))`, s.TicketID, s.Generation, groupID, projectID).Scan(&outstanding); err != nil {
		return "", err
	}
	if outstanding {
		return "", ErrNotInvestigated
	}
	if s.InvestigationStatus != "done" || s.CauseCoverage < 0.5 || s.Cause == "" || s.Brief == "" {
		if _, err = enqueueTicketInvestigation(ctx, tx, projectID, groupID, s); err != nil {
			return "", err
		}
		if err = tx.Commit(ctx); err != nil {
			return "", err
		}
		return "", ErrNotInvestigated
	}
	var attempt, job string
	err = tx.QueryRow(ctx, `INSERT INTO friction_fix_attempts(ticket_id,error_group_id,generation,status,requested_by)
		VALUES($1,$2,$3,'active','human') RETURNING id`, s.TicketID, groupID, s.Generation).Scan(&attempt)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"diagnosis": s.Diagnosis})
	if err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `INSERT INTO error_group_jobs(error_group_id,project_id,job_type,ticket_id,publication_generation,fix_attempt_id,source_id,source_job_id,guidance,triggered_by,platform,payload)
		VALUES($1,$2,'fix',$3,$4,$5,$1,$6,$7,'human',(SELECT platform FROM error_groups WHERE id=$1),$8) RETURNING id`, groupID, projectID, s.TicketID, s.Generation, attempt, s.SourceJobID, nilIfEmpty(guidance), payload).Scan(&job)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE error_groups SET status='fixing',fix_substate='fixing',terminal_fix_job_id=NULL,updated_at=now() WHERE id=$1 AND project_id=$2`, groupID, projectID)
	if err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return job, nil
}

type TicketPRWebhook struct {
	Repository string
	Number     int
	Event      string
	DeliveryID string
	URL        string
	OccurredAt time.Time
}

// ProcessTicketPRWebhook records the event and queues its fenced application.
// Attempt identity survives archived generations and later fix attempts.
func (q *Queries) ProcessTicketPRWebhook(ctx context.Context, event TicketPRWebhook) (PRWebhookResult, error) {
	if event.Event != "opened" && event.Event != "closed" && event.Event != "merged" {
		return PRWebhookResult{}, fmt.Errorf("invalid ticket PR event")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return PRWebhookResult{}, err
	}
	defer tx.Rollback(ctx)
	var result PRWebhookResult
	err = tx.QueryRow(ctx, `SELECT error_group_id FROM friction_pr_events WHERE delivery_id=$1 AND github_repo=$2 AND pr_number=$3`, event.DeliveryID, event.Repository, event.Number).Scan(&result.GroupID)
	if err == nil {
		result.Duplicate = true
		return result, nil
	}
	if err != pgx.ErrNoRows {
		return result, err
	}
	var attempt, ticket, project, prURL string
	var generation int
	err = tx.QueryRow(ctx, `SELECT a.id,a.ticket_id,a.error_group_id,a.generation,g.project_id,coalesce(a.pr_url,'')
		FROM friction_fix_attempts a JOIN error_groups g ON g.id=a.error_group_id
		WHERE a.github_repo=$1 AND a.pr_number=$2 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF a`, event.Repository, event.Number).
		Scan(&attempt, &ticket, &result.GroupID, &generation, &project, &prURL)
	if err == pgx.ErrNoRows {
		return PRWebhookResult{}, nil
	}
	if err != nil {
		return result, err
	}
	if event.URL != "" {
		prURL = event.URL
	}
	var fact string
	err = tx.QueryRow(ctx, `INSERT INTO friction_pr_events(ticket_id,error_group_id,fix_attempt_id,generation,event,delivery_id,pr_url,pr_number,github_repo,occurred_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(delivery_id) DO NOTHING RETURNING id`, ticket, result.GroupID, attempt, generation, event.Event, event.DeliveryID, prURL, event.Number, event.Repository, event.OccurredAt).Scan(&fact)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `SELECT error_group_id FROM friction_pr_events WHERE delivery_id=$1 AND github_repo=$2 AND pr_number=$3`, event.DeliveryID, event.Repository, event.Number).Scan(&result.GroupID)
		result.Duplicate = true
		return result, err
	}
	if err != nil {
		return result, err
	}
	payload, err := json.Marshal(map[string]string{"eventId": fact})
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO error_group_jobs(error_group_id,project_id,job_type,ticket_id,publication_generation,fix_attempt_id,source_id,payload)
		VALUES($1,$2,'friction_pr_event',$3,$4,$5,$6,$7)`, result.GroupID, project, ticket, generation, attempt, fact, payload)
	if err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}
