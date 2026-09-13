package db

import (
	"context"
	"fmt"
	"time"
)

// AgentStep is one agent-reported row of the approve-page checklist.
type AgentStep struct {
	SessionID string
	Step      string
	Status    string
	Note      string
	UpdatedAt time.Time
}

// AgentStepNames is the fixed checklist in display order and the source of
// truth for names accepted by the progress handler.
var AgentStepNames = []string{"install_sdk", "first_event", "github", "slack", "sourcemaps", "mcp", "pull_request"}

func (q *Queries) UpsertAgentStep(ctx context.Context, sessionID, step, status, note string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO agent_session_steps (session_id, step, status, note, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (session_id, step) DO UPDATE
		 SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`,
		sessionID, step, status, note)
	if err != nil {
		return fmt.Errorf("upsert agent step: %w", err)
	}
	return nil
}

func (q *Queries) ListAgentSteps(ctx context.Context, sessionID string) ([]AgentStep, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT session_id, step, status, note, updated_at
		 FROM agent_session_steps WHERE session_id = $1
		 ORDER BY array_position($2::text[], step)`,
		sessionID, AgentStepNames)
	if err != nil {
		return nil, fmt.Errorf("list agent steps: %w", err)
	}
	defer rows.Close()
	var out []AgentStep
	for rows.Next() {
		var s AgentStep
		if err := rows.Scan(&s.SessionID, &s.Step, &s.Status, &s.Note, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
