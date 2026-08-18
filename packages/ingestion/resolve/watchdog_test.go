package resolve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeRow struct {
	count int
	err   error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*int)) = r.count
	return nil
}

type fakeWatchdogDB struct {
	settled int64
	stuck   int
	execErr error
	rowErr  error
	args    []any
}

func (db *fakeWatchdogDB) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	db.args = args
	if db.execErr != nil {
		return pgconn.CommandTag{}, db.execErr
	}
	return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", db.settled)), nil
}

func TestWatchdogSettlesStaleUnresolvedEventsInDatabase(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("skipping DB test: cannot connect to postgres: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("skipping DB test: postgres not reachable: %v", err)
	}
	t.Cleanup(pool.Close)

	ctx := context.Background()
	var orgID, projectID, environmentID, eventID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
		"resolve-watchdog-"+time.Now().UTC().Format("20060102150405.000000000"),
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_events WHERE project_id=$1`, projectID)
		_, _ = pool.Exec(context.Background(), `UPDATE projects SET default_environment_id=NULL WHERE id=$1`, projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM environments WHERE project_id=$1`, projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM projects WHERE id=$1`, projectID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orgs WHERE id=$1`, orgID)
	})
	if err := pool.QueryRow(ctx,
		`INSERT INTO projects (org_id, name) VALUES ($1, 'resolve-watchdog') RETURNING id`,
		orgID,
	).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`,
		projectID,
	).Scan(&environmentID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_events
		   (project_id, environment_id, timestamp, error_type, error_message, stack_trace_raw)
		 VALUES ($1, $2, now(), 'TypeError', 'boom', 'at app.js:1:1')
		 RETURNING id`,
		projectID, environmentID,
	).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO error_event_resolutions
		   (project_id, event_id, status, resolver_version, resolved_at)
		 VALUES ($1, $2, 'pending', 2, now() - interval '30 hours')`,
		projectID, eventID,
	); err != nil {
		t.Fatal(err)
	}

	settled, _, err := NewWatchdog(pool, 24*time.Hour).Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if settled < 1 {
		t.Errorf("settled = %d, want at least 1", settled)
	}
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM error_event_resolutions WHERE project_id=$1 AND event_id=$2`,
		projectID, eventID,
	).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "no_map" {
		t.Errorf("status = %q, want no_map", status)
	}
}

func (db *fakeWatchdogDB) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	return fakeRow{count: db.stuck, err: db.rowErr}
}

func TestWatchdogSettlesStaleUnresolvedEventsOnRaw(t *testing.T) {
	db := &fakeWatchdogDB{settled: 1}
	w := &Watchdog{pool: db, boundary: 24 * time.Hour}

	settled, stuck, err := w.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if settled != 1 {
		t.Errorf("settled = %d, want 1", settled)
	}
	if stuck != 0 {
		t.Errorf("stuck = %d, want 0", stuck)
	}
	if len(db.args) != 1 || db.args[0] != "24h0m0s" {
		t.Errorf("boundary args = %#v, want [24h0m0s]", db.args)
	}
}

func TestWatchdogReportsFailedResolutions(t *testing.T) {
	db := &fakeWatchdogDB{stuck: 2}
	w := &Watchdog{pool: db, boundary: 24 * time.Hour}

	settled, stuck, err := w.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if settled != 0 || stuck != 2 {
		t.Errorf("Sweep = (%d, %d), want (0, 2)", settled, stuck)
	}
}

func TestWatchdogReturnsDatabaseErrors(t *testing.T) {
	t.Run("settle", func(t *testing.T) {
		w := &Watchdog{pool: &fakeWatchdogDB{execErr: errors.New("down")}, boundary: time.Hour}
		if _, _, err := w.Sweep(context.Background()); err == nil {
			t.Fatal("Sweep accepted settle failure")
		}
	})

	t.Run("count", func(t *testing.T) {
		w := &Watchdog{pool: &fakeWatchdogDB{rowErr: errors.New("down")}, boundary: time.Hour}
		if _, _, err := w.Sweep(context.Background()); err == nil {
			t.Fatal("Sweep accepted count failure")
		}
	})
}
