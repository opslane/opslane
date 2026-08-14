package digest

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/opslane/opslane/packages/ingestion/narrative"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

type accountSummary struct {
	names []string
	more  int
}

var (
	fillerExcerpt = regexp.MustCompile(`(?i)^\s*(placeholder|tbd|to be determined)\b`)
	// One predicate block feeds two queries: the aggregate counts run over every
	// qualifying row (so held-back and overflow stay exact even when zero rows
	// are publishable), while the row fetch adds AND pub.publishable so belt
	// failures can never consume LIMIT slots and starve renderable receipts.
	receiptItemsFromClause = `
		  FROM error_groups g
		  JOIN digest_readiness dr
		    ON dr.incident_id = g.id AND dr.project_id = g.project_id
		 CROSS JOIN LATERAL (
		    SELECT EXISTS (
		      SELECT 1 FROM (
		        SELECT dd.outcome, dd.diagnosis
		          FROM diagnosis_decisions dd
		         WHERE dd.error_group_id = g.id AND dd.project_id = g.project_id
		         ORDER BY dd.decided_at DESC, dd.id DESC
		         LIMIT 1
		      ) latest
		      WHERE latest.outcome IN ('code_fix','not_actionable')
		        AND (CASE WHEN jsonb_typeof(latest.diagnosis->'evidence') = 'array'
		                  THEN jsonb_array_length(latest.diagnosis->'evidence') >= 1
		                   AND NOT EXISTS (
		                     SELECT 1 FROM jsonb_array_elements(latest.diagnosis->'evidence') e
		                      WHERE btrim(coalesce(e->>'path','')) = ''
		                         OR btrim(coalesce(e->>'detail','')) = ''
		                         OR btrim(coalesce(e->>'symptomLink','')) = ''
		                   )
		                  ELSE false END)
		        AND (latest.outcome <> 'code_fix'
		             OR (NULLIF(btrim(latest.diagnosis->>'agentTaskBrief'), '') IS NOT NULL
		                 AND latest.diagnosis->>'agentTaskBrief' !~* '^\s*(placeholder|tbd|to be determined)\M'))
		    ) AS has_validated_diagnosis
		  ) d
		 CROSS JOIN LATERAL (
		    SELECT (COALESCE(g.root_cause, '') !~* '^\s*(placeholder|tbd|to be determined)\M')
		           AND CASE
		             WHEN g.status IN ('pr_created','pr_draft') THEN COALESCE(g.pr_url, '') <> ''
		             WHEN g.status = 'needs_human'
		               THEN NULLIF(btrim(g.candidate_diff), '') IS NOT NULL OR d.has_validated_diagnosis
		             ELSE d.has_validated_diagnosis
		           END AS publishable
		  ) pub
		 WHERE g.project_id = $1
		   AND dr.status = 'eligible'
		   AND dr.updated_at >= $2 AND dr.updated_at < $3
		   AND g.status IN ('pr_created','pr_draft','needs_human','investigated','insight','awaiting_approval')`

	receiptCountsQuery = `
		SELECT count(*),
		       count(*) FILTER (WHERE NOT pub.publishable)` + receiptItemsFromClause

	receiptItemsQuery = fmt.Sprintf(`
		SELECT g.id, g.kind, g.title, g.occurrence_count::bigint,
		       g.impact_class, g.impact_visits, g.impact_visits_recovered,
		       g.status::text,
		       COALESCE(g.pr_url, ''), COALESCE(g.root_cause, ''),
		       COALESCE(g.suggested_mitigation, ''),
		       NULLIF(btrim(g.candidate_diff), '') IS NOT NULL,
		       d.has_validated_diagnosis`+receiptItemsFromClause+`
		   AND pub.publishable
		 ORDER BY COALESCE(g.priority_score, 0) DESC, g.last_seen DESC, g.id DESC
		 LIMIT %d`, receiptCap*2)
)

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
	from, to := s.windowFor(ctx, projectID, now)
	receiptItems, receiptOverflow, receiptBeltFailures, err := s.buildReceiptItems(ctx, projectID, from, to)
	if err != nil {
		return notify.EventPayload{}, err
	}
	triageCounts, heldBack, err := s.buildTriageAndHeldBack(ctx, projectID)
	if err != nil {
		return notify.EventPayload{}, err
	}
	heldBack += receiptBeltFailures

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
			SchemaVersion:     2,
			ReceiptItems:      receiptItems,
			TriageCounts:      triageCounts,
			HeldBackCount:     heldBack,
			ReceiptOverflow:   receiptOverflow,
		},
	}
	if err := payload.Validate(); err != nil {
		return notify.EventPayload{}, fmt.Errorf("digest payload: %w", err)
	}
	return payload, nil
}

type receiptQueryRow struct {
	item                  notify.ReceiptItem
	status                string
	rootCause             string
	mitigation            string
	hasValidatedDiagnosis bool
}

func receiptState(status string, hasSavedDiff bool) string {
	switch status {
	case "pr_created", "pr_draft":
		return "pr_open"
	case "needs_human":
		if hasSavedDiff {
			return "attempt_failed_with_diff"
		}
		return "attempt_failed_no_diff"
	default:
		return "report_ready"
	}
}

// publishable is defense in depth beneath the readiness projection. A failure
// means an eligible writer produced no reviewable artifact.
func publishable(item notify.ReceiptItem, hasValidatedDiagnosis bool) bool {
	if item.RootCauseExcerpt != "" && fillerExcerpt.MatchString(item.RootCauseExcerpt) {
		return false
	}
	switch item.ReceiptState {
	case "pr_open":
		return item.PRURL != ""
	case "attempt_failed_with_diff":
		return item.HasSavedDiff
	case "attempt_failed_no_diff", "report_ready":
		return hasValidatedDiagnosis
	default:
		return false
	}
}

func (s *Sweeper) buildReceiptItems(ctx context.Context, projectID string, from, to time.Time) ([]notify.ReceiptItem, int, int, error) {
	// Counts run over every qualifying row, before the publishable filter and
	// the LIMIT, so they stay exact even when nothing is renderable.
	var total, sqlBeltFailures int
	if err := s.pool.QueryRow(ctx, receiptCountsQuery, projectID, from, to).Scan(&total, &sqlBeltFailures); err != nil {
		return nil, 0, 0, fmt.Errorf("digest receipt counts: %w", err)
	}
	if sqlBeltFailures > 0 {
		slog.Warn("eligible digest receipts failed the artifact belt", "project_id", projectID, "count", sqlBeltFailures)
	}

	rows, err := s.pool.Query(ctx, receiptItemsQuery, projectID, from, to)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("digest receipt items: %w", err)
	}
	defer rows.Close()

	fetched := make([]receiptQueryRow, 0, receiptCap*2)
	for rows.Next() {
		var row receiptQueryRow
		var impactClass *string
		if err := rows.Scan(
			&row.item.IncidentID, &row.item.Kind, &row.item.Title, &row.item.OccurrenceCount,
			&impactClass, &row.item.ImpactVisits, &row.item.ImpactRecovered,
			&row.status, &row.item.PRURL, &row.rootCause, &row.mitigation,
			&row.item.HasSavedDiff, &row.hasValidatedDiagnosis,
		); err != nil {
			return nil, 0, 0, fmt.Errorf("digest receipt items scan: %w", err)
		}
		if impactClass != nil {
			row.item.ImpactClass = *impactClass
		}
		row.item.ReceiptState = receiptState(row.status, row.item.HasSavedDiff)
		row.item.Title = narrative.SanitizeExcerpt(row.item.Title, excerptMax)
		if row.hasValidatedDiagnosis {
			row.item.RootCauseExcerpt = narrative.SanitizeExcerpt(row.rootCause, excerptMax)
			row.item.MitigationExcerpt = narrative.SanitizeExcerpt(row.mitigation, excerptMax)
		}
		fetched = append(fetched, row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, fmt.Errorf("digest receipt items rows: %w", err)
	}
	// Release the cursor before the bounded per-card replay lookups.
	rows.Close()

	items := make([]notify.ReceiptItem, 0, receiptCap)
	goBeltFailures := 0
	for _, row := range fetched {
		// Drift re-check of the SQL belt; a hit means the two spellings disagree.
		if !publishable(row.item, row.hasValidatedDiagnosis) {
			goBeltFailures++
			slog.Warn("eligible digest receipt failed Go artifact belt", "group_id", row.item.IncidentID, "state", row.item.ReceiptState)
			continue
		}
		if len(items) >= receiptCap {
			continue
		}
		if replayURL := s.replayURLFor(ctx, row.item.IncidentID, projectID); replayURL != nil {
			row.item.SessionURL = *replayURL
		}
		items = append(items, row.item)
	}

	overflow := total - sqlBeltFailures - goBeltFailures - len(items)
	if overflow < 0 {
		overflow = 0
	}
	return items, overflow, sqlBeltFailures + goBeltFailures, nil
}

func (s *Sweeper) buildTriageAndHeldBack(ctx context.Context, projectID string) (*notify.DigestTriageCounts, int, error) {
	counts := &notify.DigestTriageCounts{}
	var heldBack int
	err := s.pool.QueryRow(ctx, `
		SELECT
		  count(*) FILTER (WHERE g.status IN ('pr_created','pr_draft')),
		  count(*) FILTER (WHERE g.status = 'needs_human'
		    OR (g.status IN ('investigated','awaiting_approval') AND dr.status = 'eligible')),
		  count(*) FILTER (WHERE g.status IN ('needs_human','investigated','insight')
		    AND dr.status IS DISTINCT FROM 'eligible')
		FROM error_groups g
		LEFT JOIN digest_readiness dr
		  ON dr.incident_id = g.id AND dr.project_id = g.project_id
		WHERE g.project_id = $1
		  AND g.status NOT IN ('resolved','merged','archived')`, projectID).Scan(
		&counts.PRsAwaitingReview, &counts.NeedsDecision, &heldBack,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("digest triage counts: %w", err)
	}
	return counts, heldBack, nil
}

func (s *Sweeper) buildInsights(ctx context.Context, projectID string, from, to time.Time) ([]notify.DigestInsight, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.id, COALESCE(g.signal_type,''), COALESCE(g.page_url_normalized,''),
		       SUM(fs.occurrence_count)::bigint,
		       COUNT(DISTINCT fs.end_user_id)
		FROM friction_signals fs
		JOIN error_groups g ON g.id = fs.incident_id
		WHERE fs.project_id = $1 AND fs.occurred_at >= $2 AND fs.occurred_at < $3
		  AND fs.retracted_at IS NULL AND fs.superseded_by IS NULL
		  AND g.status = 'insight'
		  AND EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.project_id = g.project_id AND dr.status = 'eligible'
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
		var groupID string
		var item notify.DigestInsight
		var affectedUsers int64
		if err := rows.Scan(&groupID, &item.SignalType, &item.Page, &item.Occurrences, &affectedUsers); err != nil {
			return nil, false, fmt.Errorf("digest insights scan: %w", err)
		}
		item.AffectedUsers = int(affectedUsers)
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
		items[i].ReplayURL = s.replayURLFor(ctx, groupIDs[i], projectID)
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
		       g.root_cause
		FROM error_groups g
		WHERE g.project_id = $1 AND g.kind = 'error'
		  AND g.first_seen >= $2 AND g.first_seen < $3
		  AND (g.pr_created_at IS NULL OR g.pr_created_at < $2 OR g.pr_created_at >= $3)
		  AND (g.needs_human_at IS NULL OR g.needs_human_at < $2 OR g.needs_human_at >= $3)
		  AND (g.merged_at IS NULL OR g.merged_at < $2 OR g.merged_at >= $3)
		  AND EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.project_id = g.project_id AND dr.status = 'eligible'
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
		var groupID string
		var rootCause *string
		var item notify.DigestIssue
		if err := rows.Scan(&groupID, &item.Title, &item.Occurrences, &item.AffectedUsers, &rootCause); err != nil {
			return nil, false, fmt.Errorf("digest top new issues scan: %w", err)
		}
		item.URL = notify.BuildIncidentURL(s.dashboardURL, groupID, projectID)
		item.RootCauseExcerpt = rootCauseExcerpt(rootCause)
		items = append(items, item)
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("digest top new issues rows: %w", err)
	}
	rows.Close() // see buildInsights: never query with a cursor still open

	items, more := capped(items)
	for i := range items {
		items[i].ReplayURL = s.replayURLFor(ctx, groupIDs[i], projectID)
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
		  AND EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.project_id = g.project_id AND dr.status = 'eligible'
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
		  -- C1's interim predicate, kept deliberately (plan Deviation 3): merged
		  -- groups were skipped by the 047 backfill, but a readiness row written
		  -- while the incident was still open survives the merge — nothing deletes
		  -- projection rows — so ineligible/pending rows are still excluded here.
		  AND NOT EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.project_id = g.project_id
		      AND dr.status IN ('ineligible', 'pending')
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
		  AND EXISTS (
		    SELECT 1 FROM digest_readiness dr
		    WHERE dr.incident_id = g.id AND dr.project_id = g.project_id AND dr.status = 'eligible'
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
