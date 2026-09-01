package db

import (
	"context"
	"fmt"
	"time"
)

// UnbilledMergedPR is a worker-opened merged PR that has not been recorded in
// the billing dispatch ledger.
type UnbilledMergedPR struct {
	Ref        string
	PRNumber   int
	OrgID      string
	OrgName    string
	OccurredAt time.Time
	Ambiguous  bool
}

// ListUnbilledMergedPRs returns worker-opened merged-PR receipts not yet
// reported to Autumn, one per stable PR identity. fix_job_id IS NOT NULL
// excludes human/MCP-linked PRs (design 2026-09-01). DISTINCT ON collapses
// duplicate receipts for the same PR (GitHub manual redelivery mints fresh
// delivery IDs; recoverReopenedMerge can insert a second merged receipt).
//
// Receipts whose repo is bound to projects in more than one org are returned
// with Ambiguous=true. ProcessPRWebhook's match is arbitrary there, so callers
// must alert an operator instead of billing a possibly-wrong org.
func (q *Queries) ListUnbilledMergedPRs(ctx context.Context, limit int) ([]UnbilledMergedPR, error) {
	// The outer ORDER BY puts ambiguous receipts last: they stay visible for
	// reconciliation (and bill automatically once the cross-org binding is
	// fixed) but can never occupy the whole batch and starve billable receipts.
	rows, err := q.pool.Query(ctx, `
		SELECT ref, pr_number, org_id, org_name, occurred_at, ambiguous FROM (
			SELECT DISTINCT ON (po.project_id, lower(coalesce(po.github_repo, p.github_repo, '')), po.pr_number)
			       'pr:' || po.project_id || ':' || lower(coalesce(po.github_repo, p.github_repo, '')) || ':' || po.pr_number AS ref,
			       po.pr_number, p.org_id, o.name AS org_name, po.occurred_at, po.created_at, po.id,
			       EXISTS (
			         SELECT 1 FROM projects p2
			         WHERE lower(p2.github_repo) = lower(coalesce(po.github_repo, p.github_repo, ''))
			           AND p2.org_id <> p.org_id
			       ) AS ambiguous
			FROM pr_outcomes po
			JOIN projects p ON p.id = po.project_id
			JOIN orgs o ON o.id = p.org_id
			WHERE po.outcome = 'merged'
			  AND po.fix_job_id IS NOT NULL
			  AND NOT EXISTS (
			    SELECT 1 FROM billing_tracked bt
			    WHERE bt.ref = 'pr:' || po.project_id || ':' || lower(coalesce(po.github_repo, p.github_repo, '')) || ':' || po.pr_number
			  )
			ORDER BY po.project_id, lower(coalesce(po.github_repo, p.github_repo, '')), po.pr_number,
			         po.occurred_at, po.created_at, po.id
		) candidates
		ORDER BY ambiguous, occurred_at, created_at, id
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list unbilled merged PRs: %w", err)
	}
	defer rows.Close()

	result := make([]UnbilledMergedPR, 0)
	for rows.Next() {
		var item UnbilledMergedPR
		if err := rows.Scan(
			&item.Ref,
			&item.PRNumber,
			&item.OrgID,
			&item.OrgName,
			&item.OccurredAt,
			&item.Ambiguous,
		); err != nil {
			return nil, fmt.Errorf("scan unbilled merged PR: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate unbilled merged PRs: %w", err)
	}
	return result, nil
}

// MarkBillingTracked records a successfully dispatched billing side effect.
// The stable ref makes repeat calls idempotent.
func (q *Queries) MarkBillingTracked(ctx context.Context, ref, orgID, featureID string, value float64) (bool, error) {
	ct, err := q.pool.Exec(ctx, `
		INSERT INTO billing_tracked (ref, org_id, feature_id, value)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (ref) DO NOTHING`,
		ref, orgID, featureID, value,
	)
	if err != nil {
		return false, fmt.Errorf("mark billing tracked: %w", err)
	}
	return ct.RowsAffected() > 0, nil
}

// OrgSessionCountsThisMonth returns current-calendar-month session counts for
// orgs over threshold. It is alerting-grade rather than billing-grade:
// retention shorter than a month can undercount sessions.
func (q *Queries) OrgSessionCountsThisMonth(ctx context.Context, threshold int) (map[string]int, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT p.org_id, count(*)
		FROM sessions s
		JOIN projects p ON p.id = s.project_id
		WHERE s.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
		GROUP BY p.org_id
		HAVING count(*) > $1`, threshold)
	if err != nil {
		return nil, fmt.Errorf("list org session counts this month: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var orgID string
		var count int
		if err := rows.Scan(&orgID, &count); err != nil {
			return nil, fmt.Errorf("scan org session count: %w", err)
		}
		result[orgID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate org session counts: %w", err)
	}
	return result, nil
}
