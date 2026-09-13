package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	// HTMLURL is GitHub's settings page for the installation; empty keeps
	// whatever the row already has.
	HTMLURL string
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
		 (installation_id, github_org_name, github_org_id, org_id, repos, html_url)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     github_org_id = EXCLUDED.github_org_id,
		     repos = EXCLUDED.repos,
		     html_url = CASE WHEN EXCLUDED.html_url <> '' THEN EXCLUDED.html_url ELSE github_app_installations.html_url END,
		     suspended = false,
		     updated_at = now()`,
		params.InstallationID, params.GitHubOrgName, params.GitHubOrgID,
		params.OrgID, reposJSON, params.HTMLURL); err != nil {
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

// RetireGitHubInstallation records that GitHub no longer honours an
// installation. In one transaction it suspends the rich row, if any, and
// clears the legacy org pointer where it equals installationID. Returns true
// when either write changed a row.
func (q *Queries) RetireGitHubInstallation(ctx context.Context, installationID int64, orgID string) (bool, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin retire installation: %w", err)
	}
	defer tx.Rollback(ctx)
	// The rich row is scoped to the org on the on-use path (orgID set) so a
	// caller can only ever retire an installation mapped to their own org;
	// signed webhooks pass "" and may retire any mapped row.
	var rowTag pgconn.CommandTag
	if orgID == "" {
		rowTag, err = tx.Exec(ctx,
			`UPDATE github_app_installations SET suspended = true, updated_at = now()
			 WHERE installation_id = $1 AND NOT suspended`, installationID)
	} else {
		rowTag, err = tx.Exec(ctx,
			`UPDATE github_app_installations SET suspended = true, updated_at = now()
			 WHERE installation_id = $1 AND org_id = $2 AND NOT suspended`, installationID, orgID)
	}
	if err != nil {
		return false, fmt.Errorf("retire github installation: %w", err)
	}
	var orgTag pgconn.CommandTag
	if orgID == "" {
		orgTag, err = tx.Exec(ctx,
			`UPDATE orgs SET github_installation_id = NULL WHERE github_installation_id = $1`, installationID)
	} else {
		orgTag, err = tx.Exec(ctx,
			`UPDATE orgs SET github_installation_id = NULL WHERE github_installation_id = $1 AND id = $2`, installationID, orgID)
	}
	if err != nil {
		return false, fmt.Errorf("clear org github installation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit retire installation: %w", err)
	}
	return rowTag.RowsAffected()+orgTag.RowsAffected() > 0, nil
}

// ReactivateGitHubInstallation unsuspends the row and restores a missing org
// pointer. It never overwrites a pointer to a different installation.
func (q *Queries) ReactivateGitHubInstallation(ctx context.Context, installationID int64) (bool, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin reactivate installation: %w", err)
	}
	defer tx.Rollback(ctx)
	var orgID string
	err = tx.QueryRow(ctx,
		`UPDATE github_app_installations SET suspended = false, updated_at = now()
		 WHERE installation_id = $1 RETURNING org_id`, installationID).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("reactivate github installation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1 AND github_installation_id IS NULL`,
		orgID, installationID); err != nil {
		return false, fmt.Errorf("restore org github installation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit reactivate installation: %w", err)
	}
	return true, nil
}

// SetGitHubInstallationSuspended mirrors GitHub's suspend state.
func (q *Queries) SetGitHubInstallationSuspended(ctx context.Context, installationID int64, suspended bool) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations SET suspended = $2, updated_at = now() WHERE installation_id = $1`,
		installationID, suspended)
	if err != nil {
		return false, fmt.Errorf("set github installation suspended: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// ReplaceGitHubInstallationRepos overwrites an installation's repository list.
func (q *Queries) ReplaceGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations SET repos = $2, updated_at = now() WHERE installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("replace github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// AddGitHubInstallationRepos appends new names, preserves existing order, and
// collapses duplicate input names.
func (q *Queries) AddGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations i
		 SET repos = (
		   SELECT COALESCE(jsonb_agg(name ORDER BY ord), '[]'::jsonb)
		   FROM (
		     SELECT name, ord FROM jsonb_array_elements_text(i.repos) WITH ORDINALITY AS e(name, ord)
		     UNION ALL
		     SELECT name, 1000000 + ord FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS n(name, ord)
		       WHERE NOT i.repos ? name
		   ) merged
		 ), updated_at = now()
		 WHERE i.installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("add github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// RemoveGitHubInstallationRepos drops names and ignores unknown names.
func (q *Queries) RemoveGitHubInstallationRepos(ctx context.Context, installationID int64, repos []string) (bool, error) {
	reposJSON, err := json.Marshal(dedupeRepoNames(repos))
	if err != nil {
		return false, fmt.Errorf("encode installation repos: %w", err)
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations i
		 SET repos = (
		   SELECT COALESCE(jsonb_agg(name ORDER BY ord), '[]'::jsonb)
		   FROM jsonb_array_elements_text(i.repos) WITH ORDINALITY AS e(name, ord)
		   WHERE NOT ($2::jsonb ? name)
		 ), updated_at = now()
		 WHERE i.installation_id = $1`,
		installationID, reposJSON)
	if err != nil {
		return false, fmt.Errorf("remove github installation repos: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// GetGitHubInstallationHTMLURL reads the stored settings page for an
// installation the org owns; "" when unknown.
func (q *Queries) GetGitHubInstallationHTMLURL(ctx context.Context, orgID string, installationID int64) (string, error) {
	var u string
	err := q.pool.QueryRow(ctx,
		`SELECT html_url FROM github_app_installations WHERE installation_id = $1 AND org_id = $2`,
		installationID, orgID).Scan(&u)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get github installation html_url: %w", err)
	}
	return u, nil
}

// SetGitHubInstallationHTMLURL fills the settings page for a row persisted
// before the column existed.
func (q *Queries) SetGitHubInstallationHTMLURL(ctx context.Context, installationID int64, htmlURL string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE github_app_installations SET html_url = $2, updated_at = now() WHERE installation_id = $1 AND html_url = ''`,
		installationID, htmlURL)
	if err != nil {
		return fmt.Errorf("set github installation html_url: %w", err)
	}
	return nil
}

// AnyOrgPointsAtInstallation reports whether a legacy org pointer names the
// installation even when no rich row exists.
func (q *Queries) AnyOrgPointsAtInstallation(ctx context.Context, installationID int64) (bool, error) {
	var ok bool
	err := q.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM orgs WHERE github_installation_id = $1)`, installationID).Scan(&ok)
	return ok, err
}

func dedupeRepoNames(names []string) []string {
	out := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, duplicate := seen[name]; duplicate {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}
