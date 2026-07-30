package db

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const onboardSessionTTL = 24 * time.Hour

// OnboardProvisionInput contains the authenticated tenant and CLI session data
// needed to provision a project without a GitHub App installation.
type OnboardProvisionInput struct {
	OrgID         string
	ProvisionedBy string
	Repo          string
	AgentName     *string
	PollTokenHash string
	AgentKeyPub   string
	SealKey       func(sessionID, rawKey string) (string, error)
}

// OnboardProvisionResult contains the one-time credentials returned to the CLI.
type OnboardProvisionResult struct {
	SessionID string
	OrgID     string
	ProjectID string
	RawKey    string
}

// ProvisionOnboardSession creates or reuses the org-scoped project, rotates its
// one-time provisioning key, and binds that key to a provisioned agent session.
func (q *Queries) ProvisionOnboardSession(ctx context.Context, in OnboardProvisionInput) (*OnboardProvisionResult, error) {
	repo := strings.TrimSpace(in.Repo)
	if in.OrgID == "" || in.ProvisionedBy == "" || repo == "" {
		return nil, fmt.Errorf("provision onboard session: org, actor, and repo are required")
	}
	if in.PollTokenHash == "" || in.AgentKeyPub == "" || in.SealKey == nil {
		return nil, fmt.Errorf("provision onboard session: poll token, agent key, and seal function are required")
	}

	name := repo
	if separator := strings.LastIndex(repo, "/"); separator >= 0 {
		name = repo[separator+1:]
	}
	if name == "" {
		return nil, fmt.Errorf("provision onboard session: repo name is required")
	}
	agentName := in.AgentName
	if agentName != nil && *agentName == "" {
		agentName = nil
	}

	// The project upsert takes a row lock for an existing idempotency token.
	// Keeping key rotation, prior-session invalidation, and replacement-session
	// creation in this transaction serializes concurrent onboarding attempts.
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("provision onboard session: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Adopt an existing untagged project for this org+repo (e.g. created by the
	// GitHub-App setup flow) so onboarding converges on it instead of minting a
	// duplicate. Tag exactly one row -- the oldest -- and only when no project
	// in this org already carries this token. If a tagged project already
	// exists, it wins and any untagged duplicate remains untouched.
	if _, err := tx.Exec(ctx, `
		UPDATE projects
		SET idempotency_token = $3
		WHERE id = (
			SELECT id
			FROM projects
			WHERE org_id = $1
			  AND lower(github_repo) = lower($2)
			  AND idempotency_token IS NULL
			ORDER BY created_at ASC
			LIMIT 1
			FOR UPDATE
		)
		AND NOT EXISTS (
			SELECT 1
			FROM projects
			WHERE org_id = $1 AND idempotency_token = $3
		)`,
		in.OrgID,
		repo,
		"onboard:"+strings.ToLower(repo),
	); err != nil {
		return nil, fmt.Errorf("provision onboard session: adopt existing project: %w", err)
	}

	provisioning, err := q.provisionProjectTx(
		ctx,
		tx,
		in.OrgID,
		name,
		&repo,
		"onboard:"+strings.ToLower(repo),
	)
	if err != nil {
		return nil, fmt.Errorf("provision onboard session: %w", err)
	}

	// Once the tracked provisioning key rotates, every older account-based
	// session for this project contains a revoked key. Expire and unseal those
	// rows so an older CLI receives an actionable 410 instead of dead credentials.
	if _, err := tx.Exec(ctx, `
		UPDATE agent_sessions
		SET status = 'expired',
		    api_key_sealed = NULL,
		    expires_at = LEAST(expires_at, now())
		WHERE org_id = $1
		  AND project_id = $2
		  AND provisioned_by_user_id IS NOT NULL
		  AND status IN ('completed', 'provisioned', 'key_ok', 'app_reporting')`,
		in.OrgID,
		provisioning.Project.ID,
	); err != nil {
		return nil, fmt.Errorf("provision onboard session: expire prior sessions: %w", err)
	}

	var sessionID string
	expiresAt := time.Now().Add(onboardSessionTTL)
	err = tx.QueryRow(ctx, `
		INSERT INTO agent_sessions (
			repo_url, agent_name, poll_token_hash, agent_key_pub, status,
			org_id, project_id, provisioned_by_user_id, expires_at
		)
		VALUES ($1, $2, $3, $4, 'provisioned', $5, $6, $7, $8)
		RETURNING id`,
		repo,
		agentName,
		in.PollTokenHash,
		in.AgentKeyPub,
		in.OrgID,
		provisioning.Project.ID,
		in.ProvisionedBy,
		expiresAt,
	).Scan(&sessionID)
	if err != nil {
		return nil, fmt.Errorf("provision onboard session: insert session: %w", err)
	}

	sealed, err := in.SealKey(sessionID, provisioning.APIKey.Raw)
	if err != nil {
		return nil, fmt.Errorf("provision onboard session: seal key: %w", err)
	}
	if sealed == "" {
		return nil, fmt.Errorf("provision onboard session: seal key returned an empty value")
	}

	tag, err := tx.Exec(ctx,
		`UPDATE agent_sessions SET api_key_sealed = $2 WHERE id = $1`,
		sessionID,
		sealed,
	)
	if err != nil {
		return nil, fmt.Errorf("provision onboard session: store sealed key: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, fmt.Errorf("provision onboard session: session disappeared before commit")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("provision onboard session: commit session: %w", err)
	}

	return &OnboardProvisionResult{
		SessionID: sessionID,
		OrgID:     in.OrgID,
		ProjectID: provisioning.Project.ID,
		RawKey:    provisioning.APIKey.Raw,
	}, nil
}
