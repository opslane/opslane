package identity

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

type alias struct {
	fingerprint string
	kind        string
}

func normalizeAliases(candidates []alias) []alias {
	byFingerprint := make(map[string]alias, len(candidates))
	for _, candidate := range candidates {
		if candidate.fingerprint == "" {
			continue
		}
		if _, ok := byFingerprint[candidate.fingerprint]; !ok || candidate.kind == "resolved" {
			byFingerprint[candidate.fingerprint] = candidate
		}
	}
	result := make([]alias, 0, len(byFingerprint))
	for _, candidate := range byFingerprint {
		result = append(result, candidate)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].fingerprint < result[j].fingerprint
	})
	return result
}

func lockAliases(ctx context.Context, tx pgx.Tx, projectID string, identityVersion int, candidates []alias) error {
	for _, candidate := range candidates {
		key := fmt.Sprintf("%s:%d:%s", projectID, identityVersion, candidate.fingerprint)
		if _, err := tx.Exec(ctx,
			`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
			return fmt.Errorf("lock fingerprint alias: %w", err)
		}
	}
	return nil
}

func lookupAliases(ctx context.Context, tx pgx.Tx, projectID string, identityVersion int, candidates []alias) (map[string]string, error) {
	bound := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		var issueID string
		err := tx.QueryRow(ctx,
			`SELECT canonical_issue_id::text
			   FROM canonical_issue_fingerprints
			  WHERE project_id=$1 AND identity_version=$2 AND fingerprint=$3`,
			projectID, identityVersion, candidate.fingerprint).Scan(&issueID)
		if err == nil {
			bound[candidate.fingerprint] = issueID
			continue
		}
		if err != pgx.ErrNoRows {
			return nil, fmt.Errorf("lookup fingerprint alias: %w", err)
		}
	}
	return bound, nil
}

func distinctIssues(bound map[string]string) []string {
	set := make(map[string]struct{}, len(bound))
	for _, issueID := range bound {
		set[issueID] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for issueID := range set {
		result = append(result, issueID)
	}
	sort.Strings(result)
	return result
}

func bindAlias(ctx context.Context, tx pgx.Tx, projectID string, identityVersion int, candidate alias, issueID string) error {
	tag, err := tx.Exec(ctx,
		`INSERT INTO canonical_issue_fingerprints
		   (project_id,fingerprint,fingerprint_kind,canonical_issue_id,identity_version,confirmed_by)
		 VALUES ($1,$2,$3,$4,$5,'exact')
		 ON CONFLICT (project_id,identity_version,fingerprint) DO NOTHING`,
		projectID, candidate.fingerprint, candidate.kind, issueID, identityVersion)
	if err != nil {
		return fmt.Errorf("bind fingerprint alias: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var boundIssueID string
	if err := tx.QueryRow(ctx,
		`SELECT canonical_issue_id::text
		   FROM canonical_issue_fingerprints
		  WHERE project_id=$1 AND identity_version=$2 AND fingerprint=$3`,
		projectID, identityVersion, candidate.fingerprint).Scan(&boundIssueID); err != nil {
		return fmt.Errorf("verify fingerprint alias: %w", err)
	}
	if boundIssueID != issueID {
		return fmt.Errorf("fingerprint alias was concurrently bound to a different issue")
	}
	return nil
}

func recordConflict(ctx context.Context, tx pgx.Tx, projectID, eventID string, issueIDs []string) error {
	if len(issueIDs) != 2 {
		return fmt.Errorf("record conflict: got %d issues, want 2", len(issueIDs))
	}
	left, right := issueIDs[0], issueIDs[1]
	if left > right {
		left, right = right, left
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO issue_alias_conflicts
		   (project_id,event_id,left_issue_id,right_issue_id)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (project_id,event_id,left_issue_id,right_issue_id) DO NOTHING`,
		projectID, eventID, left, right)
	if err != nil {
		return fmt.Errorf("record alias conflict: %w", err)
	}
	return nil
}
