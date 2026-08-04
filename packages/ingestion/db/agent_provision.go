package db

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrAgentSessionNotPending     = errors.New("agent session is not pending")
	ErrAgentIdentityUnverified    = errors.New("github identity has no verified email")
	ErrAgentOrgExistsNeedsInvite  = errors.New("installation org already exists; user needs an invite")
	ErrAgentRepoAlreadyConfigured = errors.New("repo already has a project")
)

type AgentProvisionInput struct {
	SessionID      string
	InstallationID int64
	CanonicalRepo  string
	Repos          []InstallationRepo
	// CanonicalDefaultBranch is taken from the installation repository list.
	CanonicalDefaultBranch string
	GitHubOrgName          string
	GitHubOrgID            int64
	GitHubUserID           int64
	GitHubLogin            string
	DisplayName            string
	Email                  string
	EmailVerified          bool
	AvatarURL              string
	SealKey                func(rawKey string) (string, error)
}

type AgentProvisionResult struct {
	OrgID     string
	ProjectID string
}

// ProvisionAgentSession performs the complete agent onboarding write set in
// one transaction. Definitive business failures are committed to the session;
// unexpected failures roll back and leave it pending for a retry.
func (q *Queries) ProvisionAgentSession(ctx context.Context, in AgentProvisionInput) (*AgentProvisionResult, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin agent provision: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	var expiresAt time.Time
	err = tx.QueryRow(ctx,
		`SELECT status, expires_at FROM agent_sessions WHERE id = $1 FOR UPDATE`,
		in.SessionID).Scan(&status, &expiresAt)
	if err == pgx.ErrNoRows {
		return nil, ErrAgentSessionNotPending
	}
	if err != nil {
		return nil, fmt.Errorf("lock agent session: %w", err)
	}
	if status != "pending" || time.Now().After(expiresAt) {
		return nil, ErrAgentSessionNotPending
	}

	fail := func(reason string, sentinel error) (*AgentProvisionResult, error) {
		if _, err := tx.Exec(ctx,
			`UPDATE agent_sessions SET status = 'failed', failure_reason = $2 WHERE id = $1`,
			in.SessionID, reason); err != nil {
			return nil, fmt.Errorf("mark failed (%s): %w", reason, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit failure (%s): %w", reason, err)
		}
		return nil, sentinel
	}

	repoKey := strings.ToLower(in.CanonicalRepo)
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('agent_repo:' || $1, 0))`, repoKey); err != nil {
		return nil, fmt.Errorf("advisory lock: %w", err)
	}
	var existingProjectID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM projects WHERE lower(github_repo) = $1 LIMIT 1`, repoKey).Scan(&existingProjectID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("recheck project: %w", err)
	}
	if err == nil {
		return fail("repo_already_configured", ErrAgentRepoAlreadyConfigured)
	}
	// Every successful agent provision requires a currently verified GitHub
	// email, including returning and legacy-column users. Identity existence is
	// not a substitute for the callback's live verification proof.
	if !in.EmailVerified || strings.TrimSpace(in.Email) == "" {
		return fail("identity_unverified", ErrAgentIdentityUnverified)
	}

	subject := strconv.FormatInt(in.GitHubUserID, 10)
	if err := lockIdentityTx(ctx, tx, "github", subject); err != nil {
		return nil, err
	}
	if in.EmailVerified && in.Email != "" {
		if err := lockEmailTx(ctx, tx, NormalizeEmail(in.Email)); err != nil {
			return nil, err
		}
	}

	var userID, userOrgID string
	err = tx.QueryRow(ctx,
		`SELECT u.id, u.org_id FROM auth_identities ai JOIN users u ON u.id = ai.user_id
		 WHERE ai.provider = 'github' AND ai.provider_subject = $1`, subject).Scan(&userID, &userOrgID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("identity lookup: %w", err)
	}
	if userID == "" {
		err = tx.QueryRow(ctx,
			`SELECT id, org_id FROM users WHERE github_id = $1`, in.GitHubUserID).Scan(&userID, &userOrgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("github_id lookup: %w", err)
		}
	}
	if userID == "" && in.EmailVerified && in.Email != "" {
		err = tx.QueryRow(ctx,
			`SELECT id, org_id FROM users WHERE lower(email) = $1`, NormalizeEmail(in.Email)).Scan(&userID, &userOrgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("email lookup: %w", err)
		}
		if userID != "" {
			if _, err := tx.Exec(ctx,
				`UPDATE users SET github_id = $2, github_username = $3, avatar_url = $4, updated_at = now()
				 WHERE id = $1 AND github_id IS NULL`,
				userID, in.GitHubUserID, in.GitHubLogin, in.AvatarURL); err != nil {
				return nil, fmt.Errorf("link github: %w", err)
			}
		}
	}

	var orgID string
	err = tx.QueryRow(ctx,
		`SELECT org_id FROM github_app_installations WHERE installation_id = $1`,
		in.InstallationID).Scan(&orgID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("installation lookup: %w", err)
	}
	if orgID == "" {
		err = tx.QueryRow(ctx,
			`SELECT id FROM orgs WHERE github_installation_id = $1
			 ORDER BY created_at ASC LIMIT 1`, in.InstallationID).Scan(&orgID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("legacy installation lookup: %w", err)
		}
	}
	if orgID != "" {
		if userID == "" {
			return fail("org_exists_needs_invite", ErrAgentOrgExistsNeedsInvite)
		}
		affiliated := userOrgID == orgID
		if !affiliated {
			var n int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM memberships WHERE user_id = $1 AND org_id = $2`,
				userID, orgID).Scan(&n); err != nil {
				return nil, fmt.Errorf("membership check: %w", err)
			}
			affiliated = n > 0
		}
		if !affiliated {
			return fail("org_exists_needs_invite", ErrAgentOrgExistsNeedsInvite)
		}
	} else if userID != "" {
		orgID = userOrgID
	} else {
		orgName := in.GitHubOrgName
		if orgName == "" {
			orgName = in.GitHubLogin
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, orgName).Scan(&orgID); err != nil {
			return nil, fmt.Errorf("create org: %w", err)
		}
		name := in.DisplayName
		if name == "" {
			name = in.GitHubLogin
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO users (org_id, email, name, github_id, github_username, avatar_url)
			 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			orgID, NormalizeEmail(in.Email), name, in.GitHubUserID, in.GitHubLogin, in.AvatarURL,
		).Scan(&userID); err != nil {
			return nil, fmt.Errorf("create user: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')
			 ON CONFLICT (user_id, org_id) DO NOTHING`, userID, orgID); err != nil {
			return nil, fmt.Errorf("create membership: %w", err)
		}
	}

	if userID != "" {
		if _, err := tx.Exec(ctx,
			`INSERT INTO auth_identities (user_id, provider, provider_subject, provider_email, email_verified)
			 VALUES ($1, 'github', $2, $3, $4)
			 ON CONFLICT (provider, provider_subject)
			 DO UPDATE SET provider_email = EXCLUDED.provider_email,
			               email_verified = auth_identities.email_verified OR EXCLUDED.email_verified`,
			userID, subject, NormalizeEmail(in.Email), in.EmailVerified); err != nil {
			return nil, fmt.Errorf("upsert identity: %w", err)
		}
	}

	installationRepos := in.Repos
	if len(installationRepos) == 0 {
		installationRepos = []InstallationRepo{{
			FullName:      in.CanonicalRepo,
			DefaultBranch: in.CanonicalDefaultBranch,
		}}
	}
	if err := q.PersistInstallation(ctx, tx, PersistInstallationParams{
		InstallationID: in.InstallationID,
		GitHubOrgName:  in.GitHubOrgName,
		GitHubOrgID:    in.GitHubOrgID,
		OrgID:          orgID,
		Repos:          installationRepos,
	}); err != nil {
		return nil, fmt.Errorf("persist installation: %w", err)
	}

	projectName := in.CanonicalRepo
	if idx := strings.LastIndex(in.CanonicalRepo, "/"); idx >= 0 {
		projectName = in.CanonicalRepo[idx+1:]
	}
	canonicalRepo := in.CanonicalRepo
	project, err := q.CreateProjectTx(ctx, tx, orgID, projectName, &canonicalRepo)
	if err != nil {
		return nil, err
	}
	// PersistInstallation runs before this project exists, so apply the branch
	// to the new row after creation in the same transaction.
	if in.CanonicalDefaultBranch != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE projects SET default_branch = $2 WHERE id = $1`,
			project.ID, in.CanonicalDefaultBranch); err != nil {
			return nil, fmt.Errorf("set project default branch: %w", err)
		}
	}
	if _, err := q.CreateEnvironmentTx(ctx, tx, project.ID, "production"); err != nil {
		return nil, err
	}
	if _, err := q.CreateEnvironmentTx(ctx, tx, project.ID, "development"); err != nil {
		return nil, err
	}
	developmentKey, err := q.CreateProjectKeyTx(
		ctx, tx, project.ID, ScopeIngest, "agent setup", nil, "",
	)
	if err != nil {
		return nil, err
	}
	if in.SealKey == nil {
		return nil, fmt.Errorf("seal api key: no seal function")
	}
	sealed, err := in.SealKey(developmentKey.Raw)
	if err != nil {
		return nil, fmt.Errorf("seal api key: %w", err)
	}

	tag, err := tx.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'provisioned', org_id = $2, project_id = $3,
		     api_key_sealed = $4, installation_id = $5
		 WHERE id = $1 AND status = 'pending'`,
		in.SessionID, orgID, project.ID, sealed, in.InstallationID)
	if err != nil {
		return nil, fmt.Errorf("provision agent session: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrAgentSessionNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit agent provision: %w", err)
	}
	return &AgentProvisionResult{OrgID: orgID, ProjectID: project.ID}, nil
}
