package db_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

// approveTenant seeds an org with one user and cleans up in dependency order.
// Sessions are cleaned by newPendingSession (agent_steps_test.go).
func approveTenant(t *testing.T, q *db.Queries) (orgID, userID string) {
	t.Helper()
	ctx := context.Background()
	pool := q.Pool()
	email := fmt.Sprintf("approve-%d@test.local", time.Now().UnixNano())
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name) VALUES ('approve-test') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (org_id, email, name) VALUES ($1, $2, 'Approver') RETURNING id`, orgID, email).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, stmt := range []string{
			`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
			`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
			`DELETE FROM projects WHERE org_id = $1`,
			`DELETE FROM users WHERE org_id = $1`,
			`DELETE FROM orgs WHERE id = $1`,
		} {
			if _, err := pool.Exec(ctx, stmt, orgID); err != nil {
				t.Errorf("cleanup %q: %v", stmt, err)
			}
		}
	})
	return orgID, userID
}

func approveInput(s *db.AgentSession, orgID, userID string) db.AgentApproveInput {
	pub := *s.AgentKeyPub
	return db.AgentApproveInput{
		SessionID: s.ID, OrgID: orgID, UserID: userID, ProjectName: "approve-new",
		SourcemapEndpoint: "https://app.opslane.com",
		SealKeys:          func(b string) (string, error) { return auth.SealAgentKey(pub, s.ID, b) },
	}
}

func createProject(t *testing.T, q *db.Queries, orgID, name string) *db.Project {
	t.Helper()
	ctx := context.Background()
	tx, err := q.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	p, err := q.CreateProjectTx(ctx, tx, orgID, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestApproveAgentSession_CreatesProjectAndThreeKeys(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, raw := newPendingSession(t, q, "approve-new")

	project, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID))
	if err != nil {
		t.Fatal(err)
	}
	if project.OrgID != orgID || project.Name != "approve-new" {
		t.Fatalf("unexpected project %+v", project)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "provisioned" || got.ProjectID == nil || *got.ProjectID != project.ID || got.OrgID == nil || *got.OrgID != orgID {
		t.Fatalf("session not provisioned: %+v", got)
	}
	opened, err := auth.OpenAgentKey(raw, s.ID, *got.APIKeySealed)
	if err != nil {
		t.Fatal(err)
	}
	var bundle db.AgentKeyBundle
	if err := json.Unmarshal([]byte(opened), &bundle); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(bundle.IngestKey, "opslane_pk_") || !strings.HasPrefix(bundle.APIKey, "opslane_ak_") || !strings.HasPrefix(bundle.SourcemapKey, "opslane_sk_") {
		t.Fatalf("bundle prefixes wrong: %+v", bundle)
	}
	var labels []string
	rows, err := q.Pool().Query(ctx, `SELECT scope || ':' || label FROM project_api_keys WHERE project_id = $1 ORDER BY scope`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			t.Fatal(err)
		}
		labels = append(labels, l)
	}
	rows.Close()
	if want := "api:agent-setup,ingest:agent setup,sourcemaps:agent-setup"; strings.Join(labels, ",") != want {
		t.Fatalf("labels %v, want %s", labels, want)
	}
}

func TestApproveAgentSession_AttachesToExistingProject(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	existing := createProject(t, q, orgID, "approve-existing")
	s, _ := newPendingSession(t, q, "ignored")
	in := approveInput(s, orgID, userID)
	in.ExistingProjectID = &existing.ID
	project, err := q.ApproveAgentSession(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if project.ID != existing.ID {
		t.Fatalf("expected attach to %s, got %s", existing.ID, project.ID)
	}
	var n int
	q.Pool().QueryRow(ctx, `SELECT count(*) FROM projects WHERE org_id = $1`, orgID).Scan(&n)
	if n != 1 {
		t.Fatalf("expected no new project, have %d", n)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.ProjectName == nil || *got.ProjectName != "approve-existing" {
		t.Fatalf("session project_name should follow the attached project: %+v", got.ProjectName)
	}
}

func TestApproveAgentSession_ExistingProjectMustBelongToOrg(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	otherOrg, _ := approveTenant(t, q)
	foreign := createProject(t, q, otherOrg, "foreign")
	s, _ := newPendingSession(t, q, "x")
	in := approveInput(s, orgID, userID)
	in.ExistingProjectID = &foreign.ID
	if _, err := q.ApproveAgentSession(ctx, in); !errors.Is(err, db.ErrAgentProjectNotInOrg) {
		t.Fatalf("expected ErrAgentProjectNotInOrg, got %v", err)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "pending" {
		t.Fatalf("rejected approve must leave the session pending: %s", got.Status)
	}
}

func TestApproveAgentSession_ConcurrentOneWinner(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, _ := newPendingSession(t, q, "approve-race")
	var wg sync.WaitGroup
	results := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID))
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	ok, notPending := 0, 0
	for err := range results {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, db.ErrAgentSessionNotPending):
			notPending++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 1 || notPending != 3 {
		t.Fatalf("want 1 winner and 3 not-pending, got %d/%d", ok, notPending)
	}
	var n int
	q.Pool().QueryRow(ctx, `SELECT count(*) FROM projects WHERE org_id = $1`, orgID).Scan(&n)
	if n != 1 {
		t.Fatalf("race created %d projects", n)
	}
}

func TestApproveAgentSession_ExpiredIsNotPending(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	orgID, userID := approveTenant(t, q)
	s, _ := newPendingSession(t, q, "approve-expired")
	q.Pool().Exec(ctx, `UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, s.ID)
	if _, err := q.ApproveAgentSession(ctx, approveInput(s, orgID, userID)); !errors.Is(err, db.ErrAgentSessionExpired) {
		t.Fatalf("expected expired, got %v", err)
	}
}

func TestDenyAgentSession(t *testing.T) {
	q := db.New(testPool(t))
	ctx := context.Background()
	s, _ := newPendingSession(t, q, "approve-deny")
	if err := q.DenyAgentSession(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := q.GetAgentSession(ctx, s.ID)
	if got.Status != "failed" || got.FailureReason == nil || *got.FailureReason != "authorization_denied" {
		t.Fatalf("deny did not mark failed: %+v", got)
	}
	if err := q.DenyAgentSession(ctx, s.ID); !errors.Is(err, db.ErrAgentSessionNotPending) {
		t.Fatalf("second deny should be not-pending, got %v", err)
	}
}
