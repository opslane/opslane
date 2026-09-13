package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var ErrTicketUnarchive = errors.New("known problems cannot be unarchived")
var ErrTicketGeneration = errors.New("incident is no longer the current publication")

func lockFrictionPublication(ctx context.Context, tx pgx.Tx, environmentID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('friction_publish|'||$1))`, environmentID)
	return err
}

func lockTicketPublication(ctx context.Context, tx pgx.Tx, projectID, groupID string) error {
	var environment string
	if err := tx.QueryRow(ctx, `SELECT t.environment_id FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id
		WHERE g.id=$1 AND g.project_id=$2 AND t.project_id=$2`, groupID, projectID).Scan(&environment); err != nil {
		return err
	}
	return lockFrictionPublication(ctx, tx, environment)
}

// SetSessionIdentity is the internal identity/consolidation seam. The database
// serializes it with matching and publication and reconciles before committing.
func (q *Queries) SetSessionIdentity(ctx context.Context, sessionID, projectID string, endUserID *string) error {
	_, err := q.pool.Exec(ctx, `SELECT friction_set_session_identity($1,$2,$3)`, projectID, sessionID, endUserID)
	if err != nil {
		return fmt.Errorf("set session identity: %w", err)
	}
	return nil
}

func (q *Queries) archiveTicketGroup(ctx context.Context, projectID, groupID string) (bool, error) {
	var ticketID *string
	if err := q.pool.QueryRow(ctx, `SELECT ticket_id FROM error_groups WHERE id=$1 AND project_id=$2`, groupID, projectID).Scan(&ticketID); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	if ticketID == nil {
		return false, nil
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return true, err
	}
	defer tx.Rollback(ctx)
	if err := lockTicketPublication(ctx, tx, projectID, groupID); err != nil {
		return true, err
	}
	var status string
	var live, generation int
	if err := tx.QueryRow(ctx, `SELECT t.status,t.live_generation,g.publication_generation
		FROM friction_tickets t JOIN error_groups g ON g.ticket_id=t.id
		WHERE t.id=$1 AND t.project_id=$2 AND g.id=$3 AND g.project_id=$2 FOR UPDATE OF t,g`, *ticketID, projectID, groupID).Scan(&status, &live, &generation); err != nil {
		return true, err
	}
	if status == "archived" {
		return true, tx.Commit(ctx)
	}
	if live != generation {
		return true, ErrTicketGeneration
	}
	for _, statement := range []string{
		`UPDATE friction_tickets SET status='archived',steps=NULL,reconcile_needed=false,reinvestigate_needed=false,updated_at=now() WHERE id=$1`,
		`UPDATE error_groups SET status_before_archive=status,status='archived',archived_at=now(),representative_signal_id=NULL,representative_session_id=NULL,updated_at=now() WHERE ticket_id=$1 AND status<>'archived'`,
		`UPDATE error_group_jobs SET status='failed',last_error='Problem archived',lease_expires_at=NULL,updated_at=now() WHERE ticket_id=$1 AND status IN ('pending','claimed')`,
		`UPDATE friction_fix_attempts SET status='superseded',updated_at=now() WHERE ticket_id=$1 AND status IN ('active','pr_open')`,
		`UPDATE friction_confirm_batches SET status='discarded' WHERE ticket_id=$1 AND status='staging'`,
		`UPDATE digest_card_copy SET invalidated_at=now() WHERE error_group_id IN (SELECT id FROM error_groups WHERE ticket_id=$1) AND invalidated_at IS NULL`,
	} {
		if _, err := tx.Exec(ctx, statement, *ticketID); err != nil {
			return true, err
		}
	}
	return true, tx.Commit(ctx)
}
