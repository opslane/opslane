package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestInboxSeparatesWatchedDeclinedAndProcessing(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	ctx := context.Background()

	seedIssue := func(title string) (string, string) {
		t.Helper()
		var issueID, episodeID string
		if err := pool.QueryRow(ctx, `INSERT INTO error_groups
			(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
			VALUES ($1,$2,$3,$4,'error','new',now(),now()) RETURNING id::text`,
			projectID, environmentID, "inbox-"+uuid.NewString(), title).Scan(&issueID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
			(project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id::text`,
			projectID, issueID).Scan(&episodeID); err != nil {
			t.Fatal(err)
		}
		return issueID, episodeID
	}
	watchedID, watchedEpisode := seedIssue("Watched issue")
	if _, err := pool.Exec(ctx, `INSERT INTO issue_decisions
		(project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version)
		VALUES ($1,$2,'watch','1 affected unit in seven days',1,0,1)`, projectID, watchedEpisode); err != nil {
		t.Fatal(err)
	}
	declinedID, declinedEpisode := seedIssue("Declined issue")
	if _, err := pool.Exec(ctx, `INSERT INTO issue_inquiry_decisions
		(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		VALUES ($1,$2,'do_not_pursue','browser extension noise',1,$3,'test',1)`,
		projectID, declinedEpisode, "inbox-"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	var eventID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_events
		(project_id,environment_id,timestamp,error_type,error_message,stack_trace_raw,platform)
		VALUES ($1,$2,now(),'TypeError','pending identity','at pending','javascript') RETURNING id::text`,
		projectID, environmentID).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO error_event_identities
		(project_id,event_id,status,raw_fingerprint,identity_version)
		VALUES ($1,$2,'pending',$3,2)`, projectID, eventID, "pending-"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/incidents", nil)
	request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list inbox: %d %s", response.Code, response.Body.String())
	}
	var issues []struct {
		ID          string `json:"id"`
		State       string `json:"state"`
		StateReason string `json:"state_reason"`
	}
	if err := json.NewDecoder(response.Body).Decode(&issues); err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]struct{ state, reason string })
	for _, issue := range issues {
		byID[issue.ID] = struct{ state, reason string }{issue.State, issue.StateReason}
	}
	if got := byID[watchedID]; got.state != "watching" || got.reason != "1 affected unit in seven days" {
		t.Errorf("watched=%+v", got)
	}
	if got := byID[declinedID]; got.state != "reviewed_not_pursuing" || got.reason != "browser extension noise" {
		t.Errorf("declined=%+v", got)
	}
	if got := byID[eventID]; got.state != "processing" || got.reason == "" {
		t.Errorf("processing=%+v", got)
	}
}

func TestInboxReviewAgainReusesActiveInquiry(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	ctx := context.Background()
	var issueID, episodeID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen)
		VALUES ($1,$2,$3,'Declined issue','error','new',now(),now()) RETURNING id::text`,
		projectID, environmentID, "review-"+uuid.NewString()).Scan(&issueID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
		(project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id::text`,
		projectID, issueID).Scan(&episodeID); err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	var firstJob string
	for attempt := 0; attempt < 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost,
			"/api/v1/projects/"+projectID+"/incidents/"+issueID+"/review", nil)
		request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("review attempt %d: %d %s", attempt, response.Code, response.Body.String())
		}
		var body struct {
			JobID string `json:"job_id"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			firstJob = body.JobID
		} else if body.JobID != firstJob {
			t.Fatalf("active inquiry was not reused: %s != %s", body.JobID, firstJob)
		}
	}
	var jobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM error_group_jobs
		WHERE project_id=$1 AND episode_id=$2 AND job_type='issue_inquiry'`,
		projectID, episodeID).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("inquiry jobs = %d, want 1", jobs)
	}
}

// An issue that never reached an episode has no pipeline state. The inbox must
// keep showing its own status: the dashboard files "watching" away from the
// primary list, so claiming one here hides work a customer can act on today.
func TestInboxLeavesPreEpisodeIssuesToTheirOwnStatus(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })
	ctx := context.Background()

	var legacyID, archivedID string
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,pr_url)
		VALUES ($1,$2,$3,'Legacy issue with a fix PR','error','pr_created',now(),now(),
		        'https://github.com/acme/shop/pull/7') RETURNING id::text`,
		projectID, environmentID, "legacy-"+uuid.NewString()).Scan(&legacyID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO error_groups
		(project_id,environment_id,fingerprint,title,kind,status,first_seen,last_seen,archived_at)
		VALUES ($1,$2,$3,'Archived issue','error','archived',now(),now(),now()) RETURNING id::text`,
		projectID, environmentID, "archived-"+uuid.NewString()).Scan(&archivedID); err != nil {
		t.Fatal(err)
	}
	var archivedEpisode string
	if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes
		(project_id,canonical_issue_id,sequence) VALUES ($1,$2,1) RETURNING id::text`,
		projectID, archivedID).Scan(&archivedEpisode); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO issue_inquiry_decisions
		(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		VALUES ($1,$2,'investigate','worth a look',3,$3,'test',1)`,
		projectID, archivedEpisode, "archived-"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO diagnosis_decisions
		(error_group_id,project_id,episode_id,outcome,decision_reason,model,prompt_version)
		VALUES ($1,$2,$3,'verified_fix','shipped','test','1')`,
		archivedID, projectID, archivedEpisode); err != nil {
		t.Fatal(err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	for _, want := range []struct{ id, status string }{{legacyID, "pr_created"}, {archivedID, "archived"}} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/incidents/"+want.id, nil)
		request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("read %s: %d %s", want.id, response.Code, response.Body.String())
		}
		var issue struct {
			Status string `json:"status"`
			State  string `json:"state"`
		}
		if err := json.NewDecoder(response.Body).Decode(&issue); err != nil {
			t.Fatal(err)
		}
		if issue.Status != want.status {
			t.Errorf("%s status=%q want %q", want.id, issue.Status, want.status)
		}
		if issue.State != "" {
			t.Errorf("%s carries pipeline state %q; it must keep its own status", want.id, issue.State)
		}
	}
}
