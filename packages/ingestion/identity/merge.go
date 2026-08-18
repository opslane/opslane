package identity

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConfirmMerge is the only identity operation that moves observations. It
// redirects a confirmed duplicate into the winner and records the rewrite so
// the decision remains auditable.
func ConfirmMerge(ctx context.Context, pool *pgxpool.Pool, projectID, winnerID, loserID, confirmedBy, actor string) error {
	if winnerID == loserID {
		return errors.New("merge winner and loser must differ")
	}
	if confirmedBy != "model" && confirmedBy != "human" {
		return fmt.Errorf("unsupported merge confirmation %q", confirmedBy)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin confirmed merge: %w", err)
	}
	defer tx.Rollback(ctx)

	statuses, err := lockMergeIssues(ctx, tx, projectID, winnerID, loserID)
	if err != nil {
		return err
	}
	if statuses[winnerID] == "merged" {
		return errors.New("merge winner is already merged")
	}
	if statuses[loserID] == "merged" {
		var existingWinner string
		err := tx.QueryRow(ctx,
			`SELECT winner_id::text FROM issue_merges
			  WHERE project_id=$1 AND loser_id=$2`, projectID, loserID).Scan(&existingWinner)
		if err == nil && existingWinner == winnerID {
			return tx.Commit(ctx)
		}
		return errors.New("merge loser is already merged into another issue")
	}

	var blocked bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM error_group_jobs j
		   LEFT JOIN issue_episodes ep
		     ON ep.project_id=j.project_id AND ep.id=j.episode_id
		   WHERE j.project_id=$1 AND j.job_type='investigate'
		     AND (j.error_group_id IN ($2,$3) OR ep.canonical_issue_id IN ($2,$3)))
		 OR EXISTS (
		   SELECT 1 FROM issue_publications p
		   JOIN issue_episodes ep
		     ON ep.project_id=p.project_id AND ep.id=p.episode_id
		   WHERE p.project_id=$1 AND ep.canonical_issue_id IN ($2,$3))`,
		projectID, winnerID, loserID).Scan(&blocked); err != nil {
		return fmt.Errorf("check merge blockers: %w", err)
	}
	if blocked && confirmedBy != "human" {
		return errors.New("automatic merge refused: an issue was investigated or published")
	}

	winnerEpisodeID, err := OpenOrGetEpisode(ctx, tx, projectID, winnerID)
	if err != nil {
		return fmt.Errorf("open winner episode: %w", err)
	}
	aliasTag, err := tx.Exec(ctx,
		`UPDATE canonical_issue_fingerprints
		    SET canonical_issue_id=$1,confirmed_by=$3,bound_at=now()
		  WHERE project_id=$4 AND canonical_issue_id=$2`,
		winnerID, loserID, confirmedBy, projectID)
	if err != nil {
		return fmt.Errorf("redirect fingerprint aliases: %w", err)
	}
	aliasesMoved := int(aliasTag.RowsAffected())

	eventTag, err := tx.Exec(ctx,
		`UPDATE error_event_identities
		    SET canonical_issue_id=$1,episode_id=$4
		  WHERE project_id=$3 AND canonical_issue_id=$2`,
		winnerID, loserID, projectID, winnerEpisodeID)
	if err != nil {
		return fmt.Errorf("move settled observations: %w", err)
	}
	eventsMoved := int(eventTag.RowsAffected())

	if _, err := tx.Exec(ctx,
		`UPDATE error_events e SET error_group_id=$2
		   FROM error_event_identities i
		  WHERE i.project_id=e.project_id AND i.event_id=e.id
		    AND i.project_id=$1 AND i.canonical_issue_id=$2`,
		projectID, winnerID); err != nil {
		return fmt.Errorf("move observation handles: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups g SET
		   occurrence_count=sub.n,
		   first_seen=COALESCE(sub.first_seen,g.first_seen),
		   last_seen=COALESCE(sub.last_seen,g.last_seen),
		   updated_at=now()
		  FROM (
		    SELECT count(*)::integer AS n,min(e.timestamp) AS first_seen,max(e.timestamp) AS last_seen
		      FROM error_events e
		      JOIN error_event_identities i
		        ON i.project_id=e.project_id AND i.event_id=e.id
		     WHERE i.project_id=$1 AND i.canonical_issue_id=$2 AND i.status='settled'
		  ) sub
		 WHERE g.project_id=$1 AND g.id=$2`, projectID, winnerID); err != nil {
		return fmt.Errorf("rebuild issue counters: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM error_group_environments ege
		   USING error_groups g
		  WHERE ege.error_group_id=g.id AND g.project_id=$3 AND g.id IN ($1,$2)`,
		winnerID, loserID, projectID); err != nil {
		return fmt.Errorf("clear environment rollups for merge: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_environments
		   (error_group_id,environment_id,first_seen,last_seen,occurrence_count)
		 SELECT $2,e.environment_id,min(e.timestamp),max(e.timestamp),count(*)::bigint
		   FROM error_events e
		   JOIN error_event_identities i
		     ON i.project_id=e.project_id AND i.event_id=e.id
		  WHERE i.project_id=$1 AND i.canonical_issue_id=$2 AND i.status='settled'
		  GROUP BY e.environment_id`, projectID, winnerID); err != nil {
		return fmt.Errorf("rebuild environment rollups: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM error_group_affected_users u
		   USING error_groups g
		  WHERE u.error_group_id=g.id AND g.project_id=$3 AND g.id IN ($1,$2)`,
		winnerID, loserID, projectID); err != nil {
		return fmt.Errorf("clear affected users for merge: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO error_group_affected_users
		   (error_group_id,end_user_id,first_seen,last_seen,occurrence_count)
		 SELECT $2,e.end_user_id,min(e.timestamp),max(e.timestamp),count(*)::integer
		   FROM error_events e
		   JOIN error_event_identities i
		     ON i.project_id=e.project_id AND i.event_id=e.id
		  WHERE i.project_id=$1 AND i.canonical_issue_id=$2
		    AND i.status='settled' AND e.end_user_id IS NOT NULL
		  GROUP BY e.end_user_id`, projectID, winnerID); err != nil {
		return fmt.Errorf("rebuild affected users: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups g SET affected_users_count=(
		   SELECT count(*) FROM error_group_affected_users u WHERE u.error_group_id=g.id)
		 WHERE g.project_id=$1 AND g.id=$2`, projectID, winnerID); err != nil {
		return fmt.Errorf("rebuild affected user count: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE issue_episodes SET closed_at=COALESCE(closed_at,now())
		  WHERE project_id=$1 AND canonical_issue_id=$2`, projectID, loserID); err != nil {
		return fmt.Errorf("close loser episodes: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE error_groups SET status='merged',merged_at=now(),updated_at=now()
		  WHERE project_id=$1 AND id=$2`, projectID, loserID); err != nil {
		return fmt.Errorf("mark loser merged: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO issue_merges
		   (project_id,winner_id,loser_id,confirmed_by,actor,aliases_moved,events_moved)
		 VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7)`,
		projectID, winnerID, loserID, confirmedBy, actor, aliasesMoved, eventsMoved); err != nil {
		return fmt.Errorf("record issue merge: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE issue_alias_conflicts SET status='resolved'
		  WHERE project_id=$1 AND status='open'
		    AND left_issue_id IN ($2,$3) AND right_issue_id IN ($2,$3)`,
		projectID, winnerID, loserID); err != nil {
		return fmt.Errorf("resolve alias conflict: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit confirmed merge: %w", err)
	}
	return nil
}

func lockMergeIssues(ctx context.Context, tx pgx.Tx, projectID, winnerID, loserID string) (map[string]string, error) {
	issueIDs := []string{winnerID, loserID}
	sort.Strings(issueIDs)
	statuses := make(map[string]string, 2)
	for _, issueID := range issueIDs {
		var status string
		if err := tx.QueryRow(ctx,
			`SELECT status::text FROM error_groups
			  WHERE project_id=$1 AND id=$2 FOR UPDATE`, projectID, issueID).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, errors.New("merge issue not found in project")
			}
			return nil, fmt.Errorf("lock merge issue: %w", err)
		}
		statuses[issueID] = status
	}
	return statuses, nil
}
