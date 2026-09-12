package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ingestTestEvent sends one error event through the real ingest route with
// the fixture's ingest key and attaches it to a group, the way
// read_api_event_count_test.go does, so has_events and LatestErrorGroupID flip.
func ingestTestEvent(t *testing.T, a approveRig) string {
	t.Helper()
	ctx := context.Background()
	pool := a.deps.Queries.Pool()
	event := `{"timestamp":"2026-08-26T00:00:00Z","error":{"type":"Error","message":"opslane-test","stack":"at test.js:1:1"},"breadcrumbs":[],"context":{"url":"https://example.test"},"sdk_version":"0.1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(event))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", a.rawKey)
	rec := httptest.NewRecorder()
	a.r.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("ingest: %d %s", rec.Code, rec.Body.String())
	}
	var eventID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM error_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, a.project).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	var groupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO error_groups (project_id, fingerprint, title, first_seen, last_seen, occurrence_count, sample_event_id, platform)
		VALUES ($1, $2, 'opslane-test', now(), now(), 1, $3, 'javascript') RETURNING id::text`,
		a.project, "agent-poll-"+uuid.NewString(), eventID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE error_events SET error_group_id = $1 WHERE id = $2`, groupID, eventID); err != nil {
		t.Fatal(err)
	}
	return groupID
}

func timedPoll(t *testing.T, a approveRig, query string) (int, map[string]any, time.Duration) {
	t.Helper()
	start := time.Now()
	code, out := a.poll(t, query)
	return code, out, time.Since(start)
}

func TestAgentPoll_PendingLongPollReturnsOnApproval(t *testing.T) {
	a := newApproveRig(t)
	code, out, took := timedPoll(t, a, "")
	if code != http.StatusOK || out["status"] != "pending" || out["approved"] != false || took > time.Second {
		t.Fatalf("plain poll: %d %v %s", code, out, took)
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		a.fire(http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	}()
	code, out, took = timedPoll(t, a, "?wait=10")
	if code != http.StatusOK || out["approved"] != true {
		t.Fatalf("long poll: %d %v", code, out)
	}
	if took < time.Second || took > 4*time.Second {
		t.Fatalf("long poll should return ~1s after approval, took %s", took)
	}
	for _, k := range []string{"ingest_key", "api_key", "sourcemap_key", "project_id", "dashboard_url", "next", "status_help", "issues_url", "github_connect_url", "steps"} {
		if _, present := out[k]; !present {
			t.Fatalf("missing %s: %v", k, out)
		}
	}
	if out["has_events"] != false || out["github_connected"] != false || out["slack_connected"] != false || out["sourcemaps_uploaded"] != false {
		t.Fatalf("fresh facts should all be false: %v", out)
	}
	for field, want := range map[string]string{
		"issues_url":         "https://app.example.test/?project_id=" + a.project,
		"dashboard_url":      "https://app.example.test/?project_id=" + a.project,
		"github_connect_url": "https://app.example.test/settings?project_id=" + a.project + "#github",
	} {
		if out[field] != want {
			t.Fatalf("%s=%v want %s", field, out[field], want)
		}
	}
	if u, _ := out["github_connect_url"].(string); !strings.HasPrefix(u, "https://app.example.test/settings") {
		t.Fatalf("github_connect_url must be an Opslane page: %v", out["github_connect_url"])
	}
}

func TestAgentPoll_UntilEventHoldsThenFlips(t *testing.T) {
	a := newApproveRig(t)
	// History on the attached project predates the session and must not count.
	if _, err := a.deps.Queries.Pool().Exec(context.Background(),
		`INSERT INTO error_events (project_id, environment_id, "timestamp", platform, error_type, error_message, stack_trace_raw, created_at)
		 SELECT $1, default_environment_id, now() - interval '1 day', 'javascript', 'TypeError', 'old', 'at a (b.js:1:1)', now() - interval '1 day'
		 FROM projects WHERE id = $1`, a.project); err != nil {
		t.Fatal(err)
	}
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	code, out, took := timedPoll(t, a, "?wait=2&until=event")
	if code != http.StatusOK || out["has_events"] != false || took < 1900*time.Millisecond {
		t.Fatalf("until=event should hold the full wait with no events: %d %v %s", code, out, took)
	}
	groupID := ingestTestEvent(t, a)
	code, out, _ = timedPoll(t, a, "?wait=5&until=event")
	if code != http.StatusOK || out["has_events"] != true {
		t.Fatalf("after event: %d %v", code, out)
	}
	if u, _ := out["latest_error_group_url"].(string); u != "https://app.example.test/issues/"+groupID+"?project_id="+a.project {
		t.Fatalf("latest_error_group_url %v", out["latest_error_group_url"])
	}
	if next, _ := out["next"].(string); !strings.Contains(next, "Remove the test button") {
		t.Fatalf("next after event: %q", next)
	}
}

func TestAgentPoll_DenyAndExpiryDuringWaitReturnPromptly(t *testing.T) {
	a := newApproveRig(t)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		a.fire(http.MethodPost, "/api/v1/agent/approve/"+a.pollID+"/deny", ``, true)
	}()
	code, out, took := timedPoll(t, a, "?wait=10")
	if code != http.StatusOK || out["status"] != "failed" || took > 4*time.Second {
		t.Fatalf("deny during wait: %d %v %s", code, out, took)
	}
	b := newApproveRig(t)
	b.do(t, http.MethodPost, "/api/v1/agent/approve/"+b.pollID, `{"existing_project_id":"`+b.project+`"}`, true)
	go func() {
		time.Sleep(1200 * time.Millisecond)
		b.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, b.pollID)
	}()
	code, out, took = timedPoll(t, b, "?wait=10&until=event")
	if code != http.StatusGone || out["status"] != "expired" || took > 4*time.Second {
		t.Fatalf("expiry during until=event wait: %d %v %s", code, out, took)
	}
}

func TestAgentPoll_CompletedSessionNeverHolds(t *testing.T) {
	a := newApproveRig(t)
	a.do(t, http.MethodPost, "/api/v1/agent/approve/"+a.pollID, `{"existing_project_id":"`+a.project+`"}`, true)
	a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET status = 'completed' WHERE id = $1`, a.pollID)
	code, out, took := timedPoll(t, a, "?wait=10&until=event")
	if code != http.StatusOK || out["status"] != "completed" || took > 2*time.Second {
		t.Fatalf("completed must return at once: %d %v %s", code, out, took)
	}
}

func TestAgentPoll_CancelledRequestReturns(t *testing.T) {
	a := newApproveRig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req := agentRequest(http.MethodGet, "/api/v1/agent/poll/"+a.pollID+"?wait=30", "", a.ip).WithContext(ctx)
	req.Header.Set("X-Opslane-Poll-Token", a.token)
	rec := httptest.NewRecorder()
	start := time.Now()
	a.r.ServeHTTP(rec, req)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("cancelled request should return promptly, took %s", took)
	}
}
