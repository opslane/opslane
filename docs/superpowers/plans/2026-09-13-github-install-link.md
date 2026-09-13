# GitHub Install Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the GitHub status poll from invalidating an in-progress App install, and give operators a verified command that links an installation Opslane never recorded.

**Architecture:** Install state moves from `GET /api/v1/github/status` to a new `POST /api/v1/github/install-url`, called by a dashboard page at `/github/install` only when the user opens the Install link. A new `link-installation` Go command in the ingestion image verifies an installation with the GitHub App JWT and writes it through the existing `PersistInstallation` and `SetProjectGitHubConfig`.

**Tech Stack:** Go 1.24 (chi, pgx), Vue 3 with Vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-09-13-github-install-link-design.md`

## Global Constraints

- `GET /api/v1/github/status` never sets a cookie and never writes `oauth_login_states`.
- Install state lifetime is 30 minutes (`githubInstallStateTTL = 30 * time.Minute`); the cookie is `__auth_state`, Path `/auth`, `MaxAge` 1800, HttpOnly, SameSite Lax, Secure when the request is HTTPS.
- `link-installation` writes nothing unless `-apply` is passed, and runs every GitHub and database check before its first write.
- No new dependencies, no migrations, no changes to the OAuth callback.
- Commits in this repository use the identity `abhishek@opslane.com` (check `git config user.email`; if it differs, commit with `git -c user.email=abhishek@opslane.com commit …`) and end with the line `Claude-Session: https://claude.ai/code/session_01NH1xAULqRNKBh4oNBptCXv`.
- Do not push, open a pull request, or touch production. Task 6 is for the operator only.

## File Structure

| File | Responsibility |
|---|---|
| `packages/ingestion/db/installations.go` | Add `InstallationOrgID`, the pool-level form of the existing mapping lookup. |
| `packages/ingestion/db/queries.go` | Add `GetOrgName`. |
| `packages/ingestion/db/installations_test.go` | Tests for both helpers. |
| `packages/ingestion/cmd/link-installation/main.go` | Flag parsing, environment checks, process exit codes. |
| `packages/ingestion/cmd/link-installation/link.go` | `run`: GitHub verification, database checks, dry run, writes, read-back. |
| `packages/ingestion/cmd/link-installation/main_test.go` | Flag parsing tests. |
| `packages/ingestion/cmd/link-installation/link_test.go` | Database tests against a fake GitHub transport. |
| `packages/ingestion/Dockerfile` | Build and ship the `link-installation` binary. |
| `packages/ingestion/handler/github_install_start.go` | `startGitHubInstall` helper and `GitHubInstallURL` handler. |
| `packages/ingestion/handler/github_install_start_test.go` | Mint-on-click and no-mint-on-poll tests. |
| `packages/ingestion/handler/github_oauth.go` | Status handler stops minting and reports `install_available`. |
| `packages/ingestion/handler/agent_github_install.go` | Uses the shared helper. |
| `packages/ingestion/handler/routes.go` | Registers `POST /api/v1/github/install-url`. |
| `packages/ingestion/handler/github_oauth_test.go` | Removes the test that pinned minting in status. |
| `packages/dashboard/src/types/api.ts`, `src/api.ts` | `install_available` field and `githubInstallUrl()`. |
| `packages/dashboard/src/views/AgentGitHubInstall.vue` | Serves both `/agent/github/:id` and `/github/install`. |
| `packages/dashboard/src/router.ts`, `src/route-project.ts` | New route, post-sign-in resume, project-gate exemption. |
| `packages/dashboard/src/views/SetupWizard.vue`, `src/views/Settings.vue` | Install links point at `/github/install`. |
| Dashboard tests, `test-e2e/dashboard-mock-harness.ts` | Updated status shape and new assertions. |
| `docs/reference/http-routes.md`, `docs/guides/github-app.md` | Route contract and operator instructions. |

## Test database

Go database tests skip, not fail, when Postgres is unreachable, so every Go test step below runs against a disposable database and checks for zero skips. Create it once before Task 1:

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent
PGC=logging-postgres-1   # any running compose Postgres on host port 5434; `docker ps | grep postgres` lists them
docker exec "$PGC" psql -U opslane -d postgres -c 'DROP DATABASE IF EXISTS link_installation_test' -c 'CREATE DATABASE link_installation_test'
for f in packages/ingestion/db/migrations/*.sql; do
  docker exec -i "$PGC" psql -q -U opslane -d link_installation_test -v ON_ERROR_STOP=1 < "$f" > /dev/null || { echo "migration failed: $f"; break; }
done
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable"
```

Shell variables do not persist between tool calls: re-export `DATABASE_URL` in every command that runs Go tests. If port 5434 belongs to a container without the `opslane` role, pick another running compose Postgres and adjust the port in `DATABASE_URL`.

---

### Task 1: Database lookups for the command

**Files:**
- Modify: `packages/ingestion/db/installations.go:129-151`
- Modify: `packages/ingestion/db/queries.go` (next to `OrgExists` at line 756)
- Test: `packages/ingestion/db/installations_test.go`

**Interfaces:**
- Produces: `func (q *Queries) InstallationOrgID(ctx context.Context, installationID int64) (string, error)` returns the mapped organization ID from the rich row, else from the legacy `orgs.github_installation_id` pointer, else `""`.
- Produces: `func (q *Queries) GetOrgName(ctx context.Context, orgID string) (string, error)` returns `""` with a nil error when the organization does not exist.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/db/installations_test.go` (it is `package db_test` and already imports `context`, `testing`, `time`, `uuid`, and `db`):

```go
func TestInstallationOrgID_RichRowLegacyPointerAndUnmapped(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	rich, err := q.CreateOrg(ctx, "inst-owner-rich-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := q.CreateOrg(ctx, "inst-owner-legacy-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, rich.ID)
		cleanupTenant(t, pool, legacy.ID)
	})
	richID := time.Now().UnixNano()
	legacyID := richID + 1
	unmappedID := richID + 2
	if _, err := pool.Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, richID, rich.ID); err != nil {
		t.Fatal(err)
	}
	if err := q.SetOrgGitHubInstallation(ctx, legacy.ID, legacyID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id   int64
		want string
	}{{richID, rich.ID}, {legacyID, legacy.ID}, {unmappedID, ""}} {
		got, err := q.InstallationOrgID(ctx, c.id)
		if err != nil || got != c.want {
			t.Fatalf("InstallationOrgID(%d) = %q, %v; want %q", c.id, got, err, c.want)
		}
	}
}

func TestGetOrgName(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	name := "org-name-" + uuid.NewString()
	org, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	if got, err := q.GetOrgName(ctx, org.ID); err != nil || got != name {
		t.Fatalf("GetOrgName(existing) = %q, %v; want %q", got, err, name)
	}
	if got, err := q.GetOrgName(ctx, uuid.NewString()); err != nil || got != "" {
		t.Fatalf("GetOrgName(missing) = %q, %v; want empty", got, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && export DATABASE_URL=… && go test -count=1 -run 'TestInstallationOrgID_|TestGetOrgName' ./db/`
Expected: build failure, `q.InstallationOrgID undefined` and `q.GetOrgName undefined`.

- [ ] **Step 3: Implement**

In `packages/ingestion/db/installations.go`, change the helper to accept either a transaction or the pool, and add the exported method directly above it. `projectQueryRower` is the existing `QueryRow`-only interface in `queries.go`; both `pgx.Tx` and `*pgxpool.Pool` satisfy it.

```go
// InstallationOrgID returns the Opslane organization an installation is linked
// to: the rich row's org_id, else the oldest organization whose legacy pointer
// names it, else "".
func (q *Queries) InstallationOrgID(ctx context.Context, installationID int64) (string, error) {
	return installationOrgID(ctx, q.pool, installationID)
}

func installationOrgID(ctx context.Context, tx projectQueryRower, installationID int64) (string, error) {
```

The body of `installationOrgID` stays unchanged. `PersistInstallation` still passes its `pgx.Tx`.

In `packages/ingestion/db/queries.go`, after `OrgExists`:

```go
// GetOrgName returns the organization's name, or "" when it does not exist.
func (q *Queries) GetOrgName(ctx context.Context, orgID string) (string, error) {
	var name string
	err := q.pool.QueryRow(ctx, `SELECT name FROM orgs WHERE id = $1`, orgID).Scan(&name)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get org name: %w", err)
	}
	return name, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && export DATABASE_URL=… && go test -count=1 -v -run 'TestInstallationOrgID_|TestGetOrgName|TestPersistInstallation|TestRetireGitHubInstallation' ./db/ 2>&1 | tee /tmp/claude-1000/task1.log; grep -c -- '--- SKIP' /tmp/claude-1000/task1.log`
Expected: every test PASS, and the skip count prints `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/installations.go packages/ingestion/db/queries.go packages/ingestion/db/installations_test.go
git commit -m "feat(db): look up an installation's organization and an organization's name outside a transaction"
```

---

### Task 2: `link-installation` command

**Files:**
- Create: `packages/ingestion/cmd/link-installation/main.go`
- Create: `packages/ingestion/cmd/link-installation/link.go`
- Create: `packages/ingestion/cmd/link-installation/main_test.go`
- Create: `packages/ingestion/cmd/link-installation/link_test.go`
- Modify: `packages/ingestion/Dockerfile:17` and `:26-29`
- Modify: `docs/guides/github-app.md` (end of the "GitHub App mode" section, before "## Point a project at a repo")

**Interfaces:**
- Consumes: `db.Queries.InstallationOrgID`, `db.Queries.GetOrgName` (Task 1); existing `gh.GenerateAppJWT`, `gh.GetApp`, `gh.VerifyInstallation`, `gh.GetInstallationToken`, `gh.ListInstallationRepos`, `gh.ErrInstallationGone`, `gh.ErrInstallationSuspended`, `db.Queries.GetOrgGitHubInstallation`, `GetProjectByOrgID`, `ListProjectsByOrg`, `PersistInstallation`, `SetProjectGitHubConfig`, `OrgHasActiveGitHubInstallation`, `RepoCoveredByActiveInstallation`, `db.ErrInstallationOrgConflict`.
- Produces: binary `/usr/local/bin/link-installation` in the ingestion image; exit 0 on success or dry run, 1 on a refusal or failure, 2 on usage or missing environment.

- [ ] **Step 1: Write the failing flag tests**

`packages/ingestion/cmd/link-installation/main_test.go`:

```go
package main

import "testing"

const (
	testOrg     = "0ff3bcae-0000-4000-8000-000000000001"
	testProject = "5a64d496-0000-4000-8000-000000000002"
)

func TestParseArgsAcceptsFullCommand(t *testing.T) {
	got, err := parseArgs([]string{
		"-installation", "161250809", "-org", testOrg, "-expect-account", "agentwebpro",
		"-project", testProject, "-repo", "agentwebpro/agentweb", "-apply",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := config{
		InstallationID: 161250809, OrgID: testOrg, ExpectAccount: "agentwebpro",
		ProjectID: testProject, Repo: "agentwebpro/agentweb", Apply: true,
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseArgsDefaultsToDryRun(t *testing.T) {
	got, err := parseArgs([]string{"-installation", "1", "-org", testOrg, "-expect-account", "acme"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Apply {
		t.Fatal("expected a dry run without -apply")
	}
}

func TestParseArgsRejectsBadInput(t *testing.T) {
	cases := map[string][]string{
		"missing installation":     {"-org", testOrg, "-expect-account", "acme"},
		"non-numeric installation": {"-installation", "abc", "-org", testOrg, "-expect-account", "acme"},
		"zero installation":        {"-installation", "0", "-org", testOrg, "-expect-account", "acme"},
		"missing org":              {"-installation", "1", "-expect-account", "acme"},
		"org not a UUID":           {"-installation", "1", "-org", "nope", "-expect-account", "acme"},
		"missing expect-account":   {"-installation", "1", "-org", testOrg},
		"blank expect-account":     {"-installation", "1", "-org", testOrg, "-expect-account", "  "},
		"project not a UUID":       {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-project", "nope"},
		"repo without project":     {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-repo", "acme/web"},
		"stray argument":           {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "extra"},
		"unknown flag":             {"-installation", "1", "-org", testOrg, "-expect-account", "acme", "-force"},
	}
	for name, args := range cases {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
```

- [ ] **Step 2: Write the failing database tests**

`packages/ingestion/cmd/link-installation/link_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

const testAppID = "4242"

var (
	oneRepo  = []gh.Repo{{FullName: "agentwebpro/agentweb", DefaultBranch: "main"}}
	twoRepos = []gh.Repo{
		{FullName: "agentwebpro/agentweb", DefaultBranch: "main"},
		{FullName: "agentwebpro/docs", DefaultBranch: "trunk"},
	}
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

// fakeGitHub answers the four GitHub API calls the command makes.
type fakeGitHub struct {
	appID     int64
	login     string
	gone      bool
	suspended bool
	repos     []gh.Repo
}

func (f fakeGitHub) serve(t *testing.T, installationID int64) {
	t.Helper()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		respond := func(status int, body string) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
		}
		switch {
		case req.Method == http.MethodGet && req.URL.Path == "/app":
			return respond(http.StatusOK, fmt.Sprintf(`{"id":%d,"slug":"opslane-test"}`, f.appID))
		case req.Method == http.MethodGet && req.URL.Path == fmt.Sprintf("/app/installations/%d", installationID):
			if f.gone {
				return respond(http.StatusNotFound, `{"message":"Not Found"}`)
			}
			return respond(http.StatusOK, fmt.Sprintf(
				`{"id":%d,"account":{"login":%q,"id":77},"html_url":"https://github.com/settings/installations/%d"}`,
				installationID, f.login, installationID))
		case req.Method == http.MethodPost && req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			if f.suspended {
				return respond(http.StatusForbidden, `{"message":"This installation has been suspended"}`)
			}
			return respond(http.StatusCreated, `{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case req.Method == http.MethodGet && req.URL.Path == "/installation/repositories":
			body, err := json.Marshal(map[string]any{"repositories": f.repos})
			if err != nil {
				return nil, err
			}
			return respond(http.StatusOK, string(body))
		}
		return respond(http.StatusNotFound, `{}`)
	})})
	t.Cleanup(restore)
}

type fixture struct {
	pool           *pgxpool.Pool
	q              *db.Queries
	orgID          string
	projectID      string
	installationID int64
	key            []byte
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	ctx := context.Background()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	q := db.New(pool)
	org, err := q.CreateOrg(ctx, "link-installation-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupOrg(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "web", nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return fixture{
		pool: pool, q: q, orgID: org.ID, projectID: project.ID,
		installationID: time.Now().UnixNano(),
		key:            pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}),
	}
}

// cleanupOrg deletes what these tests create, in foreign-key order.
func cleanupOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	for _, stmt := range []string{
		`DELETE FROM installation_landed WHERE org_id = $1`,
		`DELETE FROM github_app_installations WHERE org_id = $1`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(context.Background(), stmt, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

func (f fixture) config(mutate func(*config)) config {
	c := config{InstallationID: f.installationID, OrgID: f.orgID, ExpectAccount: "agentwebpro", ProjectID: f.projectID}
	if mutate != nil {
		mutate(&c)
	}
	return c
}

func (f fixture) run(c config) (string, error) {
	var out bytes.Buffer
	err := run(context.Background(), f.q, testAppID, f.key, c, &out)
	return out.String(), err
}

// assertNotLinked proves no installation write reached this organization.
func (f fixture) assertNotLinked(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	var rows int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM github_app_installations WHERE installation_id = $1 AND org_id = $2`,
		f.installationID, f.orgID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	pointer, err := f.q.GetOrgGitHubInstallation(ctx, f.orgID)
	if err != nil {
		t.Fatal(err)
	}
	if rows != 0 || pointer != 0 {
		t.Fatalf("expected no link: installation rows=%d org pointer=%d", rows, pointer)
	}
}

func (f fixture) projectRepo(t *testing.T) string {
	t.Helper()
	project, err := f.q.GetProjectByOrgID(context.Background(), f.orgID, f.projectID)
	if err != nil || project == nil {
		t.Fatalf("project=%v err=%v", project, err)
	}
	if project.GithubRepo == nil {
		return ""
	}
	return *project.GithubRepo
}

func TestDryRunVerifiesAndWritesNothing(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo}.serve(t, f.installationID)
	out, err := f.run(f.config(nil))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	for _, want := range []string{"opslane-test", "agentwebpro", "agentwebpro/agentweb", "Dry run"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output is missing %q:\n%s", want, out)
		}
	}
	f.assertNotLinked(t)
	if repo := f.projectRepo(t); repo != "" {
		t.Fatalf("dry run connected the project to %q", repo)
	}
}

func TestApplyLinksInstallationAndConnectsProject(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "AgentWebPro", repos: oneRepo}.serve(t, f.installationID)
	out, err := f.run(f.config(func(c *config) { c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	ctx := context.Background()
	if active, err := f.q.OrgHasActiveGitHubInstallation(ctx, f.orgID); err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
	if pointer, err := f.q.GetOrgGitHubInstallation(ctx, f.orgID); err != nil || pointer != f.installationID {
		t.Fatalf("pointer=%d err=%v", pointer, err)
	}
	if covered, err := f.q.RepoCoveredByActiveInstallation(ctx, f.orgID, "agentwebpro/agentweb"); err != nil || !covered {
		t.Fatalf("covered=%v err=%v", covered, err)
	}
	if repo := f.projectRepo(t); repo != "agentwebpro/agentweb" {
		t.Fatalf("project repo=%q", repo)
	}
	var landed int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM installation_landed WHERE installation_id = $1 AND org_id = $2`,
		f.installationID, f.orgID).Scan(&landed); err != nil || landed != 1 {
		t.Fatalf("installation_landed rows=%d err=%v", landed, err)
	}
	if out, err := f.run(f.config(func(c *config) { c.Apply = true })); err != nil {
		t.Fatalf("re-running -apply failed: %v\n%s", err, out)
	}
}

func TestApplyWithoutProjectLinksOnly(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: twoRepos}.serve(t, f.installationID)
	out, err := f.run(f.config(func(c *config) { c.ProjectID = ""; c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	if active, err := f.q.OrgHasActiveGitHubInstallation(context.Background(), f.orgID); err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
	if repo := f.projectRepo(t); repo != "" {
		t.Fatalf("project was connected to %q without -project", repo)
	}
}

func TestApplyWithRepoUsesGitHubSpelling(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: twoRepos}.serve(t, f.installationID)
	out, err := f.run(f.config(func(c *config) { c.Repo = "AGENTWEBPRO/Docs"; c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	project, err := f.q.GetProjectByOrgID(context.Background(), f.orgID, f.projectID)
	if err != nil || project == nil || project.GithubRepo == nil || *project.GithubRepo != "agentwebpro/docs" ||
		project.DefaultBranch == nil || *project.DefaultBranch != "trunk" {
		t.Fatalf("project=%+v err=%v", project, err)
	}
}

func TestRefusalsWriteNothing(t *testing.T) {
	cases := []struct {
		name    string
		github  fakeGitHub
		mutate  func(*config)
		seed    func(t *testing.T, f fixture)
		wantErr string
	}{
		{name: "credentials for another App", github: fakeGitHub{appID: 999, login: "agentwebpro", repos: oneRepo}, wantErr: "GITHUB_APP_ID"},
		{name: "installation gone", github: fakeGitHub{appID: 4242, gone: true}, wantErr: "does not exist"},
		{name: "wrong account", github: fakeGitHub{appID: 4242, login: "someone-else", repos: oneRepo}, wantErr: "belongs to GitHub account"},
		{name: "suspended", github: fakeGitHub{appID: 4242, login: "agentwebpro", suspended: true}, wantErr: "suspended"},
		{name: "several repositories without -repo", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: twoRepos}, wantErr: "pass -repo"},
		{name: "installation without repositories", github: fakeGitHub{appID: 4242, login: "agentwebpro"}, wantErr: "no repositories"},
		{name: "-repo not covered", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			mutate: func(c *config) { c.Repo = "agentwebpro/missing" }, wantErr: "does not cover"},
		{name: "missing organization", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			mutate: func(c *config) { c.OrgID = uuid.NewString(); c.ProjectID = "" }, wantErr: "does not exist"},
		{name: "project outside the organization", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			mutate: func(c *config) { c.ProjectID = uuid.NewString() }, wantErr: "is not in organization"},
		{name: "installation linked to another organization", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			seed: func(t *testing.T, f fixture) {
				other, err := f.q.CreateOrg(context.Background(), "link-installation-other-"+uuid.NewString())
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { cleanupOrg(t, f.pool, other.ID) })
				if _, err := f.pool.Exec(context.Background(),
					`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
					 VALUES ($1, 'agentwebpro', 77, $2, '[]')`, f.installationID, other.ID); err != nil {
					t.Fatal(err)
				}
			}, wantErr: "already linked to organization"},
		{name: "project connected to a different repository", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			seed: func(t *testing.T, f fixture) {
				if _, err := f.pool.Exec(context.Background(),
					`UPDATE projects SET github_repo = 'agentwebpro/old' WHERE id = $1`, f.projectID); err != nil {
					t.Fatal(err)
				}
			}, wantErr: "already connected"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			tc.github.serve(t, f.installationID)
			if tc.seed != nil {
				tc.seed(t, f)
			}
			repoBefore := f.projectRepo(t)
			out, err := f.run(f.config(func(c *config) {
				c.Apply = true
				if tc.mutate != nil {
					tc.mutate(c)
				}
			}))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err=%v, want it to contain %q\n%s", err, tc.wantErr, out)
			}
			f.assertNotLinked(t)
			if repo := f.projectRepo(t); repo != repoBefore {
				t.Fatalf("project repo changed from %q to %q", repoBefore, repo)
			}
		})
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/ingestion && export DATABASE_URL=… && go test -count=1 ./cmd/link-installation/`
Expected: build failure, `undefined: parseArgs`, `undefined: config`, `undefined: run`.

- [ ] **Step 4: Implement `main.go`**

```go
// Command link-installation links a GitHub App installation that exists on
// GitHub to an Opslane organization, for installs whose OAuth callback never
// reached Opslane. It verifies the installation with the App's own credentials
// and prints what it would change; nothing is written without -apply.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/opslane/opslane/packages/ingestion/db"
)

const usage = "usage: link-installation -installation <id> -org <org-uuid> -expect-account <github-login> [-project <project-uuid> [-repo owner/name]] [-apply]"

type config struct {
	InstallationID int64
	OrgID          string
	ExpectAccount  string
	ProjectID      string
	Repo           string
	Apply          bool
}

func parseArgs(args []string) (config, error) {
	fs := flag.NewFlagSet("link-installation", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	installation := fs.String("installation", "", "GitHub App installation ID")
	org := fs.String("org", "", "Opslane organization UUID")
	expectAccount := fs.String("expect-account", "", "GitHub account login the installation must belong to")
	project := fs.String("project", "", "project UUID to connect to a repository (optional)")
	repo := fs.String("repo", "", "repository owner/name; required with -project when the installation covers several repositories")
	apply := fs.Bool("apply", false, "write the link; without it the command only prints what it would do")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	installationID, err := strconv.ParseInt(*installation, 10, 64)
	if err != nil || installationID <= 0 {
		return config{}, errors.New("-installation must be a positive integer")
	}
	orgID, err := uuid.Parse(*org)
	if err != nil {
		return config{}, errors.New("-org must be an organization UUID")
	}
	if strings.TrimSpace(*expectAccount) == "" {
		return config{}, errors.New("-expect-account is required")
	}
	cfg := config{
		InstallationID: installationID,
		OrgID:          orgID.String(),
		ExpectAccount:  strings.TrimSpace(*expectAccount),
		Repo:           strings.TrimSpace(*repo),
		Apply:          *apply,
	}
	if *project != "" {
		projectID, err := uuid.Parse(*project)
		if err != nil {
			return config{}, errors.New("-project must be a project UUID")
		}
		cfg.ProjectID = projectID.String()
	}
	if cfg.Repo != "" && cfg.ProjectID == "" {
		return config{}, errors.New("-repo needs -project")
	}
	return cfg, nil
}

func main() {
	cfg, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	appID := os.Getenv("GITHUB_APP_ID")
	privateKey := os.Getenv("GITHUB_APP_PRIVATE_KEY")
	if os.Getenv("DATABASE_URL") == "" || appID == "" || privateKey == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY are required")
		os.Exit(2)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	runErr := run(ctx, db.New(pool), appID, []byte(privateKey), cfg, os.Stdout)
	pool.Close()
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "link-installation:", runErr)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: Implement `link.go`**

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// run verifies everything before its first write. A returned error before the
// "Writing" line means nothing was written.
func run(ctx context.Context, q *db.Queries, appID string, privateKey []byte, cfg config, out io.Writer) error {
	appJWT, err := gh.GenerateAppJWT(appID, privateKey)
	if err != nil {
		return fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	app, err := gh.GetApp(appJWT)
	if err != nil {
		return fmt.Errorf("read GitHub App identity: %w", err)
	}
	if strconv.FormatInt(app.ID, 10) != appID {
		return fmt.Errorf("GitHub reports App %d for this private key, but GITHUB_APP_ID is %s", app.ID, appID)
	}
	fmt.Fprintf(out, "GitHub App:    %s (id %d)\n", app.Slug, app.ID)

	info, err := gh.VerifyInstallation(appJWT, cfg.InstallationID)
	if errors.Is(err, gh.ErrInstallationGone) {
		return fmt.Errorf("installation %d does not exist for App %s", cfg.InstallationID, app.Slug)
	}
	if err != nil {
		return fmt.Errorf("read installation %d: %w", cfg.InstallationID, err)
	}
	if !strings.EqualFold(info.Account.Login, cfg.ExpectAccount) {
		return fmt.Errorf("installation %d belongs to GitHub account %q, not %q", cfg.InstallationID, info.Account.Login, cfg.ExpectAccount)
	}
	token, err := gh.GetInstallationToken(appJWT, cfg.InstallationID)
	if errors.Is(err, gh.ErrInstallationSuspended) {
		return fmt.Errorf("installation %d is suspended on GitHub; unsuspend it first", cfg.InstallationID)
	}
	if err != nil {
		return fmt.Errorf("mint installation token: %w", err)
	}
	repos, err := gh.ListInstallationRepos(token.Token)
	if err != nil {
		return fmt.Errorf("list installation repositories: %w", err)
	}
	fmt.Fprintf(out, "Installation:  %d on GitHub account %s (%s)\n", cfg.InstallationID, info.Account.Login, info.HTMLURL)
	fmt.Fprintf(out, "Repositories:  %d\n", len(repos))
	for _, repo := range repos {
		fmt.Fprintf(out, "  - %s (default branch %s)\n", repo.FullName, repo.DefaultBranch)
	}

	orgName, err := q.GetOrgName(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if orgName == "" {
		return fmt.Errorf("organization %s does not exist", cfg.OrgID)
	}
	fmt.Fprintf(out, "Organization:  %s (%s)\n", orgName, cfg.OrgID)

	linkedOrg, err := q.InstallationOrgID(ctx, cfg.InstallationID)
	if err != nil {
		return err
	}
	if linkedOrg != "" && linkedOrg != cfg.OrgID {
		return fmt.Errorf("installation %d is already linked to organization %s; refusing to move it", cfg.InstallationID, linkedOrg)
	}
	current, err := q.GetOrgGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	switch {
	case linkedOrg == cfg.OrgID:
		fmt.Fprintln(out, "Status:        already linked to this organization; -apply refreshes its repositories")
	case current != 0 && current != cfg.InstallationID:
		fmt.Fprintf(out, "Status:        the organization's primary installation changes from %d to %d\n", current, cfg.InstallationID)
	default:
		fmt.Fprintln(out, "Status:        not linked")
	}

	var target *gh.Repo
	if cfg.ProjectID != "" {
		project, err := q.GetProjectByOrgID(ctx, cfg.OrgID, cfg.ProjectID)
		if err != nil {
			return err
		}
		if project == nil {
			return fmt.Errorf("project %s is not in organization %s", cfg.ProjectID, cfg.OrgID)
		}
		if target, err = chooseRepo(repos, cfg.Repo); err != nil {
			return err
		}
		if project.GithubRepo != nil && *project.GithubRepo != "" && !strings.EqualFold(*project.GithubRepo, target.FullName) {
			return fmt.Errorf("project %q is already connected to %s; disconnect it in Settings first", project.Name, *project.GithubRepo)
		}
		fmt.Fprintf(out, "Project:       %s (%s) connects to %s\n", project.Name, project.ID, target.FullName)
	} else {
		projects, err := q.ListProjectsByOrg(ctx, cfg.OrgID)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, "Projects (pass -project to connect one):")
		for _, p := range projects {
			repo := "no repository"
			if p.GithubRepo != nil && *p.GithubRepo != "" {
				repo = *p.GithubRepo
			}
			fmt.Fprintf(out, "  - %s %s (%s)\n", p.ID, p.Name, repo)
		}
	}

	if !cfg.Apply {
		fmt.Fprintln(out, "\nDry run: nothing written. Re-run with -apply to link.")
		return nil
	}

	fmt.Fprintln(out, "\nWriting.")
	installRepos := make([]db.InstallationRepo, 0, len(repos))
	for _, repo := range repos {
		installRepos = append(installRepos, db.InstallationRepo{FullName: repo.FullName, DefaultBranch: repo.DefaultBranch})
	}
	tx, err := q.Pool().Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: cfg.InstallationID,
		GitHubOrgName:  info.Account.Login,
		GitHubOrgID:    info.Account.ID,
		OrgID:          cfg.OrgID,
		Repos:          installRepos,
		HTMLURL:        info.HTMLURL,
	}); err != nil {
		if errors.Is(err, db.ErrInstallationOrgConflict) {
			return fmt.Errorf("installation %d was linked to another organization while this ran; nothing written", cfg.InstallationID)
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit installation: %w", err)
	}
	fmt.Fprintf(out, "Linked installation %d to %s.\n", cfg.InstallationID, orgName)

	if target != nil {
		if err := q.SetProjectGitHubConfig(ctx, cfg.OrgID, cfg.ProjectID, target.FullName, target.DefaultBranch); err != nil {
			return fmt.Errorf("installation is linked, but connecting the project failed (re-run with -apply): %w", err)
		}
		fmt.Fprintf(out, "Connected project %s to %s.\n", cfg.ProjectID, target.FullName)
	}

	active, err := q.OrgHasActiveGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if !active {
		return errors.New("read-back failed: the organization still has no active installation")
	}
	if target != nil {
		covered, err := q.RepoCoveredByActiveInstallation(ctx, cfg.OrgID, target.FullName)
		if err != nil {
			return err
		}
		if !covered {
			return fmt.Errorf("read-back failed: %s is not covered by an active installation", target.FullName)
		}
	}
	fmt.Fprintln(out, "Verified: the dashboard now reports GitHub as installed.")
	return nil
}

// chooseRepo returns the repository to connect, using GitHub's spelling.
func chooseRepo(repos []gh.Repo, want string) (*gh.Repo, error) {
	if want != "" {
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, want) {
				return &repos[i], nil
			}
		}
		return nil, fmt.Errorf("installation does not cover %s; it covers: %s", want, repoNames(repos))
	}
	switch len(repos) {
	case 0:
		return nil, errors.New("installation covers no repositories; add one on GitHub first")
	case 1:
		return &repos[0], nil
	default:
		return nil, fmt.Errorf("installation covers %d repositories; pass -repo with one of: %s", len(repos), repoNames(repos))
	}
}

func repoNames(repos []gh.Repo) string {
	if len(repos) == 0 {
		return "(none)"
	}
	names := make([]string, 0, len(repos))
	for _, repo := range repos {
		names = append(names, repo.FullName)
	}
	return strings.Join(names, ", ")
}
```

If `go vet` flags an unused import in either file, remove it; the code above is the full behavior.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/ingestion && export DATABASE_URL=… && go vet ./cmd/link-installation/ && go test -count=1 -v ./cmd/link-installation/ 2>&1 | tee /tmp/claude-1000/task2.log; grep -c -- '--- SKIP' /tmp/claude-1000/task2.log`
Expected: every test PASS, including all `TestRefusalsWriteNothing` subtests, and the skip count prints `0`.

- [ ] **Step 7: Ship the binary in the image**

In `packages/ingestion/Dockerfile`, after line 17:

```dockerfile
RUN CGO_ENABLED=0 go build -o /link-installation ./cmd/link-installation
```

After the `COPY --from=builder /mint-key /usr/local/bin/mint-key` line:

```dockerfile
# Linking a GitHub App installation whose install callback never reached
# Opslane. Dry run by default; see docs/guides/github-app.md.
COPY --from=builder /link-installation /usr/local/bin/link-installation
```

- [ ] **Step 8: Document the command**

In `docs/guides/github-app.md`, insert before `## Point a project at a repo`:

````markdown
### Link an installation Opslane did not record

If GitHub shows the App installed but Opslane says GitHub is not connected, the install never reached Opslane. An operator can link it from the server container without the user:

```bash
docker exec <ingestion-container> link-installation \
  -installation <installation-id> \
  -org <organization-uuid> \
  -expect-account <github-account-login> \
  -project <project-uuid>
```

The installation ID is the number at the end of the installation's settings URL on GitHub. The command checks with GitHub that the installation belongs to this App and to that account, then prints what it would change and writes nothing. Add `-apply` to link it. Pass `-repo owner/name` when the installation covers more than one repository.

It refuses to move an installation that is linked to a different organization, and it refuses to replace a project's existing repository.
````

- [ ] **Step 9: Commit**

```bash
git add packages/ingestion/cmd/link-installation packages/ingestion/Dockerfile docs/guides/github-app.md
git commit -m "feat(ingestion): add link-installation to link a GitHub App installation Opslane never recorded"
```

---

### Task 3: Mint install state only on request

**Files:**
- Create: `packages/ingestion/handler/github_install_start.go`
- Create: `packages/ingestion/handler/github_install_start_test.go`
- Modify: `packages/ingestion/handler/github_oauth.go:741-801` (`GetGitHubAppStatus`)
- Modify: `packages/ingestion/handler/agent_github_install.go:49-65`
- Modify: `packages/ingestion/handler/routes.go:196`
- Modify: `packages/ingestion/handler/github_oauth_test.go:257` (delete `TestGetGitHubAppStatusUsesSharedOAuthState`)
- Modify: `docs/reference/http-routes.md:126`

**Interfaces:**
- Produces: `POST /api/v1/github/install-url` returning 200 `{"install_url": string}` with a `Set-Cookie: __auth_state`, or 400 `{"code":"github_app_not_configured"}`, or 401.
- Produces: `GET /api/v1/github/status` returning `{"installed": bool, "installation_id": number|null, "install_available": bool}`.
- Produces: `func (d *Dependencies) startGitHubInstall(w http.ResponseWriter, r *http.Request, orgID string) (string, error)`.

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/handler/github_install_start_test.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestGitHubStatusPollingDoesNotReplaceInstallState(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "install-start-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	user, err := q.CreateUserGitHub(ctx, org.ID, "install-start-"+uuid.NewString()+"@example.com",
		"Install Start", time.Now().UnixNano(), "install-start", "")
	if err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q, GitHubAppSlug: "opslane", JWTSecret: []byte("secret")}
	asUser := func(req *http.Request) *http.Request {
		reqCtx := context.WithValue(req.Context(), ctxOrgID, org.ID)
		reqCtx = context.WithValue(reqCtx, ctxUserID, user.ID)
		return req.WithContext(reqCtx)
	}

	start := httptest.NewRecorder()
	deps.GitHubInstallURL(start, asUser(httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)))
	if start.Code != http.StatusOK {
		t.Fatalf("install-url code=%d body=%q", start.Code, start.Body.String())
	}
	if got := start.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
	var body struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(body.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := parsed.Query().Get("state")
	if parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.Path != "/apps/opslane/installations/new" || state == "" {
		t.Fatalf("install_url=%q", body.InstallURL)
	}
	var cookie *http.Cookie
	for _, c := range start.Result().Cookies() {
		if c.Name == "__auth_state" {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value != state || cookie.Path != "/auth" || cookie.MaxAge != 1800 || !cookie.HttpOnly {
		t.Fatalf("state cookie=%+v", cookie)
	}
	details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state))
	if err != nil || details == nil || details.TargetOrgID == nil || *details.TargetOrgID != org.ID ||
		details.InitiatingUserID == nil || *details.InitiatingUserID != user.ID {
		t.Fatalf("stored state=%+v err=%v", details, err)
	}

	for i := 0; i < 3; i++ {
		poll := httptest.NewRecorder()
		deps.GetGitHubAppStatus(poll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
		if poll.Code != http.StatusOK {
			t.Fatalf("status code=%d body=%q", poll.Code, poll.Body.String())
		}
		if cookies := poll.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("status poll set cookies: %v", cookies)
		}
		var status map[string]any
		if err := json.Unmarshal(poll.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status["install_available"] != true || status["installed"] != false {
			t.Fatalf("status=%v", status)
		}
		if _, ok := status["install_url"]; ok {
			t.Fatalf("status still returns install_url: %v", status)
		}
	}
	var states int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM oauth_login_states WHERE target_org_id = $1`, org.ID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if states != 1 {
		t.Fatalf("oauth_login_states rows=%d, want only the one install-url minted", states)
	}
	if details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state)); err != nil || details == nil {
		t.Fatalf("clicked state no longer valid after polling: %+v err=%v", details, err)
	}

	noApp := &Dependencies{Queries: q, JWTSecret: []byte("secret")}
	poll := httptest.NewRecorder()
	noApp.GetGitHubAppStatus(poll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
	if !strings.Contains(poll.Body.String(), `"install_available":false`) {
		t.Fatalf("status without an App slug=%q", poll.Body.String())
	}
}

func TestGitHubInstallURLWithoutAppIsTypedAndSetsNoCookie(t *testing.T) {
	deps := &Dependencies{JWTSecret: []byte("secret")}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	reqCtx := context.WithValue(req.Context(), ctxOrgID, uuid.NewString())
	reqCtx = context.WithValue(reqCtx, ctxUserID, uuid.NewString())
	w := httptest.NewRecorder()
	deps.GitHubInstallURL(w, req.WithContext(reqCtx))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"github_app_not_configured"`) {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("cookies=%v", cookies)
	}
}

func TestGitHubInstallURLRequiresUser(t *testing.T) {
	deps := &Dependencies{GitHubAppSlug: "opslane", JWTSecret: []byte("secret")}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	w := httptest.NewRecorder()
	deps.GitHubInstallURL(w, req.WithContext(context.WithValue(req.Context(), ctxOrgID, uuid.NewString())))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && export DATABASE_URL=… && go test -count=1 -run 'TestGitHubStatusPolling|TestGitHubInstallURL' ./handler/`
Expected: build failure, `deps.GitHubInstallURL undefined`.

- [ ] **Step 3: Implement the helper and handler**

`packages/ingestion/handler/github_install_start.go`:

```go
package handler

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

// githubInstallStateTTL covers a person choosing repositories on GitHub. The
// state stays single-use and bound to the user and organization.
const githubInstallStateTTL = 30 * time.Minute

// startGitHubInstall mints install state for orgID and the calling user, sets
// the matching __auth_state cookie, and returns GitHub's install URL. Call it
// only for an explicit user action: each call replaces the browser's state
// cookie, so a background caller breaks any GitHub tab that is already open.
func (d *Dependencies) startGitHubInstall(w http.ResponseWriter, r *http.Request, orgID string) (string, error) {
	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		return "", fmt.Errorf("generate install state: %w", err)
	}
	if err := d.Queries.StoreOAuthLoginStateForOrg(r.Context(), auth.HashToken(state), orgID,
		UserIDFromCtx(r.Context()), time.Now().Add(githubInstallStateTTL)); err != nil {
		return "", fmt.Errorf("store install state: %w", err)
	}
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name: "__auth_state", Value: state, Path: "/auth", MaxAge: int(githubInstallStateTTL / time.Second),
		HttpOnly: true, Secure: isSecure, SameSite: http.SameSiteLaxMode,
	})
	return fmt.Sprintf("https://github.com/apps/%s/installations/new?state=%s", d.GitHubAppSlug, url.QueryEscape(state)), nil
}

// GitHubInstallURL starts a GitHub App installation for the caller's active
// organization. The dashboard calls it when the user opens the install link.
func (d *Dependencies) GitHubInstallURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" || UserIDFromCtx(r.Context()) == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if d.GitHubAppSlug == "" {
		writeJSONErrorCode(w, http.StatusBadRequest, "this Opslane has no GitHub App; connect a repository from Settings with a token", "github_app_not_configured")
		return
	}
	installURL, err := d.startGitHubInstall(w, r, orgID)
	if err != nil {
		slog.Error("start GitHub install failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"install_url": installURL})
}
```

- [ ] **Step 4: Stop minting in status**

Replace the body of `GetGitHubAppStatus` in `packages/ingestion/handler/github_oauth.go` with:

```go
func (d *Dependencies) GetGitHubAppStatus(w http.ResponseWriter, r *http.Request) {
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	active, err := d.Queries.OrgHasActiveGitHubInstallation(r.Context(), orgID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// The dashboard polls this endpoint while an install is in progress in
	// another tab, so it must never mint install state: that would replace the
	// __auth_state cookie the GitHub tab depends on. The install link comes
	// from POST /api/v1/github/install-url when the user opens it.
	type statusResponse struct {
		Installed        bool   `json:"installed"`
		InstallationID   *int64 `json:"installation_id"`
		InstallAvailable bool   `json:"install_available"`
	}
	resp := statusResponse{Installed: active, InstallAvailable: d.GitHubAppSlug != ""}
	if active && installationID > 0 {
		resp.InstallationID = &installationID
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
```

Delete `TestGetGitHubAppStatusUsesSharedOAuthState` from `packages/ingestion/handler/github_oauth_test.go`; the new test replaces it. Remove imports the deletion leaves unused in either file (`go build` names them).

- [ ] **Step 5: Share the helper with the agent endpoint**

In `packages/ingestion/handler/agent_github_install.go`, replace everything from `state, err := generateOAuthState(d.JWTSecret)` to the end of the function with:

```go
	installURL, err := d.startGitHubInstall(w, r, *session.OrgID)
	if err != nil {
		slog.Error("start agent GitHub install failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"install_url": installURL})
}
```

Fix the imports: add `log/slog`; remove `fmt`, `net/url`, and `auth` if nothing else uses them. Keep `time` (used by the expiry check).

- [ ] **Step 6: Register the route**

In `packages/ingestion/handler/routes.go`, after the `/github/status` line:

```go
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/github/install-url", deps.GitHubInstallURL)
```

- [ ] **Step 7: Update the route reference**

In `docs/reference/http-routes.md`, replace the `/api/v1/github/status` row and add the new row after it:

```markdown
| GET | `/api/v1/github/status` | GitHub App status: `installed`, `installation_id`, and `install_available`; never creates install state |
| POST | `/api/v1/github/install-url` | Start a GitHub App installation for the active organization: returns `install_url` and sets its single-use, 30-minute callback state; admin on cloud; 400 `github_app_not_configured` without an App |
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/ingestion && export DATABASE_URL=… && go build ./... && go vet ./handler/ && go test -count=1 -v -run 'TestGitHubStatusPolling|TestGitHubInstallURL|TestAgentGitHubInstall|TestWebInstallCallback|GitHubAppStatus|InstallCallback' ./handler/ 2>&1 | tee /tmp/claude-1000/task3.log; grep -c -- '--- SKIP' /tmp/claude-1000/task3.log; grep -- '--- FAIL' /tmp/claude-1000/task3.log`
Expected: every selected test PASS, the skip count prints `0`, and no FAIL lines. If `-run` selects no agent install test, run `grep -ln AgentGitHubInstallURL packages/ingestion/handler/*_test.go` and include those test names.

- [ ] **Step 9: Commit**

```bash
git add packages/ingestion/handler/github_install_start.go packages/ingestion/handler/github_install_start_test.go \
  packages/ingestion/handler/github_oauth.go packages/ingestion/handler/github_oauth_test.go \
  packages/ingestion/handler/agent_github_install.go packages/ingestion/handler/routes.go docs/reference/http-routes.md
git commit -m "fix(github): mint install state when the user opens Install, not on every status poll"
```

---

### Task 4: Dashboard opens a click-time install page

**Files:**
- Modify: `packages/dashboard/src/types/api.ts:407-411`
- Modify: `packages/dashboard/src/api.ts:633-635`
- Modify: `packages/dashboard/src/views/AgentGitHubInstall.vue:4,22-31`
- Modify: `packages/dashboard/src/router.ts:23,49`
- Modify: `packages/dashboard/src/route-project.ts:1`
- Modify: `packages/dashboard/src/views/SetupWizard.vue:246-248`
- Modify: `packages/dashboard/src/views/Settings.vue:841-844`
- Test: `packages/dashboard/src/views/__tests__/agent-github-install.test.ts`, `src/views/__tests__/setup-wizard.test.ts`, `src/views/Settings.test.ts`
- Modify: `test-e2e/dashboard-mock-harness.ts:142`

**Interfaces:**
- Consumes: `POST /api/v1/github/install-url` and the new status shape (Task 3).
- Produces: `export function githubInstallUrl(): Promise<{ install_url: string }>`; dashboard route `/github/install` named `github-install`.

- [ ] **Step 1: Write the failing tests**

In `packages/dashboard/src/views/__tests__/agent-github-install.test.ts`:
1. Add `githubInstallUrl: vi.fn()` to the hoisted `api` object's return value.
2. Replace the `vue-router` mock with a mutable route:

```ts
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('vue-router', () => ({ useRoute: () => route }));
```

3. Change `beforeEach` to `beforeEach(() => { vi.resetAllMocks(); route.params = { id: 'session-1' }; });`
4. Add:

```ts
  it('starts an organization install when opened without a session', async () => {
    route.params = {};
    api.githubInstallUrl.mockResolvedValue({ install_url: 'https://github.com/apps/opslane/installations/new?state=org' });
    const navigate = vi.fn();
    mount(AgentGitHubInstall, { props: { navigate } });
    await flushPromises();
    expect(api.githubInstallUrl).toHaveBeenCalledTimes(1);
    expect(api.agentGitHubInstallUrl).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('https://github.com/apps/opslane/installations/new?state=org');
  });

  it('never navigates to a non-GitHub install URL', async () => {
    route.params = {};
    api.githubInstallUrl.mockResolvedValue({ install_url: 'https://evil.example/apps/opslane' });
    const navigate = vi.fn();
    const wrapper = mount(AgentGitHubInstall, { props: { navigate } });
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('unexpected install link');
  });
```

In `packages/dashboard/src/views/__tests__/setup-wizard.test.ts`:
1. In `beforeEach`, change the status mock to `{ installed: false, installation_id: null, install_available: true }`.
2. Replace every other `install_url: ''` and `install_url: null` in status mocks with `install_available: true`.
3. In "shows the GitHub waiting state only after the install link is clicked, then polls", before the `trigger('click')` line, add:

```ts
    const installLink = wrapper.get('[data-testid="github-install"]');
    expect(installLink.attributes('href')).toBe('/github/install');
    expect(installLink.attributes('target')).toBe('_blank');
```

4. Add:

```ts
  it('hides the install link when this Opslane has no GitHub App', async () => {
    api.getOnboardingState.mockResolvedValue({
      ...baseState, next_step: 'connect_github', project_id: 'p1', has_events: true,
    });
    api.getGitHubAppStatus.mockResolvedValue({ installed: false, installation_id: null, install_available: false });
    const wrapper = mount(SetupWizard, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(wrapper.find('[data-testid="github-install"]').exists()).toBe(false);
    wrapper.unmount();
  });
```

In `packages/dashboard/src/views/Settings.test.ts`:
1. Change the module-level mock `getGitHubAppStatus: vi.fn().mockResolvedValue({ installed: false })` to `vi.fn().mockResolvedValue({ installed: false, installation_id: null, install_available: false })`.
2. Change line 130's mock to `{ installed: true, installation_id: 7, install_available: true }`.
3. Inside `describe('GitHub settings', …)`, add:

```ts
	it('points Install at the click-time install page', async () => {
		vi.mocked(getGitHubAppStatus).mockResolvedValue({ installed: false, installation_id: null, install_available: true });
		const wrapper = await mountSettings('admin');
		await flushPromises();
		expect(wrapper.get('[data-testid="settings-github-install"]').attributes('href')).toBe('/github/install');
		wrapper.unmount();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @opslane/dashboard test -- src/views/__tests__/agent-github-install.test.ts src/views/__tests__/setup-wizard.test.ts src/views/Settings.test.ts`
Expected: the new tests FAIL. The organization-install test fails because `githubInstallUrl` is never called; the link tests fail on `href`.

- [ ] **Step 3: Implement the API contract**

`packages/dashboard/src/types/api.ts`:

```ts
export interface GitHubAppStatus {
  installed: boolean;
  installation_id: number | null;
  /** True when this Opslane has a GitHub App; the link itself is minted on click. */
  install_available: boolean;
}
```

`packages/dashboard/src/api.ts`, after `getGitHubAppStatus`:

```ts
// Mints single-use install state and its cookie. Call only when the user opens
// the install link: each call replaces the state an open GitHub tab relies on.
export function githubInstallUrl(): Promise<{ install_url: string }> {
  return postJSON<{ install_url: string }>('/github/install-url', {});
}
```

- [ ] **Step 4: Serve both install routes from one page**

In `packages/dashboard/src/views/AgentGitHubInstall.vue`, change the import to `import { agentGitHubInstallUrl, APIError, githubInstallUrl } from '../api';` and replace the first four lines inside the `try` block with:

```ts
    const sessionId = route.params.id;
    const { install_url } = sessionId
      ? await agentGitHubInstallUrl(String(sessionId))
      : await githubInstallUrl();
    const target = safeUrl(install_url, GITHUB_PR_URL_OPTIONS);
    if (!target) {
      phase.value = 'error';
      message.value = 'Opslane returned an unexpected install link.';
      return;
    }
    // replace, not assign: Back from GitHub must not reopen this page and mint again.
    (props.navigate ?? window.location.replace.bind(window.location))(target);
```

`packages/dashboard/src/router.ts`: add the route after the agent one, and add its name to the post-sign-in resume condition.

```ts
  { path: '/github/install', name: 'github-install', component: AgentGitHubInstall },
```

```ts
    if (to.name === 'invite-accept' || to.name === 'agent-approve' || to.name === 'agent-github-install' || to.name === 'github-install') {
```

`packages/dashboard/src/route-project.ts`: add `'github-install'` to `PROJECT_EXEMPT_ROUTES`. The wizard opens this page before onboarding completes, so the project gate must not bounce it to `/setup`.

- [ ] **Step 5: Point both Install links at the page**

`packages/dashboard/src/views/SetupWizard.vue`, replace the `installHref` computed:

```ts
// A same-origin page mints the install state when opened, so the status poll
// below can never replace the cookie the GitHub tab depends on.
const installHref = computed(() => (githubAppStatus.value?.install_available ? '/github/install' : ''));
```

Keep the anchor's `target="_blank"` and `@click="startGitHubStatusPolling"`. If `GITHUB_PR_URL_OPTIONS` or `safeUrl` becomes unused in the file, remove it from the import; both are still used by the add-repo links today.

`packages/dashboard/src/views/Settings.vue`, change the Install anchor's opening attributes to:

```html
          <a
            v-if="githubAppStatus?.install_available"
            href="/github/install"
            data-testid="settings-github-install"
```

Leave its classes and content unchanged.

`test-e2e/dashboard-mock-harness.ts:142`: return `{ installed: true, installation_id: 1, install_available: true }`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test`
Expected: the build succeeds and every dashboard test passes.

Then run: `grep -rn "install_url" packages/dashboard/src test-e2e --include=*.ts --include=*.vue | grep -v node_modules`
Expected: matches only in `api.ts`, `AgentGitHubInstall.vue`, and `agent-github-install.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src test-e2e/dashboard-mock-harness.ts
git commit -m "fix(dashboard): open the GitHub install through a page that mints state on click"
```

---

### Task 5: Full verification

- [ ] **Step 1: Go**

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent/packages/ingestion
export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable"
go build ./... && go vet ./...
go test -count=1 ./... 2>&1 | tee /tmp/claude-1000/go-all.log | grep -v '^ok' | head -40
```

Expected: no `FAIL` lines. Storage suites may skip without MinIO; report any failure together with whether it also fails on `origin/main` (`git stash` is shared, so check with a temporary worktree: `git worktree add /tmp/claude-1000/main-check origin/main`).

- [ ] **Step 2: Dashboard and workspace types**

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent
pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test
```

Expected: build succeeds, all tests pass.

- [ ] **Step 3: Image contains the command**

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent
docker build -f packages/ingestion/Dockerfile -t opslane-ingestion:link-installation .
docker run --rm opslane-ingestion:link-installation link-installation; echo "exit=$?"
docker run --rm opslane-ingestion:link-installation link-installation -installation 1 -org 0ff3bcae-0000-4000-8000-000000000001 -expect-account acme; echo "exit=$?"
```

Expected: the first prints the usage line and `exit=2`. The second prints `DATABASE_URL, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY are required` and `exit=2`. If the build runs out of disk, run `docker builder prune -af` and retry once.

- [ ] **Step 4: Report**

Report each command's result, the skip counts from Tasks 1 to 3, and any failure with its output. Do not push.

---

### Task 6: Link the stuck installation in production (operator only, after merge and deploy)

Not for the implementing agent. Each step that writes needs the user's explicit yes.

- [ ] **Step 1: Resolve the organization and project IDs (read-only)**

```bash
~/deploy/scripts/prod-sql.sh "SELECT o.id AS org_id, o.name, o.github_installation_id, p.id AS project_id, p.name AS project, p.github_repo FROM orgs o LEFT JOIN projects p ON p.org_id = o.id WHERE o.id::text LIKE '0ff3bcae%'"
```

- [ ] **Step 2: Dry run as a one-off task**

```bash
export AWS_PROFILE=opslane AWS_REGION=us-west-2
ORG=<org_id from step 1>; PROJECT=<project_id from step 1>
TD=$(aws ecs describe-services --cluster opslane --services ingestion --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --cluster opslane --services ingestion --query 'services[0].networkConfiguration' --output json)
link_task() {
  OVR=$(jq -cn '{containerOverrides:[{name:"ingestion",command:$ARGS.positional}]}' --args link-installation "$@")
  TASK=$(aws ecs run-task --cluster opslane --launch-type FARGATE --task-definition "$TD" \
    --network-configuration "$NET" --overrides "$OVR" --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster opslane --tasks "$TASK"
  aws ecs describe-tasks --cluster opslane --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'
  aws logs get-log-events --log-group-name /ecs/opslane-ingestion \
    --log-stream-name "ingestion/ingestion/${TASK##*/}" --query 'events[].message' --output text
}
link_task -installation 161250809 -org "$ORG" -expect-account agentwebpro -project "$PROJECT"
```

Expected: exit code 0, output ending in `Dry run: nothing written`, listing the `agentwebpro` repositories and the project. If the installation covers several repositories, pick the one the project should use and add `-repo owner/name`.

- [ ] **Step 3: Show the dry-run output to the user and get an explicit yes**

- [ ] **Step 4: Apply**

Run the same `link_task` line with `-apply` appended. Expected: exit code 0 and `Verified: the dashboard now reports GitHub as installed.`

- [ ] **Step 5: Confirm (read-only)**

```bash
~/deploy/scripts/prod-sql.sh "SELECT installation_id, org_id, github_org_name, suspended, jsonb_array_length(repos) AS repos FROM github_app_installations WHERE installation_id = 161250809"
```
