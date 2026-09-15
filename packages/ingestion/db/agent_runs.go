package db

import (
	"context"
	"fmt"
	"time"
)

// AgentRunRetention is how long one project's agent run logs live.
type AgentRunRetention struct {
	ProjectID     string
	RetentionDays int
}

// AgentRunRetentions returns every project's run log retention, capped at the
// session hard cap.
func (q *Queries) AgentRunRetentions(ctx context.Context) ([]AgentRunRetention, error) {
	rows, err := q.pool.Query(ctx, `SELECT id::text, LEAST(session_retention_days, $1) FROM projects`, hardCapDays)
	if err != nil {
		return nil, fmt.Errorf("agent run retentions: %w", err)
	}
	defer rows.Close()
	var out []AgentRunRetention
	for rows.Next() {
		var r AgentRunRetention
		if err := rows.Scan(&r.ProjectID, &r.RetentionDays); err != nil {
			return nil, fmt.Errorf("scan agent run retention: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteAgentRunsRecordedBetween deletes run rows (finished rows cascade)
// recorded in [from, to).
func (q *Queries) DeleteAgentRunsRecordedBetween(ctx context.Context, projectID string, from, to time.Time) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM agent_run_started WHERE project_id = $1 AND recorded_at >= $2 AND recorded_at < $3`,
		projectID, from, to)
	if err != nil {
		return 0, fmt.Errorf("delete agent runs for day: %w", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteAgentRunsRecordedBefore removes rows whose day folder never existed
// (the bundle write failed), so rows cannot outlive retention either.
func (q *Queries) DeleteAgentRunsRecordedBefore(ctx context.Context, projectID string, cutoff time.Time) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM agent_run_started WHERE project_id = $1 AND recorded_at < $2`,
		projectID, cutoff)
	if err != nil {
		return 0, fmt.Errorf("delete agent runs before cutoff: %w", err)
	}
	return tag.RowsAffected(), nil
}
