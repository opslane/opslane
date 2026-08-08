package priority

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"testing"
)

func ptr(s string) *string { return &s }

func approx(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func TestRunOnceScoresAndStampsErrorGroups(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	groupID := seedGroup(t, pool, projectID, envID, "scored", "error")
	oldID := seedGroup(t, pool, projectID, envID, "old", "error")

	var recentUser, weekUser, oldUser string
	for _, item := range []struct {
		external string
		age      string
		dest     *string
	}{
		{"recent", "1 hour", &recentUser},
		{"week", "2 days", &weekUser},
		{"old", "8 days", &oldUser},
	} {
		if err := pool.QueryRow(context.Background(), `
			INSERT INTO end_users (project_id, external_user_id, last_seen)
			VALUES ($1, $2, now() - $3::interval) RETURNING id`, projectID, item.external, item.age).Scan(item.dest); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(t, pool, `INSERT INTO error_group_affected_users (error_group_id, end_user_id, last_seen) VALUES ($1,$2,now()-interval '1 hour'),($1,$3,now()-interval '2 days')`, groupID, recentUser, weekUser)
	mustExec(t, pool, `INSERT INTO error_group_affected_users (error_group_id, end_user_id, last_seen) VALUES ($1,$2,now()-interval '8 days')`, oldID, oldUser)

	insertEvent := func(session any, rawURL, age string) {
		mustExec(t, pool, `
			INSERT INTO error_events
			  (project_id, environment_id, error_group_id, timestamp, error_type, error_message, stack_trace_raw, context, session_id, created_at)
			VALUES ($1,$2,$3,now(),'TypeError','boom','at test',$4::jsonb,$5,now()-$6::interval)`,
			projectID, envID, groupID, `{"url":"`+rawURL+`"}`, session, age)
	}
	insertEvent("anonymous-week", "https://app.test/assets/1", "2 days")
	insertEvent(nil, "https://app.test/assets/1", "1 hour")
	insertEvent(nil, "https://app.test/assets/2", "2 hours")
	insertEvent(nil, "https://app.test/assets/2", "3 hours")
	insertEvent(nil, "https://app.test/other", "1 hour")
	insertEvent(nil, "https://app.test/other", "2 hours")
	insertEvent(nil, "https://app.test/other", "3 hours")

	updated, err := (&Sweeper{Pool: pool}).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if updated < 2 {
		t.Fatalf("updated = %d, want at least the two seeded groups", updated)
	}
	var score float64
	var route string
	var scoredAt any
	var inputsJSON []byte
	if err := pool.QueryRow(context.Background(), `SELECT priority_score, page_url_normalized, priority_scored_at, priority_inputs FROM error_groups WHERE id=$1`, groupID).Scan(&score, &route, &scoredAt, &inputsJSON); err != nil {
		t.Fatal(err)
	}
	approx(t, score, 5, "score")
	if route != "/assets/:id" {
		t.Errorf("route = %q, want /assets/:id", route)
	}
	if scoredAt == nil {
		t.Error("priority_scored_at is nil")
	}
	var inputs map[string]any
	if err := json.Unmarshal(inputsJSON, &inputs); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(inputs))
	for key := range inputs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	wantKeys := []string{"anon_sessions_24h", "anon_sessions_7d", "cap_applied", "impact", "reason_code", "route_name", "route_pattern", "route_tier", "route_weight", "users_24h", "users_7d"}
	if len(keys) != len(wantKeys) {
		t.Fatalf("input keys = %v", keys)
	}
	for i := range keys {
		if keys[i] != wantKeys[i] {
			t.Fatalf("input keys = %v", keys)
		}
	}
	if capped, ok := inputs["cap_applied"].(bool); !ok || capped {
		t.Errorf("cap_applied = %#v, want boolean false", inputs["cap_applied"])
	}
	var oldScore float64
	if err := pool.QueryRow(context.Background(), `SELECT priority_score FROM error_groups WHERE id=$1`, oldID).Scan(&oldScore); err != nil {
		t.Fatal(err)
	}
	approx(t, oldScore, 0, "old score")
}

func TestRunOnceScoresAcceptedFrictionAndRouteWeights(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	groupID := seedGroup(t, pool, projectID, envID, "friction", "friction")
	mustExec(t, pool, `UPDATE error_groups SET page_url_normalized='/portal' WHERE id=$1`, groupID)
	mustExec(t, pool, `INSERT INTO route_map (project_id,pattern,name,tier) VALUES ($1,'/portal','Portal','customer')`, projectID)

	for _, session := range []string{"identified-1", "identified-2", "anon", "rejected", "retracted"} {
		mustExec(t, pool, `INSERT INTO sessions (id,project_id,environment_id,started_at) VALUES ($1,$2,$3,now()-interval '2 days')`, session+groupID, projectID, envID)
	}
	var user1, user2 string
	if err := pool.QueryRow(context.Background(), `INSERT INTO end_users (project_id,external_user_id) VALUES ($1,'f-user-1') RETURNING id`, projectID).Scan(&user1); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `INSERT INTO end_users (project_id,external_user_id) VALUES ($1,'f-user-2') RETURNING id`, projectID).Scan(&user2); err != nil {
		t.Fatal(err)
	}
	insertSignal := func(session string, user *string, status string, retracted bool) {
		mustExec(t, pool, `
			INSERT INTO friction_signals
			  (session_id,project_id,environment_id,end_user_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,incident_id,adjudication_status,retracted_at,created_at)
			VALUES ($1,$2,$3,$4,1,'rage_click',$5,'/portal',now()-interval '2 days',$6,$7,
			        CASE WHEN $8 THEN now() ELSE NULL END,now()-interval '2 days')`,
			session+groupID, projectID, envID, user, session, groupID, status, retracted)
	}
	insertSignal("identified-1", &user1, "accepted", false)
	insertSignal("identified-2", &user2, "accepted", false)
	insertSignal("anon", nil, "accepted", false)
	insertSignal("rejected", nil, "rejected", false)
	insertSignal("retracted", nil, "accepted", true)

	if _, err := (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var score float64
	var tier, name string
	var weight float64
	if err := pool.QueryRow(context.Background(), `SELECT priority_score, priority_inputs->>'route_tier', priority_inputs->>'route_name', (priority_inputs->>'route_weight')::float8 FROM error_groups WHERE id=$1`, groupID).Scan(&score, &tier, &name, &weight); err != nil {
		t.Fatal(err)
	}
	approx(t, score, 9, "customer friction score")
	approx(t, weight, 3, "route weight")
	if tier != "customer" || name != "Portal" {
		t.Errorf("route metadata = %q %q", tier, name)
	}
}

func TestRunOnceEnqueuesRouteMapJobsWithDedupeAndCooldown(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, ptr("owner/repo"))
	groupID := seedGroup(t, pool, projectID, envID, "enqueue", "error")
	mustExec(t, pool, `UPDATE error_groups SET page_url_normalized='/unmapped' WHERE id=$1`, groupID)
	s := &Sweeper{Pool: pool}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM error_group_jobs WHERE project_id=$1 AND job_type='route_map'`, projectID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("active jobs = %d, want 1", count)
	}
	mustExec(t, pool, `UPDATE error_group_jobs SET status='dead_letter', created_at=now()-interval '1 hour' WHERE project_id=$1 AND job_type='route_map'`, projectID)
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM error_group_jobs WHERE project_id=$1 AND job_type='route_map'`, projectID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("jobs during cooldown = %d, want 1", count)
	}
	mustExec(t, pool, `UPDATE error_group_jobs SET created_at=now()-interval '25 hours' WHERE project_id=$1 AND job_type='route_map'`, projectID)
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM error_group_jobs WHERE project_id=$1 AND job_type='route_map'`, projectID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("jobs after cooldown = %d, want 2", count)
	}
}

// Friction incidents are stamped by the worker's own normalizer, which keeps
// the origin ("https://app.test/orders/:id") while the ingestion normalizer
// emits a bare path ("/orders/:id"). route_map is keyed on an exact match, so
// before both kinds were re-normalized here a customer-facing friction issue
// silently kept the default weight of 1 while the error issue on the very same
// page got 3. This asserts they now converge on one pattern and one weight.
func TestRunOnceConvergesFrictionAndErrorOnOneRoutePattern(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	errorID := seedGroup(t, pool, projectID, envID, "conv-error", "error")
	frictionID := seedGroup(t, pool, projectID, envID, "conv-friction", "friction")
	mustExec(t, pool, `INSERT INTO route_map (project_id,pattern,name,tier) VALUES ($1,'/orders/:id','Orders','customer')`, projectID)

	// Error side: raw URL straight off the browser event.
	mustExec(t, pool, `
		INSERT INTO error_events
		  (project_id, environment_id, error_group_id, timestamp, error_type, error_message, stack_trace_raw, context, created_at)
		VALUES ($1,$2,$3,now(),'TypeError','boom','at test','{"url":"https://app.test/orders/4021"}'::jsonb,now()-interval '1 hour')`,
		projectID, envID, errorID)

	// Friction side: already normalized by fingerprint.ts, origin retained.
	mustExec(t, pool, `INSERT INTO sessions (id,project_id,environment_id,started_at) VALUES ($1,$2,$3,now()-interval '2 days')`, "conv-sess", projectID, envID)
	var user string
	if err := pool.QueryRow(context.Background(), `INSERT INTO end_users (project_id,external_user_id) VALUES ($1,'conv-user') RETURNING id`, projectID).Scan(&user); err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `
		INSERT INTO friction_signals
		  (session_id,project_id,environment_id,end_user_id,rule_version,signal_type,fingerprint,page_url_normalized,occurred_at,incident_id,adjudication_status,created_at)
		VALUES ($1,$2,$3,$4,1,'rage_click','conv-fp','https://app.test/orders/:id',now()-interval '2 days',$5,'accepted',now()-interval '2 days')`,
		"conv-sess", projectID, envID, user, frictionID)

	if _, err := (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct{ label, id string }{{"error", errorID}, {"friction", frictionID}} {
		var pattern, tier string
		var weight float64
		if err := pool.QueryRow(context.Background(), `
			SELECT page_url_normalized, priority_inputs->>'route_tier', (priority_inputs->>'route_weight')::float8
			FROM error_groups WHERE id=$1`, c.id).Scan(&pattern, &tier, &weight); err != nil {
			t.Fatal(err)
		}
		if pattern != "/orders/:id" {
			t.Errorf("%s pattern = %q, want /orders/:id", c.label, pattern)
		}
		if tier != "customer" {
			t.Errorf("%s route_tier = %q, want customer", c.label, tier)
		}
		approx(t, weight, 3, c.label+" route weight")
	}
}

// Two replicas tick at the same moment. The second must decline rather than
// duplicate a full-table rewrite, and must not report an error for doing so.
func TestRunOnceIsSingleFlightAcrossReplicas(t *testing.T) {
	pool := testPool(t)
	_, projectID, envID := seedTenant(t, pool, nil)
	seedGroup(t, pool, projectID, envID, "lock-probe", "error")

	holder, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	var locked bool
	if err := holder.QueryRow(context.Background(), `SELECT pg_try_advisory_lock($1)`, sweepAdvisoryLockKey).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if !locked {
		t.Fatal("could not take the sweep lock to simulate a peer replica")
	}

	updated, err := (&Sweeper{Pool: pool}).RunOnce(context.Background())
	if err != nil {
		t.Fatalf("a contended pass must skip quietly, got %v", err)
	}
	if updated != 0 {
		t.Fatalf("contended pass scored %d groups, want 0", updated)
	}

	if _, err := holder.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, sweepAdvisoryLockKey); err != nil {
		t.Fatal(err)
	}
	if updated, err = (&Sweeper{Pool: pool}).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if updated == 0 {
		t.Fatal("pass after the lock cleared scored nothing")
	}
}
