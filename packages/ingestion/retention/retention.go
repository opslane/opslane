// Package retention removes expired session recordings from storage and Postgres.
package retention

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

const (
	batchSize        = 100
	tombstoneBatch   = 1000
	defaultInterval  = time.Hour
	idleCloseMinutes = 30
	// 30s POST-policy TTL + 30s bounded scrub operation.
	deletionGrace = time.Minute
)

// Sweeper owns one bounded retention pass.
type Sweeper struct {
	Q     *db.Queries
	MinIO *minioPkg.Client
	// IdleCloseMinutes overrides how long a recording session may sit without
	// a chunk before it closes (and its session_analysis job is enqueued).
	// Zero means the 30-minute default.
	IdleCloseMinutes int
}

// resolveInterval picks the tick interval for Start. Only a non-positive
// interval is overridden; deletionGrace is a floor on how long a session waits
// before purge (see SessionsReadyForPurge) and must not bound the tick rate.
func resolveInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultInterval
	}
	return interval
}

// Start closes idle sessions and sweeps expired sessions until cancellation.
func (s *Sweeper) Start(ctx context.Context, interval time.Duration) {
	interval = resolveInterval(interval)
	s.runPass(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runPass(ctx)
		}
	}
}

func (s *Sweeper) runPass(ctx context.Context) {
	idleMinutes := s.IdleCloseMinutes
	if idleMinutes <= 0 {
		idleMinutes = idleCloseMinutes
	}
	if closed, err := s.Q.CloseIdleSessions(ctx, idleMinutes); err != nil {
		slog.Error("close idle sessions failed", "error", err)
	} else if closed > 0 {
		slog.Info("closed idle sessions", "count", closed)
	}
	if deleted, err := s.RunOnce(ctx); err != nil {
		slog.Error("retention sweep failed", "error", err)
	} else if deleted > 0 {
		slog.Info("retention sweep", "sessions_deleted", deleted)
	}
}

// RunOnce first tombstones expiry candidates, then purges sessions whose
// pre-existing upload policies and scrub leases have expired.
func (s *Sweeper) RunOnce(ctx context.Context) (int, error) {
	if s.Q == nil || s.MinIO == nil {
		return 0, errors.New("retention dependencies are not configured")
	}
	sessions, err := s.Q.SessionsToDelete(ctx, batchSize)
	if err != nil {
		return 0, err
	}

	for _, session := range sessions {
		if err := s.Q.MarkSessionDeleting(ctx, session.ID, session.ProjectID); err != nil {
			slog.Error("mark session deleting failed", "error", err, "session_id", session.ID)
		}
	}

	ready, err := s.Q.SessionsReadyForPurge(ctx, deletionGrace, batchSize)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, session := range ready {
		if err := s.MinIO.RemovePrefix(ctx, sessionPrefix(session)); err != nil {
			slog.Error("remove session objects failed", "error", err, "session_id", session.ID)
			continue
		}
		if err := s.Q.DeleteMarkedSession(ctx, session.ID, session.ProjectID); err != nil {
			slog.Error("delete session failed", "error", err, "session_id", session.ID)
			continue
		}
		deleted++
	}
	if err := s.sweepDeletedPrefixes(ctx); err != nil {
		return deleted, err
	}
	return deleted, nil
}

func sessionPrefix(session db.SessionRef) string {
	return fmt.Sprintf("sessions/%s/%s/", session.ProjectID, session.ID)
}

// An ingestion-owned storage write already in flight during deletion can
// finish after the initial purge. Tombstones are permanent, so rotate through
// their prefixes on every pass and make any such late object temporary rather
// than permanently orphaned.
func (s *Sweeper) sweepDeletedPrefixes(ctx context.Context) error {
	tombstones, err := s.Q.ClaimTombstonesForStorageSweep(ctx, tombstoneBatch)
	if err != nil {
		return err
	}
	for _, tombstone := range tombstones {
		if err := s.MinIO.RemovePrefix(ctx, sessionPrefix(tombstone)); err != nil {
			slog.Error("re-sweep tombstoned session failed", "error", err, "session_id", tombstone.ID)
			_ = s.Q.ReleaseTombstoneStorageSweep(ctx, tombstone.ID, tombstone.ProjectID)
			continue
		}
		if err := s.Q.MarkTombstoneStorageSwept(ctx, tombstone.ID, tombstone.ProjectID); err != nil {
			slog.Error("mark tombstone storage sweep failed", "error", err, "session_id", tombstone.ID)
		}
	}
	return nil
}
