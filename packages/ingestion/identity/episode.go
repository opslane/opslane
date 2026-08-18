package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// OpenOrGetEpisode returns the canonical issue's open work round, creating one
// when necessary. The partial unique index on open episodes closes the race
// between concurrent settlers.
func OpenOrGetEpisode(ctx context.Context, tx pgx.Tx, projectID, issueID string) (string, error) {
	var episodeID string
	err := tx.QueryRow(ctx,
		`INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		 SELECT $1,g.id,COALESCE(MAX(ep.sequence),0)+1
		   FROM error_groups g
		   LEFT JOIN issue_episodes ep
		     ON ep.project_id=g.project_id AND ep.canonical_issue_id=g.id
		  WHERE g.project_id=$1 AND g.id=$2
		  GROUP BY g.id
		 ON CONFLICT DO NOTHING
		 RETURNING id::text`, projectID, issueID).Scan(&episodeID)
	if err == nil {
		return episodeID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("open issue episode: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM issue_episodes
		  WHERE project_id=$1 AND canonical_issue_id=$2 AND closed_at IS NULL`,
		projectID, issueID).Scan(&episodeID); err != nil {
		return "", fmt.Errorf("read open issue episode: %w", err)
	}
	return episodeID, nil
}

func CloseEpisode(ctx context.Context, tx pgx.Tx, projectID, episodeID string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE issue_episodes SET closed_at=now()
		  WHERE project_id=$1 AND id=$2 AND closed_at IS NULL`, projectID, episodeID)
	if err != nil {
		return fmt.Errorf("close issue episode: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return errors.New("open issue episode not found")
	}
	return nil
}

// episodeForObservation chooses the work round that owns an attached
// observation. A genuinely later observation reopens a resolved issue; an
// observation captured before resolution but settled late remains in the
// episode that was resolved.
func episodeForObservation(ctx context.Context, tx pgx.Tx, projectID, issueID, eventID string) (string, error) {
	var status string
	var resolvedAt *time.Time
	var observedAt time.Time
	if err := tx.QueryRow(ctx,
		`SELECT g.status::text,g.resolved_at,e.timestamp
		   FROM error_groups g
		   JOIN error_events e ON e.project_id=g.project_id
		  WHERE g.project_id=$1 AND g.id=$2 AND e.id=$3`,
		projectID, issueID, eventID).Scan(&status, &resolvedAt, &observedAt); err != nil {
		return "", fmt.Errorf("read issue episode state: %w", err)
	}
	if status != "resolved" {
		return OpenOrGetEpisode(ctx, tx, projectID, issueID)
	}
	if resolvedAt != nil && !observedAt.After(*resolvedAt) {
		var episodeID string
		if err := tx.QueryRow(ctx,
			`SELECT id::text FROM issue_episodes
			  WHERE project_id=$1 AND canonical_issue_id=$2
			  ORDER BY sequence DESC LIMIT 1`, projectID, issueID).Scan(&episodeID); err != nil {
			return "", fmt.Errorf("read resolved issue episode: %w", err)
		}
		return episodeID, nil
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups
		    SET status='new',resolved_at=NULL,resolved_in_release=NULL,
		        resolved_reason=NULL,updated_at=now()
		  WHERE project_id=$1 AND id=$2`, projectID, issueID); err != nil {
		return "", fmt.Errorf("reopen resolved issue: %w", err)
	}
	return OpenOrGetEpisode(ctx, tx, projectID, issueID)
}
