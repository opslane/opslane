package identity

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	settlementBatchSize = 100
	settlementLease     = 5 * time.Minute
)

type Loop struct {
	pool      *pgxpool.Pool
	projectID string
}

func NewLoop(pool *pgxpool.Pool) *Loop {
	return &Loop{pool: pool}
}

// Tick resets expired leases, claims a bounded batch, and settles each claimed
// observation. The status transition is the durable claim; SKIP LOCKED lets
// every ingestion replica claim a different batch without waiting.
func (l *Loop) Tick(ctx context.Context) error {
	if err := l.resetAbandoned(ctx); err != nil {
		return err
	}
	rows, err := l.pool.Query(ctx,
		`UPDATE error_event_identities i
		    SET status='settling',claimed_at=now()
		  WHERE (i.project_id,i.event_id) IN (
		        SELECT i2.project_id,i2.event_id
		          FROM error_event_identities i2
		          JOIN error_event_resolutions r
		            ON r.project_id=i2.project_id AND r.event_id=i2.event_id
		         WHERE i2.status='pending' AND r.status IN ('resolved','no_map')
		           AND ($2='' OR i2.project_id::text=$2)
		         ORDER BY i2.event_id
		         LIMIT $1
		         FOR UPDATE OF i2 SKIP LOCKED)
		 RETURNING i.project_id::text,i.event_id::text`, settlementBatchSize, l.projectID)
	if err != nil {
		return fmt.Errorf("claim identity settlement batch: %w", err)
	}
	type observationRef struct {
		projectID string
		eventID   string
	}
	batch := make([]observationRef, 0, settlementBatchSize)
	for rows.Next() {
		var ref observationRef
		if err := rows.Scan(&ref.projectID, &ref.eventID); err != nil {
			rows.Close()
			return fmt.Errorf("read claimed identity: %w", err)
		}
		batch = append(batch, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read identity settlement batch: %w", err)
	}
	rows.Close()

	var settlementErrors []error
	for _, ref := range batch {
		if _, err := Settle(ctx, l.pool, ref.projectID, ref.eventID); err != nil {
			slog.Error("identity settlement failed",
				"project_id", ref.projectID, "event_id", ref.eventID, "error", err)
			settlementErrors = append(settlementErrors,
				fmt.Errorf("settle event %s: %w", ref.eventID, err))
		}
	}
	return errors.Join(settlementErrors...)
}

func (l *Loop) resetAbandoned(ctx context.Context) error {
	_, err := l.pool.Exec(ctx,
		`UPDATE error_event_identities
		    SET status='pending',claimed_at=NULL
		  WHERE status='settling' AND claimed_at < now()-$1::interval
		    AND ($2='' OR project_id::text=$2)`,
		settlementLease.String(), l.projectID)
	if err != nil {
		return fmt.Errorf("reset abandoned identity settlements: %w", err)
	}
	return nil
}

func (l *Loop) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	run := func() {
		if err := l.Tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("identity settlement tick failed", "error", err)
		}
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
