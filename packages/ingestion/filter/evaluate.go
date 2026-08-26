// Package filter applies the factual admission rule to settled issue episodes.
package filter

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	RuleVersion    = 1
	admitUnits     = 2
	livenessWindow = 7 * 24 * time.Hour
)

type Decision struct {
	Outcome string
	Reason  string
	Users7d int
	Anon7d  int
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type episodeFacts struct {
	users7d    int
	anon7d     int
	lastSeen   *time.Time
	hasInScope bool
}

// Evaluate answers one factual question: has this issue happened recently,
// inside the project's action scope, to enough distinct affected units to
// deserve an AI review? Product judgment belongs to the inquiry stage.
func Evaluate(ctx context.Context, pool *pgxpool.Pool, projectID, episodeID string) (Decision, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Decision{}, fmt.Errorf("begin filter evaluation: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	// Serializing on the episode makes the append-if-changed decision safe when
	// multiple ingestion replicas evaluate the same work round concurrently.
	var lockedID string
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM issue_episodes WHERE project_id=$1 AND id=$2 FOR UPDATE`,
		projectID, episodeID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Decision{}, fmt.Errorf("episode %s not found in project %s", episodeID, projectID)
		}
		return Decision{}, fmt.Errorf("lock filter episode: %w", err)
	}

	decision, err := evaluateAt(ctx, tx, projectID, episodeID, time.Now().UTC())
	if err != nil {
		return Decision{}, err
	}
	if err := appendIfChanged(ctx, tx, projectID, episodeID, decision); err != nil {
		return Decision{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Decision{}, fmt.Errorf("commit filter evaluation: %w", err)
	}
	return decision, nil
}

func evaluateAt(ctx context.Context, q queryRower, projectID, episodeID string, at time.Time) (Decision, error) {
	facts, err := loadEpisodeFacts(ctx, q, projectID, episodeID, at)
	if err != nil {
		return Decision{}, err
	}

	decision := Decision{Users7d: facts.users7d, Anon7d: facts.anon7d}
	units := facts.users7d + facts.anon7d
	switch {
	case !facts.hasInScope:
		decision.Outcome = "watch"
		decision.Reason = "no error events linked to this episode yet"
	case facts.lastSeen == nil || facts.lastSeen.Before(at.Add(-livenessWindow)):
		decision.Outcome = "inactive"
		if facts.lastSeen == nil {
			decision.Reason = "no in-scope occurrence recorded"
		} else {
			decision.Reason = fmt.Sprintf("no occurrence since %s", facts.lastSeen.UTC().Format(time.RFC3339))
		}
	case units >= admitUnits:
		decision.Outcome = "open_inquiry"
		decision.Reason = fmt.Sprintf("%d affected units in seven days", units)
	default:
		decision.Outcome = "watch"
		decision.Reason = fmt.Sprintf("%d affected unit in seven days, below %d", units, admitUnits)
	}
	return decision, nil
}

func loadEpisodeFacts(ctx context.Context, q queryRower, projectID, episodeID string, at time.Time) (episodeFacts, error) {
	var facts episodeFacts
	err := q.QueryRow(ctx, `
		WITH episode_events AS (
		  SELECT e.end_user_id, e.session_id, e.created_at,
		         (NOT p.action_scope_enabled OR pae.environment_id IS NOT NULL) AS in_scope
		    FROM error_event_identities i
		    JOIN error_events e
		      ON e.project_id=i.project_id AND e.id=i.event_id
		    JOIN projects p ON p.id=i.project_id
		    LEFT JOIN project_action_environments pae
		      ON pae.project_id=e.project_id AND pae.environment_id=e.environment_id
		   WHERE i.project_id=$1 AND i.episode_id=$2
		), recent AS (
		  SELECT end_user_id,session_id
		    FROM episode_events
		   WHERE in_scope
		     AND created_at > $3::timestamptz-interval '7 days'
		     AND created_at <= $3::timestamptz
		), anonymous_sessions AS (
		  SELECT session_id
		    FROM recent
		   WHERE session_id IS NOT NULL
		   GROUP BY session_id
		  HAVING bool_and(end_user_id IS NULL)
		)
		SELECT
		  (SELECT count(DISTINCT end_user_id) FROM recent WHERE end_user_id IS NOT NULL),
		  (SELECT count(*) FROM anonymous_sessions),
		  (SELECT max(created_at) FROM episode_events WHERE in_scope AND created_at <= $3::timestamptz),
		  EXISTS(SELECT 1 FROM episode_events WHERE in_scope AND created_at <= $3::timestamptz)`,
		projectID, episodeID, at).Scan(
		&facts.users7d, &facts.anon7d, &facts.lastSeen, &facts.hasInScope,
	)
	if err != nil {
		return episodeFacts{}, fmt.Errorf("count episode reach: %w", err)
	}
	return facts, nil
}

func appendIfChanged(ctx context.Context, tx pgx.Tx, projectID, episodeID string, decision Decision) error {
	var outcome, reason string
	var users7d, anon7d, ruleVersion int
	err := tx.QueryRow(ctx,
		`SELECT decision,reason,users_7d,anon_7d,rule_version
		   FROM issue_decisions
		  WHERE project_id=$1 AND episode_id=$2
		  ORDER BY decided_at DESC,id DESC LIMIT 1`,
		projectID, episodeID).Scan(&outcome, &reason, &users7d, &anon7d, &ruleVersion)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read latest filter decision: %w", err)
	}
	if err == nil && outcome == decision.Outcome && reason == decision.Reason &&
		users7d == decision.Users7d && anon7d == decision.Anon7d && ruleVersion == RuleVersion {
		return nil
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO issue_decisions
		   (project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		projectID, episodeID, decision.Outcome, decision.Reason,
		decision.Users7d, decision.Anon7d, RuleVersion); err != nil {
		return fmt.Errorf("append filter decision: %w", err)
	}
	return nil
}
