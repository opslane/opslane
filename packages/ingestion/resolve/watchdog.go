package resolve

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type watchdogDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// Watchdog settles resolution work that cannot wait indefinitely and reports
// failed work that still needs operator attention.
type Watchdog struct {
	pool     watchdogDB
	boundary time.Duration
}

func NewWatchdog(pool *pgxpool.Pool, boundary time.Duration) *Watchdog {
	return &Watchdog{pool: pool, boundary: boundary}
}

// Start runs Sweep on the given interval until ctx is cancelled. A sweep
// failure is logged and retried at the next tick; it never stops the loop.
func (w *Watchdog) Start(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			settled, _, err := w.Sweep(ctx)
			if err != nil {
				slog.Error("resolve watchdog sweep failed", "error", err)
			} else if settled > 0 {
				slog.Info("resolve watchdog settled stale resolutions", "settled", settled)
			}
		}
	}
}

// Sweep settles events whose source map never arrived. Waiting forever would
// let a bug fragment indefinitely while looking smaller than it is.
//
// Stale 'failed' rows settle the same way: a resolution can freeze at
// 'failed' when the job's final attempt never runs its handler (a lease
// expiry dead-letters it in the reaper), and nothing else would ever move
// the row. Settling is the explicit raw fallback the architecture requires;
// the warning keeps the exhaustion visible to the operator.
func (w *Watchdog) Sweep(ctx context.Context) (settledRaw int, stuck int, err error) {
	tag, err := w.pool.Exec(ctx,
		`UPDATE error_event_resolutions
		    SET status = 'no_map', resolved_at = now()
		  WHERE status = 'pending'
		    AND resolved_at < now() - $1::interval`,
		w.boundary.String())
	if err != nil {
		return 0, 0, fmt.Errorf("settle stale resolutions: %w", err)
	}

	failedTag, err := w.pool.Exec(ctx,
		`UPDATE error_event_resolutions
		    SET status = 'no_map', resolved_at = now()
		  WHERE status = 'failed'
		    AND resolved_at < now() - $1::interval`,
		w.boundary.String())
	if err != nil {
		return 0, 0, fmt.Errorf("settle stuck resolutions: %w", err)
	}
	stuck = int(failedTag.RowsAffected())

	// A resolve job that dead-letters before its first write leaves an event
	// with a pending identity and NO resolution row: invisible to the wake
	// path, the settle claim, and the updates above, so identity would wait
	// forever. Past the boundary, materialize the explicit raw fallback.
	orphanTag, err := w.pool.Exec(ctx,
		`INSERT INTO error_event_resolutions
		   (project_id, event_id, status, resolver_version)
		 SELECT i.project_id, i.event_id, 'no_map', i.identity_version
		   FROM error_event_identities i
		   JOIN error_events e
		     ON e.project_id = i.project_id AND e.id = i.event_id
		  WHERE i.status = 'pending'
		    AND e.created_at < now() - $1::interval
		    AND NOT EXISTS (
		      SELECT 1 FROM error_event_resolutions r
		      WHERE r.project_id = i.project_id AND r.event_id = i.event_id)
		 ON CONFLICT (project_id, event_id) DO NOTHING`,
		w.boundary.String())
	if err != nil {
		return 0, 0, fmt.Errorf("settle resolution-less identities: %w", err)
	}
	if n := orphanTag.RowsAffected(); n > 0 {
		slog.Warn("resolutions materialized for orphaned identities", "count", n)
	}
	if stuck > 0 {
		slog.Warn("resolution jobs stuck", "count", stuck)
	}
	settledRaw = int(tag.RowsAffected()) + int(orphanTag.RowsAffected())
	return settledRaw, stuck, nil
}
