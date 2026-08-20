package digest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ASCII "digest3". The legacy sweeper has no advisory lock; this key belongs
// only to the frozen-run state machine.
const schedulerAdvisoryLockKey int64 = 0x64696765737433

type Scheduler struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewScheduler(pool *pgxpool.Pool) *Scheduler {
	return &Scheduler{pool: pool, now: func() time.Time { return time.Now().UTC() }}
}

type scheduledProject struct {
	id       string
	timezone string
}

// Tick advances at most one project-local daily run per project. Durable run
// status is the handoff between Go and the asynchronous TypeScript writer.
func (s *Scheduler) Tick(ctx context.Context) error {
	if s.pool == nil {
		return errors.New("digest scheduler pool is not configured")
	}
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire digest scheduler connection: %w", err)
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, schedulerAdvisoryLockKey).Scan(&locked); err != nil {
		return fmt.Errorf("lock digest scheduler: %w", err)
	}
	if !locked {
		return nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, schedulerAdvisoryLockKey)
	}()

	projects, err := s.projects(ctx)
	if err != nil {
		return err
	}
	now := s.now()
	for _, project := range projects {
		location, err := time.LoadLocation(project.timezone)
		if err != nil {
			slog.Error("digest project has invalid timezone", "project_id", project.id, "timezone", project.timezone, "error", err)
			continue
		}
		local := now.In(location)
		if local.Hour() < sendHourLocal {
			continue
		}
		boundaryLocal := time.Date(local.Year(), local.Month(), local.Day(), sendHourLocal, 0, 0, 0, location)
		boundary := boundaryLocal.UTC()
		runID, _, err := FreezeCandidates(ctx, s.pool, project.id, boundary)
		if err != nil {
			slog.Error("digest freeze failed", "project_id", project.id, "error", err)
			continue
		}
		var status string
		if err := s.pool.QueryRow(ctx, `SELECT status FROM digest_runs WHERE project_id=$1 AND id=$2`, project.id, runID).Scan(&status); err != nil {
			slog.Error("digest status lookup failed", "project_id", project.id, "run_id", runID, "error", err)
			continue
		}
		switch status {
		case "frozen", "failed":
			if err := s.enqueueWrite(ctx, project.id, runID); err != nil {
				slog.Error("digest writer enqueue failed", "project_id", project.id, "run_id", runID, "error", err)
			}
		case "written", "validated":
			if err := ValidateAndPublish(ctx, s.pool, runID); err != nil {
				slog.Error("digest publication failed", "project_id", project.id, "run_id", runID, "error", err)
			}
		}
	}
	return nil
}

func (s *Scheduler) projects(ctx context.Context) ([]scheduledProject, error) {
	rows, err := s.pool.Query(ctx, `SELECT p.id::text,p.digest_timezone FROM projects p
		WHERE EXISTS (SELECT 1 FROM notification_destinations destination
		 WHERE destination.project_id=p.id AND destination.enabled
		   AND 'digest.daily'=ANY(destination.event_types)) ORDER BY p.id`)
	if err != nil {
		return nil, fmt.Errorf("list scheduled digest projects: %w", err)
	}
	defer rows.Close()
	projects := make([]scheduledProject, 0)
	for rows.Next() {
		var project scheduledProject
		if err := rows.Scan(&project.id, &project.timezone); err != nil {
			return nil, fmt.Errorf("scan scheduled digest project: %w", err)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read scheduled digest projects: %w", err)
	}
	return projects, nil
}

// maxWritesPerRun bounds model spend on one frozen run. A publication failure
// that is permanent for the day -- an episode closed after the freeze, a
// destination disabled, a link that fails the repository check -- marks the run
// failed, and the frozen/failed arm above would otherwise re-enqueue a fresh
// write every tick, paying for a model call each time and never delivering.
// Retries still cover transient failures; the next daily boundary opens a new
// run with a new budget.
const maxWritesPerRun = 3

func (s *Scheduler) enqueueWrite(ctx context.Context, projectID, runID string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO error_group_jobs
		(project_id,run_id,job_type,status,triggered_by)
		SELECT $1,$2,'digest_write','pending','auto'
		WHERE NOT EXISTS (SELECT 1 FROM error_group_jobs
		 WHERE project_id=$1 AND run_id=$2 AND job_type='digest_write'
		   AND status IN ('pending','claimed'))
		  AND (SELECT count(*) FROM error_group_jobs
		        WHERE project_id=$1 AND run_id=$2 AND job_type='digest_write') < $3`,
		projectID, runID, maxWritesPerRun)
	return err
}

func (s *Scheduler) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultInterval
	}
	run := func() {
		if err := s.Tick(ctx); err != nil {
			slog.Error("digest scheduler failed", "error", err)
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
