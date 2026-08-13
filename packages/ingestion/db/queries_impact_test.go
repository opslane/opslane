package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestErrorGroupReadsCarryImpactAndSavedDiff(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "impact-reads")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "impact-reads", nil)
	if err != nil {
		t.Fatal(err)
	}

	seed := func(fingerprint, diff string) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,fingerprint,title,first_seen,last_seen,status,kind,candidate_diff)
			VALUES ($1,$2,$2,now(),now(),'new','error',$3) RETURNING id`,
			project.ID, fingerprint, diff).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	knownID := seed("known-impact", "diff --git a/x b/x")
	unknownID := seed("unknown-impact", "")
	if _, err := pool.Exec(ctx, `UPDATE error_groups
		SET impact_class='degraded', impact_visits=3, impact_visits_recovered=1
		WHERE id=$1`, knownID); err != nil {
		t.Fatal(err)
	}

	assertKnown := func(group *db.ErrorGroup) {
		t.Helper()
		if group == nil || group.ImpactClass == nil || *group.ImpactClass != "degraded" ||
			group.ImpactVisits == nil || *group.ImpactVisits != 3 ||
			group.ImpactVisitsRecovered == nil || *group.ImpactVisitsRecovered != 1 || !group.HasSavedDiff {
			t.Fatalf("known impact group = %#v", group)
		}
	}
	known, err := q.GetErrorGroup(ctx, project.ID, knownID)
	if err != nil {
		t.Fatal(err)
	}
	assertKnown(known)
	unknown, err := q.GetErrorGroup(ctx, project.ID, unknownID)
	if err != nil {
		t.Fatal(err)
	}
	if unknown == nil || unknown.ImpactClass != nil || unknown.ImpactVisits != nil || unknown.ImpactVisitsRecovered != nil || unknown.HasSavedDiff {
		t.Fatalf("unknown impact group = %#v", unknown)
	}

	groups, err := q.ListErrorGroups(ctx, project.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	for index := range groups {
		if groups[index].ID == knownID {
			assertKnown(&groups[index])
			return
		}
	}
	t.Fatalf("known group missing from list: %#v", groups)
}
