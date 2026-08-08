package db_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestListErrorGroupsOrdersByPriorityAndReturnsInputs(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "priority-list")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "priority-list", nil)
	if err != nil {
		t.Fatal(err)
	}

	seed := func(fingerprint, age string, score any, inputs any) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO error_groups
			  (project_id,fingerprint,title,first_seen,last_seen,status,kind,priority_score,priority_inputs,priority_scored_at)
			VALUES ($1,$2,$2,now()-$3::interval,now()-$3::interval,'new','error',$4,$5::jsonb,
			        CASE WHEN $4::real IS NULL THEN NULL ELSE now() END)
			RETURNING id`, project.ID, fingerprint, age, score, inputs).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	highID := seed("older-high", "2 hours", 10, `{"impact":10}`)
	seed("newer-zero", "0 seconds", nil, nil)
	seed("mid", "1 hour", .5, `{"impact":1}`)

	groups, err := q.ListErrorGroups(ctx, project.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 || groups[0].ID != highID {
		t.Fatalf("order = %#v", groups)
	}
	if groups[0].PriorityScore == nil || *groups[0].PriorityScore != 10 {
		t.Fatalf("priority score = %#v", groups[0].PriorityScore)
	}
	var inputs map[string]any
	if err := json.Unmarshal(groups[0].PriorityInputs, &inputs); err != nil || inputs["impact"] != float64(10) {
		t.Fatalf("priority inputs = %s, err=%v", groups[0].PriorityInputs, err)
	}
	detail, err := q.GetErrorGroup(ctx, project.ID, highID)
	if err != nil {
		t.Fatal(err)
	}
	if detail == nil || detail.PriorityScore == nil || *detail.PriorityScore != 10 || detail.PriorityScoredAt == nil {
		t.Fatalf("detail priority fields = %#v", detail)
	}
}

func TestListErrorGroupsEnvironmentArmUsesPriorityBeforeLimit(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "priority-env-list")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "priority-env-list", nil)
	if err != nil {
		t.Fatal(err)
	}
	env, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 101; i++ {
		var id string
		seen := time.Now().UTC().Add(-time.Duration(i) * time.Minute)
		if err := pool.QueryRow(ctx, `
			INSERT INTO error_groups (project_id,fingerprint,title,first_seen,last_seen,status,kind,priority_score)
			VALUES ($1,$2,$2,$3,$3,'new','error',0) RETURNING id`, project.ID, "low-"+time.Unix(int64(i), 0).UTC().Format("150405"), seen).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO error_group_environments (error_group_id,environment_id,first_seen,last_seen,occurrence_count) VALUES ($1,$2,$3,$3,1)`, id, env.ID, seen); err != nil {
			t.Fatal(err)
		}
	}
	var highID string
	old := time.Now().UTC().Add(-48 * time.Hour)
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups (project_id,fingerprint,title,first_seen,last_seen,status,kind,priority_score)
		VALUES ($1,'old-high','old-high',$2,$2,'new','error',100) RETURNING id`, project.ID, old).Scan(&highID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO error_group_environments (error_group_id,environment_id,first_seen,last_seen,occurrence_count) VALUES ($1,$2,$3,$3,1)`, highID, env.ID, old); err != nil {
		t.Fatal(err)
	}

	groups, err := q.ListErrorGroups(ctx, project.ID, &db.ErrorGroupFilters{EnvironmentID: &env.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) == 0 || groups[0].ID != highID {
		t.Fatalf("first group = %#v, want high priority %s", groups[0], highID)
	}
}
