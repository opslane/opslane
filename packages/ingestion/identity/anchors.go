package identity

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// FreezeAnchors pins the observations an inquiry will read for one work round.
// Existing anchors never move: retries and concurrent dispatchers keep reading
// the same evidence even while newer observations arrive.
func FreezeAnchors(ctx context.Context, tx pgx.Tx, projectID, episodeID string) error {
	if _, err := tx.Exec(ctx, `
		WITH episode_events AS (
		  SELECT e.id,e.end_user_id,e.session_id,e.created_at,
		         (NOT p.action_scope_enabled OR pae.environment_id IS NOT NULL) AS in_scope
		    FROM error_event_identities i
		    JOIN error_events e
		      ON e.project_id=i.project_id AND e.id=i.event_id
		    JOIN projects p ON p.id=i.project_id
		    LEFT JOIN project_action_environments pae
		      ON pae.project_id=e.project_id AND pae.environment_id=e.environment_id
		   WHERE i.project_id=$1 AND i.episode_id=$2 AND i.status='settled'
		), recent_scoped AS (
		  SELECT * FROM episode_events
		   WHERE in_scope AND created_at > now()-interval '7 days'
		), unit_events AS (
		  SELECT e.id,e.created_at,
		         CASE
		           WHEN e.end_user_id IS NOT NULL THEN 'user:' || e.end_user_id::text
		           WHEN e.session_id IS NOT NULL AND NOT EXISTS (
		             SELECT 1 FROM recent_scoped known
		              WHERE known.session_id=e.session_id AND known.end_user_id IS NOT NULL
		           ) THEN 'session:' || e.session_id
		         END AS unit_key
		    FROM recent_scoped e
		), unit_firsts AS (
		  SELECT DISTINCT ON (unit_key) id,created_at,unit_key
		    FROM unit_events WHERE unit_key IS NOT NULL
		   ORDER BY unit_key,created_at,id
		), first_anchor AS (
		  SELECT id FROM episode_events ORDER BY created_at,id LIMIT 1
		), threshold_anchor AS (
		  SELECT id FROM unit_firsts ORDER BY created_at,id OFFSET 1 LIMIT 1
		), recent_anchor AS (
		  SELECT COALESCE(
		    (SELECT e.id FROM episode_events e
		      WHERE e.id<>(SELECT id FROM first_anchor)
		        AND e.id<>(SELECT id FROM threshold_anchor)
		      ORDER BY e.created_at DESC,e.id DESC LIMIT 1),
		    (SELECT e.id FROM episode_events e ORDER BY e.created_at DESC,e.id DESC LIMIT 1)
		  ) AS id
		), anchors(anchor_kind,event_id) AS (
		  VALUES
		    ('first',(SELECT id FROM first_anchor)),
		    ('threshold',(SELECT id FROM threshold_anchor)),
		    ('recent',(SELECT id FROM recent_anchor))
		)
		INSERT INTO issue_evidence_anchors (project_id,episode_id,anchor_kind,event_id)
		SELECT $1,$2,anchor_kind,event_id FROM anchors WHERE event_id IS NOT NULL
		ON CONFLICT (project_id,episode_id,anchor_kind) DO NOTHING`,
		projectID, episodeID); err != nil {
		return fmt.Errorf("freeze issue evidence anchors: %w", err)
	}

	var anchors int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM issue_evidence_anchors
		  WHERE project_id=$1 AND episode_id=$2`, projectID, episodeID).Scan(&anchors); err != nil {
		return fmt.Errorf("verify issue evidence anchors: %w", err)
	}
	if anchors != 3 {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM issue_episodes WHERE project_id=$1 AND id=$2)`,
			projectID, episodeID).Scan(&exists); err != nil {
			return fmt.Errorf("verify issue episode: %w", err)
		}
		if !exists {
			return fmt.Errorf("episode %s not found in project %s", episodeID, projectID)
		}
		return errors.New("cannot freeze evidence before the episode has two in-scope affected units")
	}
	return nil
}
