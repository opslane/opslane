package db

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
)

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

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
