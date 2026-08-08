package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func createFrictionTestProject(t *testing.T, name string) (*db.Queries, string) {
	t.Helper()
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatalf("CreateOrg: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	project, err := q.CreateProject(ctx, org.ID, name, ptrStr("org/repo"))
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	return q, project.ID
}

func insertIncident(t *testing.T, q *db.Queries, projectID, fingerprint, kind, status string) string {
	t.Helper()
	var id string
	err := q.Pool().QueryRow(context.Background(),
		`INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, kind, status)
		 VALUES ($1, $2, $2, now(), now(), $3, $4)
		 RETURNING id`,
		projectID, fingerprint, kind, status,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert incident %s/%s: %v", kind, status, err)
	}
	return id
}

func TestFrictionKindRoundTripsThroughReadQueries(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "friction-kind-read")
	groupID := insertIncident(t, q, projectID, "friction-kind-read", "friction", "insight")

	groups, err := q.ListErrorGroups(context.Background(), projectID, nil)
	if err != nil {
		t.Fatalf("ListErrorGroups: %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("ListErrorGroups returned %d groups, want 1", len(groups))
	}
	if groups[0].Kind != "friction" {
		t.Errorf("listed group kind = %q, want friction", groups[0].Kind)
	}

	group, err := q.GetErrorGroup(context.Background(), projectID, groupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group == nil {
		t.Fatal("GetErrorGroup returned nil")
	}
	if group.Kind != "friction" {
		t.Errorf("detail group kind = %q, want friction", group.Kind)
	}
}

func TestCandidateIncidentsAreHiddenFromAllReadQueries(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "candidate-hidden")
	groupID := insertIncident(t, q, projectID, "candidate-hidden", "friction", "candidate")

	for name, filters := range map[string]*db.ErrorGroupFilters{
		"unfiltered":       nil,
		"candidate filter": {Status: "candidate"},
	} {
		t.Run(name, func(t *testing.T) {
			groups, err := q.ListErrorGroups(context.Background(), projectID, filters)
			if err != nil {
				t.Fatalf("ListErrorGroups: %v", err)
			}
			if len(groups) != 0 {
				t.Fatalf("ListErrorGroups returned %d candidate groups, want 0", len(groups))
			}
		})
	}

	group, err := q.GetErrorGroup(context.Background(), projectID, groupID)
	if err != nil {
		t.Fatalf("GetErrorGroup: %v", err)
	}
	if group != nil {
		t.Fatalf("GetErrorGroup returned candidate group %#v, want not found", group)
	}
}

func TestTriggerFixRequiresKindSpecificStatusAndRecordsHumanTrigger(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "trigger-fix-kind-status")
	ctx := context.Background()

	tests := []struct {
		kind   string
		status string
		wantOK bool
	}{
		{kind: "error", status: "investigated", wantOK: true},
		{kind: "friction", status: "awaiting_approval", wantOK: true},
		{kind: "friction", status: "investigated"},
		{kind: "error", status: "awaiting_approval"},
		{kind: "error", status: "insight"},
		{kind: "friction", status: "insight"},
		{kind: "error", status: "new"},
	}

	for i, tt := range tests {
		t.Run(fmt.Sprintf("%s_%s", tt.kind, tt.status), func(t *testing.T) {
			groupID := insertIncident(t, q, projectID, fmt.Sprintf("trigger-%d", i), tt.kind, tt.status)
			jobID, err := q.TriggerFixJob(ctx, projectID, groupID, "ship the fix")
			if !tt.wantOK {
				if !errors.Is(err, db.ErrNotInvestigated) {
					t.Fatalf("TriggerFixJob error = %v, want ErrNotInvestigated", err)
				}
				if jobID != "" {
					t.Errorf("TriggerFixJob job id = %q after rejection, want empty", jobID)
				}
				var gotStatus string
				if queryErr := q.Pool().QueryRow(ctx, `SELECT status FROM error_groups WHERE id = $1`, groupID).Scan(&gotStatus); queryErr != nil {
					t.Fatalf("query rejected incident: %v", queryErr)
				}
				if gotStatus != tt.status {
					t.Errorf("rejected incident status = %q, want %q", gotStatus, tt.status)
				}
				return
			}

			if err != nil {
				t.Fatalf("TriggerFixJob: %v", err)
			}
			if jobID == "" {
				t.Fatal("TriggerFixJob returned empty job id")
			}

			var gotStatus, jobType, triggeredBy string
			if err := q.Pool().QueryRow(ctx,
				`SELECT eg.status, egj.job_type, egj.triggered_by
				 FROM error_groups eg
				 JOIN error_group_jobs egj ON egj.error_group_id = eg.id
				 WHERE eg.id = $1 AND egj.id = $2`,
				groupID, jobID,
			).Scan(&gotStatus, &jobType, &triggeredBy); err != nil {
				t.Fatalf("query fix result: %v", err)
			}
			if gotStatus != "fixing" {
				t.Errorf("incident status = %q, want fixing", gotStatus)
			}
			if jobType != "fix" {
				t.Errorf("job type = %q, want fix", jobType)
			}
			if triggeredBy != "human" {
				t.Errorf("triggered_by = %q, want human", triggeredBy)
			}
		})
	}
}

func TestUnarchiveIncidentRestoresKindSafeStatus(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "unarchive-kind-status")
	ctx := context.Background()

	for _, tt := range []struct {
		kind       string
		wantStatus string
	}{
		{kind: "error", wantStatus: "investigated"},
		{kind: "friction", wantStatus: "insight"},
	} {
		t.Run(tt.kind, func(t *testing.T) {
			groupID := insertIncident(t, q, projectID, "unarchive-"+tt.kind, tt.kind, "archived")
			if _, err := q.Pool().Exec(ctx, `UPDATE error_groups SET archived_at = now() WHERE id = $1`, groupID); err != nil {
				t.Fatalf("set archived_at: %v", err)
			}
			if err := q.UnarchiveErrorGroup(ctx, projectID, groupID); err != nil {
				t.Fatalf("UnarchiveErrorGroup: %v", err)
			}

			var status string
			var archivedAt *string
			if err := q.Pool().QueryRow(ctx,
				`SELECT status, archived_at::text FROM error_groups WHERE id = $1`, groupID,
			).Scan(&status, &archivedAt); err != nil {
				t.Fatalf("query unarchived incident: %v", err)
			}
			if status != tt.wantStatus {
				t.Errorf("status = %q, want %q", status, tt.wantStatus)
			}
			if archivedAt != nil {
				t.Errorf("archived_at = %q, want nil", *archivedAt)
			}
		})
	}
}

func TestUpdateProjectFrictionAutonomy(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "autonomy-settings")
	ctx := context.Background()

	var orgID string
	if err := q.Pool().QueryRow(ctx,
		`SELECT org_id FROM projects WHERE id = $1`, projectID,
	).Scan(&orgID); err != nil {
		t.Fatalf("get project org: %v", err)
	}

	autoFix := "auto_fix"
	project, err := q.UpdateProject(ctx, orgID, projectID, nil, &autoFix, nil, nil, nil)
	if err != nil || project == nil {
		t.Fatalf("UpdateProject = (%+v, %v)", project, err)
	}
	if project.FrictionAutonomy != autoFix {
		t.Fatalf("FrictionAutonomy = %q, want %q", project.FrictionAutonomy, autoFix)
	}
	if project.GithubRepo == nil || *project.GithubRepo != "org/repo" {
		t.Fatalf("GithubRepo was clobbered: %v", project.GithubRepo)
	}

	project, err = q.UpdateProject(ctx, orgID, projectID, nil, nil, nil, nil, nil)
	if err != nil || project == nil || project.FrictionAutonomy != autoFix {
		t.Fatalf("omitted autonomy was not preserved: project=%+v err=%v", project, err)
	}

	invalid := "yolo"
	if _, err := q.UpdateProject(ctx, orgID, projectID, nil, &invalid, nil, nil, nil); err == nil {
		t.Fatal("expected invalid autonomy to violate the database constraint")
	}
}

func TestGetFixStats(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "fix-stats")
	ctx := context.Background()

	errorGroupID := insertIncident(t, q, projectID, "fp-stats-error", "error", "merged")
	frictionGroupID := insertIncident(t, q, projectID, "fp-stats-friction", "friction", "pr_created")

	var errorJobID, frictionJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'auto') RETURNING id`,
		errorGroupID, projectID,
	).Scan(&errorJobID); err != nil {
		t.Fatalf("insert auto fix job: %v", err)
	}
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'human') RETURNING id`,
		frictionGroupID, projectID,
	).Scan(&frictionJobID); err != nil {
		t.Fatalf("insert human fix job: %v", err)
	}

	for _, receipt := range []struct {
		groupID  string
		prNumber int
		outcome  string
		delivery string
		fixJobID string
	}{
		{errorGroupID, 41, "merged", "fix-stats-merged", errorJobID},
		{frictionGroupID, 42, "closed", "fix-stats-closed", frictionJobID},
	} {
		if _, err := q.Pool().Exec(ctx,
			`INSERT INTO pr_outcomes
			   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now())`,
			receipt.groupID, projectID, receipt.prNumber, receipt.outcome, receipt.delivery, receipt.fixJobID,
		); err != nil {
			t.Fatalf("insert %s receipt: %v", receipt.outcome, err)
		}
	}

	stats, err := q.GetFixStats(ctx, projectID)
	if err != nil {
		t.Fatalf("GetFixStats: %v", err)
	}
	if stat := stats["error"]; stat.GeneratedAuto != 1 || stat.GeneratedHuman != 0 || stat.PRsMerged != 1 || stat.PRsClosed != 0 {
		t.Fatalf("error stats = %+v", stat)
	}
	// The error merge came from an auto job, so it counts in the auto split.
	if stat := stats["error"]; stat.PRsMergedAuto != 1 || stat.PRsClosedAuto != 0 {
		t.Fatalf("error auto splits = %+v", stat)
	}
	if stat := stats["friction"]; stat.GeneratedAuto != 0 || stat.GeneratedHuman != 1 || stat.PRsMerged != 0 || stat.PRsClosed != 1 {
		t.Fatalf("friction stats = %+v", stat)
	}
	// The friction close came from a human-requested job: total counts it, the
	// auto split must not.
	if stat := stats["friction"]; stat.PRsMergedAuto != 0 || stat.PRsClosedAuto != 0 {
		t.Fatalf("friction auto splits = %+v", stat)
	}
}

func TestGetFixStats_TenantScoped(t *testing.T) {
	q, projectID := createFrictionTestProject(t, "fix-stats-scope-a")
	_, otherProjectID := createFrictionTestProject(t, "fix-stats-scope-b")
	ctx := context.Background()

	otherGroupID := insertIncident(t, q, otherProjectID, "fp-stats-other", "error", "merged")
	var otherJobID string
	if err := q.Pool().QueryRow(ctx,
		`INSERT INTO error_group_jobs (error_group_id, project_id, job_type, triggered_by)
		 VALUES ($1, $2, 'fix', 'auto') RETURNING id`,
		otherGroupID, otherProjectID,
	).Scan(&otherJobID); err != nil {
		t.Fatalf("insert other project's fix job: %v", err)
	}
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO pr_outcomes
		   (error_group_id, project_id, pr_number, outcome, github_delivery_id, fix_job_id, occurred_at)
		 VALUES ($1, $2, 99, 'merged', 'fix-stats-scope-d1', $3, now())`,
		otherGroupID, otherProjectID, otherJobID,
	); err != nil {
		t.Fatalf("insert other project's receipt: %v", err)
	}

	stats, err := q.GetFixStats(ctx, projectID)
	if err != nil {
		t.Fatalf("GetFixStats: %v", err)
	}
	if stat := stats["error"]; stat != (db.FixStats{}) {
		t.Fatalf("leaked another project's error stats: %+v", stat)
	}
	if stat := stats["friction"]; stat != (db.FixStats{}) {
		t.Fatalf("leaked another project's friction stats: %+v", stat)
	}
}
