package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestGetIncidentIncludesStoryAndCoverageProvenRecordings(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	ctx := context.Background()
	eventAt := time.Now().UTC().Truncate(time.Millisecond).Add(-time.Minute)
	sessionID := fmt.Sprintf("sess_receipt_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, environmentID, sessionID, eventAt.Add(-time.Minute))
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM sessions WHERE id = $1`, sessionID); err != nil {
			t.Logf("session cleanup warning: %v", err)
		}
	})

	firstMs := eventAt.UnixMilli() - 20_000
	lastMs := eventAt.UnixMilli() + 20_000
	for seq := range 6 {
		key := fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, seq)
		if err := deps.Queries.ReserveChunkSeq(ctx, sessionID, projectID, seq, key, seq == 0); err != nil {
			t.Fatalf("reserve chunk %d: %v", seq, err)
		}
		if err := deps.Queries.CommitChunk(ctx, sessionID, projectID, seq, 100); err != nil {
			t.Fatalf("commit chunk %d: %v", seq, err)
		}
		if err := deps.Queries.MarkChunkScrubbed(ctx, sessionID, projectID, seq, &firstMs, &lastMs, 100); err != nil {
			t.Fatalf("mark chunk %d scrubbed: %v", seq, err)
		}
	}

	result, err := deps.Queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: environmentID,
		Fingerprint: "handler-recordings", Title: "recording-backed incident",
		ErrorType: "TypeError", ErrorMessage: "boom", StackTraceRaw: "at test",
		SessionID: sessionID, EventTime: eventAt,
	})
	if err != nil {
		t.Fatalf("insert error event: %v", err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	requestIncident := func(groupID string) map[string]json.RawMessage {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
		request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("incident %s returned %d: %s", groupID, response.Code, response.Body.String())
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatalf("decode incident %s: %v", groupID, err)
		}
		if _, ok := body["story"]; !ok {
			t.Fatalf("incident %s omitted story: %#v", groupID, body)
		}
		return body
	}

	errorBody := requestIncident(result.GroupID)
	var recordings []struct {
		SessionID  string `json:"session_id"`
		CrashCount int64  `json:"crash_count"`
		AnchorMs   int64  `json:"anchor_ms"`
	}
	if err := json.Unmarshal(errorBody["recordings"], &recordings); err != nil {
		t.Fatalf("decode recordings: %v", err)
	}
	if len(recordings) != 1 || recordings[0].SessionID != sessionID ||
		recordings[0].CrashCount != 1 || recordings[0].AnchorMs != eventAt.UnixMilli() {
		t.Fatalf("recordings = %#v, want one crash at %d", recordings, eventAt.UnixMilli())
	}

	var frictionGroupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups
		  (project_id, environment_id, fingerprint, title, first_seen, last_seen, kind, status)
		VALUES ($1, $2, $3, 'friction incident', now(), now(), 'friction', 'insight')
		RETURNING id`, projectID, environmentID, "handler-friction-"+sessionID).Scan(&frictionGroupID); err != nil {
		t.Fatalf("insert friction incident: %v", err)
	}
	frictionBody := requestIncident(frictionGroupID)
	if _, ok := frictionBody["recordings"]; ok {
		t.Fatalf("friction incident exposed recordings: %#v", frictionBody)
	}
}

// The draft page line and the lifecycle-action responses share one
// enrichment path: a draft PR must not read "ready for review", and the
// archive/unarchive responses (which the dashboard assigns straight into
// page state) must carry the same receipt and recordings surfaces GET does.
func TestLifecycleResponsesCarryReceiptAndRecordings(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	ctx := context.Background()
	eventAt := time.Now().UTC().Truncate(time.Millisecond).Add(-time.Minute)
	sessionID := fmt.Sprintf("sess_lifecycle_%d", time.Now().UnixNano())
	seedReadableSession(t, deps.Queries, projectID, environmentID, sessionID, eventAt.Add(-time.Minute))
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM sessions WHERE id = $1`, sessionID); err != nil {
			t.Logf("session cleanup warning: %v", err)
		}
	})
	firstMs := eventAt.UnixMilli() - 20_000
	lastMs := eventAt.UnixMilli() + 20_000
	key := fmt.Sprintf("sessions/%s/%s/chunk-%06d.json.gz", projectID, sessionID, 0)
	if err := deps.Queries.ReserveChunkSeq(ctx, sessionID, projectID, 0, key, true); err != nil {
		t.Fatalf("reserve chunk: %v", err)
	}
	if err := deps.Queries.CommitChunk(ctx, sessionID, projectID, 0, 100); err != nil {
		t.Fatalf("commit chunk: %v", err)
	}
	if err := deps.Queries.MarkChunkScrubbed(ctx, sessionID, projectID, 0, &firstMs, &lastMs, 100); err != nil {
		t.Fatalf("mark chunk scrubbed: %v", err)
	}

	result, err := deps.Queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID: projectID, DefaultEnvironmentID: environmentID,
		Fingerprint: "handler-lifecycle", Title: "draft PR incident",
		ErrorType: "TypeError", ErrorMessage: "boom", StackTraceRaw: "at test",
		SessionID: sessionID, EventTime: eventAt,
	})
	if err != nil {
		t.Fatalf("insert error event: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_groups SET status = 'pr_draft', pr_url = 'https://github.com/o/r/pull/7' WHERE id = $1`, result.GroupID); err != nil {
		t.Fatalf("set draft status: %v", err)
	}
	var episodeID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
		VALUES ($1,$2,1) RETURNING id`, projectID, result.GroupID).Scan(&episodeID); err != nil {
		t.Fatalf("seed episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_decisions
		  (project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version)
		VALUES ($1,$2,'open_inquiry','test',2,0,1)`, projectID, episodeID); err != nil {
		t.Fatalf("seed factual decision: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue_inquiry_decisions
		  (project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
		VALUES ($1,$2,'investigate','test',2,$3,'test',1)`,
		projectID, episodeID, "handler-lifecycle-"+result.GroupID); err != nil {
		t.Fatalf("seed inquiry decision: %v", err)
	}

	router := handler.NewRouterWithPool(deps, pool)
	call := func(method, path string) map[string]json.RawMessage {
		t.Helper()
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s %s returned %d: %s", method, path, response.Code, response.Body.String())
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		return body
	}
	base := "/api/v1/projects/" + projectID + "/incidents/" + result.GroupID

	got := call(http.MethodGet, base)
	if string(got["receipt_state"]) != `"pr_open"` {
		t.Fatalf("draft receipt_state = %s, want pr_open", got["receipt_state"])
	}
	if string(got["receipt_line"]) != `"Draft fix PR opened; verification is pending review."` {
		t.Fatalf("draft receipt_line = %s: a draft must not read ready-for-review", got["receipt_line"])
	}

	unarchived := func() map[string]json.RawMessage {
		call(http.MethodPost, base+"/archive")
		return call(http.MethodPost, base+"/unarchive")
	}()
	if _, ok := unarchived["recordings"]; !ok {
		t.Fatalf("unarchive response dropped recordings: %#v", unarchived)
	}
	if string(unarchived["receipt_state"]) != `"pr_open"` {
		t.Fatalf("unarchive response receipt_state = %s, want pr_open", unarchived["receipt_state"])
	}
	if string(unarchived["receipt_line"]) != `"Draft fix PR opened; verification is pending review."` {
		t.Fatalf("unarchive response receipt_line = %s", unarchived["receipt_line"])
	}
}

// The incident page must not tell a reader a fix attempt failed when no fix
// job ever ran. Reconciling a dead-lettered investigation stores that
// INVESTIGATION job's id in terminal_fix_job_id, and the page used to read the
// status alone. It now reads the same database function the digest's ask does.
func TestGetIncidentDistinguishesAFailedFixFromADeadLetteredInvestigation(t *testing.T) {
	deps, pool := testDeps(t)
	orgID, projectID, environmentID, _ := seedTenant(t, deps.Queries)
	t.Cleanup(func() { cleanupTenantHandler(t, pool, orgID) })

	ctx := context.Background()
	seed := func(fingerprint, jobType string) string {
		t.Helper()
		result, err := deps.Queries.InsertErrorEventAndGroup(ctx, db.IngestParams{
			ProjectID: projectID, DefaultEnvironmentID: environmentID,
			Fingerprint: fingerprint, Title: "fix provenance incident",
			ErrorType: "TypeError", ErrorMessage: "boom", StackTraceRaw: "at test",
			EventTime: time.Now().UTC().Add(-time.Minute),
		})
		if err != nil {
			t.Fatalf("insert error event: %v", err)
		}
		var jobID string
		if err := pool.QueryRow(ctx, `INSERT INTO error_group_jobs
			(error_group_id,project_id,job_type,status) VALUES ($1,$2,$3,'completed')
			RETURNING id::text`, result.GroupID, projectID, jobType).Scan(&jobID); err != nil {
			t.Fatalf("seed %s job: %v", jobType, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE error_groups
			SET status='needs_human',root_cause='The submit handler exits early.',
			    terminal_fix_job_id=$2::uuid WHERE id=$1`, result.GroupID, jobID); err != nil {
			t.Fatalf("set terminal state: %v", err)
		}
		// The receipt framing is served only for an investigation-eligible
		// incident, so the episode and its two decisions are part of the fixture.
		var episodeID string
		if err := pool.QueryRow(ctx, `INSERT INTO issue_episodes (project_id,canonical_issue_id,sequence)
			VALUES ($1,$2,1) RETURNING id`, projectID, result.GroupID).Scan(&episodeID); err != nil {
			t.Fatalf("seed episode: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO issue_decisions
			(project_id,episode_id,decision,reason,users_7d,anon_7d,rule_version)
			VALUES ($1,$2,'open_inquiry','test',2,0,1)`, projectID, episodeID); err != nil {
			t.Fatalf("seed factual decision: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO issue_inquiry_decisions
			(project_id,episode_id,decision,reason,evaluated_units,evidence_signature,model,prompt_version)
			VALUES ($1,$2,'investigate','test',2,$3,'test',1)`,
			projectID, episodeID, fingerprint+"-"+result.GroupID); err != nil {
			t.Fatalf("seed inquiry decision: %v", err)
		}
		return result.GroupID
	}
	failedFix := seed("handler-fix-provenance-fix", "fix")
	deadLetteredInvestigation := seed("handler-fix-provenance-investigate", "investigate")

	router := handler.NewRouterWithPool(deps, pool)
	receiptState := func(groupID string) string {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/projects/"+projectID+"/incidents/"+groupID, nil)
		request.Header.Set("Authorization", "Bearer "+dashboardToken(t, orgID))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("GET incident returned %d: %s", response.Code, response.Body.String())
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatalf("decode incident: %v", err)
		}
		return string(body["receipt_state"])
	}

	if got := receiptState(failedFix); got != `"attempt_failed_no_diff"` {
		t.Fatalf("incident whose fix job ran = %s, want attempt_failed_no_diff", got)
	}
	if got := receiptState(deadLetteredInvestigation); got != `"report_ready"` {
		t.Fatalf("incident whose fix never ran = %s, want report_ready", got)
	}
}
