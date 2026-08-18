package resolve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeExec struct {
	rows int64
	err  error
}

type fakeWatchdogDB struct {
	execs []fakeExec
	calls []struct {
		sql  string
		args []any
	}
}

func (db *fakeWatchdogDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	call := struct {
		sql  string
		args []any
	}{sql, args}
	db.calls = append(db.calls, call)
	idx := len(db.calls) - 1
	if idx >= len(db.execs) {
		return pgconn.NewCommandTag("UPDATE 0"), nil
	}
	if db.execs[idx].err != nil {
		return pgconn.CommandTag{}, db.execs[idx].err
	}
	return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", db.execs[idx].rows)), nil
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
	var orgID, projectID, environmentID string
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

	insertEvent := func(status string, age string) string {
		var eventID string
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
			 VALUES ($1, $2, $3, 2, now() - $4::interval)`,
			projectID, eventID, status, age,
		); err != nil {
			t.Fatal(err)
		}
		return eventID
	}
	agedPending := insertEvent("pending", "30 hours")
	agedFailed := insertEvent("failed", "30 hours")
	freshPending := insertEvent("pending", "1 hour")

	settled, stuck, err := NewWatchdog(pool, 24*time.Hour).Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if settled < 1 {
		t.Errorf("settled = %d, want at least 1", settled)
	}
	if stuck < 1 {
		t.Errorf("stuck = %d, want at least 1", stuck)
	}
	status := func(eventID string) string {
		var s string
		if err := pool.QueryRow(ctx,
			`SELECT status FROM error_event_resolutions WHERE project_id=$1 AND event_id=$2`,
			projectID, eventID,
		).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if s := status(agedPending); s != "no_map" {
		t.Errorf("aged pending status = %q, want no_map", s)
	}
	if s := status(agedFailed); s != "no_map" {
		t.Errorf("aged failed status = %q, want no_map", s)
	}
	if s := status(freshPending); s != "pending" {
		t.Errorf("fresh pending status = %q, want pending", s)
	}
}

func TestWatchdogSettlesStaleUnresolvedEventsOnRaw(t *testing.T) {
	db := &fakeWatchdogDB{execs: []fakeExec{{rows: 1}, {rows: 0}, {rows: 0}}}
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
	if len(db.calls) != 3 {
		t.Fatalf("exec calls = %d, want 3", len(db.calls))
	}
	for i, call := range db.calls {
		if len(call.args) != 1 || call.args[0] != "24h0m0s" {
			t.Errorf("call %d boundary args = %#v, want [24h0m0s]", i, call.args)
		}
	}
	if !strings.Contains(db.calls[0].sql, "'pending'") {
		t.Errorf("first exec should settle pending rows, got: %s", db.calls[0].sql)
	}
	if !strings.Contains(db.calls[1].sql, "'failed'") {
		t.Errorf("second exec should settle failed rows, got: %s", db.calls[1].sql)
	}
	if !strings.Contains(db.calls[2].sql, "INSERT INTO error_event_resolutions") {
		t.Errorf("third exec should materialize resolutions for orphaned identities, got: %s", db.calls[2].sql)
	}
}

func TestWatchdogSettlesAndReportsFailedResolutions(t *testing.T) {
	db := &fakeWatchdogDB{execs: []fakeExec{{rows: 0}, {rows: 2}, {rows: 0}}}
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
	t.Run("settle pending", func(t *testing.T) {
		w := &Watchdog{
			pool:     &fakeWatchdogDB{execs: []fakeExec{{err: errors.New("down")}}},
			boundary: time.Hour,
		}
		if _, _, err := w.Sweep(context.Background()); err == nil {
			t.Fatal("Sweep accepted settle failure")
		}
	})

	t.Run("settle failed", func(t *testing.T) {
		w := &Watchdog{
			pool:     &fakeWatchdogDB{execs: []fakeExec{{rows: 1}, {err: errors.New("down")}}},
			boundary: time.Hour,
		}
		if _, _, err := w.Sweep(context.Background()); err == nil {
			t.Fatal("Sweep accepted stuck-settle failure")
		}
	})
}
