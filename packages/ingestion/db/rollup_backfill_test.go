package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func rollupBackfillTestDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, migration := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, migration); err != nil {
			t.Fatalf("apply migration %s: %v", migration, err)
		}
	}
	return db.New(pool), pool
}

func TestRollupBackfillRecomputesExactSourceAggregatesAndIsIdempotent(t *testing.T) {
	q, pool := rollupBackfillTestDB(t)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "rollup-backfill-exact")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "rollup-backfill-exact", ptrStr("org/rollup-backfill"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	production, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment production: %v", err)
	}
	staging, err := q.CreateEnvironment(ctx, project.ID, "staging")
	if err != nil {
		t.Fatalf("CreateEnvironment staging: %v", err)
	}

	base := time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC)
	var groupID string
	for i, occurrence := range []struct {
		environmentID string
		at            time.Time
	}{
		{production.ID, base},
		{production.ID, base.Add(2 * time.Hour)},
		{staging.ID, base.Add(time.Hour)},
	} {
		result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID:            project.ID,
			DefaultEnvironmentID: occurrence.environmentID,
			ErrorType:            "TypeError",
			ErrorMessage:         "backfill",
			StackTraceRaw:        "at app.js:1:1",
			Fingerprint:          "fp-rollup-backfill",
			Title:                "TypeError: backfill",
			EventTime:            occurrence.at,
		})
		if err != nil {
			t.Fatalf("InsertErrorEventAndGroup %d: %v", i, err)
		}
		groupID = result.GroupID
	}

	if err := q.InsertSession(ctx, "session-rollup-backfill", project.ID, staging.ID, nil, base, "/checkout"); err != nil {
		t.Fatalf("InsertSession: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO friction_signals
		  (session_id, project_id, environment_id, rule_version, signal_type,
		   fingerprint, page_url_normalized, occurred_at, occurrence_count,
		   incident_id, adjudication_status)
		VALUES ($1, $2, $3, 1, 'rage_click', 'friction-folded', '/checkout', $4, 3, $5, 'accepted')`,
		"session-rollup-backfill", project.ID, staging.ID, base.Add(3*time.Hour), groupID,
	); err != nil {
		t.Fatalf("insert folded friction signal: %v", err)
	}

	// Prove this is an absolute recompute, not an additive repair.
	if _, err := pool.Exec(ctx, `
		UPDATE error_group_environments
		SET first_seen = '2000-01-01', last_seen = '2100-01-01', occurrence_count = 999
		WHERE error_group_id = $1`, groupID); err != nil {
		t.Fatalf("corrupt rollup: %v", err)
	}

	ran, err := q.RunRollupBackfill(ctx)
	if err != nil {
		t.Fatalf("RunRollupBackfill: %v", err)
	}
	if !ran {
		t.Fatal("RunRollupBackfill reported it did not run")
	}

	type row struct {
		first time.Time
		last  time.Time
		count int64
	}
	got := make(map[string]row)
	rows, err := pool.Query(ctx, `
		SELECT environment_id, first_seen, last_seen, occurrence_count
		FROM error_group_environments
		WHERE error_group_id = $1`, groupID)
	if err != nil {
		t.Fatalf("query recomputed rollup: %v", err)
	}
	for rows.Next() {
		var environmentID string
		var value row
		if err := rows.Scan(&environmentID, &value.first, &value.last, &value.count); err != nil {
			rows.Close()
			t.Fatalf("scan recomputed rollup: %v", err)
		}
		got[environmentID] = value
	}
	rows.Close()
	if len(got) != 2 {
		t.Fatalf("rollup rows = %d, want 2: %#v", len(got), got)
	}
	if value := got[production.ID]; value.count != 2 || !value.first.Equal(base) || !value.last.Equal(base.Add(2*time.Hour)) {
		t.Fatalf("production rollup = %+v", value)
	}
	if value := got[staging.ID]; value.count != 4 || !value.first.Equal(base.Add(time.Hour)) || !value.last.Equal(base.Add(3*time.Hour)) {
		t.Fatalf("staging rollup = %+v", value)
	}

	var state string
	if err := pool.QueryRow(ctx, `SELECT status FROM rollup_backfill_state WHERE id`).Scan(&state); err != nil {
		t.Fatalf("query state: %v", err)
	}
	if state != "complete" {
		t.Fatalf("state = %q, want complete", state)
	}
	var passOne, passTwo int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE pass = 1), count(*) FILTER (WHERE pass = 2)
		FROM rollup_backfill_ledger`).Scan(&passOne, &passTwo); err != nil {
		t.Fatalf("query ledger: %v", err)
	}
	if passOne == 0 || passTwo == 0 || passOne != passTwo {
		t.Fatalf("ledger pass counts = (%d, %d), want equal non-zero reconciliation passes", passOne, passTwo)
	}

	before := got
	ran, err = q.RunRollupBackfill(ctx)
	if err != nil || ran {
		t.Fatalf("second RunRollupBackfill = (ran=%v, err=%v), want completed no-op", ran, err)
	}
	var afterCount int64
	if err := pool.QueryRow(ctx,
		`SELECT occurrence_count FROM error_group_environments WHERE error_group_id = $1 AND environment_id = $2`,
		groupID, production.ID,
	).Scan(&afterCount); err != nil {
		t.Fatalf("query rollup after replay: %v", err)
	}
	if afterCount != before[production.ID].count {
		t.Fatalf("replay changed production count from %d to %d", before[production.ID].count, afterCount)
	}
}

func TestRollupBackfillCompletesOnFreshDatabase(t *testing.T) {
	q, pool := rollupBackfillTestDB(t)
	ctx := context.Background()

	ran, err := q.RunRollupBackfill(ctx)
	if err != nil || !ran {
		t.Fatalf("RunRollupBackfill = (ran=%v, err=%v), want successful run", ran, err)
	}
	var state string
	if err := pool.QueryRow(ctx, `SELECT status FROM rollup_backfill_state WHERE id`).Scan(&state); err != nil {
		t.Fatalf("query state: %v", err)
	}
	if state != "complete" {
		t.Fatalf("state = %q, want complete", state)
	}
	var ledgerRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM rollup_backfill_ledger`).Scan(&ledgerRows); err != nil {
		t.Fatalf("query ledger: %v", err)
	}
	if ledgerRows != 0 {
		t.Fatalf("fresh database ledger rows = %d, want 0", ledgerRows)
	}
}

func TestRollupBackfillAllowsOnlyOneRunner(t *testing.T) {
	q, pool := rollupBackfillTestDB(t)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "rollup-backfill-single-runner")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "rollup-backfill-single-runner", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}
	result, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "single runner",
		StackTraceRaw:        "at app.js:1:1",
		Fingerprint:          "fp-rollup-single-runner",
		Title:                "TypeError: single runner",
	})
	if err != nil {
		t.Fatalf("InsertErrorEventAndGroup: %v", err)
	}

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx,
		`SELECT id FROM error_groups WHERE id = $1 FOR UPDATE`, result.GroupID,
	); err != nil {
		t.Fatalf("lock group: %v", err)
	}

	type runResult struct {
		ran bool
		err error
	}
	firstDone := make(chan runResult, 1)
	go func() {
		ran, err := q.RunRollupBackfill(context.Background())
		firstDone <- runResult{ran: ran, err: err}
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		var state string
		if err := pool.QueryRow(ctx, `SELECT status FROM rollup_backfill_state WHERE id`).Scan(&state); err != nil {
			t.Fatalf("query running state: %v", err)
		}
		if state == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first backfill did not reach running state")
		}
		time.Sleep(10 * time.Millisecond)
	}

	secondCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	secondRan, secondErr := q.RunRollupBackfill(secondCtx)
	if secondErr != nil || secondRan {
		t.Fatalf("second RunRollupBackfill = (ran=%v, err=%v), want immediate skip", secondRan, secondErr)
	}

	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release group lock: %v", err)
	}
	select {
	case first := <-firstDone:
		if first.err != nil || !first.ran {
			t.Fatalf("first RunRollupBackfill = (ran=%v, err=%v)", first.ran, first.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first backfill did not finish after releasing group lock")
	}
}

func TestRollupBackfillStaysExactWithConcurrentIngest(t *testing.T) {
	q, pool := rollupBackfillTestDB(t)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, "rollup-backfill-concurrent-ingest")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "rollup-backfill-concurrent-ingest", nil)
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment: %v", err)
	}
	base := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	first, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: project.ID, DefaultEnvironmentID: environment.ID,
		ErrorType: "TypeError", ErrorMessage: "concurrent backfill",
		StackTraceRaw: "at app.js:1:1", Fingerprint: "fp-backfill-concurrent",
		Title: "concurrent backfill", EventTime: base,
	})
	if err != nil {
		t.Fatalf("seed event: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_group_environments SET occurrence_count = 99 WHERE error_group_id = $1`, first.GroupID); err != nil {
		t.Fatalf("corrupt rollup: %v", err)
	}

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker: %v", err)
	}
	if _, err := blocker.Exec(ctx, `SELECT id FROM error_groups WHERE id = $1 FOR UPDATE`, first.GroupID); err != nil {
		t.Fatalf("lock group: %v", err)
	}

	backfillDone := make(chan error, 1)
	go func() {
		_, runErr := q.RunRollupBackfill(context.Background())
		backfillDone <- runErr
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var state string
		if err := pool.QueryRow(ctx, `SELECT status FROM rollup_backfill_state WHERE id`).Scan(&state); err != nil {
			t.Fatalf("query running state: %v", err)
		}
		if state == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("backfill did not reach running state")
		}
		time.Sleep(10 * time.Millisecond)
	}

	ingestDone := make(chan error, 1)
	go func() {
		_, ingestErr := q.InsertErrorEventAndGroup(context.Background(), db.IngestParams{
			ProjectID: project.ID, DefaultEnvironmentID: environment.ID,
			ErrorType: "TypeError", ErrorMessage: "concurrent backfill",
			StackTraceRaw: "at app.js:1:1", Fingerprint: "fp-backfill-concurrent",
			Title: "concurrent backfill", EventTime: base.Add(time.Hour),
		})
		ingestDone <- ingestErr
	}()
	time.Sleep(25 * time.Millisecond)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release group lock: %v", err)
	}
	if err := <-ingestDone; err != nil {
		t.Fatalf("concurrent ingest: %v", err)
	}
	if err := <-backfillDone; err != nil {
		t.Fatalf("concurrent backfill: %v", err)
	}

	var sourceCount, rollupCount int64
	var sourceFirst, sourceLast, rollupFirst, rollupLast time.Time
	if err := pool.QueryRow(ctx, `
		SELECT count(*), min("timestamp"), max("timestamp")
		FROM error_events WHERE error_group_id = $1`, first.GroupID,
	).Scan(&sourceCount, &sourceFirst, &sourceLast); err != nil {
		t.Fatalf("query sources: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT occurrence_count, first_seen, last_seen
		FROM error_group_environments
		WHERE error_group_id = $1 AND environment_id = $2`, first.GroupID, environment.ID,
	).Scan(&rollupCount, &rollupFirst, &rollupLast); err != nil {
		t.Fatalf("query rollup: %v", err)
	}
	if rollupCount != sourceCount || !rollupFirst.Equal(sourceFirst) || !rollupLast.Equal(sourceLast) {
		t.Fatalf("rollup (%d,%s,%s) != sources (%d,%s,%s)",
			rollupCount, rollupFirst, rollupLast, sourceCount, sourceFirst, sourceLast)
	}
}
