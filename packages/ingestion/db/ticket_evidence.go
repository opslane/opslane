package db

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math"
	"regexp"
	"sort"
	"strconv"
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
	// RepresentativeAttemptID is the representative session's finalized check
	// attempt; RepresentativeSignalMs is that check's earliest verified signal
	// time (0 when it verified none).
	RepresentativeAttemptID string
	RepresentativeSignalMs  int64
	// RepresentativeAnchorMs is the absolute client-clock time the replay link
	// seeks to. Only LoadTicketReplayAnchor sets it.
	RepresentativeAnchorMs int64
	Coverage               float64
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
	rows, err := q.Query(ctx, `SELECT a.id::text,m.session_id,coalesce(m.end_user_id::text,''),coalesce(u.account_name,''),
 coalesce(verified.signal_ids,'{}'),a.note,coalesce(verified.first_ms,0)
 FROM friction_tickets t JOIN friction_ticket_matches m ON m.ticket_id=t.id
 JOIN friction_checks c USING(ticket_id,session_id)
 JOIN friction_check_attempts a ON a.id=c.attempt_id AND a.ticket_id=t.id AND a.session_id=m.session_id
 JOIN friction_confirm_batches b ON b.id=a.batch_id AND b.status='finalized'
 LEFT JOIN end_users u ON u.id=m.end_user_id AND u.project_id=t.project_id
 CROSS JOIN LATERAL (
 SELECT array_agg(DISTINCT o.signal_id::text ORDER BY o.signal_id::text) AS signal_ids,
 (extract(epoch FROM min(s.occurred_at))*1000)::bigint AS first_ms
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
	attempts := []string{}
	firstSignalMs := []int64{}
	for rows.Next() {
		var attempt, session, user, account, note string
		var ids []string
		var first int64
		if err := rows.Scan(&attempt, &session, &user, &account, &ids, &note, &first); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
		attempts = append(attempts, attempt)
		firstSignalMs = append(firstSignalMs, first)
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
		f.RepresentativeAttemptID = attempts[median]
		f.RepresentativeSignalMs = firstSignalMs[median]
	}
	return &f, nil
}

// LoadTicketReplayAnchor sets f.RepresentativeAnchorMs: the earliest timeline
// line the representative session's finalized check cited, else its earliest
// verified signal, else 0. Only digest links use it, so it is separate from
// LoadTicketDigestFacts. The link is decoration: an attempt purged since the
// facts were read, or malformed citations, fall back instead of failing.
// The timeline is the one the check read: a narrative reaches status ok once
// and its timeline is never rewritten.
func LoadTicketReplayAnchor(ctx context.Context, q TicketEvidenceQuerier, projectID string, f *TicketDigestFacts) error {
	if f == nil || f.RepresentativeAttemptID == "" {
		return nil
	}
	f.RepresentativeAnchorMs = f.RepresentativeSignalMs
	var evidenceLines []string
	var timeline []byte
	err := q.QueryRow(ctx, `SELECT ARRAY(SELECT e FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.evidence_lines)='array' THEN a.evidence_lines ELSE '[]' END) e WHERE e IS NOT NULL),n.timeline
 FROM friction_check_attempts a
 JOIN friction_tickets t ON t.id=a.ticket_id AND t.project_id=$2
 LEFT JOIN session_narratives n ON n.session_id=a.session_id AND n.project_id=t.project_id AND n.status='ok'
 WHERE a.id=$1`, f.RepresentativeAttemptID, projectID).Scan(&evidenceLines, &timeline)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load ticket replay anchor: %w", err)
	}
	if anchor, ok := timelineAnchorMs(evidenceLines, timeline); ok {
		f.RepresentativeAnchorMs = anchor
	}
	return nil
}

var evidenceLineID = regexp.MustCompile(`^L(\d+)$`)

// timelineAnchorMs resolves a confirmed check's cited timeline line IDs to the
// absolute client-clock time of the earliest one. It is the Go twin of the
// citation resolution in worker friction/confirm-job.ts loadRecording: keep the
// 1-based L<n> IDs and the idle and untimed line skipping aligned.
func timelineAnchorMs(evidenceLines []string, timeline []byte) (int64, bool) {
	if len(timeline) == 0 {
		return 0, false
	}
	var parsed struct {
		StartTs *float64 `json:"startTs"`
		Lines   []struct {
			A *float64 `json:"a"`
			K string   `json:"k"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(timeline, &parsed); err != nil || !validEpochMs(parsed.StartTs) {
		return 0, false
	}
	start := int64(math.Round(*parsed.StartTs))
	var best int64
	found := false
	for _, id := range evidenceLines {
		match := evidenceLineID.FindStringSubmatch(id)
		if match == nil {
			continue
		}
		n, err := strconv.Atoi(match[1])
		if err != nil || n < 1 || n > len(parsed.Lines) {
			continue
		}
		line := parsed.Lines[n-1]
		if line.K == "idle" || !validEpochMs(line.A) {
			continue
		}
		ms := int64(math.Round(*line.A))
		if !found || ms < best {
			best, found = ms, true
		}
	}
	if found && best < start {
		best = start
	}
	return best, found
}

// validEpochMs accepts a positive millisecond timestamp that converts to int64
// exactly; JSON numbers outside that range are malformed timeline data.
func validEpochMs(value *float64) bool {
	return value != nil && *value > 0 && *value <= 1<<53
}
