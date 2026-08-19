package filter

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ReplayIssue struct {
	EpisodeID string
	IssueID   string
	Title     string
	Decision  Decision
}

type DayReplay struct {
	Admit    int
	Watch    int
	Inactive int
	Admitted []ReplayIssue
	Watched  []ReplayIssue
}

// ReplayDay applies the current filter rule at a historical cutoff without
// appending decisions or creating jobs.
func ReplayDay(ctx context.Context, pool *pgxpool.Pool, projectID string, at time.Time) (DayReplay, error) {
	rows, err := pool.Query(ctx, `
		SELECT ep.id::text,ep.canonical_issue_id::text,g.title
		  FROM issue_episodes ep
		  JOIN error_groups g
		    ON g.project_id=ep.project_id AND g.id=ep.canonical_issue_id
		 WHERE ep.project_id=$1
		   AND EXISTS (
		     SELECT 1 FROM error_event_identities i
		     JOIN error_events e ON e.project_id=i.project_id AND e.id=i.event_id
		      WHERE i.project_id=ep.project_id AND i.episode_id=ep.id
		        AND e.created_at <= $2
		   )
		 ORDER BY ep.id`, projectID, at)
	if err != nil {
		return DayReplay{}, fmt.Errorf("list replay episodes: %w", err)
	}
	type replayRef struct {
		episodeID string
		issueID   string
		title     string
	}
	var episodes []replayRef
	for rows.Next() {
		var episode replayRef
		if err := rows.Scan(&episode.episodeID, &episode.issueID, &episode.title); err != nil {
			rows.Close()
			return DayReplay{}, fmt.Errorf("scan replay episode: %w", err)
		}
		episodes = append(episodes, episode)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return DayReplay{}, fmt.Errorf("read replay episodes: %w", err)
	}
	rows.Close()

	var replay DayReplay
	for _, episode := range episodes {
		decision, err := evaluateAt(ctx, pool, projectID, episode.episodeID, at)
		if err != nil {
			return DayReplay{}, fmt.Errorf("replay episode %s: %w", episode.episodeID, err)
		}
		issue := ReplayIssue{
			EpisodeID: episode.episodeID,
			IssueID:   episode.issueID,
			Title:     episode.title,
			Decision:  decision,
		}
		switch decision.Outcome {
		case "open_inquiry":
			replay.Admit++
			replay.Admitted = append(replay.Admitted, issue)
		case "inactive":
			replay.Inactive++
		default:
			replay.Watch++
			replay.Watched = append(replay.Watched, issue)
		}
	}
	return replay, nil
}
