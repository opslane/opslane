// Package digest computes and publishes the daily digest.
//
// The module deliberately exposes only Build and RunOnce. Candidate selection,
// aggregation, and outbox publication remain private implementation details.
package digest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	ingestiondb "github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

const (
	listCap         = 3
	receiptCap      = 10
	excerptMax      = 300
	defaultInterval = 5 * time.Minute
	sendHourLocal   = 9
	// Ceiling on one project's build+publish so a slow or contended database
	// cannot stall the whole sweep. Due-ness is derived, so a timeout just
	// means the next tick retries.
	perProjectTimeout = 30 * time.Second
	// Ceiling on the catch-up window after a missed run. See windowFor.
	maxWindowLookback = 7 * 24 * time.Hour
)

type Sweeper struct {
	pool         *pgxpool.Pool
	queries      *ingestiondb.Queries
	dashboardURL string
}

func New(pool *pgxpool.Pool, dashboardURL string) *Sweeper {
	return &Sweeper{pool: pool, queries: ingestiondb.New(pool), dashboardURL: strings.TrimRight(dashboardURL, "/")}
}

func (s *Sweeper) sessionURLAt(sessionID string, anchorMs int64) *string {
	if sessionID == "" || s.dashboardURL == "" {
		return nil
	}
	u := s.dashboardURL + "/sessions/" + url.PathEscape(sessionID) + "?t=" + strconv.FormatInt(anchorMs, 10)
	return &u
}

// replayURLFor resolves the coverage-gated watch pointer best-effort. The
// replay link is optional garnish on a digest item: a transient lookup failure
// must cost one link, never the customer's whole digest.
func (s *Sweeper) replayURLFor(ctx context.Context, groupID, projectID string) *string {
	sessionID, anchorMs, ok, err := s.queries.WatchableSessionForGroup(ctx, groupID, projectID)
	if err != nil {
		slog.Warn("digest replay lookup failed; omitting the link", "group_id", groupID, "project_id", projectID, "error", err)
		return nil
	}
	if !ok {
		return nil
	}
	return s.sessionURLAt(sessionID, anchorMs)
}

func rootCauseExcerpt(rootCause *string) *string {
	if rootCause == nil || strings.TrimSpace(*rootCause) == "" {
		return nil
	}
	text := strings.TrimSpace(*rootCause)
	if i := strings.Index(text, ". "); i > 0 {
		text = text[:i+1]
	}
	runes := []rune(text)
	if len(runes) > 220 {
		text = string(runes[:219]) + "…"
	}
	return &text
}

func capped[T any](items []T) ([]T, bool) {
	if len(items) <= listCap {
		return items, false
	}
	return items[:listCap], true
}

// windowFor returns the reporting window: everything since the previous
// digest's window end, so a late, early, or missed run neither drops nor
// repeats items.
//
// A fixed trailing 24h anchored on run time cannot do this, because the run
// time moves. Prod showed both failure modes: the 08-10 and 08-11 digests
// overlapped by 8h25m (items reported twice), and the 08-13 sweep outage left
// 09:00:01-16:35:54 on 08-13 covered by no digest at all.
//
// Falls back to a trailing 24h when there is no usable prior window: the first
// digest for a project, or a stored value that cannot be trusted.
func (s *Sweeper) windowFor(ctx context.Context, projectID string, now time.Time) (time.Time, time.Time) {
	fallback := now.Add(-24 * time.Hour)
	var stored *string
	err := s.pool.QueryRow(ctx, `
		SELECT payload->'digest'->'window'->>'to'
		  FROM outbound_events
		 WHERE project_id = $1 AND event_type = 'digest.daily'
		 ORDER BY created_at DESC
		 LIMIT 1`, projectID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return fallback, now
	}
	if err != nil {
		slog.Warn("digest: previous window lookup failed; using a trailing 24h", "project_id", projectID, "error", err)
		return fallback, now
	}
	if stored == nil {
		return fallback, now
	}
	previous, parseErr := time.Parse(time.RFC3339Nano, *stored)
	if parseErr != nil {
		slog.Warn("digest: previous window end is unparseable; using a trailing 24h", "project_id", projectID, "value", *stored)
		return fallback, now
	}
	previous = previous.UTC()
	// A stored end at or after now means a clock moved backwards. Reporting a
	// negative window would silently emit an empty digest, so take the 24h.
	if !previous.Before(now) {
		slog.Warn("digest: previous window end is not in the past; using a trailing 24h", "project_id", projectID, "previous", previous, "now", now)
		return fallback, now
	}
	// Bound the catch-up after a long outage. Without this, a sweep that has
	// been down for weeks builds an unbounded window, and exceeding
	// perProjectTimeout would make the digest fail every tick instead of
	// publishing a large one -- turning a gap into a permanent outage.
	if oldest := now.Add(-maxWindowLookback); previous.Before(oldest) {
		slog.Warn("digest: previous window end is older than the lookback cap; truncating",
			"project_id", projectID, "previous", previous, "capped_to", oldest)
		return oldest, now
	}
	return previous, now
}

// Start runs the sweep until cancellation. It is safe to start unconditionally:
// a tick with no subscribed destination selects no candidates and sends nothing.
func (s *Sweeper) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n, err := s.RunOnce(ctx, time.Now().UTC()); err != nil {
				slog.Error("digest sweep failed", "error", err)
			} else if n > 0 {
				slog.Info("digest sweep", "published", n)
			}
		}
	}
}

type candidate struct {
	projectID string
	timezone  string
	hasPrior  bool
	anchor    time.Time
}

func (s *Sweeper) candidates(ctx context.Context) ([]candidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.digest_timezone,
		       EXISTS(SELECT 1 FROM outbound_events oe
		              WHERE oe.project_id = p.id AND oe.event_type = 'digest.daily'),
		       COALESCE((SELECT MIN(st.started_at) FROM sessions st WHERE st.project_id = p.id), p.created_at)
		FROM projects p
		WHERE EXISTS (
			SELECT 1 FROM notification_destinations d
			WHERE d.project_id = p.id AND d.enabled AND 'digest.daily' = ANY(d.event_types)
		)`)
	if err != nil {
		return nil, fmt.Errorf("digest candidates: %w", err)
	}
	defer rows.Close()
	out := make([]candidate, 0)
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.projectID, &c.timezone, &c.hasPrior, &c.anchor); err != nil {
			return nil, fmt.Errorf("digest candidate scan: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("digest candidate rows: %w", err)
	}
	return out, nil
}

// RunOnce publishes at most one digest for each due project. Per-project
// failures are isolated so another project cannot prevent later candidates
// from publishing; derived due-ness retries failed projects on the next tick.
func (s *Sweeper) RunOnce(ctx context.Context, now time.Time) (int, error) {
	candidates, err := s.candidates(ctx)
	if err != nil {
		return 0, err
	}
	published := 0
	for _, candidate := range candidates {
		loc, err := time.LoadLocation(candidate.timezone)
		if err != nil {
			slog.Warn("digest: invalid timezone, skipping project", "project", candidate.projectID, "tz", candidate.timezone)
			continue
		}
		localNow := now.In(loc)
		dedupKey := "digest.daily:" + candidate.projectID + ":" + localNow.Format("2006-01-02")
		var exists bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM outbound_events WHERE project_id=$1 AND dedup_key=$2)`,
			candidate.projectID, dedupKey,
		).Scan(&exists); err != nil {
			slog.Error("digest: dedup check failed", "project", candidate.projectID, "error", err)
			continue
		}
		if exists {
			continue
		}
		if candidate.hasPrior {
			if localNow.Hour() < sendHourLocal {
				continue
			}
		} else if now.Sub(candidate.anchor) < 24*time.Hour {
			continue
		}

		// Bound each project's work. Start passes the process context, which
		// never expires, so an unbounded Build could park a pool connection for
		// the lifetime of the process instead of failing and retrying next tick.
		inserted, err := func() (bool, error) {
			pctx, cancel := context.WithTimeout(ctx, perProjectTimeout)
			defer cancel()
			payload, buildErr := s.Build(pctx, candidate.projectID, now)
			if buildErr != nil {
				return false, fmt.Errorf("build: %w", buildErr)
			}
			return s.publish(pctx, candidate.projectID, dedupKey, payload)
		}()
		if err != nil {
			slog.Error("digest publish failed", "project", candidate.projectID, "error", err)
			continue
		}
		if inserted {
			published++
		}
	}
	return published, nil
}

func (s *Sweeper) publish(ctx context.Context, projectID, dedupKey string, payload notify.EventPayload) (bool, error) {
	if err := payload.Validate(); err != nil {
		return false, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}
	var eventID string
	err = s.pool.QueryRow(ctx, `
		WITH destinations AS (
			SELECT id FROM notification_destinations
			WHERE project_id = $1 AND enabled AND 'digest.daily' = ANY(event_types)
		), event AS (
			INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
			SELECT $1, 'digest.daily', $2, $3::jsonb
			WHERE EXISTS (SELECT 1 FROM destinations)
			ON CONFLICT (project_id, dedup_key) DO NOTHING
			RETURNING id
		), deliveries AS (
			INSERT INTO outbound_deliveries (event_id, destination_id)
			SELECT event.id, destinations.id FROM event CROSS JOIN destinations
			RETURNING 1
		)
		SELECT id FROM event`, projectID, dedupKey, string(body)).Scan(&eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("publish digest: %w", err)
	}
	return true, nil
}
