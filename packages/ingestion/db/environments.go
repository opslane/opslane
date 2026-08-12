package db

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
)

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var ErrEnvironmentNotInProject = errors.New("environment does not belong to project")
var ErrProjectNotFound = errors.New("project not found")

type EnvironmentOutcome string

const (
	EnvironmentOutcomeDefault      EnvironmentOutcome = "default"
	EnvironmentOutcomeInvalidLabel EnvironmentOutcome = "invalid_label"
	EnvironmentOutcomeExisting     EnvironmentOutcome = "existing"
	EnvironmentOutcomeCreated      EnvironmentOutcome = "created"
	EnvironmentOutcomeSession      EnvironmentOutcome = "session_authoritative"
)

// EnsureProjectDefaultEnvironmentTx initializes the immutable production row
// and fills a project's nullable default only when it has not already been set.
func (q *Queries) EnsureProjectDefaultEnvironmentTx(ctx context.Context, tx pgx.Tx, projectID string) (*Environment, error) {
	var env Environment
	err := tx.QueryRow(ctx, `
		INSERT INTO environments (project_id, name)
		VALUES ($1, 'production')
		ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id, project_id, name, created_at`, projectID,
	).Scan(&env.ID, &env.ProjectID, &env.Name, &env.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("ensure production environment: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE projects
		SET default_environment_id = $2
		WHERE id = $1 AND default_environment_id IS NULL`, projectID, env.ID); err != nil {
		return nil, fmt.Errorf("set project default environment: %w", err)
	}
	return &env, nil
}

func resolveEnvironmentTx(
	ctx context.Context,
	tx pgx.Tx,
	projectID, defaultEnvironmentID, label string,
) (string, EnvironmentOutcome, error) {
	verifyDefault := func(outcome EnvironmentOutcome) (string, EnvironmentOutcome, error) {
		var id string
		err := tx.QueryRow(ctx,
			`SELECT id FROM environments WHERE id = $1 AND project_id = $2`,
			defaultEnvironmentID, projectID,
		).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("default environment does not belong to project")
		}
		if err != nil {
			return "", "", fmt.Errorf("verify default environment: %w", err)
		}
		return id, outcome, nil
	}

	if label == "" {
		return verifyDefault(EnvironmentOutcomeDefault)
	}
	if !environmentNamePattern.MatchString(label) {
		return verifyDefault(EnvironmentOutcomeInvalidLabel)
	}

	var id string
	err := tx.QueryRow(ctx,
		`SELECT id FROM environments WHERE project_id = $1 AND name = $2`,
		projectID, label,
	).Scan(&id)
	if err == nil {
		return id, EnvironmentOutcomeExisting, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("resolve environment label: %w", err)
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO environments (project_id, name)
		VALUES ($1, $2)
		ON CONFLICT (project_id, name) DO NOTHING
		RETURNING id`, projectID, label,
	).Scan(&id)
	if err == nil {
		return id, EnvironmentOutcomeCreated, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("create discovered environment: %w", err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM environments WHERE project_id = $1 AND name = $2`,
		projectID, label,
	).Scan(&id); err != nil {
		return "", "", fmt.Errorf("select concurrently discovered environment: %w", err)
	}
	return id, EnvironmentOutcomeExisting, nil
}

// SetProjectActionScope replaces a project's action allowlist atomically. A nil
// pointer disables scoping; a non-nil empty slice enables a fail-closed scope.
func SetProjectActionScope(
	ctx context.Context,
	tx pgx.Tx,
	orgID, projectID string,
	environmentIDs *[]string,
) error {
	enabled := environmentIDs != nil
	tag, err := tx.Exec(ctx,
		`UPDATE projects SET action_scope_enabled = $3
		 WHERE id = $1 AND org_id = $2`,
		projectID, orgID, enabled,
	)
	if err != nil {
		return fmt.Errorf("set action scope flag: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrProjectNotFound
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM project_action_environments WHERE project_id = $1`, projectID,
	); err != nil {
		return fmt.Errorf("clear action scope environments: %w", err)
	}
	if !enabled {
		return nil
	}

	seen := make(map[string]struct{}, len(*environmentIDs))
	for _, environmentID := range *environmentIDs {
		if _, duplicate := seen[environmentID]; duplicate {
			continue
		}
		seen[environmentID] = struct{}{}
		tag, err := tx.Exec(ctx,
			`INSERT INTO project_action_environments (project_id, environment_id)
			 SELECT $1, e.id FROM environments e
			 WHERE e.id = $2 AND e.project_id = $1`,
			projectID, environmentID,
		)
		if err != nil {
			return fmt.Errorf("insert action scope environment: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: %s", ErrEnvironmentNotInProject, environmentID)
		}
	}
	return nil
}

// actionScopeQuery reads the flag and the ordered membership list in ONE
// statement so they come from the same snapshot; two separate reads can return
// a flag/list pair that never coexisted when a settings PATCH lands between.
const actionScopeQuery = `
	SELECT p.id::text, p.action_scope_enabled,
	       COALESCE(array_agg(pae.environment_id::text
	                          ORDER BY pae.created_at, pae.environment_id)
	                FILTER (WHERE pae.environment_id IS NOT NULL), '{}')
	 FROM projects p
	 LEFT JOIN project_action_environments pae ON pae.project_id = p.id`

// GetProjectActionScope reads scope configuration within both organization and
// project boundaries. Empty IDs are returned as [] rather than nil.
func (q *Queries) GetProjectActionScope(
	ctx context.Context,
	orgID, projectID string,
) (bool, []string, error) {
	return getProjectActionScope(ctx, q.pool, orgID, projectID)
}

// GetProjectActionScopeTx is GetProjectActionScope on a caller-owned
// transaction, used when a settings PATCH echoes the state it just wrote
// instead of a post-commit read that a concurrent PATCH could overwrite.
func GetProjectActionScopeTx(ctx context.Context, tx pgx.Tx, orgID, projectID string) (bool, []string, error) {
	return getProjectActionScope(ctx, tx, orgID, projectID)
}

func getProjectActionScope(
	ctx context.Context,
	queryer interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	orgID, projectID string,
) (bool, []string, error) {
	var id string
	var enabled bool
	environmentIDs := make([]string, 0)
	err := queryer.QueryRow(ctx,
		actionScopeQuery+`
		 WHERE p.id = $1 AND p.org_id = $2
		 GROUP BY p.id`,
		projectID, orgID,
	).Scan(&id, &enabled, &environmentIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, []string{}, ErrProjectNotFound
	}
	if err != nil {
		return false, []string{}, fmt.Errorf("get project action scope: %w", err)
	}
	if environmentIDs == nil {
		environmentIDs = []string{}
	}
	return enabled, environmentIDs, nil
}

// ActionScope is one project's action-scope state as read for API responses.
type ActionScope struct {
	Enabled        bool
	EnvironmentIDs []string
}

// GetActionScopesByOrg returns every project's action scope for the org in one
// query, keyed by project ID, so list endpoints avoid a per-project read.
func (q *Queries) GetActionScopesByOrg(ctx context.Context, orgID string) (map[string]ActionScope, error) {
	rows, err := q.pool.Query(ctx,
		actionScopeQuery+`
		 WHERE p.org_id = $1
		 GROUP BY p.id`,
		orgID,
	)
	if err != nil {
		return nil, fmt.Errorf("list action scopes: %w", err)
	}
	defer rows.Close()

	scopes := make(map[string]ActionScope)
	for rows.Next() {
		var id string
		var scope ActionScope
		if err := rows.Scan(&id, &scope.Enabled, &scope.EnvironmentIDs); err != nil {
			return nil, fmt.Errorf("scan action scope: %w", err)
		}
		if scope.EnvironmentIDs == nil {
			scope.EnvironmentIDs = []string{}
		}
		scopes[id] = scope
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list action scopes: %w", err)
	}
	return scopes, nil
}
