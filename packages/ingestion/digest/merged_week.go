package digest

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/opslane/opslane/packages/ingestion/notify"
	"time"
)

func mergedThisWeek(ctx context.Context, tx pgx.Tx, projectID string, at time.Time) ([]notify.DigestPRMerged, error) {
	rows, err := tx.Query(ctx, `SELECT title,pr_url,pr_number FROM (
 SELECT DISTINCT ON(g.id) g.id,g.title,coalesce(nullif(e.pr_url,''),a.pr_url,'') AS pr_url,coalesce(e.pr_number,a.pr_number,0) AS pr_number,e.occurred_at
 FROM friction_pr_events e JOIN friction_fix_attempts a ON a.id=e.fix_attempt_id
 JOIN error_groups g ON g.id=e.error_group_id AND g.ticket_id=e.ticket_id
 WHERE g.project_id=$1 AND e.event='merged' AND e.occurred_at>=$2::timestamptz-interval '7 days' AND e.occurred_at<=$2
 ORDER BY g.id,e.occurred_at DESC,e.id DESC
 ) tickets
 UNION ALL
 SELECT title,pr_url,pr_number FROM (
 SELECT DISTINCT ON(g.id) g.id,g.title,coalesce('https://github.com/'||coalesce(o.github_repo,p.github_repo)||'/pull/'||o.pr_number,CASE WHEN g.pr_number=o.pr_number THEN nullif(g.pr_url,'') END,'') AS pr_url,o.pr_number,o.occurred_at
 FROM pr_outcomes o JOIN error_groups g ON g.id=o.error_group_id AND g.project_id=o.project_id
 JOIN projects p ON p.id=g.project_id
 WHERE o.project_id=$1 AND g.kind='error' AND g.ticket_id IS NULL AND o.outcome='merged'
 AND o.occurred_at>=$2::timestamptz-interval '7 days' AND o.occurred_at<=$2
 ORDER BY g.id,o.occurred_at DESC,o.id DESC
 ) errors ORDER BY title,pr_url`, projectID, at)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []notify.DigestPRMerged{}
	for rows.Next() {
		var item notify.DigestPRMerged
		if err := rows.Scan(&item.Title, &item.PRURL, &item.PRNumber); err != nil {
			return nil, err
		}
		if item.PRURL != "" {
			result = append(result, item)
		}
	}
	return result, rows.Err()
}
