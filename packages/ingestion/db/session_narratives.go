package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// SessionNarrativeRecord is the stored, already-scrubbed model result and its
// compact evidence map. JSON interpretation stays at the presentation edge.
type SessionNarrativeRecord struct {
	SessionID         string
	ProjectID         string
	Narrative         json.RawMessage
	Timeline          json.RawMessage
	VerificationState string
	Verification      json.RawMessage
	// VerificationReason explains a non-ok VerificationState. The 068 CHECK
	// forbids a `verification` payload on any state but 'ok', so the reason
	// lives in its own column (migration 069).
	VerificationReason        *string
	PromptVersion             int
	VerificationPromptVersion *int
}

func scanSessionNarrative(row pgx.Row) (*SessionNarrativeRecord, error) {
	var result SessionNarrativeRecord
	err := row.Scan(
		&result.SessionID, &result.ProjectID, &result.Narrative, &result.Timeline,
		&result.VerificationState, &result.Verification, &result.VerificationReason,
		&result.PromptVersion, &result.VerificationPromptVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// GetSessionNarrative returns only completed narratives and scopes through the
// sessions table so a stale or malformed narrative row cannot cross tenants.
func (q *Queries) GetSessionNarrative(ctx context.Context, projectID, sessionID string) (*SessionNarrativeRecord, error) {
	result, err := scanSessionNarrative(q.pool.QueryRow(ctx, `
		SELECT n.session_id, n.project_id::text, n.narrative, n.timeline,
		       n.verification_state, n.verification, n.verification_reason,
		       n.prompt_version, n.verification_prompt_version
		  FROM session_narratives n
		  JOIN sessions s ON s.id = n.session_id AND s.project_id = n.project_id
		 WHERE n.project_id = $1 AND n.session_id = $2 AND n.status = 'ok'
		   AND s.status <> 'deleting'`, projectID, sessionID))
	if err != nil {
		return nil, fmt.Errorf("get session narrative: %w", err)
	}
	return result, nil
}

// LatestNarrativeSessionForIncident resolves a narrative-born friction issue
// to its newest contributing session. Incident existence is project-scoped.
func (q *Queries) LatestNarrativeSessionForIncident(ctx context.Context, projectID, incidentID string) (*SessionNarrativeRecord, bool, error) {
	var exists bool
	if err := q.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM error_groups WHERE project_id=$1 AND id=$2)`,
		projectID, incidentID).Scan(&exists); err != nil {
		return nil, false, fmt.Errorf("resolve narrative incident: %w", err)
	}
	if !exists {
		return nil, false, nil
	}
	result, err := scanSessionNarrative(q.pool.QueryRow(ctx, `
		SELECT n.session_id, n.project_id::text, n.narrative, n.timeline,
		       n.verification_state, n.verification, n.verification_reason,
		       n.prompt_version, n.verification_prompt_version
		  FROM friction_signals fs
		  JOIN session_narratives n
		    ON n.session_id = fs.session_id AND n.project_id = fs.project_id
		  JOIN sessions s ON s.id = n.session_id AND s.project_id = n.project_id
		 WHERE fs.project_id = $1 AND fs.incident_id = $2
		   AND fs.observation_text IS NOT NULL AND n.status = 'ok'
		   AND s.status <> 'deleting'
		 ORDER BY fs.occurred_at DESC, fs.id DESC
		 LIMIT 1`, projectID, incidentID))
	if err != nil {
		return nil, true, fmt.Errorf("latest narrative session for incident: %w", err)
	}
	return result, true, nil
}
