package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

var ErrInstallationOrgConflict = errors.New("installation is already mapped to another organization")

// InstallationRepo retains repository metadata GitHub already returned.
type InstallationRepo struct {
	FullName      string
	DefaultBranch string
}

// PersistInstallationParams is the complete database representation of a
// verified GitHub App installation.
type PersistInstallationParams struct {
	InstallationID int64
	GitHubOrgName  string
	GitHubOrgID    int64
	OrgID          string
	Repos          []InstallationRepo
}

// PersistInstallation writes the rich installation mapping, the legacy org
// column, and the landed audit row in the caller's transaction.
func (q *Queries) PersistInstallation(ctx context.Context, tx pgx.Tx, params PersistInstallationParams) error {
	if tx == nil {
		return fmt.Errorf("persist installation: transaction is required")
	}
	if params.InstallationID <= 0 || params.OrgID == "" {
		return fmt.Errorf("persist installation: installation and organization are required")
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('github_installation:' || ($1::bigint)::text, 0))`,
		params.InstallationID); err != nil {
		return fmt.Errorf("lock installation: %w", err)
	}

	existingOrgID, err := installationOrgID(ctx, tx, params.InstallationID)
	if err != nil {
		return err
	}
	if existingOrgID != "" && existingOrgID != params.OrgID {
		return ErrInstallationOrgConflict
	}

	repoNames := make([]string, 0, len(params.Repos))
	for _, repo := range params.Repos {
		repoNames = append(repoNames, repo.FullName)
	}
	reposJSON, err := json.Marshal(repoNames)
	if err != nil {
		return fmt.Errorf("encode installation repos: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO github_app_installations
		 (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     github_org_id = EXCLUDED.github_org_id,
		     repos = EXCLUDED.repos,
		     updated_at = now()`,
		params.InstallationID, params.GitHubOrgName, params.GitHubOrgID,
		params.OrgID, reposJSON); err != nil {
		return fmt.Errorf("upsert GitHub App installation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1`,
		params.OrgID, params.InstallationID); err != nil {
		return fmt.Errorf("set org GitHub installation: %w", err)
	}

	for _, repo := range params.Repos {
		if repo.FullName == "" || repo.DefaultBranch == "" {
			continue
		}
		// This column is a cache. A failed refresh must not prevent the
		// installation from landing, so isolate each write in a savepoint.
		if _, err := tx.Exec(ctx, `SAVEPOINT refresh_default_branch`); err != nil {
			return fmt.Errorf("savepoint default branch refresh: %w", err)
		}
		_, updateErr := tx.Exec(ctx,
			`UPDATE projects SET default_branch = $3
			 WHERE org_id = $1 AND lower(github_repo) = lower($2)
			   AND default_branch IS DISTINCT FROM $3`,
			params.OrgID, repo.FullName, repo.DefaultBranch)
		if updateErr != nil {
			if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT refresh_default_branch`); err != nil {
				return fmt.Errorf("recover default branch refresh: %w", err)
			}
			slog.Warn("default branch cache refresh failed",
				"org_id", params.OrgID, "repo", repo.FullName, "error", updateErr)
		}
		if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT refresh_default_branch`); err != nil {
			return fmt.Errorf("release default branch refresh savepoint: %w", err)
		}
	}
	return q.InsertInstallationLanded(ctx, tx, params.InstallationID, params.OrgID, repoNames)
}

// InsertInstallationLanded appends an audit row in the caller's transaction.
func (q *Queries) InsertInstallationLanded(ctx context.Context, tx pgx.Tx, installationID int64, orgID string, repos []string) error {
	if repos == nil {
		repos = []string{}
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO installation_landed (installation_id, org_id, repos)
		 VALUES ($1, NULLIF($2, '')::uuid, $3)`, installationID, orgID, repos)
	if err != nil {
		return fmt.Errorf("insert installation landed: %w", err)
	}
	return nil
}

func installationOrgID(ctx context.Context, tx pgx.Tx, installationID int64) (string, error) {
	var orgID string
	err := tx.QueryRow(ctx,
		`SELECT org_id FROM github_app_installations WHERE installation_id = $1`,
		installationID).Scan(&orgID)
	if err != nil && err != pgx.ErrNoRows {
		return "", fmt.Errorf("look up installation organization: %w", err)
	}
	if orgID != "" {
		return orgID, nil
	}
	err = tx.QueryRow(ctx,
		`SELECT id FROM orgs WHERE github_installation_id = $1
		 ORDER BY created_at ASC LIMIT 1`, installationID).Scan(&orgID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("look up legacy installation organization: %w", err)
	}
	return orgID, nil
}

// FindRecentInstallationLandedByRepo returns the most recent audit row for a
// canonical repository. Audit evidence is diagnostic only and never mutates a
// pending agent session.
