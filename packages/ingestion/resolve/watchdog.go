package resolve

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type watchdogDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
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

	if err := w.pool.QueryRow(ctx,
		`SELECT count(*)
		   FROM error_event_resolutions
		  WHERE status = 'failed'
		    AND resolved_at < now() - $1::interval`,
		w.boundary.String()).Scan(&stuck); err != nil {
		return 0, 0, fmt.Errorf("count stuck resolutions: %w", err)
	}
	if stuck > 0 {
		slog.Warn("resolution jobs stuck", "count", stuck)
	}
	return int(tag.RowsAffected()), stuck, nil
}
