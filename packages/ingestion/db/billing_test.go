package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestListUnbilledMergedPRs(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projectID, _, groupID := seedGroup(t, pool, q, "billing-unbilled")
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM billing_tracked WHERE org_id = $1`, orgID); err != nil {
			t.Logf("cleanup billing_tracked: %v", err)
		}
	})

	var fixJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status)
		 VALUES ($1, $2, 'fix', 'completed') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}

	mergedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at, github_repo)
		 VALUES
		   ($1, $2, 41, 'merged', 'billing-unbilled-merged', $3, $4, 'Org/Billing-Unbilled'),
		   ($1, $2, 42, 'merged', 'billing-unbilled-human', NULL, $4, 'Org/Billing-Unbilled'),
		   ($1, $2, 43, 'closed', 'billing-unbilled-closed', $3, $4, 'Org/Billing-Unbilled')`,
		groupID, projectID, fixJobID, mergedAt,
	); err != nil {
		t.Fatalf("insert PR outcome fixtures: %v", err)
	}

	wantRef := fmt.Sprintf("pr:%s:org/billing-unbilled:41", projectID)
	got := unbilledForOrg(t, q, orgID)
	if len(got) != 1 {
		t.Fatalf("unbilled merged PRs = %+v, want one fixture receipt", got)
	}
	if got[0].Ref != wantRef || got[0].PRNumber != 41 || got[0].OrgID != orgID || got[0].OrgName != "billing-unbilled" {
		t.Fatalf("unbilled merged PR = %+v, want ref %q, PR 41, org %s", got[0], wantRef, orgID)
	}
	if !got[0].OccurredAt.Equal(mergedAt) {
		t.Fatalf("OccurredAt = %v, want %v", got[0].OccurredAt, mergedAt)
	}
	if got[0].Ambiguous {
		t.Fatal("single-org repository marked ambiguous")
	}

	inserted, err := q.MarkBillingTracked(ctx, wantRef, orgID, "merged_prs", 1)
	if err != nil || !inserted {
		t.Fatalf("first MarkBillingTracked = (%v, %v), want (true, nil)", inserted, err)
	}
	inserted, err = q.MarkBillingTracked(ctx, wantRef, orgID, "merged_prs", 1)
	if err != nil || inserted {
		t.Fatalf("second MarkBillingTracked = (%v, %v), want (false, nil)", inserted, err)
	}
	if got := unbilledForOrg(t, q, orgID); len(got) != 0 {
		t.Fatalf("unbilled after tracking = %+v, want none", got)
	}
}

func TestBillingTrackedIsRemovedWithOrg(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "billing-cascade")
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}

	ref := "sessions_alert:" + org.ID + ":2026-09"
	if inserted, err := q.MarkBillingTracked(ctx, ref, org.ID, "sessions", 1); err != nil || !inserted {
		t.Fatalf("MarkBillingTracked = (%v, %v), want (true, nil)", inserted, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM orgs WHERE id = $1`, org.ID); err != nil {
		t.Fatalf("delete org: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM billing_tracked WHERE ref = $1`, ref).Scan(&count); err != nil {
		t.Fatalf("count billing marker: %v", err)
	}
	if count != 0 {
		t.Fatalf("billing marker count = %d, want 0 after org deletion", count)
	}
}

func TestListUnbilledMergedPRsDedupesRedelivery(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projectID, _, groupID := seedGroup(t, pool, q, "billing-redelivery")
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM billing_tracked WHERE org_id = $1`, orgID); err != nil {
			t.Logf("cleanup billing_tracked: %v", err)
		}
	})

	var fixJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status)
		 VALUES ($1, $2, 'fix', 'completed') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at, github_repo)
		 VALUES
		   ($1, $2, 51, 'merged', 'billing-redelivery-a', $3, now() - interval '1 minute', 'Org/Billing-Redelivery'),
		   ($1, $2, 51, 'merged', 'billing-redelivery-b', $3, now(), 'Org/Billing-Redelivery')`,
		groupID, projectID, fixJobID,
	); err != nil {
		t.Fatalf("insert redelivery receipts: %v", err)
	}

	got := unbilledForOrg(t, q, orgID)
	if len(got) != 1 || got[0].PRNumber != 51 {
		t.Fatalf("unbilled redeliveries = %+v, want one PR 51", got)
	}
}

func TestListUnbilledMergedPRsKeepsReboundRepoIdentities(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projectID, _, groupID := seedGroup(t, pool, q, "billing-rebound")
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM billing_tracked WHERE org_id = $1`, orgID); err != nil {
			t.Logf("cleanup billing_tracked: %v", err)
		}
	})

	var fixJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status)
		 VALUES ($1, $2, 'fix', 'completed') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at, github_repo)
		 VALUES
		   ($1, $2, 71, 'merged', 'billing-rebound-old', $3, now() - interval '1 minute', 'Org/Old-Repo'),
		   ($1, $2, 71, 'merged', 'billing-rebound-new', $3, now(), 'Org/New-Repo')`,
		groupID, projectID, fixJobID,
	); err != nil {
		t.Fatalf("insert rebound-repo receipts: %v", err)
	}

	got := unbilledForOrg(t, q, orgID)
	if len(got) != 2 {
		t.Fatalf("unbilled rebound repo identities = %+v, want two distinct stable PR refs", got)
	}
}

func TestListUnbilledMergedPRsMarksCrossOrgRepoAmbiguous(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)
	orgID, projectID, _, groupID := seedGroup(t, pool, q, "billing-ambiguous")
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM billing_tracked WHERE org_id = $1`, orgID); err != nil {
			t.Logf("cleanup billing_tracked: %v", err)
		}
	})

	otherOrg, err := q.CreateOrg(ctx, "billing-ambiguous-other")
	if err != nil {
		t.Fatalf("CreateOrg(other): %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, otherOrg.ID) })
	if _, err := q.CreateProject(ctx, otherOrg.ID, "billing-ambiguous-other-project", ptrStr("ORG/BILLING-AMBIGUOUS")); err != nil {
		t.Fatalf("CreateProject(other): %v", err)
	}

	var fixJobID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, status)
		 VALUES ($1, $2, 'fix', 'completed') RETURNING id`,
		groupID, projectID,
	).Scan(&fixJobID); err != nil {
		t.Fatalf("insert fix job: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at, github_repo)
		 VALUES ($1, $2, 61, 'merged', 'billing-ambiguous-merge', $3, now(), 'org/billing-ambiguous')`,
		groupID, projectID, fixJobID,
	); err != nil {
		t.Fatalf("insert ambiguous receipt: %v", err)
	}

	got := unbilledForOrg(t, q, orgID)
	if len(got) != 1 || !got[0].Ambiguous {
		t.Fatalf("ambiguous unbilled PRs = %+v, want one row marked ambiguous", got)
	}
}

func TestOrgSessionCountsThisMonth(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "billing-sessions-over")
	if err != nil {
		t.Fatalf("CreateOrg(over): %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "billing-sessions-over", ptrStr("org/billing-sessions-over"))
	if err != nil {
		t.Fatalf("CreateProject(over): %v", err)
	}
	env, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment(over): %v", err)
	}

	underOrg, err := q.CreateOrg(ctx, "billing-sessions-under")
	if err != nil {
		t.Fatalf("CreateOrg(under): %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, underOrg.ID) })
	underProject, err := q.CreateProject(ctx, underOrg.ID, "billing-sessions-under", ptrStr("org/billing-sessions-under"))
	if err != nil {
		t.Fatalf("CreateProject(under): %v", err)
	}
	underEnv, err := q.CreateEnvironment(ctx, underProject.ID, "production")
	if err != nil {
		t.Fatalf("CreateEnvironment(under): %v", err)
	}

	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE project_id = ANY($1::uuid[])`, []string{project.ID, underProject.ID}); err != nil {
			t.Logf("cleanup sessions: %v", err)
		}
	})
	if _, err := pool.Exec(ctx,
		`INSERT INTO sessions (id, project_id, environment_id, started_at) VALUES
		 ('billing-session-over-1', $1, $2, now()),
		 ('billing-session-over-2', $1, $2, now()),
		 ('billing-session-over-3', $1, $2, now()),
		 ('billing-session-old', $1, $2, date_trunc('month', now()) - interval '1 day'),
		 ('billing-session-under-1', $3, $4, now()),
		 ('billing-session-under-2', $3, $4, now())`,
		project.ID, env.ID, underProject.ID, underEnv.ID,
	); err != nil {
		t.Fatalf("insert session fixtures: %v", err)
	}

	got, err := q.OrgSessionCountsThisMonth(ctx, 2)
	if err != nil {
		t.Fatalf("OrgSessionCountsThisMonth: %v", err)
	}
	if got[org.ID] != 3 {
		t.Fatalf("session count for over-threshold org = %d, want 3 (got %+v)", got[org.ID], got)
	}
	if _, ok := got[underOrg.ID]; ok {
		t.Fatalf("under-threshold org unexpectedly returned: %+v", got)
	}
}

func unbilledForOrg(t *testing.T, q *db.Queries, orgID string) []db.UnbilledMergedPR {
	t.Helper()
	rows, err := q.ListUnbilledMergedPRs(context.Background(), 1000)
	if err != nil {
		t.Fatalf("ListUnbilledMergedPRs: %v", err)
	}
	got := make([]db.UnbilledMergedPR, 0, len(rows))
	for _, row := range rows {
		if row.OrgID == orgID {
			got = append(got, row)
		}
	}
	return got
}
