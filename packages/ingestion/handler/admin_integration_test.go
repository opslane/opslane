package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestAdminRoutesFailClosedAndAuthMeSignalsAllowlist(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	uniq := fmt.Sprint(time.Now().UnixNano())
	org, err := q.CreateOrg(ctx, "admin-auth-"+uniq)
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID, "admin+"+uniq+"@example.com", "Admin", time.Now().UnixNano(), "admin-"+uniq, "")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	project, err := q.CreateProject(ctx, org.ID, "admin-funnel-"+uniq, ptrStr("admin/funnel-"+uniq))
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, project.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	if _, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            project.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "admin onboarding contract fixture",
		StackTraceRaw:        "at admin-fixture.ts:1:1",
		Fingerprint:          "admin-funnel-" + uniq,
		Title:                "Admin onboarding contract fixture",
	}); err != nil {
		t.Fatalf("insert event: %v", err)
	}
	before, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview before fixture session: %v", err)
	}
	session, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		RepoURL:       "admin/funnel-" + uniq,
		PollTokenHash: "poll-" + uniq,
		AgentKeyPub:   "pub-" + uniq,
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE agent_sessions
		SET status = 'completed', project_id = $2, completed_at = now(),
		    auth_clicked_at = now(), key_claimed_at = now()
		WHERE id = $1`, session.ID, project.ID); err != nil {
		t.Fatalf("complete agent session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_sessions WHERE id = $1`, session.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_group_jobs WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_events WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM error_groups WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM environments WHERE project_id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM projects WHERE id = $1`, project.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, org.ID)
	})

	token, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	authz := map[string]string{"Authorization": "Bearer " + token}

	adminDeps := &handler.Dependencies{
		Queries:     db.New(pool),
		JWTSecret:   []byte(authTestJWTSecret),
		AdminEmails: handler.ParseAdminEmails(strings.ToUpper(user.Email)),
	}
	adminRouter := handler.NewRouter(adminDeps)
	overviewResponse := doRequest(adminRouter, http.MethodGet, "/api/v1/admin/overview", authz)
	if overviewResponse.Code != http.StatusOK {
		t.Fatalf("admin overview = %d, want 200: %s", overviewResponse.Code, overviewResponse.Body.String())
	}
	var overviewBody map[string]json.RawMessage
	if err := json.Unmarshal(overviewResponse.Body.Bytes(), &overviewBody); err != nil {
		t.Fatalf("decode admin overview: %v", err)
	}
	var onboarding map[string]json.RawMessage
	if raw, ok := overviewBody["onboarding"]; !ok {
		t.Fatal("admin overview missing onboarding object")
	} else if err := json.Unmarshal(raw, &onboarding); err != nil {
		t.Fatalf("decode onboarding object: %v", err)
	}
	minimums := map[string]int64{
		"started":              before.Onboarding.Started + 1,
		"auth_clicked":         before.Onboarding.AuthClicked + 1,
		"completed":            before.Onboarding.Completed + 1,
		"key_claimed":          before.Onboarding.KeyClaimed + 1,
		"first_event_received": before.Onboarding.FirstEventReceived + 1,
		"failed":               before.Onboarding.Failed,
	}
	for field, minimum := range minimums {
		raw, ok := onboarding[field]
		if !ok {
			t.Errorf("onboarding missing numeric field %q", field)
			continue
		}
		var got int64
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Errorf("decode onboarding.%s: %v", field, err)
		} else if got < minimum {
			t.Errorf("onboarding.%s=%d want at least %d", field, got, minimum)
		}
	}
	if raw, ok := onboarding["by_failure_reason"]; !ok {
		t.Error("onboarding missing by_failure_reason field")
	} else {
		var reasons map[string]int64
		if err := json.Unmarshal(raw, &reasons); err != nil {
			t.Errorf("decode onboarding.by_failure_reason: %v", err)
		}
	}
	me := doRequest(adminRouter, http.MethodGet, "/api/v1/auth/me", authz)
	if me.Code != http.StatusOK {
		t.Fatalf("auth me = %d, want 200: %s", me.Code, me.Body.String())
	}
	var meBody map[string]any
	if err := json.Unmarshal(me.Body.Bytes(), &meBody); err != nil {
		t.Fatalf("decode auth me: %v", err)
	}
	if meBody["is_admin"] != true {
		t.Fatalf("auth me is_admin = %v, want true", meBody["is_admin"])
	}

	nonAdminDeps := &handler.Dependencies{
		Queries:     db.New(pool),
		JWTSecret:   []byte(authTestJWTSecret),
		AdminEmails: handler.ParseAdminEmails("someone-else@example.com"),
	}
	if w := doRequest(handler.NewRouter(nonAdminDeps), http.MethodGet, "/api/v1/admin/overview", authz); w.Code != http.StatusNotFound {
		t.Fatalf("non-admin overview = %d, want 404: %s", w.Code, w.Body.String())
	}

	disabledDeps := &handler.Dependencies{Queries: db.New(pool), JWTSecret: []byte(authTestJWTSecret)}
	if w := doRequest(handler.NewRouter(disabledDeps), http.MethodGet, "/api/v1/admin/jobs", authz); w.Code != http.StatusNotFound {
		t.Fatalf("disabled admin jobs = %d, want 404: %s", w.Code, w.Body.String())
	}
}
