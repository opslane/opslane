package db

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
	"time"
)

// TicketDigestFacts is the current, finalized seven-day evidence projection.
// Signal membership is the exact intersection checked by the finalized attempt.
type TicketDigestFacts struct {
	LatestAttemptID                                             string
	TicketID                                                    string
	Generation, EvidenceVersion, LiveGeneration                 int
	FixSubstate, InvestigationStatus, GroupStatus, TicketStatus string
	Steps                                                       string
	VerifiedUsers, VerifiedSessions                             int
	Accounts, SignalIDs, ConfirmedNotes                         []string
	RepresentativeSessionID, RepresentativeNote                 string
	Coverage                                                    float64
}

func (f TicketDigestFacts) OnCard() bool {
	return f.TicketStatus == "published" && f.Generation == f.LiveGeneration && f.GroupStatus != "archived" && f.FixSubstate != "resolved" && f.InvestigationStatus == "done" && f.Coverage >= 0.5
}

type TicketEvidenceQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// LoadTicketDigestFacts is the SQL twin of worker verifiedEvidence. Keep the
// attempt membership, cohort cutoff and cost ordering aligned with that query.
func LoadTicketDigestFacts(ctx context.Context, q TicketEvidenceQuerier, projectID, groupID string, at time.Time) (*TicketDigestFacts, error) {
	var f TicketDigestFacts
	var explained []string
	err := q.QueryRow(ctx, `SELECT t.id,g.publication_generation,t.evidence_version,t.live_generation,
 g.fix_substate,g.investigation_status,g.status,t.status,coalesce(t.steps,''),
 ARRAY(SELECT jsonb_array_elements_text(coalesce(g.explained_signal_ids,'[]'))),coalesce((SELECT id::text FROM friction_fix_attempts WHERE ticket_id=t.id AND generation=g.publication_generation ORDER BY created_at DESC,id DESC LIMIT 1),'')
 FROM error_groups g JOIN friction_tickets t ON t.id=g.ticket_id AND t.project_id=g.project_id
 WHERE g.project_id=$1 AND g.id=$2`, projectID, groupID).Scan(&f.TicketID, &f.Generation, &f.EvidenceVersion, &f.LiveGeneration, &f.FixSubstate, &f.InvestigationStatus, &f.GroupStatus, &f.TicketStatus, &f.Steps, &explained, &f.LatestAttemptID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load ticket digest state: %w", err)
	}
	rows, err := q.Query(ctx, `SELECT m.session_id,coalesce(m.end_user_id::text,''),coalesce(u.account_name,''),
 coalesce(verified.signal_ids,'{}'),a.note
 FROM friction_tickets t JOIN friction_ticket_matches m ON m.ticket_id=t.id
 JOIN friction_checks c USING(ticket_id,session_id)
 JOIN friction_check_attempts a ON a.id=c.attempt_id AND a.ticket_id=t.id AND a.session_id=m.session_id
 JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized'
 LEFT JOIN end_users u ON u.id=m.end_user_id AND u.project_id=t.project_id
 CROSS JOIN LATERAL (
 SELECT array_agg(DISTINCT o.signal_id::text ORDER BY o.signal_id::text) AS signal_ids
 FROM friction_ticket_match_observations o JOIN friction_signals s ON s.id=o.signal_id
 WHERE o.ticket_id=t.id AND o.session_id=m.session_id AND a.signal_ids ? o.signal_id::text
 ) verified
 WHERE t.id=$1 AND t.project_id=$2 AND c.outcome='confirmed'
 AND (t.cohort_cutoff IS NULL OR m.occurred_at>t.cohort_cutoff)
 AND m.occurred_at >= $3::timestamptz-interval '7 days' AND m.occurred_at <= $3
 ORDER BY CASE a.cost_to_user WHEN 'none' THEN 0 WHEN 'annoyance' THEN 1 WHEN 'lost_time' THEN 2 WHEN 'abandoned_task' THEN 3 ELSE 0 END,m.arrival_number,m.session_id`, f.TicketID, projectID, at)
	if err != nil {
		return nil, fmt.Errorf("load verified ticket evidence: %w", err)
	}
	defer rows.Close()
	users, accounts, signals := map[string]bool{}, map[string]bool{}, map[string]bool{}
	sessions := []string{}
	for rows.Next() {
		var session, user, account, note string
		var ids []string
		if err := rows.Scan(&session, &user, &account, &ids, &note); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
		f.ConfirmedNotes = append(f.ConfirmedNotes, note)
		if user != "" {
			users[user] = true
		}
		if strings.TrimSpace(account) != "" {
			accounts[account] = true
		}
		for _, id := range ids {
			signals[id] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	f.VerifiedUsers = len(users)
	f.VerifiedSessions = len(sessions)
	for account := range accounts {
		f.Accounts = append(f.Accounts, account)
	}
	sort.Strings(f.Accounts)
	for id := range signals {
		f.SignalIDs = append(f.SignalIDs, id)
	}
	sort.Strings(f.SignalIDs)
	covered := 0
	explainedSet := make(map[string]bool, len(explained))
	for _, id := range explained {
		explainedSet[id] = true
	}
	for id := range signals {
		if explainedSet[id] {
			covered++
		}
	}
	if len(signals) > 0 {
		f.Coverage = float64(covered) / float64(len(signals))
	}
	if len(sessions) > 0 {
		median := (len(sessions) - 1) / 2
		f.RepresentativeSessionID = sessions[median]
		f.RepresentativeNote = f.ConfirmedNotes[median]
	}
	return &f, nil
}
