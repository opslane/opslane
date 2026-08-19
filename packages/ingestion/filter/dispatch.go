package filter

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/identity"
)

// ASCII "filter". This differs from every other background sweeper lock.
const sweepAdvisoryLockKey int64 = 0x66696c746572

// sweepBatchLimit bounds one tick's work so a fleet-wide backlog (a rule
// version bump marks every open episode stale at once) drains across ticks
// instead of holding the advisory lock for one unbounded serial pass.
const sweepBatchLimit = 500

type Dispatcher struct {
	pool      *pgxpool.Pool
	projectID string
}

type episodeRef struct {
	projectID string
	episodeID string
}

func NewDispatcher(pool *pgxpool.Pool) *Dispatcher {
	return &Dispatcher{pool: pool}
}

// Tick evaluates stale open episodes, freezes evidence for newly admitted
// work, and enqueues one inquiry per episode. A fleet-wide advisory lock keeps
// replicas from repeating the read-heavy sweep.
func (d *Dispatcher) Tick(ctx context.Context) (evaluated, enqueued int, err error) {
	if d.pool == nil {
		return 0, 0, errors.New("filter dispatcher pool is not configured")
	}
	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("acquire filter sweep connection: %w", err)
	}
	defer conn.Release()

	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, sweepAdvisoryLockKey).Scan(&locked); err != nil {
		return 0, 0, fmt.Errorf("lock filter sweep: %w", err)
	}
	if !locked {
		return 0, 0, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, sweepAdvisoryLockKey)
	}()

	if err := d.closeResolvedEpisodes(ctx); err != nil {
		return 0, 0, err
	}
	episodes, err := d.staleEpisodes(ctx)
	if err != nil {
		return 0, 0, err
	}
	for _, episode := range episodes {
		if ctx.Err() != nil {
			return evaluated, 0, ctx.Err()
		}
		if _, err := Evaluate(ctx, d.pool, episode.projectID, episode.episodeID); err != nil {
			slog.Error("filter evaluation failed",
				"project_id", episode.projectID, "episode_id", episode.episodeID, "error", err)
			continue
		}
		evaluated++
	}

	admitted, err := d.admittedWithoutInquiry(ctx)
	if err != nil {
		return evaluated, 0, err
	}
	for _, episode := range admitted {
		if ctx.Err() != nil {
			return evaluated, enqueued, ctx.Err()
		}
		inserted, err := d.admitOne(ctx, episode.projectID, episode.episodeID)
		if err != nil {
			slog.Error("filter admission failed",
				"project_id", episode.projectID, "episode_id", episode.episodeID, "error", err)
			continue
		}
		if inserted {
			enqueued++
		}
	}
	return evaluated, enqueued, nil
}

func (d *Dispatcher) closeResolvedEpisodes(ctx context.Context) error {
	_, err := d.pool.Exec(ctx,
		`UPDATE issue_episodes ep SET closed_at=COALESCE(g.resolved_at,now())
		   FROM error_groups g
		  WHERE ep.project_id=g.project_id AND ep.canonical_issue_id=g.id
		    AND ep.closed_at IS NULL AND g.status IN ('resolved','merged','archived')
		    AND ($1='' OR ep.project_id::text=$1)`, d.projectID)
	if err != nil {
		return fmt.Errorf("close resolved filter episodes: %w", err)
	}
	return nil
}

func (d *Dispatcher) staleEpisodes(ctx context.Context) ([]episodeRef, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT ep.project_id::text,ep.id::text
		  FROM issue_episodes ep
		  LEFT JOIN LATERAL (
		    SELECT decision,rule_version,decided_at
		      FROM issue_decisions d
		     WHERE d.project_id=ep.project_id AND d.episode_id=ep.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) latest ON true
		 WHERE ep.closed_at IS NULL
		   AND ($1='' OR ep.project_id::text=$1)
		   AND (
		     latest.decision IS NULL
		     OR latest.rule_version < $2
		     -- Liveness flip only: a quiet watch/open_inquiry must eventually
		     -- turn inactive, but once it has, only new evidence (the EXISTS
		     -- below) re-evaluates it. Without the decision guard every quiet
		     -- episode is re-locked on every tick forever, because unchanged
		     -- outcomes append nothing and decided_at never advances.
		     OR (latest.decided_at < now()-interval '7 days' AND latest.decision <> 'inactive')
		     OR EXISTS (
		       SELECT 1 FROM error_event_identities i
		        WHERE i.project_id=ep.project_id AND i.episode_id=ep.id
		          AND i.status='settled' AND i.settled_at > latest.decided_at
		     )
		   )
		 ORDER BY ep.opened_at,ep.id
		 LIMIT $3`, d.projectID, RuleVersion, sweepBatchLimit)
	if err != nil {
		return nil, fmt.Errorf("list stale filter episodes: %w", err)
	}
	defer rows.Close()
	var episodes []episodeRef
	for rows.Next() {
		var episode episodeRef
		if err := rows.Scan(&episode.projectID, &episode.episodeID); err != nil {
			return nil, fmt.Errorf("scan stale filter episode: %w", err)
		}
		episodes = append(episodes, episode)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read stale filter episodes: %w", err)
	}
	return episodes, nil
}

func (d *Dispatcher) admittedWithoutInquiry(ctx context.Context) ([]episodeRef, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT ep.project_id::text,ep.id::text
		  FROM issue_episodes ep
		  JOIN LATERAL (
		    SELECT decision
		      FROM issue_decisions d
		     WHERE d.project_id=ep.project_id AND d.episode_id=ep.id
		     ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
		  ) latest ON true
		 WHERE ep.closed_at IS NULL AND latest.decision='open_inquiry'
		   AND ($1='' OR ep.project_id::text=$1)
		   AND NOT EXISTS (
		     SELECT 1 FROM error_group_jobs j
		      WHERE j.project_id=ep.project_id AND j.episode_id=ep.id
		        AND j.job_type='issue_inquiry'
		   )
		 ORDER BY ep.opened_at,ep.id
		 LIMIT $2`, d.projectID, sweepBatchLimit)
	if err != nil {
		return nil, fmt.Errorf("list admitted filter episodes: %w", err)
	}
	defer rows.Close()
	var episodes []episodeRef
	for rows.Next() {
		var episode episodeRef
		if err := rows.Scan(&episode.projectID, &episode.episodeID); err != nil {
			return nil, fmt.Errorf("scan admitted filter episode: %w", err)
		}
		episodes = append(episodes, episode)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read admitted filter episodes: %w", err)
	}
	return episodes, nil
}

func (d *Dispatcher) admitOne(ctx context.Context, projectID, episodeID string) (bool, error) {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin filter admission: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var issueID, latestDecision string
	if err := tx.QueryRow(ctx, `
		SELECT ep.canonical_issue_id::text,
		       (SELECT d.decision FROM issue_decisions d
		         WHERE d.project_id=ep.project_id AND d.episode_id=ep.id
		         ORDER BY d.decided_at DESC,d.id DESC LIMIT 1)
		  FROM issue_episodes ep
		 WHERE ep.project_id=$1 AND ep.id=$2 AND ep.closed_at IS NULL
		 FOR UPDATE`, projectID, episodeID).Scan(&issueID, &latestDecision); err != nil {
		return false, fmt.Errorf("lock admitted filter episode: %w", err)
	}
	if latestDecision != "open_inquiry" {
		return false, fmt.Errorf("episode %s is no longer admitted", episodeID)
	}
	if err := identity.FreezeAnchors(ctx, tx, projectID, episodeID); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx,
		`INSERT INTO error_group_jobs
		   (error_group_id,project_id,episode_id,job_type,status,input_version)
		 VALUES ($1,$2,$3,'issue_inquiry','pending',$4)
		 ON CONFLICT DO NOTHING`, issueID, projectID, episodeID, RuleVersion)
	if err != nil {
		return false, fmt.Errorf("enqueue issue inquiry: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit filter admission: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (d *Dispatcher) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	run := func() {
		evaluated, enqueued, err := d.Tick(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("filter sweep failed", "error", err)
			return
		}
		if evaluated > 0 || enqueued > 0 {
			slog.Info("filter sweep", "episodes_evaluated", evaluated, "inquiries_enqueued", enqueued)
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
