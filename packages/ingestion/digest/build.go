package digest

import (
	"context"
	"fmt"
	"time"

	"github.com/opslane/opslane/packages/ingestion/notify"
)

type accountSummary struct {
	names []string
	more  int
}

func (s *Sweeper) Build(ctx context.Context, projectID string, now time.Time) (notify.EventPayload, error) {
	var projectName, timezone string
	if err := s.pool.QueryRow(ctx,
		`SELECT name, digest_timezone FROM projects WHERE id = $1`, projectID,
	).Scan(&projectName, &timezone); err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest project: %w", err)
	}
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest timezone %q: %w", timezone, err)
	}
	from, to := digestWindow(now)

	insights, insightsMore, err := s.buildInsights(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}
	issues, issuesMore, err := s.buildTopNewIssues(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}
	prsOpened, prsOpenedMore, err := s.buildPRsOpened(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}
	prsMerged, prsMergedMore, err := s.buildPRsMerged(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}
	needsHuman, needsHumanMore, err := s.buildNeedsHuman(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}

	var backlog int
	if err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM error_groups WHERE project_id = $1 AND status = 'needs_human'`, projectID,
	).Scan(&backlog); err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest needs-human backlog: %w", err)
	}
	var sessions, users int64
	if err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(DISTINCT end_user_id)
		FROM sessions
		WHERE project_id = $1 AND started_at >= $2 AND started_at < $3`,
		projectID, from, to,
	).Scan(&sessions, &users); err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest watching: %w", err)
	}

	payload := notify.EventPayload{
		Version:      1,
		EventType:    "digest.daily",
		Project:      notify.ProjectRef{ID: projectID, Name: projectName},
		DashboardURL: s.dashboardURL,
		Digest: &notify.DigestPayload{
			Date:                now.In(loc).Format("2006-01-02"),
			Window:              notify.DigestWindow{From: from.Format(time.RFC3339Nano), To: to.Format(time.RFC3339Nano)},
			Insights:            insights,
			InsightsHasMore:     insightsMore,
			TopNewIssues:        issues,
			TopNewIssuesHasMore: issuesMore,
			Outcomes: notify.DigestOutcomes{
				PRsOpened:         prsOpened,
				PRsMerged:         prsMerged,
				NeedsHuman:        needsHuman,
				PRsOpenedHasMore:  prsOpenedMore,
				PRsMergedHasMore:  prsMergedMore,
				NeedsHumanHasMore: needsHumanMore,
			},
			NeedsHumanBacklog: backlog,
			Watching:          notify.DigestWatching{Sessions: sessions, Users: users},
		},
	}
	if err := payload.Validate(); err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest payload: %w", err)
	}
	return payload, nil
}

func (s *Sweeper) buildInsights(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestInsight, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.id, COALESCE(g.signal_type,''), COALESCE(g.page_url_normalized,''),
		       SUM(fs.occurrence_count)::bigint,
		       COUNT(DISTINCT fs.end_user_id),
		       (array_agg(fs.session_id ORDER BY fs.occurred_at DESC))[1]
		FROM friction_signals fs
		JOIN error_groups g ON g.id = fs.incident_id
		WHERE fs.project_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
		  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		  AND g.status = 'insight'
		  -- C1 interim readiness gate: ineligible/pending excluded; absent rows are the legacy book and render as today. C4 flips to eligible-only after the C3 backfill.
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
		  )
		GROUP BY g.id
		ORDER BY COUNT(DISTINCT fs.end_user_id) DESC, g.id
		LIMIT $4`, projectID, from, to, listCap+1)
	if err != nil {
		return nil, false, fmt.Errorf("digest insights: %w", err)
	}
	defer rows.Close()
	items := make([]notify.DigestInsight, 0, listCap+1)
	groupIDs := make([]string, 0, listCap+1)
	for rows.Next() {
		var groupID, replaySession string
		var item notify.DigestInsight
		var affectedUsers int64
		if err := rows.Scan(&groupID, &item.SignalType, &item.Page, &item.Occurrences, &affectedUsers, &replaySession); err != nil {
			return nil, false, fmt.Errorf("digest insights scan: %w", err)
		}
		item.AffectedUsers = int(affectedUsers)
		item.ReplayURL = s.sessionURL(replaySession)
		item.URL = notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)
		items = append(items, item)
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest insights rows: %w", err)
	}
	// Release this cursor's connection before the per-item account lookups.
	// Querying while the cursor is open holds two pool connections at once, so
	// concurrent Builds deadlock each other once the pool is saturated.
	rows.Close()

	items, more := capped(items)
	for i := range items {
		accounts, err := s.insightAccounts(ctx, groupIDs[i], from, to)
		if err != nil {
			return nil, false, err
		}
		items[i].Accounts, items[i].AccountsMore = accounts.names, accounts.more
	}
	return items, more, nil
}

func (s *Sweeper) insightAccounts(ctx context.Context, groupID string, from, to time.Time) (accountSummary, error) {
	return s.accounts(ctx, `
		SELECT eu.account_name, COUNT(DISTINCT fs.end_user_id) AS cnt, COUNT(*) OVER () AS total
		FROM friction_signals fs
		JOIN end_users eu ON eu.id = fs.end_user_id
		WHERE fs.incident_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
		  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		  AND eu.account_name IS NOT NULL
		GROUP BY eu.account_name
		ORDER BY cnt DESC, eu.account_name
		LIMIT 3`, groupID, from, to)
}

func (s *Sweeper) groupAccounts(ctx context.Context, groupID string) (accountSummary, error) {
	return s.accounts(ctx, `
		SELECT eu.account_name, COUNT(*) AS cnt, COUNT(*) OVER () AS total
		FROM error_group_affected_users au
		JOIN end_users eu ON eu.id = au.end_user_id
		WHERE au.error_group_id = $1 AND eu.account_name IS NOT NULL
		GROUP BY eu.account_name
		ORDER BY cnt DESC, eu.account_name
		LIMIT 3`, groupID)
}

func (s *Sweeper) accounts(ctx context.Context, query string, args ...any) (accountSummary, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return accountSummary{}, fmt.Errorf("digest accounts: %w", err)
	}
	defer rows.Close()
	result := accountSummary{names: make([]string, 0, 3)}
	var total int64
	for rows.Next() {
		var name string
		var count int64
		if err := rows.Scan(&name, &count, &total); err != nil {
			return accountSummary{}, fmt.Errorf("digest accounts scan: %w", err)
		}
		result.names = append(result.names, name)
	}
	if err := rows.Err(); err != nil {
		return accountSummary{}, fmt.Errorf("digest accounts rows: %w", err)
	}
	result.more = int(total) - len(result.names)
	return result, nil
}

func (s *Sweeper) buildTopNewIssues(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestIssue, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.id, g.title, g.occurrence_count::bigint, g.affected_users_count,
		       g.root_cause, COALESCE(g.representative_session_id,'')
		FROM error_groups g
		WHERE g.project_id = $1 AND g.kind = 'error'
		  AND g.first_seen >= $2 AND g.first_seen < $3
		  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2 OR g.pr_created_at >= $3)
		  AND (g.needs_human_at IS NULL OR g.needs_human_at < $2 OR g.needs_human_at >= $3)
		  AND (g.merged_at IS NULL OR g.merged_at < $2 OR g.merged_at >= $3)
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
		  )
		ORDER BY (g.affected_users_count::bigint * g.occurrence_count::bigint) DESC, g.id
		LIMIT $4`, projectID, from, to, listCap+1)
	if err != nil {
		return nil, false, fmt.Errorf("digest top new issues: %w", err)
	}
	defer rows.Close()
	items := make([]notify.DigestIssue, 0, listCap+1)
	groupIDs := make([]string, 0, listCap+1)
	for rows.Next() {
		var groupID, replaySession string
		var rootCause *string
		var item notify.DigestIssue
		if err := rows.Scan(&groupID, &item.Title, &item.Occurrences, &item.AffectedUsers, &rootCause, &replaySession); err != nil {
			return nil, false, fmt.Errorf("digest top new issues scan: %w", err)
		}
		item.URL = notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)
		item.RootCauseExcerpt = rootCauseExcerpt(rootCause)
		item.ReplayURL = s.sessionURL(replaySession)
		items = append(items, item)
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest top new issues rows: %w", err)
	}
	rows.Close() // see buildInsights: never query with a cursor still open

	items, more := capped(items)
	for i := range items {
		accounts, err := s.groupAccounts(ctx, groupIDs[i])
		if err != nil {
			return nil, false, err
		}
		items[i].Accounts, items[i].AccountsMore = accounts.names, accounts.more
	}
	return items, more, nil
}

func (s *Sweeper) buildPRsOpened(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestPROpened, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.title, COALESCE(g.pr_url,''), COALESCE(g.pr_number,0), g.root_cause,
		       EXISTS(SELECT 1 FROM pr_outcomes po
		              WHERE po.error_group_id = g.id AND po.pr_number = g.pr_number
		                AND po.outcome = 'merged')
		FROM error_groups g
		WHERE g.project_id = $1 AND g.pr_created_at >= $2 AND g.pr_created_at < $3
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
		  )
		ORDER BY g.pr_created_at DESC
		LIMIT $4`, projectID, from, to, listCap+1)
	if err != nil {
		return nil, false, fmt.Errorf("digest PRs opened: %w", err)
	}
	defer rows.Close()
	items := make([]notify.DigestPROpened, 0, listCap+1)
	for rows.Next() {
		var item notify.DigestPROpened
		var rootCause *string
		if err := rows.Scan(&item.Title, &item.PRURL, &item.PRNumber, &rootCause, &item.Merged); err != nil {
			return nil, false, fmt.Errorf("digest PRs opened scan: %w", err)
		}
		item.RootCauseExcerpt = rootCauseExcerpt(rootCause)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest PRs opened rows: %w", err)
	}
	items, more := capped(items)
	return items, more, nil
}

func (s *Sweeper) buildPRsMerged(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestPRMerged, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.title, COALESCE(g.pr_url,''), po.pr_number
		FROM pr_outcomes po
		JOIN error_groups g ON g.id = po.error_group_id
		WHERE po.project_id = $1 AND po.outcome = 'merged'
		  AND po.occurred_at >= $2 AND po.occurred_at < $3
		  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2)
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
		  )
		ORDER BY po.occurred_at DESC
		LIMIT $4`, projectID, from, to, listCap+1)
	if err != nil {
		return nil, false, fmt.Errorf("digest PRs merged: %w", err)
	}
	defer rows.Close()
	items := make([]notify.DigestPRMerged, 0, listCap+1)
	for rows.Next() {
		var item notify.DigestPRMerged
		if err := rows.Scan(&item.Title, &item.PRURL, &item.PRNumber); err != nil {
			return nil, false, fmt.Errorf("digest PRs merged scan: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest PRs merged rows: %w", err)
	}
	items, more := capped(items)
	return items, more, nil
}

func (s *Sweeper) buildNeedsHuman(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestNeedsHuman, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.id, g.title, COALESCE(g.reason_message,'')
		FROM error_groups g
		WHERE g.project_id = $1 AND g.needs_human_at >= $2 AND g.needs_human_at < $3
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.status IN ('ineligible', 'pending')
		  )
		ORDER BY g.needs_human_at DESC
		LIMIT $4`, projectID, from, to, listCap+1)
	if err != nil {
		return nil, false, fmt.Errorf("digest needs-human: %w", err)
	}
	defer rows.Close()
	items := make([]notify.DigestNeedsHuman, 0, listCap+1)
	groupIDs := make([]string, 0, listCap+1)
	for rows.Next() {
		var groupID string
		var item notify.DigestNeedsHuman
		if err := rows.Scan(&groupID, &item.Title, &item.ReasonMessage); err != nil {
			return nil, false, fmt.Errorf("digest needs-human scan: %w", err)
		}
		item.URL = notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)
		items = append(items, item)
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest needs-human rows: %w", err)
	}
	rows.Close() // see buildInsights: never query with a cursor still open

	items, more := capped(items)
	for i := range items {
		accounts, err := s.groupAccounts(ctx, groupIDs[i])
		if err != nil {
			return nil, false, err
		}
		items[i].Accounts, items[i].AccountsMore = accounts.names, accounts.more
	}
	return items, more, nil
}
