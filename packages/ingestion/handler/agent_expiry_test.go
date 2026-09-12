package handler_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func expireSoon(t *testing.T, a approveRig) {
	t.Helper()
	if _, err := a.deps.Queries.Pool().Exec(context.Background(), `UPDATE agent_sessions SET expires_at=now()+interval '500 milliseconds' WHERE id=$1`, a.pollID); err != nil {
		t.Fatal(err)
	}
}

func assertExpiredWithoutFacts(t *testing.T, code int, body map[string]any) {
	t.Helper()
	if code != http.StatusGone || body["status"] != "expired" {
		t.Fatalf("expected expiry, got HTTP %d status %v", code, body["status"])
	}
	for _, key := range []string{"ingest_key", "api_key", "sourcemap_key", "project_id", "has_events", "steps"} {
		if _, ok := body[key]; ok {
			t.Fatalf("expired response includes %s", key)
		}
	}
}

func TestAgentPoll_ExpiryDuringKeyDeliveryDoesNotReleaseKeys(t *testing.T) {
	a := approvedRig(t)
	expireSoon(t, a)
	tx, err := a.deps.Queries.Pool().Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE`, a.pollID); err != nil {
		t.Fatal(err)
	}
	// Hold the row across expiry so MarkAgentKeyDelivered cannot finish in time.
	unlocked := make(chan struct{})
	go func() { time.Sleep(800 * time.Millisecond); _ = tx.Rollback(context.Background()); close(unlocked) }()
	defer func() { <-unlocked }()
	code, body := a.poll(t, "")
	assertExpiredWithoutFacts(t, code, body)
}

func TestAgentState_ExpiryDuringFactReadDoesNotReleaseFacts(t *testing.T) {
	a := approvedRig(t)
	expireSoon(t, a)
	tx, err := a.deps.Queries.Pool().Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `LOCK TABLE sourcemap_files IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	unlocked := make(chan struct{})
	go func() { time.Sleep(800 * time.Millisecond); _ = tx.Rollback(context.Background()); close(unlocked) }()
	defer func() { <-unlocked }()
	code, body := sessionCall(t, a, http.MethodGet, "state", "", a.token)
	assertExpiredWithoutFacts(t, code, body)
}

type delayedAgentBody struct {
	reader io.Reader
	wait   time.Duration
}

func (b *delayedAgentBody) Read(p []byte) (int, error) {
	time.Sleep(b.wait)
	b.wait = 0
	return b.reader.Read(p)
}

func TestAgentActions_ExpiryDuringBodyReadPreventsMutation(t *testing.T) {
	for _, sub := range []string{"progress", "github", "slack"} {
		t.Run(sub, func(t *testing.T) {
			a := approvedRig(t)
			expireSoon(t, a)
			body := map[string]string{"progress": `{"step":"mcp","status":"done"}`, "github": `{"repo":"acme/web"}`, "slack": `{"webhook_url":"https://hooks.slack.com/services/test"}`}[sub]
			req := agentRequest(http.MethodPost, "/api/v1/agent/poll/"+a.pollID+"/"+sub, "", a.ip)
			req.Header.Set("X-Opslane-Poll-Token", a.token)
			req.Body = io.NopCloser(&delayedAgentBody{reader: strings.NewReader(body), wait: 800 * time.Millisecond})
			rec := httptest.NewRecorder()
			a.r.ServeHTTP(rec, req)
			assertExpiredWithoutFacts(t, rec.Code, decodeBody(t, rec))
			steps, err := a.deps.Queries.ListAgentSteps(context.Background(), a.pollID)
			if err != nil || len(steps) != 0 {
				t.Fatalf("expired request recorded progress: %v %v", steps, err)
			}
		})
	}
}
