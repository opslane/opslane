package db_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/db"
)

var provisionFixtureSequence atomic.Int64

type provisionFixture struct {
	suffix         string
	installationID int64
	githubOrgID    int64
	githubUserID   int64
}

func newProvisionFixture() provisionFixture {
	base := time.Now().UnixNano() + provisionFixtureSequence.Add(1)
	return provisionFixture{
		suffix:         fmt.Sprintf("%d", base),
		installationID: base,
		githubOrgID:    base + 1,
		githubUserID:   base + 2,
	}
}

func (f provisionFixture) input(sessionID, canonicalRepo string) db.AgentProvisionInput {
	return db.AgentProvisionInput{
		SessionID:      sessionID,
		InstallationID: f.installationID,
		CanonicalRepo:  canonicalRepo,
		GitHubOrgName:  "agent-org-" + f.suffix,
		GitHubOrgID:    f.githubOrgID,
		GitHubUserID:   f.githubUserID,
		GitHubLogin:    "agent-user-" + f.suffix,
		DisplayName:    "Agent User " + f.suffix,
		Email:          "agent-user-" + f.suffix + "@example.com",
		EmailVerified:  true,
		AvatarURL:      "https://example.com/avatar-" + f.suffix + ".png",
		SealKey: func(rawKey string) (string, error) {
			return "sealed:" + rawKey, nil
		},
	}
}

// provisionCleanup keeps cleanup dependency ordered. Agent sessions and GitHub
// installations both reference tenant rows, so they must be removed first.
type provisionCleanup struct {
	t               *testing.T
	pool            *pgxpool.Pool
	sessionIDs      []string
	installationIDs []int64
	orgIDs          []string
}

func newProvisionCleanup(t *testing.T, pool *pgxpool.Pool) *provisionCleanup {
	t.Helper()
	c := &provisionCleanup{t: t, pool: pool}
	t.Cleanup(c.run)
	return c
}

func (c *provisionCleanup) session(id string) {
	c.sessionIDs = append(c.sessionIDs, id)
}

func (c *provisionCleanup) installation(id int64) {
	c.installationIDs = append(c.installationIDs, id)
}

func (c *provisionCleanup) org(id string) {
	c.orgIDs = append(c.orgIDs, id)
}

func (c *provisionCleanup) run() {
	ctx := context.Background()
	for _, id := range uniqueStrings(c.sessionIDs) {
		if _, err := c.pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, id); err != nil {
			c.t.Logf("cleanup agent session %s: %v", id, err)
		}
	}
	for _, id := range uniqueInt64s(c.installationIDs) {
		if _, err := c.pool.Exec(ctx, `DELETE FROM installation_landed WHERE installation_id = $1`, id); err != nil {
			c.t.Logf("cleanup landed installation %d: %v", id, err)
		}
		if _, err := c.pool.Exec(ctx, `DELETE FROM github_app_installations WHERE installation_id = $1`, id); err != nil {
			c.t.Logf("cleanup GitHub installation %d: %v", id, err)
		}
	}
	for _, id := range uniqueStrings(c.orgIDs) {
		cleanupTenant(c.t, c.pool, id)
	}
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func uniqueInt64s(values []int64) []int64 {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func createProvisionSession(t *testing.T, q *db.Queries, cleanup *provisionCleanup, repo string) *db.AgentSession {
	t.Helper()
	nonce := fmt.Sprintf("%d", time.Now().UnixNano()+provisionFixtureSequence.Add(1))
	session, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		RepoURL:       repo,
		PollTokenHash: "provision-hash-" + nonce,
		AgentKeyPub:   "provision-pub-" + nonce,
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	cleanup.session(session.ID)
	return session
}

func requireProvisionFailure(t *testing.T, q *db.Queries, sessionID string, err, want error, reason string) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("provision error = %v, want %v", err, want)
	}
	session, getErr := q.GetAgentSession(context.Background(), sessionID)
	if getErr != nil {
		t.Fatalf("get failed session: %v", getErr)
	}
	if session == nil {
		t.Fatal("failed session is missing")
	}
	if session.Status != "failed" {
		t.Fatalf("session status = %q, want failed", session.Status)
	}
	if session.FailureReason == nil || *session.FailureReason != reason {
		t.Fatalf("session failure reason = %v, want %q", session.FailureReason, reason)
	}
}

func TestProvisionAgentSession_NewOrgUserProjectKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo := "Prov-Owner-" + fixture.suffix + "/Prov-Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(ctx, input)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	cleanup.org(result.OrgID)
	if !result.Created || result.UserID == "" {
		t.Fatalf("new agent provision result = %+v, want created user", result)
	}

	after, err := q.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get provisioned session: %v", err)
	}
	if after == nil || after.Status != "provisioned" || after.APIKeySealed == nil {
		t.Fatalf("session not provisioned with sealed key: %+v", after)
	}
	if !strings.HasPrefix(*after.APIKeySealed, "sealed:opslane_pk_") {
		t.Errorf("sealed API key = %q, want sealed raw Opslane key", *after.APIKeySealed)
	}
	if after.OrgID == nil || *after.OrgID != result.OrgID || after.ProjectID == nil || *after.ProjectID != result.ProjectID {
		t.Errorf("provisioned session tenant = (%v, %v), want (%s, %s)", after.OrgID, after.ProjectID, result.OrgID, result.ProjectID)
	}
	if after.InstallationID == nil || *after.InstallationID != input.InstallationID {
		t.Errorf("provisioned session installation = %v, want %d", after.InstallationID, input.InstallationID)
	}

	var storedRepo string
	if err := pool.QueryRow(ctx, `SELECT github_repo FROM projects WHERE id = $1`, result.ProjectID).Scan(&storedRepo); err != nil {
		t.Fatalf("read provisioned project: %v", err)
	}
	if storedRepo != repo {
		t.Errorf("github_repo = %q, want canonical %q", storedRepo, repo)
	}

	var verified bool
	var role string
	err = pool.QueryRow(ctx,
		`SELECT ai.email_verified, m.role
		 FROM auth_identities ai
		 JOIN users u ON u.id = ai.user_id
		 JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
		 WHERE u.org_id = $1 AND ai.provider = 'github' AND ai.provider_subject = $2`,
		result.OrgID, fmt.Sprintf("%d", input.GitHubUserID)).Scan(&verified, &role)
	if err != nil {
		t.Fatalf("read provisioned identity: %v", err)
	}
	if !verified || role != "owner" {
		t.Errorf("provisioned identity verified=%v role=%q, want true/owner", verified, role)
	}

	var environmentCount, keyCount int
	err = pool.QueryRow(ctx,
		`SELECT count(DISTINCT e.id), count(DISTINCT k.id)
		 FROM environments e
		 LEFT JOIN project_api_keys k ON k.project_id = e.project_id
		 WHERE e.project_id = $1`, result.ProjectID).Scan(&environmentCount, &keyCount)
	if err != nil {
		t.Fatalf("count environment and key: %v", err)
	}
	if environmentCount != 1 || keyCount != 1 {
		t.Errorf("environments/keys = %d/%d, want 1/1", environmentCount, keyCount)
	}
	lookup, err := q.LookupProjectKey(ctx, strings.TrimPrefix(*after.APIKeySealed, "sealed:"))
	if err != nil {
		t.Fatalf("lookup sealed development key: %v", err)
	}
	if lookup.ProjectID != result.ProjectID {
		t.Errorf("sealed key project = %q, want %q", lookup.ProjectID, result.ProjectID)
	}

	var installationOrg string
	if err := pool.QueryRow(ctx,
		`SELECT org_id FROM github_app_installations WHERE installation_id = $1`,
		input.InstallationID).Scan(&installationOrg); err != nil {
		t.Fatalf("read installation mapping: %v", err)
	}
	var legacyInstallationID int64
	if err := pool.QueryRow(ctx,
		`SELECT github_installation_id FROM orgs WHERE id = $1`, result.OrgID).Scan(&legacyInstallationID); err != nil {
		t.Fatalf("read legacy installation mapping: %v", err)
	}
	if installationOrg != result.OrgID || legacyInstallationID != input.InstallationID {
		t.Errorf("installation mappings = (%s, %d), want (%s, %d)", installationOrg, legacyInstallationID, result.OrgID, input.InstallationID)
	}
}

func TestProvisionAgentSessionStoresResolvedDefaultBranch(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo := "Master-Owner-" + fixture.suffix + "/Master-Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	input.CanonicalDefaultBranch = "master"
	input.Repos = []db.InstallationRepo{{
		FullName:      repo,
		DefaultBranch: "master",
	}}
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	cleanup.org(result.OrgID)

	var branch *string
	if err := pool.QueryRow(ctx,
		`SELECT default_branch FROM projects WHERE id = $1`,
		result.ProjectID).Scan(&branch); err != nil {
		t.Fatal(err)
	}
	if branch == nil || *branch != "master" {
		t.Fatalf("default_branch = %v, want master", branch)
	}
}

func TestProvisionAgentSession_ReturningUserUsesExistingOrg(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()

	org, err := q.CreateOrg(ctx, "returning-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create returning org: %v", err)
	}
	cleanup.org(org.ID)
	user, err := q.CreateUserGitHub(ctx, org.ID, "returning-"+fixture.suffix+"@example.com", "Returning User", fixture.githubUserID, "returning-"+fixture.suffix, "")
	if err != nil {
		t.Fatalf("create returning user: %v", err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", fmt.Sprintf("%d", fixture.githubUserID), user.Email, true); err != nil {
		t.Fatalf("record returning identity: %v", err)
	}

	repo := "Returning-" + fixture.suffix + "/New-Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)
	result, err := q.ProvisionAgentSession(ctx, input)
	if err != nil {
		t.Fatalf("provision returning user: %v", err)
	}
	if result.OrgID != org.ID {
		t.Fatalf("project org = %s, want existing org %s", result.OrgID, org.ID)
	}
	if result.Created || result.UserID != user.ID {
		t.Fatalf("returning agent provision result = %+v, want existing user %s", result, user.ID)
	}

	var projectOrg string
	if err := pool.QueryRow(ctx, `SELECT org_id FROM projects WHERE id = $1`, result.ProjectID).Scan(&projectOrg); err != nil {
		t.Fatalf("read returning project: %v", err)
	}
	if projectOrg != org.ID {
		t.Errorf("stored project org = %s, want %s", projectOrg, org.ID)
	}
	var unexpectedOrgs, users int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM orgs WHERE name = $1`, input.GitHubOrgName).Scan(&unexpectedOrgs); err != nil {
		t.Fatalf("count unexpected orgs: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE github_id = $1`, input.GitHubUserID).Scan(&users); err != nil {
		t.Fatalf("count returning users: %v", err)
	}
	if unexpectedOrgs != 0 || users != 1 {
		t.Errorf("new orgs/users = %d/%d, want 0/1", unexpectedOrgs, users)
	}
}

func TestProvisionAgentSession_IdentityUnverified(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	session := createProvisionSession(t, q, cleanup, "unverified/"+fixture.suffix)
	input := fixture.input(session.ID, "Unverified/"+fixture.suffix)
	input.EmailVerified = false
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(context.Background(), input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentIdentityUnverified, "identity_unverified")
}

func TestProvisionAgentSession_ReturningIdentityStillRequiresVerifiedEmail(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	org, err := q.CreateOrg(ctx, "unverified-returning-"+fixture.suffix)
	if err != nil {
		t.Fatal(err)
	}
	cleanup.org(org.ID)
	inputTemplate := fixture.input("", "")
	user, err := q.CreateUserGitHub(ctx, org.ID, inputTemplate.Email, "Returning", fixture.githubUserID, inputTemplate.GitHubLogin, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", fmt.Sprintf("%d", fixture.githubUserID), user.Email, true); err != nil {
		t.Fatal(err)
	}
	session := createProvisionSession(t, q, cleanup, "unverified-returning/"+fixture.suffix)
	input := fixture.input(session.ID, "Unverified-Returning/"+fixture.suffix)
	input.Email = ""
	input.EmailVerified = false
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(ctx, input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentIdentityUnverified, "identity_unverified")
	var verified bool
	if err := pool.QueryRow(ctx,
		`SELECT email_verified FROM auth_identities WHERE provider = 'github' AND provider_subject = $1`,
		fmt.Sprintf("%d", fixture.githubUserID)).Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if !verified {
		t.Fatal("failed onboarding downgraded the existing verified identity")
	}
}

func TestProvisionAgentSession_ExistingOrgUnknownUserNeedsInvite(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	org, err := q.CreateOrg(ctx, "installed-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create installed org: %v", err)
	}
	cleanup.org(org.ID)
	cleanup.installation(fixture.installationID)
	if _, err := q.UpsertGitHubAppInstallation(ctx, fixture.installationID, "installed-"+fixture.suffix, fixture.githubOrgID, org.ID, []byte(`[]`)); err != nil {
		t.Fatalf("create installation: %v", err)
	}
	session := createProvisionSession(t, q, cleanup, "unknown-user/"+fixture.suffix)
	input := fixture.input(session.ID, "Unknown-User/"+fixture.suffix)

	result, err := q.ProvisionAgentSession(ctx, input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentOrgExistsNeedsInvite, "org_exists_needs_invite")
}

func TestProvisionAgentSession_ExistingOrgUnaffiliatedUserNeedsInvite(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	installedOrg, err := q.CreateOrg(ctx, "installed-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create installed org: %v", err)
	}
	cleanup.org(installedOrg.ID)
	cleanup.installation(fixture.installationID)
	if _, err := q.UpsertGitHubAppInstallation(ctx, fixture.installationID, "installed-"+fixture.suffix, fixture.githubOrgID, installedOrg.ID, []byte(`[]`)); err != nil {
		t.Fatalf("create installation: %v", err)
	}
	userOrg, err := q.CreateOrg(ctx, "user-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create user org: %v", err)
	}
	cleanup.org(userOrg.ID)
	user, err := q.CreateUserGitHub(ctx, userOrg.ID, fixture.input("", "").Email, "Unaffiliated", fixture.githubUserID, "unaffiliated-"+fixture.suffix, "")
	if err != nil {
		t.Fatalf("create unaffiliated user: %v", err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", fmt.Sprintf("%d", fixture.githubUserID), user.Email, true); err != nil {
		t.Fatalf("record unaffiliated identity: %v", err)
	}
	session := createProvisionSession(t, q, cleanup, "unaffiliated/"+fixture.suffix)
	input := fixture.input(session.ID, "Unaffiliated/"+fixture.suffix)

	result, err := q.ProvisionAgentSession(ctx, input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentOrgExistsNeedsInvite, "org_exists_needs_invite")
}

func TestProvisionAgentSession_RepoAlreadyConfiguredCaseInsensitive(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	org, err := q.CreateOrg(ctx, "configured-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create configured org: %v", err)
	}
	cleanup.org(org.ID)
	repo := "Configured-" + fixture.suffix + "/Repo"
	differentCase := strings.ToUpper(repo[:1]) + strings.ToLower(repo[1:])
	if _, err := q.CreateProject(ctx, org.ID, "configured", &differentCase); err != nil {
		t.Fatalf("create configured project: %v", err)
	}
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)

	result, err := q.ProvisionAgentSession(ctx, input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentRepoAlreadyConfigured, "repo_already_configured")
}

func TestProvisionAgentSession_NotPendingLeavesProvisionedSessionUntouched(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo := "Completed-" + fixture.suffix + "/Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)
	result, err := q.ProvisionAgentSession(ctx, input)
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}
	cleanup.org(result.OrgID)
	before, err := q.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("read provisioned session: %v", err)
	}

	secondResult, err := q.ProvisionAgentSession(ctx, input)
	if secondResult != nil {
		t.Fatalf("second provision returned result %+v", secondResult)
	}
	if !errors.Is(err, db.ErrAgentSessionNotPending) {
		t.Fatalf("second provision error = %v, want %v", err, db.ErrAgentSessionNotPending)
	}
	after, err := q.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("read session after replay: %v", err)
	}
	if after.Status != before.Status || after.FailureReason != nil || after.ProjectID == nil || before.ProjectID == nil || *after.ProjectID != *before.ProjectID {
		t.Fatalf("provisioned session changed: before=%+v after=%+v", before, after)
	}
}

func TestProvisionAgentSession_LegacyInstallationMappingNeedsInvite(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	installedOrg, err := q.CreateOrg(ctx, "legacy-installed-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create legacy installed org: %v", err)
	}
	cleanup.org(installedOrg.ID)
	if _, err := pool.Exec(ctx, `UPDATE orgs SET github_installation_id = $2 WHERE id = $1`, installedOrg.ID, fixture.installationID); err != nil {
		t.Fatalf("set legacy installation mapping: %v", err)
	}
	cleanup.installation(fixture.installationID)

	userOrg, err := q.CreateOrg(ctx, "legacy-user-org-"+fixture.suffix)
	if err != nil {
		t.Fatalf("create legacy user org: %v", err)
	}
	cleanup.org(userOrg.ID)
	inputTemplate := fixture.input("", "")
	user, err := q.CreateUserGitHub(ctx, userOrg.ID, inputTemplate.Email, "Legacy Unaffiliated", fixture.githubUserID, inputTemplate.GitHubLogin, "")
	if err != nil {
		t.Fatalf("create legacy unaffiliated user: %v", err)
	}
	if err := q.UpsertIdentityDetails(ctx, user.ID, "github", fmt.Sprintf("%d", fixture.githubUserID), user.Email, true); err != nil {
		t.Fatalf("record legacy unaffiliated identity: %v", err)
	}
	session := createProvisionSession(t, q, cleanup, "legacy/"+fixture.suffix)
	input := fixture.input(session.ID, "Legacy/"+fixture.suffix)

	result, err := q.ProvisionAgentSession(ctx, input)
	if result != nil {
		t.Fatalf("failure returned result %+v", result)
	}
	requireProvisionFailure(t, q, session.ID, err, db.ErrAgentOrgExistsNeedsInvite, "org_exists_needs_invite")

	var legacyOrgs, richMappings, unexpectedOrgs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM orgs WHERE github_installation_id = $1`, fixture.installationID).Scan(&legacyOrgs); err != nil {
		t.Fatalf("count legacy org mappings: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM github_app_installations WHERE installation_id = $1`, fixture.installationID).Scan(&richMappings); err != nil {
		t.Fatalf("count rich installation mappings: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM orgs WHERE name = $1`, input.GitHubOrgName).Scan(&unexpectedOrgs); err != nil {
		t.Fatalf("count unexpected second org: %v", err)
	}
	if legacyOrgs != 1 || richMappings != 0 || unexpectedOrgs != 0 {
		t.Errorf("legacy/rich/new org counts = %d/%d/%d, want 1/0/0", legacyOrgs, richMappings, unexpectedOrgs)
	}
}

type provisionCallResult struct {
	result *db.AgentProvisionResult
	err    error
}

func provisionConcurrently(q *db.Queries, inputs ...db.AgentProvisionInput) []provisionCallResult {
	results := make(chan provisionCallResult, len(inputs))
	start := make(chan struct{})
	var ready sync.WaitGroup
	var done sync.WaitGroup
	ready.Add(len(inputs))
	done.Add(len(inputs))
	for _, input := range inputs {
		input := input
		go func() {
			defer done.Done()
			ready.Done()
			<-start
			result, err := q.ProvisionAgentSession(context.Background(), input)
			results <- provisionCallResult{result: result, err: err}
		}()
	}
	ready.Wait()
	close(start)
	done.Wait()
	close(results)

	collected := make([]provisionCallResult, 0, len(inputs))
	for result := range results {
		collected = append(collected, result)
	}
	return collected
}

func TestProvisionAgentSession_ConcurrentCallbacksOneWinner(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo := "Callback-" + fixture.suffix + "/Repo"
	session := createProvisionSession(t, q, cleanup, strings.ToLower(repo))
	input := fixture.input(session.ID, repo)
	cleanup.installation(input.InstallationID)
	results := provisionConcurrently(q, input, input)

	successes, notPending := 0, 0
	for _, call := range results {
		switch {
		case call.err == nil && call.result != nil:
			successes++
			cleanup.org(call.result.OrgID)
		case errors.Is(call.err, db.ErrAgentSessionNotPending) && call.result == nil:
			notPending++
		default:
			t.Errorf("unexpected concurrent callback result: result=%+v err=%v", call.result, call.err)
		}
	}
	if successes != 1 || notPending != 1 {
		t.Fatalf("success/not-pending counts = %d/%d, want 1/1", successes, notPending)
	}
	var projects int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE lower(github_repo) = lower($1)`, repo).Scan(&projects); err != nil {
		t.Fatalf("count concurrent callback projects: %v", err)
	}
	if projects != 1 {
		t.Errorf("project count = %d, want 1", projects)
	}
}

func TestProvisionAgentSession_ConcurrentSameRepoSessionsOneProject(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	canonicalRepo := "Same-Repo-" + fixture.suffix + "/Project"
	session1 := createProvisionSession(t, q, cleanup, canonicalRepo)
	session2 := createProvisionSession(t, q, cleanup, strings.ToLower(canonicalRepo))
	input1 := fixture.input(session1.ID, canonicalRepo)
	input2 := fixture.input(session2.ID, canonicalRepo)
	cleanup.installation(fixture.installationID)
	results := provisionConcurrently(q, input1, input2)

	successes, configured := 0, 0
	for _, call := range results {
		switch {
		case call.err == nil && call.result != nil:
			successes++
			cleanup.org(call.result.OrgID)
		case errors.Is(call.err, db.ErrAgentRepoAlreadyConfigured) && call.result == nil:
			configured++
		default:
			t.Errorf("unexpected same-repo result: result=%+v err=%v", call.result, call.err)
		}
	}
	if successes != 1 || configured != 1 {
		t.Fatalf("success/already-configured counts = %d/%d, want 1/1", successes, configured)
	}
	var projects int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE lower(github_repo) = lower($1)`, canonicalRepo).Scan(&projects); err != nil {
		t.Fatalf("count same-repo projects: %v", err)
	}
	if projects != 1 {
		t.Errorf("same-repo project count = %d, want 1", projects)
	}
	provisioned, failed := 0, 0
	for _, id := range []string{session1.ID, session2.ID} {
		session, err := q.GetAgentSession(ctx, id)
		if err != nil {
			t.Fatalf("read same-repo session: %v", err)
		}
		switch session.Status {
		case "provisioned":
			provisioned++
		case "failed":
			if session.FailureReason == nil || *session.FailureReason != "repo_already_configured" {
				t.Errorf("failed session reason = %v, want repo_already_configured", session.FailureReason)
			}
			failed++
		default:
			t.Errorf("same-repo session status = %q", session.Status)
		}
	}
	if provisioned != 1 || failed != 1 {
		t.Errorf("provisioned/failed session counts = %d/%d, want 1/1", provisioned, failed)
	}
}

func TestProvisionAgentSession_ConcurrentSameIdentityDifferentRepos(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	cleanup := newProvisionCleanup(t, pool)
	fixture := newProvisionFixture()
	repo1 := "Identity-" + fixture.suffix + "/First"
	repo2 := "Identity-" + fixture.suffix + "/Second"
	session1 := createProvisionSession(t, q, cleanup, strings.ToLower(repo1))
	session2 := createProvisionSession(t, q, cleanup, strings.ToLower(repo2))
	input1 := fixture.input(session1.ID, repo1)
	input2 := fixture.input(session2.ID, repo2)
	cleanup.installation(fixture.installationID)
	results := provisionConcurrently(q, input1, input2)

	orgID := ""
	for _, call := range results {
		if call.err != nil || call.result == nil {
			t.Fatalf("same-identity provisioning failed: result=%+v err=%v", call.result, call.err)
		}
		cleanup.org(call.result.OrgID)
		if orgID == "" {
			orgID = call.result.OrgID
		} else if call.result.OrgID != orgID {
			t.Fatalf("same identity created different orgs: %s and %s", orgID, call.result.OrgID)
		}
	}

	var users, orgs, projects, identities int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE github_id = $1`, fixture.githubUserID).Scan(&users); err != nil {
		t.Fatalf("count same-identity users: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM orgs WHERE name = $1`, input1.GitHubOrgName).Scan(&orgs); err != nil {
		t.Fatalf("count same-identity orgs: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE org_id = $1 AND lower(github_repo) IN (lower($2), lower($3))`,
		orgID, repo1, repo2).Scan(&projects); err != nil {
		t.Fatalf("count same-identity projects: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM auth_identities WHERE provider = 'github' AND provider_subject = $1`,
		fmt.Sprintf("%d", fixture.githubUserID)).Scan(&identities); err != nil {
		t.Fatalf("count same-identity mappings: %v", err)
	}
	if users != 1 || orgs != 1 || projects != 2 || identities != 1 {
		t.Errorf("users/orgs/projects/identities = %d/%d/%d/%d, want 1/1/2/1", users, orgs, projects, identities)
	}
	for _, id := range []string{session1.ID, session2.ID} {
		session, err := q.GetAgentSession(ctx, id)
		if err != nil {
			t.Fatalf("read same-identity session: %v", err)
		}
		if session.Status != "provisioned" {
			t.Errorf("session %s status = %q, want provisioned", id, session.Status)
		}
	}
}
