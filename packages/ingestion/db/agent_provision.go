package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrAgentSessionNotPending = errors.New("agent session is not pending")
	ErrAgentSessionExpired    = errors.New("agent session has expired")
	ErrAgentProjectNotInOrg   = errors.New("project does not belong to the approving org")
)

// AgentKeyBundle is what the approve page seals to the session and the poll
// endpoint opens for the agent.
type AgentKeyBundle struct {
	IngestKey    string `json:"ingest_key"`
	APIKey       string `json:"api_key"`
	SourcemapKey string `json:"sourcemap_key"`
}

type AgentApproveInput struct {
	SessionID         string
	OrgID             string
	UserID            string
	ProjectName       string
	ExistingProjectID *string
	SourcemapEndpoint string
	SealKeys          func(bundleJSON string) (string, error)
}

// ApproveAgentSession completes a pending session from the dashboard approve
// page. It creates a project or attaches to one the org owns, mints the three
// keys, seals them to the session, and moves it to provisioned. The row lock
// plus the status guard on UPDATE give concurrent approvals exactly one winner.
// Approval restarts the two-hour window: the remaining steps have their own
// human stops and must not inherit whatever a slow sign-up left over.
func (q *Queries) ApproveAgentSession(ctx context.Context, in AgentApproveInput) (*Project, error) {
	if in.SealKeys == nil {
		return nil, fmt.Errorf("approve: no seal function")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin approve: %w", err)
	}
	defer tx.Rollback(ctx)

	var status string
	var expiresAt time.Time
	if err := tx.QueryRow(ctx,
		`SELECT status, expires_at FROM agent_sessions WHERE id = $1 FOR UPDATE`,
		in.SessionID).Scan(&status, &expiresAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrAgentSessionNotPending
		}
		return nil, fmt.Errorf("lock agent session: %w", err)
	}
	if time.Now().After(expiresAt) {
		return nil, ErrAgentSessionExpired
	}
	if status != "pending" {
		return nil, ErrAgentSessionNotPending
	}

	var project *Project
	if in.ExistingProjectID != nil {
		var p Project
		err := tx.QueryRow(ctx,
			`SELECT id, org_id, name, github_repo, default_environment_id FROM projects WHERE id = $1 AND org_id = $2`,
			*in.ExistingProjectID, in.OrgID).Scan(&p.ID, &p.OrgID, &p.Name, &p.GithubRepo, &p.DefaultEnvironmentID)
		if err == pgx.ErrNoRows {
			return nil, ErrAgentProjectNotInOrg
		}
		if err != nil {
			return nil, fmt.Errorf("load existing project: %w", err)
		}
		project = &p
	} else {
		project, err = q.CreateProjectTx(ctx, tx, in.OrgID, in.ProjectName, nil)
		if err != nil {
			return nil, err
		}
		production, err := q.EnsureProjectDefaultEnvironmentTx(ctx, tx, project.ID)
		if err != nil {
			return nil, err
		}
		project.DefaultEnvironmentID = &production.ID
	}

	userID := in.UserID
	ingest, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeIngest, "agent setup", &userID, "")
	if err != nil {
		return nil, err
	}
	api, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeAPI, "agent-setup", &userID, "")
	if err != nil {
		return nil, err
	}
	sk, err := q.CreateProjectKeyTx(ctx, tx, project.ID, ScopeSourcemaps, "agent-setup", &userID, in.SourcemapEndpoint)
	if err != nil {
		return nil, err
	}
	bundle, err := json.Marshal(AgentKeyBundle{IngestKey: ingest.Raw, APIKey: api.Raw, SourcemapKey: sk.Raw})
	if err != nil {
		return nil, fmt.Errorf("encode key bundle: %w", err)
	}
	sealed, err := in.SealKeys(string(bundle))
	if err != nil {
		return nil, fmt.Errorf("seal key bundle: %w", err)
	}
	tag, err := tx.Exec(ctx,
		`UPDATE agent_sessions
		 SET status = 'provisioned', org_id = $2, project_id = $3, api_key_sealed = $4,
		     project_name = $5, provisioned_by_user_id = $6,
		     expires_at = GREATEST(expires_at, now() + interval '2 hours')
		 WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
		in.SessionID, in.OrgID, project.ID, sealed, project.Name, in.UserID)
	if err != nil {
		return nil, fmt.Errorf("approve agent session: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrAgentSessionNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit approve: %w", err)
	}
	return project, nil
}

// DenyAgentSession marks a pending session failed with the terminal reason
// the poll endpoint phrases for the agent.
func (q *Queries) DenyAgentSession(ctx context.Context, sessionID string) error {
	ok, err := q.MarkAgentSessionFailed(ctx, sessionID, "authorization_denied")
	if err != nil {
		return err
	}
	if !ok {
		return ErrAgentSessionNotPending
	}
	return nil
}
