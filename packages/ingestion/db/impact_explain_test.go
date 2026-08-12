package db_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/priority"
)

func sumExaminedPlanJSON(t *testing.T, raw []byte, relation string) int {
	t.Helper()
	var roots any
	if err := json.Unmarshal(raw, &roots); err != nil {
		t.Fatalf("decode plan JSON: %v", err)
	}
	var walk func(any) float64
	walk = func(value any) float64 {
		switch node := value.(type) {
		case []any:
			var total float64
			for _, child := range node {
				total += walk(child)
			}
			return total
		case map[string]any:
			var total float64
			if node["Relation Name"] == relation && node["Node Type"] != "Bitmap Index Scan" {
				loops, _ := node["Actual Loops"].(float64)
				if loops == 0 {
					loops = 1
				}
				for _, metric := range []string{"Actual Rows", "Rows Removed by Filter", "Rows Removed by Index Recheck"} {
					value, _ := node[metric].(float64)
					total += value * loops
				}
			}
			for _, child := range node {
				total += walk(child)
			}
			return total
		default:
			return 0
		}
	}
	return int(walk(roots))
}

func TestSumExaminedPlanJSON(t *testing.T) {
	raw := []byte(`[{"Plan":{"Node Type":"Nested Loop","Plans":[
		{"Node Type":"Seq Scan","Relation Name":"target","Actual Rows":10,"Rows Removed by Filter":90,"Actual Loops":1},
		{"Node Type":"Index Scan","Relation Name":"target","Actual Rows":2,"Rows Removed by Index Recheck":1,"Actual Loops":3},
		{"Node Type":"Bitmap Heap Scan","Relation Name":"target","Actual Rows":4,"Actual Loops":1,"Plans":[
			{"Node Type":"Bitmap Index Scan","Relation Name":"target","Actual Rows":4,"Actual Loops":1}
		]},
		{"Node Type":"Seq Scan","Relation Name":"other","Actual Rows":999,"Actual Loops":1},
		{"Node Type":"Index Scan","Relation Name":"target"}
	]}}]`)
	if got, want := sumExaminedPlanJSON(t, raw, "target"), 113; got != want {
		t.Fatalf("examined = %d, want %d", got, want)
	}
}

func TestImpactRollupExaminedRows(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	ctx := context.Background()
	var orgID, projectID, envID, openID, resolvedID, frictionID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('impact-plan') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO projects (org_id, name) VALUES ($1, 'impact-plan') RETURNING id`, orgID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO environments (project_id, name) VALUES ($1, 'production') RETURNING id`, projectID).Scan(&envID); err != nil {
		t.Fatal(err)
	}
	seedGroup := func(fingerprint, kind, status string) string {
		var id string
		err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id, environment_id, fingerprint, title, first_seen, last_seen, status, kind)
			VALUES ($1, $2, $3, $3, now(), now(), $4, $5) RETURNING id`,
			projectID, envID, fingerprint, status, kind).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	openID = seedGroup("plan-open", "error", "new")
	resolvedID = seedGroup("plan-resolved", "error", "resolved")
	frictionID = seedGroup("plan-friction", "friction", "insight")

	if _, err := pool.Exec(ctx, `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
		SELECT 'plan-session-' || n, $1, $2, now(), 'recording'
		FROM generate_series(1, 200) n`, projectID, envID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
		(session_id, seq, project_id, object_key, has_full_snapshot, scrubbed_at, first_event_ms, last_event_ms)
		SELECT 'plan-session-' || n, 0, $1, 'plan/' || n, true, now(),
		       (extract(epoch FROM now() - interval '1 minute') * 1000)::bigint,
		       (extract(epoch FROM now() + interval '5 minutes') * 1000)::bigint
		FROM generate_series(1, 200) n`, projectID); err != nil {
		t.Fatal(err)
	}
	// Cold ballast: sessions and scrubbed chunks that belong to no in-window
	// group. They make the chunk-side examined-rows bound falsifiable — a plan
	// that scans the whole chunk table (the always-on-recording table) instead
	// of probing per rollup session examines all 20k of these and fails.
	if _, err := pool.Exec(ctx, `INSERT INTO sessions (id, project_id, environment_id, started_at, status)
		SELECT 'cold-session-' || n, $1, $2, now(), 'recording'
		FROM generate_series(1, 20000) n`, projectID, envID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_chunks
		(session_id, seq, project_id, object_key, has_full_snapshot, scrubbed_at, first_event_ms, last_event_ms)
		SELECT 'cold-session-' || n, 0, $1, 'cold/' || n, true, now(),
		       (extract(epoch FROM now() - interval '1 minute') * 1000)::bigint,
		       (extract(epoch FROM now() + interval '5 minutes') * 1000)::bigint
		FROM generate_series(1, 20000) n`, projectID); err != nil {
		t.Fatal(err)
	}

	insertEvents := func(groupID string, count int, age string) {
		t.Helper()
		_, err := pool.Exec(ctx, `INSERT INTO error_events
			(project_id, environment_id, error_group_id, session_id, "timestamp", error_type, error_message, stack_trace_raw)
			SELECT $1, $2, $3, 'plan-session-' || (1 + (n % 200)), now() - $4::interval,
			       'TypeError', 'boom', 'at plan'
			FROM generate_series(1, $5::int) n`, projectID, envID, groupID, age, count)
		if err != nil {
			t.Fatal(err)
		}
	}
	insertEvents(openID, 20_000, "1 day")
	insertEvents(openID, 40_000, "31 days")
	insertEvents(resolvedID, 40_000, "1 day")

	if _, err := pool.Exec(ctx, `INSERT INTO friction_signals
		(session_id, project_id, environment_id, rule_version, signal_type, fingerprint,
		 page_url_normalized, occurred_at, adjudication_status, incident_id, created_at)
		SELECT 'plan-session-' || (1 + (n % 200)), $1::uuid, $2::uuid, 1, 'dead_click', 'recent-' || n,
		       '/plan', now() - interval '1 day', 'accepted', $3::uuid, now() - interval '1 day'
		FROM generate_series(1, 500) n
		UNION ALL
		SELECT 'plan-session-' || (1 + (n % 200)), $1::uuid, $2::uuid, 1, 'dead_click', 'aged-' || n,
		       '/plan', now() - interval '32 days', 'accepted', $3::uuid, now() - interval '32 days'
		FROM generate_series(1, 20000) n
		UNION ALL
		SELECT 'plan-session-' || (1 + (n % 200)), $1::uuid, $2::uuid, 1, 'dead_click', 'retracted-' || n,
		       '/plan', now() - interval '1 day', 'accepted', $3::uuid, now() - interval '1 day'
		FROM generate_series(1, 500) n`, projectID, envID, frictionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE friction_signals SET retracted_at=now() WHERE fingerprint LIKE 'retracted-%'`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"error_events", "friction_signals", "session_chunks", "error_groups"} {
		if _, err := pool.Exec(ctx, "ANALYZE "+table); err != nil {
			t.Fatal(err)
		}
	}

	var rollupRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM (`+priority.ImpactRollupSelectSQL+`) impact`).Scan(&rollupRows); err != nil {
		t.Fatal(err)
	}
	if rollupRows < 1 {
		t.Fatal("impact rollup returned no rows; planner metrics would be meaningless")
	}

	// Deterministic usability posture (the sessions_index_test.go philosophy):
	// the assertion is "the rollup's shape lets the 046 indexes bound examined
	// rows", not "the planner wins a cost race". The pre-046 single-column
	// idx_error_events_group and the created_at/reach indexes are close enough
	// in estimated cost that ANALYZE sampling flips the choice run to run
	// (observed: the group index scanning all 60k events with 40k filtered).
	// Dropping the competitors inside a rolled-back transaction removes the
	// race without touching the schema; the prod-side cost race is recorded in
	// the PR as follow-up (the 001 index is redundant next to 039's).
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DROP INDEX idx_error_events_group, idx_error_events_group_created,
		idx_friction_signals_incident, idx_friction_signals_incident_reach`); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+priority.ImpactRollupSelectSQL).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	plan := string(raw)
	events := sumExaminedPlanJSON(t, raw, "error_events")
	if events > 30_000 {
		t.Fatalf("rollup examined %d error events for 20000 relevant rows (ratio %.2f > 1.5)\n%s", events, float64(events)/20_000, plan)
	}
	signals := sumExaminedPlanJSON(t, raw, "friction_signals")
	if signals > 1_500 {
		t.Fatalf("rollup examined %d friction signals for 500 relevant rows (ratio %.2f > 3)\n%s", signals, float64(signals)/500, plan)
	}
	chunks := sumExaminedPlanJSON(t, raw, "session_chunks")
	if chunks > 600 {
		t.Fatalf("rollup examined %d session chunks for 200 rollup sessions (ratio %.2f > 3; the 20k cold chunks leaked into the scan)\n%s", chunks, float64(chunks)/200, plan)
	}
	for _, index := range []string{"idx_error_events_group_timestamp", "idx_friction_signals_incident_occurred"} {
		if !strings.Contains(plan, index) {
			t.Fatalf("rollup does not use %s\n%s", index, plan)
		}
	}
	t.Logf("AC3.8 plan: error_events=%d (%.2fx), friction_signals=%d (%.2fx)\n%s",
		events, float64(events)/20_000, signals, float64(signals)/500, fmt.Sprintf("%s", raw))
}
