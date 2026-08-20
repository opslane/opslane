package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type IssuePipelineRecord struct {
	IssueID          string
	EpisodeID        string
	FilterDecision   string
	FilterReason     string
	InquiryDecision  string
	InquiryReason    string
	DiagnosisOutcome string
	DiagnosisReason  string
	DecidedAt        *time.Time
	EvidenceEventIDs []string
}

// IssuePipelineRecords reads the latest append-only decision at every stage.
// Storage vocabulary stays inside this DB boundary; the handler maps it to
// customer-facing states.
func (q *Queries) IssuePipelineRecords(ctx context.Context, projectID string, issueIDs []string) (map[string]IssuePipelineRecord, error) {
	if len(issueIDs) == 0 {
		return map[string]IssuePipelineRecord{}, nil
	}
	rows, err := q.pool.Query(ctx, `
		SELECT issue.id::text,COALESCE(episode.id::text,''),
		       COALESCE(filter.decision,''),COALESCE(filter.reason,''),
		       COALESCE(inquiry.decision,''),COALESCE(inquiry.reason,''),
		       COALESCE(diagnosis.outcome,''),COALESCE(diagnosis.decision_reason,''),
		       GREATEST(filter.decided_at,inquiry.decided_at,diagnosis.decided_at),
		       COALESCE((SELECT array_agg(anchor.event_id::text ORDER BY anchor.anchor_kind)
		          FROM issue_evidence_anchors anchor
		         WHERE anchor.project_id=$1 AND anchor.episode_id=episode.id),'{}')
		  FROM unnest($2::uuid[]) issue(id)
		  LEFT JOIN LATERAL (
		    SELECT ep.id,ep.sequence FROM issue_episodes ep
		     WHERE ep.project_id=$1 AND ep.canonical_issue_id=issue.id
		     ORDER BY ep.sequence DESC LIMIT 1
		  ) episode ON true
		  LEFT JOIN LATERAL (
		    SELECT decision,reason,decided_at FROM issue_decisions d
		     WHERE d.project_id=$1 AND d.episode_id=episode.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) filter ON true
		  LEFT JOIN LATERAL (
		    SELECT decision,reason,decided_at FROM issue_inquiry_decisions d
		     WHERE d.project_id=$1 AND d.episode_id=episode.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) inquiry ON true
		  LEFT JOIN LATERAL (
		    SELECT outcome,decision_reason,decided_at FROM diagnosis_decisions d
		     WHERE d.project_id=$1 AND d.episode_id=episode.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) diagnosis ON true`, projectID, issueIDs)
	if err != nil {
		return nil, fmt.Errorf("load issue pipeline records: %w", err)
	}
	defer rows.Close()
	records := make(map[string]IssuePipelineRecord, len(issueIDs))
	for rows.Next() {
		var record IssuePipelineRecord
		if err := rows.Scan(
			&record.IssueID, &record.EpisodeID,
			&record.FilterDecision, &record.FilterReason,
			&record.InquiryDecision, &record.InquiryReason,
			&record.DiagnosisOutcome, &record.DiagnosisReason,
			&record.DecidedAt, &record.EvidenceEventIDs,
		); err != nil {
			return nil, fmt.Errorf("scan issue pipeline record: %w", err)
		}
		records[record.IssueID] = record
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read issue pipeline records: %w", err)
	}
	return records, nil
}

type PendingIdentity struct {
	EventID       string
	Fingerprint   string
	Title         string
	Platform      string
	EnvironmentID string
	ObservedAt    time.Time
}

// maxPendingIdentities bounds the synthetic rows the inbox renders for captures
// that have no issue yet. A settlement backlog is an operational problem, not a
// reason to grow every dashboard poll without limit.
const maxPendingIdentities = 50

// PendingIdentities returns one representative observation per capture bucket
// that has not reached an issue episode yet.
func (q *Queries) PendingIdentities(ctx context.Context, projectID string) ([]PendingIdentity, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT ON (identity.raw_fingerprint)
		       event.id::text,identity.raw_fingerprint,
		       event.error_type || CASE WHEN event.error_message='' THEN '' ELSE ': ' || event.error_message END,
		       COALESCE(event.platform,'javascript'),event.environment_id::text,event.timestamp
		  FROM error_event_identities identity
		  JOIN error_events event ON event.project_id=identity.project_id AND event.id=identity.event_id
		 WHERE identity.project_id=$1 AND identity.episode_id IS NULL
		   AND identity.status IN ('pending','settling','conflict')
		 ORDER BY identity.raw_fingerprint,event.timestamp DESC,event.id DESC
		 LIMIT $2`, projectID, maxPendingIdentities)
	if err != nil {
		return nil, fmt.Errorf("list pending identities: %w", err)
	}
	defer rows.Close()
	identities := make([]PendingIdentity, 0)
	for rows.Next() {
		var identity PendingIdentity
		if err := rows.Scan(&identity.EventID, &identity.Fingerprint, &identity.Title,
			&identity.Platform, &identity.EnvironmentID, &identity.ObservedAt); err != nil {
			return nil, fmt.Errorf("scan pending identity: %w", err)
		}
		identities = append(identities, identity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read pending identities: %w", err)
	}
	return identities, nil
}

// RequestIssueReview opens one new manually-triggered inquiry attempt for the
// current episode. Existing active work wins the race and is reused.
func (q *Queries) RequestIssueReview(ctx context.Context, projectID, issueID string) (string, error) {
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", fmt.Errorf("begin issue review: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var episodeID string
	if err := tx.QueryRow(ctx, `SELECT ep.id::text FROM issue_episodes ep
		WHERE ep.project_id=$1 AND ep.canonical_issue_id=$2 AND ep.closed_at IS NULL
		ORDER BY ep.sequence DESC LIMIT 1 FOR UPDATE`, projectID, issueID).Scan(&episodeID); err != nil {
		return "", fmt.Errorf("request issue review: %w", err)
	}
	var jobID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM error_group_jobs
		WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'
		  AND status IN ('pending','claimed') ORDER BY created_at,id LIMIT 1`,
		projectID, episodeID).Scan(&jobID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("find active issue review: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx, `INSERT INTO error_group_jobs
			(error_group_id,project_id,episode_id,job_type,status,input_version,triggered_by)
			SELECT $2,$1,$3,'issue_inquiry','pending',
			       COALESCE(max(input_version),0)+1,'human'
			  FROM error_group_jobs
			 WHERE project_id=$1 AND episode_id=$3 AND job_type='issue_inquiry'
			RETURNING id::text`, projectID, issueID, episodeID).Scan(&jobID); err != nil {
			return "", fmt.Errorf("insert issue review: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit issue review: %w", err)
	}
	return jobID, nil
}
