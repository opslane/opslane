package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestAdminOverviewOnboardingFunnel(t *testing.T) {
	admin := testPool(t)
	psql := findPsql(t)
	pool, dsn := disposableDB(t, admin)
	for _, file := range migrationFiles(t) {
		if err := applyMigration(t, psql, dsn, file); err != nil {
			t.Fatalf("apply migration %s: %v", file, err)
		}
	}
	ctx := context.Background()
	q := db.New(pool)

	org, err := q.CreateOrg(ctx, "funnel-org")
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	projectWithoutEvent, err := q.CreateProject(ctx, org.ID, "funnel-no-event", ptrStr("funnel/no-event"))
	if err != nil {
		t.Fatalf("create project without event: %v", err)
	}
	projectWithEvent, err := q.CreateProject(ctx, org.ID, "funnel-with-event", ptrStr("funnel/with-event"))
	if err != nil {
		t.Fatalf("create project with event: %v", err)
	}
	environment, err := q.CreateEnvironment(ctx, projectWithEvent.ID, "production")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	if _, err := q.InsertErrorEventAndGroup(ctx, db.IngestParams{
		ProjectID:            projectWithEvent.ID,
		DefaultEnvironmentID: environment.ID,
		ErrorType:            "TypeError",
		ErrorMessage:         "onboarding activation fixture",
		StackTraceRaw:        "at fixture.ts:1:1",
		Fingerprint:          "funnel-activation",
		Title:                "Onboarding activation fixture",
	}); err != nil {
		t.Fatalf("insert activation event: %v", err)
	}

	createSession := func(name string) string {
		t.Helper()
		session, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
			RepoURL:       "funnel/" + name,
			PollTokenHash: "poll-" + name,
			AgentKeyPub:   "pub-" + name,
		})
		if err != nil {
			t.Fatalf("create session %s: %v", name, err)
		}
		return session.ID
	}
	updateSession := func(name, query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("update session %s: %v", name, err)
		}
	}

	_ = createSession("started")
	authClickedID := createSession("auth-clicked")
	updateSession("auth-clicked", `UPDATE agent_sessions SET auth_clicked_at = now() WHERE id = $1`, authClickedID)

	completedID := createSession("completed")
	updateSession("completed", `UPDATE agent_sessions SET status = 'completed', project_id = $2, completed_at = now() WHERE id = $1`, completedID, projectWithoutEvent.ID)

	activatedID := createSession("activated")
	updateSession("activated", `UPDATE agent_sessions SET status = 'completed', project_id = $2, completed_at = now(), key_claimed_at = now() WHERE id = $1`, activatedID, projectWithEvent.ID)
	for _, status := range []string{"provisioned", "key_ok", "app_reporting"} {
		id := createSession(status)
		updateSession(status, `UPDATE agent_sessions SET status = $2, project_id = $3 WHERE id = $1`, id, status, projectWithoutEvent.ID)
	}

	failedRepoID := createSession("failed-repo")
	updateSession("failed-repo", `UPDATE agent_sessions SET status = 'failed', failure_reason = 'repo_not_granted' WHERE id = $1`, failedRepoID)
	failedIdentityID := createSession("failed-identity")
	updateSession("failed-identity", `UPDATE agent_sessions SET status = 'failed', failure_reason = 'identity_unverified' WHERE id = $1`, failedIdentityID)

	if _, err := pool.Exec(ctx, `INSERT INTO agent_sessions (repo_url) VALUES ('funnel/legacy')`); err != nil {
		t.Fatalf("insert legacy session: %v", err)
	}
	oldSessionID := createSession("old")
	updateSession("old", `UPDATE agent_sessions SET created_at = now() - interval '40 days' WHERE id = $1`, oldSessionID)

	overview, err := q.AdminOverviewData(ctx)
	if err != nil {
		t.Fatalf("admin overview: %v", err)
	}
	funnel := overview.Onboarding
	if funnel.Started != 9 {
		t.Fatalf("started=%d want 9", funnel.Started)
	}
	if funnel.AuthClicked != 1 {
		t.Fatalf("auth_clicked=%d want 1", funnel.AuthClicked)
	}
	if funnel.Completed != 5 {
		t.Fatalf("completed=%d want 5", funnel.Completed)
	}
	if funnel.KeyClaimed != 1 {
		t.Fatalf("key_claimed=%d want 1", funnel.KeyClaimed)
	}
	if funnel.FirstEventReceived != 1 {
		t.Fatalf("first_event_received=%d want 1", funnel.FirstEventReceived)
	}
	if funnel.Failed != 2 {
		t.Fatalf("failed=%d want 2", funnel.Failed)
	}
	if got := funnel.ByFailureReason["repo_not_granted"]; got != 1 {
		t.Fatalf("repo_not_granted=%d want 1", got)
	}
	if got := funnel.ByFailureReason["identity_unverified"]; got != 1 {
		t.Fatalf("identity_unverified=%d want 1", got)
	}
}
