package db_test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

var onboardProvisionSequence atomic.Int64

func seedOnboardOrgOwner(t *testing.T, pool *pgxpool.Pool, label string) (orgID, userID string) {
	t.Helper()
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()+onboardProvisionSequence.Add(1))

	if err := pool.QueryRow(ctx,
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
		"onboard-"+label+"-"+suffix,
	).Scan(&orgID); err != nil {
		t.Fatalf("seed onboard org: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (org_id, email, name)
		VALUES ($1, $2, $3)
		RETURNING id`,
		orgID,
		"onboard-"+label+"-"+suffix+"@example.com",
		"Onboard Owner",
	).Scan(&userID); err != nil {
		t.Fatalf("seed onboard owner: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
		userID,
		orgID,
	); err != nil {
		t.Fatalf("seed onboard membership: %v", err)
	}

	t.Cleanup(func() { cleanupTenant(t, pool, orgID) })
	return orgID, userID
}

func cleanupOnboardSessions(t *testing.T, pool *pgxpool.Pool, sessionIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])`, sessionIDs,
		); err != nil {
			t.Logf("cleanup onboard sessions: %v", err)
		}
	})
}

func countActiveProjectKeys(t *testing.T, pool *pgxpool.Pool, projectID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM project_api_keys
		WHERE project_id = $1 AND revoked_at IS NULL`,
		projectID,
	).Scan(&count); err != nil {
		t.Fatalf("count active project keys: %v", err)
	}
	return count
}

func onboardInput(orgID, userID, repo, suffix string) db.OnboardProvisionInput {
	return db.OnboardProvisionInput{
		OrgID:         orgID,
		ProvisionedBy: userID,
		Repo:          repo,
		PollTokenHash: "poll-hash-" + suffix,
		AgentKeyPub:   "agent-pub-" + suffix,
		SealKey: func(sessionID, rawKey string) (string, error) {
			return "sealed:" + sessionID + ":" + rawKey, nil
		},
	}
}

func TestProvisionOnboardSession(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	orgID, userID := seedOnboardOrgOwner(t, pool, "primary")

	first, err := q.ProvisionOnboardSession(ctx, onboardInput(orgID, userID, "acme/web", "first"))
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}
	cleanupOnboardSessions(t, pool, first.SessionID)
	if first.ProjectID == "" || first.SessionID == "" || first.RawKey == "" {
		t.Fatalf("first provision is incomplete: %+v", first)
	}

	session, err := q.GetAgentSession(ctx, first.SessionID)
	if err != nil {
		t.Fatalf("get provisioned session: %v", err)
	}
	if session == nil || session.Status != "provisioned" || session.OrgID == nil || *session.OrgID != orgID ||
		session.ProjectID == nil || *session.ProjectID != first.ProjectID || session.APIKeySealed == nil {
		t.Fatalf("session not provisioned, sealed, and tenant-bound: %+v", session)
	}
	wantSealed := "sealed:" + first.SessionID + ":" + first.RawKey
	if *session.APIKeySealed != wantSealed {
		t.Fatalf("sealed key = %q, want %q", *session.APIKeySealed, wantSealed)
	}
	var provisionedBy string
	if err := pool.QueryRow(ctx,
		`SELECT provisioned_by_user_id FROM agent_sessions WHERE id = $1`, first.SessionID,
	).Scan(&provisionedBy); err != nil {
		t.Fatalf("read provision actor: %v", err)
	}
	if provisionedBy != userID {
		t.Fatalf("provision actor = %s, want %s", provisionedBy, userID)
	}
	if ttl := session.ExpiresAt.Sub(session.CreatedAt); ttl < 23*time.Hour || ttl > 25*time.Hour {
		t.Fatalf("session TTL = %v, want approximately 24h", ttl)
	}
	failing := onboardInput(orgID, userID, "acme/web", "failing")
	failing.SealKey = func(string, string) (string, error) {
		return "", fmt.Errorf("seal failed")
	}
	if _, err := q.ProvisionOnboardSession(ctx, failing); err == nil {
		t.Fatal("provision with a failing seal unexpectedly succeeded")
	}
	afterFailure, err := q.GetAgentSession(ctx, first.SessionID)
	if err != nil {
		t.Fatalf("read session after failed replacement: %v", err)
	}
	if afterFailure == nil || afterFailure.Status != "provisioned" || afterFailure.APIKeySealed == nil {
		t.Fatalf("failed replacement changed prior session: %+v", afterFailure)
	}
	if _, err := q.LookupProjectKey(ctx, first.RawKey); err != nil {
		t.Fatalf("failed replacement revoked the prior key: %v", err)
	}

	second, err := q.ProvisionOnboardSession(ctx, onboardInput(orgID, userID, "acme/web", "second"))
	if err != nil {
		t.Fatalf("repeat provision: %v", err)
	}
	cleanupOnboardSessions(t, pool, second.SessionID)
	if second.ProjectID != first.ProjectID {
		t.Fatalf("repeat project = %s, want %s", second.ProjectID, first.ProjectID)
	}
	if second.RawKey == first.RawKey {
		t.Fatal("repeat provision reused the one-time API key")
	}
	superseded, err := q.GetAgentSession(ctx, first.SessionID)
	if err != nil {
		t.Fatalf("read superseded session: %v", err)
	}
	if superseded == nil || superseded.Status != "expired" || superseded.APIKeySealed != nil {
		t.Fatalf("superseded session = %+v, want expired with no sealed key", superseded)
	}
	if superseded.ExpiresAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("superseded expiry = %v, want no later than now", superseded.ExpiresAt)
	}
	current, err := q.GetAgentSession(ctx, second.SessionID)
	if err != nil {
		t.Fatalf("read current session: %v", err)
	}
	if current == nil || current.Status != "provisioned" || current.APIKeySealed == nil {
		t.Fatalf("current session = %+v, want provisioned with sealed key", current)
	}
	if _, err := q.LookupProjectKey(ctx, first.RawKey); err != nil {
		t.Fatalf("superseded session's deployed key stopped working: %v", err)
	}
	if _, err := q.LookupProjectKey(ctx, second.RawKey); err != nil {
		t.Fatalf("replacement session's key is inactive: %v", err)
	}
	if active := countActiveProjectKeys(t, pool, first.ProjectID); active != 2 {
		t.Fatalf("active project keys after reprovision = %d, want 2", active)
	}

	otherOrgID, otherUserID := seedOnboardOrgOwner(t, pool, "other")
	other, err := q.ProvisionOnboardSession(ctx, onboardInput(otherOrgID, otherUserID, "acme/web", "other"))
	if err != nil {
		t.Fatalf("other-org provision: %v", err)
	}
	cleanupOnboardSessions(t, pool, other.SessionID)
	if other.ProjectID == first.ProjectID {
		t.Fatal("same repo in a different org reused the first org's project")
	}
	if other.OrgID != otherOrgID {
		t.Fatalf("other result org = %s, want %s", other.OrgID, otherOrgID)
	}
}

func TestProvisionOnboardSessionAdoptsExistingUntaggedProject(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	orgID, userID := seedOnboardOrgOwner(t, pool, "adopt")

	var existingID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo)
		VALUES ($1, 'web', 'Acme/Web')
		RETURNING id`,
		orgID,
	).Scan(&existingID); err != nil {
		t.Fatalf("seed untagged project: %v", err)
	}

	result, err := q.ProvisionOnboardSession(
		ctx,
		onboardInput(orgID, userID, "acme/web", "adopt"),
	)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	cleanupOnboardSessions(t, pool, result.SessionID)
	if result.ProjectID != existingID {
		t.Fatalf("adopted project = %s, want existing %s", result.ProjectID, existingID)
	}

	var count int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM projects
		WHERE org_id = $1 AND lower(github_repo) = lower($2)`,
		orgID,
		"acme/web",
	).Scan(&count); err != nil {
		t.Fatalf("count matching projects: %v", err)
	}
	if count != 1 {
		t.Fatalf("project count = %d, want 1", count)
	}
}

func TestProvisionOnboardSessionAdoptsExistingUntaggedProjectWithinOrg(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	firstOrgID, firstUserID := seedOnboardOrgOwner(t, pool, "adopt-first-org")
	secondOrgID, secondUserID := seedOnboardOrgOwner(t, pool, "adopt-second-org")

	var firstProjectID, secondProjectID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo)
		VALUES ($1, 'web', 'acme/web')
		RETURNING id`,
		firstOrgID,
	).Scan(&firstProjectID); err != nil {
		t.Fatalf("seed first org project: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo)
		VALUES ($1, 'web', 'ACME/WEB')
		RETURNING id`,
		secondOrgID,
	).Scan(&secondProjectID); err != nil {
		t.Fatalf("seed second org project: %v", err)
	}

	first, err := q.ProvisionOnboardSession(
		ctx,
		onboardInput(firstOrgID, firstUserID, "Acme/Web", "adopt-first-org"),
	)
	if err != nil {
		t.Fatalf("provision first org: %v", err)
	}
	cleanupOnboardSessions(t, pool, first.SessionID)
	second, err := q.ProvisionOnboardSession(
		ctx,
		onboardInput(secondOrgID, secondUserID, "acme/web", "adopt-second-org"),
	)
	if err != nil {
		t.Fatalf("provision second org: %v", err)
	}
	cleanupOnboardSessions(t, pool, second.SessionID)

	if first.ProjectID != firstProjectID {
		t.Fatalf("first org project = %s, want %s", first.ProjectID, firstProjectID)
	}
	if second.ProjectID != secondProjectID {
		t.Fatalf("second org project = %s, want %s", second.ProjectID, secondProjectID)
	}
	if first.ProjectID == second.ProjectID {
		t.Fatalf("different orgs adopted the same project %s", first.ProjectID)
	}
}

func TestProvisionOnboardSessionAdoptsExistingTaggedProjectInDirtyCoexistence(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	orgID, userID := seedOnboardOrgOwner(t, pool, "adopt-dirty")

	var taggedID, untaggedID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo, idempotency_token)
		VALUES ($1, 'tagged-web', 'acme/web', 'onboard:acme/web')
		RETURNING id`,
		orgID,
	).Scan(&taggedID); err != nil {
		t.Fatalf("seed tagged project: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (org_id, name, github_repo)
		VALUES ($1, 'untagged-web', 'Acme/Web')
		RETURNING id`,
		orgID,
	).Scan(&untaggedID); err != nil {
		t.Fatalf("seed untagged project: %v", err)
	}

	result, err := q.ProvisionOnboardSession(
		ctx,
		onboardInput(orgID, userID, "acme/web", "adopt-dirty"),
	)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	cleanupOnboardSessions(t, pool, result.SessionID)
	if result.ProjectID != taggedID {
		t.Fatalf("provisioned project = %s, want tagged %s", result.ProjectID, taggedID)
	}

	var untaggedStillExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM projects
			WHERE id = $1 AND org_id = $2 AND idempotency_token IS NULL
		)`,
		untaggedID,
		orgID,
	).Scan(&untaggedStillExists); err != nil {
		t.Fatalf("read untagged project: %v", err)
	}
	if !untaggedStillExists {
		t.Fatal("pre-existing untagged project was changed")
	}
}

func TestProvisionOnboardSessionConcurrent(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	orgID, userID := seedOnboardOrgOwner(t, pool, "concurrent")

	const callers = 2
	results := make(chan *db.OnboardProvisionResult, callers)
	errors := make(chan error, callers)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for i := range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := q.ProvisionOnboardSession(
				context.Background(),
				onboardInput(orgID, userID, "acme/concurrent", fmt.Sprintf("%d", i)),
			)
			if err != nil {
				errors <- err
				return
			}
			results <- result
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errors)

	for err := range errors {
		t.Errorf("concurrent provision: %v", err)
	}
	projectIDs := make(map[string]struct{})
	resultsBySession := make(map[string]*db.OnboardProvisionResult, callers)
	sessionIDs := make([]string, 0, callers)
	for result := range results {
		projectIDs[result.ProjectID] = struct{}{}
		sessionIDs = append(sessionIDs, result.SessionID)
		resultsBySession[result.SessionID] = result
	}
	cleanupOnboardSessions(t, pool, sessionIDs...)
	if len(sessionIDs) != callers {
		t.Fatalf("successful concurrent calls = %d, want %d", len(sessionIDs), callers)
	}
	if len(projectIDs) != 1 {
		t.Fatalf("concurrent project IDs = %#v, want one", projectIDs)
	}
	var projectID string
	for id := range projectIDs {
		projectID = id
	}
	if active := countActiveProjectKeys(t, pool, projectID); active != callers {
		t.Fatalf("active project keys after concurrent provision = %d, want %d", active, callers)
	}
	var provisionedCount, expiredCount int
	for sessionID, result := range resultsBySession {
		session, err := q.GetAgentSession(context.Background(), sessionID)
		if err != nil || session == nil {
			t.Fatalf("read concurrent session %s: session=%+v err=%v", sessionID, session, err)
		}
		switch session.Status {
		case "provisioned":
			provisionedCount++
			if session.APIKeySealed == nil {
				t.Fatalf("current session %s has no sealed key", sessionID)
			}
			if _, err := q.LookupProjectKey(context.Background(), result.RawKey); err != nil {
				t.Fatalf("current session %s returned an inactive key: %v", sessionID, err)
			}
		case "expired":
			expiredCount++
			if session.APIKeySealed != nil {
				t.Fatalf("expired session %s retained its sealed key", sessionID)
			}
			if _, err := q.LookupProjectKey(context.Background(), result.RawKey); err != nil {
				t.Fatalf("expired session %s revoked its deployed key: %v", sessionID, err)
			}
		default:
			t.Fatalf("concurrent session %s status = %q, want provisioned or expired", sessionID, session.Status)
		}
	}
	if provisionedCount != 1 || expiredCount != 1 {
		t.Fatalf("concurrent session states provisioned/expired = %d/%d, want 1/1",
			provisionedCount, expiredCount)
	}
}
