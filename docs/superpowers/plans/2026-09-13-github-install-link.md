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
- Every verification pipeline runs under `set -o pipefail`, and skip checks use `! grep -q`, so a skipped or failed test cannot read as success.

## File Structure

| File | Responsibility |
|---|---|
| `packages/ingestion/db/installations.go` | Add `InstallationOrgIDs`: every organization linked to an installation. |
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
| `packages/ingestion/handler/github_oauth_test.go` | Removes the test that pinned minting in status; the WorkOS install test gets its state from the new endpoint. |
| `packages/ingestion/handler/github_install_callback_test.go` | Route test covers the new endpoint's auth and admin checks. |
| `packages/dashboard/src/types/api.ts`, `src/api.ts` | `install_available` field and `githubInstallUrl()`. |
| `packages/dashboard/src/views/AgentGitHubInstall.vue` | Serves both `/agent/github/:id` and `/github/install`. |
| `packages/dashboard/src/router.ts`, `src/route-project.ts` | New route, post-sign-in resume, project-gate exemption. |
| `packages/dashboard/src/views/SetupWizard.vue`, `src/views/Settings.vue` | Install links point at `/github/install`. |
| Dashboard tests, `src/api-github.test.ts`, `test-e2e/dashboard-mock-harness.ts` | Updated status shape, API method test, route and gate tests. |
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
- Modify: `packages/ingestion/db/installations.go` (add a method after `installationOrgID`, which ends near line 151)
- Modify: `packages/ingestion/db/queries.go` (next to `OrgExists` at line 756)
- Test: `packages/ingestion/db/installations_test.go`

**Interfaces:**
- Produces: `func (q *Queries) InstallationOrgIDs(ctx context.Context, installationID int64) ([]string, error)` returns every organization linked to the installation: the `org_id` on its `github_app_installations` row and every organization whose legacy `github_installation_id` names it. The result is de-duplicated and sorted; empty means unlinked. Legacy pointers are not unique, which is why this returns a set. The existing transaction helper `installationOrgID` stays unchanged.
- Produces: `func (q *Queries) GetOrgName(ctx context.Context, orgID string) (string, bool, error)` returns the name and whether the organization exists, so an existing organization with an empty name is not mistaken for a missing one.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ingestion/db/installations_test.go` (`package db_test`; it already imports `context`, `testing`, `time`, `uuid`, and `db`). Add `sort` and `strings` to its imports.

```go
func TestInstallationOrgIDs_FindsRecordAndLegacyOwners(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	owner, err := q.CreateOrg(ctx, "inst-owner-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := q.CreateOrg(ctx, "inst-foreign-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, owner.ID)
		cleanupTenant(t, pool, foreign.ID)
	})
	installationID := time.Now().UnixNano()
	check := func(label string, want ...string) {
		t.Helper()
		sort.Strings(want)
		got, err := q.InstallationOrgIDs(ctx, installationID)
		if err != nil || strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s: InstallationOrgIDs = %v, %v; want %v", label, got, err, want)
		}
	}
	check("unlinked")
	if _, err := pool.Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '[]')`, installationID, owner.ID); err != nil {
		t.Fatal(err)
	}
	check("installation record", owner.ID)
	if err := q.SetOrgGitHubInstallation(ctx, owner.ID, installationID); err != nil {
		t.Fatal(err)
	}
	check("record plus the same organization's pointer", owner.ID)
	if err := q.SetOrgGitHubInstallation(ctx, foreign.ID, installationID); err != nil {
		t.Fatal(err)
	}
	check("another organization's legacy pointer", owner.ID, foreign.ID)
}

func TestGetOrgName_DistinguishesMissingFromEmpty(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	name := "org-name-" + uuid.NewString()
	named, err := q.CreateOrg(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	unnamed, err := q.CreateOrg(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenant(t, pool, named.ID)
		cleanupTenant(t, pool, unnamed.ID)
	})
	if got, ok, err := q.GetOrgName(ctx, named.ID); err != nil || !ok || got != name {
		t.Fatalf("GetOrgName(named) = %q, %v, %v; want %q, true", got, ok, err, name)
	}
	if got, ok, err := q.GetOrgName(ctx, unnamed.ID); err != nil || !ok || got != "" {
		t.Fatalf("GetOrgName(empty name) = %q, %v, %v; want \"\", true", got, ok, err)
	}
	if got, ok, err := q.GetOrgName(ctx, uuid.NewString()); err != nil || ok || got != "" {
		t.Fatalf("GetOrgName(missing) = %q, %v, %v; want \"\", false", got, ok, err)
	}
}
```

If `CreateOrg` rejects an empty name, create that row with `pool.QueryRow(ctx, "INSERT INTO orgs (name) VALUES ('') RETURNING id").Scan(&id)` instead.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && go test -count=1 -run 'TestInstallationOrgIDs_|TestGetOrgName_' ./db/`
Expected: build failure, `q.InstallationOrgIDs undefined` and `q.GetOrgName undefined`.

- [ ] **Step 3: Implement**

In `packages/ingestion/db/installations.go`, after `installationOrgID` (add `sort` to the imports):

```go
// InstallationOrgIDs returns every Opslane organization linked to an
// installation: the one on its installation record and any whose legacy
// github_installation_id names it. Legacy pointers are not unique, so a caller
// that must never move an installation checks the whole set.
func (q *Queries) InstallationOrgIDs(ctx context.Context, installationID int64) ([]string, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT org_id::text FROM github_app_installations
		  WHERE installation_id = $1 AND org_id IS NOT NULL
		 UNION
		 SELECT id::text FROM orgs WHERE github_installation_id = $1`, installationID)
	if err != nil {
		return nil, fmt.Errorf("list installation organizations: %w", err)
	}
	defer rows.Close()
	var orgIDs []string
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, fmt.Errorf("scan installation organization: %w", err)
		}
		orgIDs = append(orgIDs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list installation organizations: %w", err)
	}
	sort.Strings(orgIDs)
	return orgIDs, nil
}
```

In `packages/ingestion/db/queries.go`, after `OrgExists`:

```go
// GetOrgName returns the organization's name and whether it exists.
func (q *Queries) GetOrgName(ctx context.Context, orgID string) (string, bool, error) {
	var name string
	err := q.pool.QueryRow(ctx, `SELECT name FROM orgs WHERE id = $1`, orgID).Scan(&name)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("get org name: %w", err)
	}
	return name, true, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && set -o pipefail && go test -count=1 -v -run 'TestInstallationOrgIDs_|TestGetOrgName_|TestPersistInstallation|TestRetireGitHubInstallation' ./db/ 2>&1 | tee /tmp/claude-1000/task1.log && ! grep -q -- '--- SKIP' /tmp/claude-1000/task1.log && echo TASK1-OK`
Expected: every test PASS and the last line is `TASK1-OK`.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion/db/installations.go packages/ingestion/db/queries.go packages/ingestion/db/installations_test.go
git commit -m "feat(db): list every organization linked to an installation and look up an organization's name"
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
- Consumes: `db.Queries.InstallationOrgIDs`, `db.Queries.GetOrgName` (Task 1); existing `gh.GenerateAppJWT`, `gh.GetApp`, `gh.VerifyInstallation`, `gh.GetInstallationToken`, `gh.ListInstallationRepos`, `gh.ErrInstallationGone`, `gh.ErrInstallationSuspended`, `db.Queries.GetOrgGitHubInstallation`, `GetProjectByOrgID`, `ListProjectsByOrg`, `PersistInstallation`, `SetProjectGitHubConfig`, `OrgHasActiveGitHubInstallation`, `RepoCoveredByActiveInstallation`, `db.ErrInstallationOrgConflict`.
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

// linkState is everything a link can change. Dry runs and refusals must leave
// it exactly as it was.
type linkState struct {
	installationRows int
	landedRows       int
	projectJobs      int
	orgPointer       int64
	projectRepo      string
	defaultBranch    string
}

func (f fixture) state(t *testing.T) linkState {
	t.Helper()
	var s linkState
	var repo, branch *string
	if err := f.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM github_app_installations WHERE installation_id = $1),
		(SELECT count(*) FROM installation_landed WHERE installation_id = $1),
		(SELECT count(*) FROM error_group_jobs WHERE project_id = $3::uuid),
		COALESCE((SELECT github_installation_id FROM orgs WHERE id = $2::uuid), 0),
		(SELECT github_repo FROM projects WHERE id = $3::uuid),
		(SELECT default_branch FROM projects WHERE id = $3::uuid)`,
		f.installationID, f.orgID, f.projectID,
	).Scan(&s.installationRows, &s.landedRows, &s.projectJobs, &s.orgPointer, &repo, &branch); err != nil {
		t.Fatal(err)
	}
	if repo != nil {
		s.projectRepo = *repo
	}
	if branch != nil {
		s.defaultBranch = *branch
	}
	return s
}

func TestDryRunVerifiesAndWritesNothing(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo}.serve(t, f.installationID)
	before := f.state(t)
	out, err := f.run(f.config(nil))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	for _, want := range []string{"opslane-test", "agentwebpro", "agentwebpro/agentweb", "Dry run"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output is missing %q:\n%s", want, out)
		}
	}
	if after := f.state(t); after != before {
		t.Fatalf("dry run changed state: before %+v, after %+v", before, after)
	}
}

func TestApplyLinksInstallationAndConnectsProject(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "AgentWebPro", repos: oneRepo}.serve(t, f.installationID)
	before := f.state(t)
	out, err := f.run(f.config(func(c *config) { c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	ctx := context.Background()
	if active, err := f.q.OrgHasActiveGitHubInstallation(ctx, f.orgID); err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
	if covered, err := f.q.RepoCoveredByActiveInstallation(ctx, f.orgID, "agentwebpro/agentweb"); err != nil || !covered {
		t.Fatalf("covered=%v err=%v", covered, err)
	}
	want := linkState{
		installationRows: 1, landedRows: 1, projectJobs: before.projectJobs + 1, orgPointer: f.installationID,
		projectRepo: "agentwebpro/agentweb", defaultBranch: "main",
	}
	if got := f.state(t); got != want {
		t.Fatalf("state after apply = %+v, want %+v", got, want)
	}
	if out, err := f.run(f.config(func(c *config) { c.Apply = true })); err != nil {
		t.Fatalf("re-running -apply failed: %v\n%s", err, out)
	}
	if again := f.state(t); again.installationRows != 1 || again.orgPointer != f.installationID || again.projectRepo != want.projectRepo {
		t.Fatalf("state after re-run = %+v", again)
	}
}

func TestApplyWithoutProjectLinksOnly(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: twoRepos}.serve(t, f.installationID)
	before := f.state(t)
	out, err := f.run(f.config(func(c *config) { c.ProjectID = ""; c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	got := f.state(t)
	if got.installationRows != 1 || got.orgPointer != f.installationID ||
		got.projectRepo != before.projectRepo || got.projectJobs != before.projectJobs {
		t.Fatalf("state after apply without -project = %+v (before %+v)", got, before)
	}
}

func TestApplyWithRepoUsesGitHubSpelling(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: twoRepos}.serve(t, f.installationID)
	out, err := f.run(f.config(func(c *config) { c.Repo = "AGENTWEBPRO/Docs"; c.Apply = true }))
	if err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	if got := f.state(t); got.projectRepo != "agentwebpro/docs" || got.defaultBranch != "trunk" {
		t.Fatalf("state = %+v", got)
	}
}

func TestRefusalsWriteNothing(t *testing.T) {
	otherOrg := func(t *testing.T, f fixture) string {
		t.Helper()
		other, err := f.q.CreateOrg(context.Background(), "link-installation-other-"+uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cleanupOrg(t, f.pool, other.ID) })
		return other.ID
	}
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
		{name: "installation record in another organization", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			seed: func(t *testing.T, f fixture) {
				if _, err := f.pool.Exec(context.Background(),
					`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
					 VALUES ($1, 'agentwebpro', 77, $2, '[]')`, f.installationID, otherOrg(t, f)); err != nil {
					t.Fatal(err)
				}
			}, wantErr: "already linked to organization"},
		{name: "another organization's legacy pointer", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			seed: func(t *testing.T, f fixture) {
				if err := f.q.SetOrgGitHubInstallation(context.Background(), otherOrg(t, f), f.installationID); err != nil {
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
			before := f.state(t)
			out, err := f.run(f.config(func(c *config) {
				c.Apply = true
				if tc.mutate != nil {
					tc.mutate(c)
				}
			}))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err=%v, want it to contain %q\n%s", err, tc.wantErr, out)
			}
			if after := f.state(t); after != before {
				t.Fatalf("refusal changed state: before %+v, after %+v", before, after)
			}
		})
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && go test -count=1 ./cmd/link-installation/`
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

	orgName, orgExists, err := q.GetOrgName(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if !orgExists {
		return fmt.Errorf("organization %s does not exist", cfg.OrgID)
	}
	fmt.Fprintf(out, "Organization:  %q (%s)\n", orgName, cfg.OrgID)

	// Legacy organization pointers are not unique, so check every organization
	// that names this installation, not only the first.
	linkedOrgs, err := q.InstallationOrgIDs(ctx, cfg.InstallationID)
	if err != nil {
		return err
	}
	alreadyLinked := false
	for _, linked := range linkedOrgs {
		if linked != cfg.OrgID {
			return fmt.Errorf("installation %d is already linked to organization %s; refusing to move it", cfg.InstallationID, linked)
		}
		alreadyLinked = true
	}
	current, err := q.GetOrgGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	switch {
	case alreadyLinked:
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

	// Read back this installation specifically, not just "some installation".
	linkedOrgs, err = q.InstallationOrgIDs(ctx, cfg.InstallationID)
	if err != nil {
		return err
	}
	pointer, err := q.GetOrgGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	active, err := q.OrgHasActiveGitHubInstallation(ctx, cfg.OrgID)
	if err != nil {
		return err
	}
	if len(linkedOrgs) != 1 || linkedOrgs[0] != cfg.OrgID || pointer != cfg.InstallationID || !active {
		return fmt.Errorf("read-back failed: installation organizations %v, organization installation %d, active %v", linkedOrgs, pointer, active)
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

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && set -o pipefail && go vet ./cmd/link-installation/ && go test -count=1 -v ./cmd/link-installation/ 2>&1 | tee /tmp/claude-1000/task2.log && ! grep -q -- '--- SKIP' /tmp/claude-1000/task2.log && echo TASK2-OK`
Expected: every test PASS, including all `TestRefusalsWriteNothing` subtests, and the last line is `TASK2-OK`.

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
- Modify: `packages/ingestion/handler/github_oauth_test.go` (delete `TestGetGitHubAppStatusUsesSharedOAuthState` at line 257; update `TestWorkosInstallCallbackPreservesActiveOrgAndBypassesProvider` near line 390)
- Modify: `packages/ingestion/handler/github_install_callback_test.go` (`TestGitHubInstallRoutesRequireCloudAdmin`, near line 220)
- Modify: `docs/reference/http-routes.md:126`

**Interfaces:**
- Produces: `POST /api/v1/github/install-url` returning 200 `{"install_url": string}` with a `Set-Cookie: __auth_state`, or 400 `{"code":"github_app_not_configured"}`, or 401.
- Produces: `GET /api/v1/github/status` returning `{"installed": bool, "installation_id": number|null, "install_available": bool}` with `Cache-Control: no-store`.
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
	// Scoped to this org and user: other packages' tests share the database.
	stateRows := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM oauth_login_states WHERE target_org_id = $1 OR initiating_user_id = $2`,
			org.ID, user.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	start := httptest.NewRecorder()
	deps.GitHubInstallURL(start, asUser(httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)))
	if start.Code != http.StatusOK {
		t.Fatalf("install-url code=%d body=%q", start.Code, start.Body.String())
	}
	if got := start.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("install-url Cache-Control=%q", got)
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
	if cookie == nil || cookie.Value != state || cookie.Path != "/auth" || cookie.MaxAge != 1800 ||
		!cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure {
		t.Fatalf("state cookie=%+v", cookie)
	}
	details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state))
	if err != nil || details == nil || details.TargetOrgID == nil || *details.TargetOrgID != org.ID ||
		details.InitiatingUserID == nil || *details.InitiatingUserID != user.ID {
		t.Fatalf("stored state=%+v err=%v", details, err)
	}
	var expiresAt time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM oauth_login_states WHERE state_hash = $1`,
		auth.HashToken(state)).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	if lifetime := time.Until(expiresAt); lifetime < 29*time.Minute || lifetime > 31*time.Minute {
		t.Fatalf("state lifetime=%v, want 30 minutes", lifetime)
	}

	rowsBeforePolling := stateRows()
	for i := 0; i < 3; i++ {
		poll := httptest.NewRecorder()
		deps.GetGitHubAppStatus(poll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
		if poll.Code != http.StatusOK {
			t.Fatalf("status code=%d body=%q", poll.Code, poll.Body.String())
		}
		if cookies := poll.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("status poll set cookies: %v", cookies)
		}
		if got := poll.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("status Cache-Control=%q", got)
		}
		var status map[string]any
		if err := json.Unmarshal(poll.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		installationID, hasInstallationID := status["installation_id"]
		if status["install_available"] != true || status["installed"] != false || !hasInstallationID || installationID != nil {
			t.Fatalf("status=%v", status)
		}
		if _, ok := status["install_url"]; ok {
			t.Fatalf("status still returns install_url: %v", status)
		}
	}
	if got := stateRows(); got != rowsBeforePolling {
		t.Fatalf("status polls wrote install state: %d rows before, %d after", rowsBeforePolling, got)
	}
	if details, err := q.GetOAuthLoginStateDetails(ctx, auth.HashToken(state)); err != nil || details == nil {
		t.Fatalf("clicked state no longer valid after polling: %+v err=%v", details, err)
	}

	secureReq := asUser(httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil))
	secureReq.Header.Set("X-Forwarded-Proto", "https")
	secureStart := httptest.NewRecorder()
	deps.GitHubInstallURL(secureStart, secureReq)
	secure := false
	for _, c := range secureStart.Result().Cookies() {
		if c.Name == "__auth_state" {
			secure = c.Secure
		}
	}
	if secureStart.Code != http.StatusOK || !secure {
		t.Fatalf("HTTPS install-url code=%d secure cookie=%v", secureStart.Code, secure)
	}

	noApp := &Dependencies{Queries: q, JWTSecret: []byte("secret")}
	noAppPoll := httptest.NewRecorder()
	noApp.GetGitHubAppStatus(noAppPoll, asUser(httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)))
	if !strings.Contains(noAppPoll.Body.String(), `"install_available":false`) {
		t.Fatalf("status without an App slug=%q", noAppPoll.Body.String())
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

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && go test -count=1 -run 'TestGitHubStatusPolling|TestGitHubInstallURL' ./handler/`
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
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
```

Delete `TestGetGitHubAppStatusUsesSharedOAuthState` from `packages/ingestion/handler/github_oauth_test.go`; the new test replaces it. Remove imports the deletion leaves unused in either file (`go build` names them).

- [ ] **Step 5: Update the two existing tests that relied on status minting**

`TestWorkosInstallCallbackPreservesActiveOrgAndBypassesProvider` in `packages/ingestion/handler/github_oauth_test.go` (near line 390) gets its install state from the status endpoint. Replace the block from `statusReq := httptest.NewRequest(http.MethodGet, "/api/v1/github/status", nil)` through the `if state == "" || stateCookie == nil {` check and its closing brace with:

```go
	startReq := httptest.NewRequest(http.MethodPost, "/api/v1/github/install-url", nil)
	startCtx := context.WithValue(startReq.Context(), ctxOrgID, activeOrg.ID)
	startCtx = context.WithValue(startCtx, ctxUserID, user.ID)
	startReq = startReq.WithContext(startCtx)
	startW := httptest.NewRecorder()
	deps.GitHubInstallURL(startW, startReq)
	if startW.Code != http.StatusOK {
		t.Fatalf("install-url code=%d body=%q", startW.Code, startW.Body.String())
	}
	var startBody struct {
		InstallURL string `json:"install_url"`
	}
	if err := json.Unmarshal(startW.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	installURL, err := url.Parse(startBody.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := installURL.Query().Get("state")
	var stateCookie *http.Cookie
	for _, cookie := range startW.Result().Cookies() {
		if cookie.Name == "__auth_state" {
			stateCookie = cookie
		}
	}
	if state == "" || stateCookie == nil {
		t.Fatalf("missing state or cookie: url=%q cookies=%v", startBody.InstallURL, startW.Result().Cookies())
	}
```

`TestGitHubInstallRoutesRequireCloudAdmin` in `packages/ingestion/handler/github_install_callback_test.go` (near line 220) checks only the GET routes. Add `GitHubAppSlug: "opslane"` to its `Dependencies`, then replace everything from `request := func(path string) *httptest.ResponseRecorder {` to the end of the function with:

```go
	request := func(method, path string, signedIn bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if signedIn {
			req.AddCookie(&http.Cookie{Name: AccessCookieName, Value: token})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	adminRoutes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/github/setup"},
		{http.MethodGet, "/api/v1/github/status"},
		{http.MethodPost, "/api/v1/github/install-url"},
	}
	if w := request(http.MethodPost, "/api/v1/github/install-url", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("signed-out install-url code=%d body=%q", w.Code, w.Body.String())
	}
	for _, route := range adminRoutes {
		if w := request(route.method, route.path, true); w.Code != http.StatusForbidden {
			t.Fatalf("member %s %s code=%d body=%q", route.method, route.path, w.Code, w.Body.String())
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND org_id = $2`, user.ID, org.ID); err != nil {
		t.Fatal(err)
	}
	for _, route := range adminRoutes {
		if w := request(route.method, route.path, true); w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
			t.Fatalf("admin %s %s code=%d body=%q", route.method, route.path, w.Code, w.Body.String())
		}
	}
	if w := request(http.MethodPost, "/api/v1/github/install-url", true); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), "/apps/opslane/installations/new?state=") {
		t.Fatalf("admin install-url code=%d body=%q", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 6: Share the helper with the agent endpoint**

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

- [ ] **Step 7: Register the route**

In `packages/ingestion/handler/routes.go`, after the `/github/status` line:

```go
		r.With(deps.AuthenticateUserSession, deps.RequireRoleIfCloud("admin")).Post("/github/install-url", deps.GitHubInstallURL)
```

- [ ] **Step 8: Update the route reference**

In `docs/reference/http-routes.md`, replace the `/api/v1/github/status` row and add the new row after it:

```markdown
| GET | `/api/v1/github/status` | GitHub App status: `installed`, `installation_id`, and `install_available`; never creates install state |
| POST | `/api/v1/github/install-url` | Start a GitHub App installation for the active organization: returns `install_url` and sets its single-use, 30-minute callback state; admin on cloud; 400 `github_app_not_configured` without an App |
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd packages/ingestion && export DATABASE_URL="postgres://opslane:opslane_dev@localhost:5434/link_installation_test?sslmode=disable" && set -o pipefail && go build ./... && go vet ./handler/ && go test -count=1 -v -run 'TestGitHubStatusPolling|TestGitHubInstallURL|TestGitHubInstallRoutesRequireCloudAdmin|TestWorkosInstallCallback|AgentGitHubInstall|TestWebInstallCallback' ./handler/ 2>&1 | tee /tmp/claude-1000/task3.log && ! grep -q -- '--- SKIP' /tmp/claude-1000/task3.log && echo TASK3-OK`
Expected: every selected test PASS and the last line is `TASK3-OK`. If `-run` selects no agent install-url test, run `grep -ln AgentGitHubInstallURL packages/ingestion/handler/*_test.go` and add those test names to the pattern.

- [ ] **Step 10: Commit**

```bash
git add packages/ingestion/handler/github_install_start.go packages/ingestion/handler/github_install_start_test.go \
  packages/ingestion/handler/github_oauth.go packages/ingestion/handler/github_oauth_test.go packages/ingestion/handler/github_install_callback_test.go \
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
- Test: `packages/dashboard/src/views/__tests__/agent-github-install.test.ts`, `src/views/__tests__/setup-wizard.test.ts`, `src/views/Settings.test.ts`, `src/router.test.ts`, `src/route-project.test.ts`
- Create: `packages/dashboard/src/api-github.test.ts`
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

  it('asks for an admin without a shareable link on the organization route', async () => {
    route.params = {};
    api.githubInstallUrl.mockRejectedValue(new api.APIError(403, 'organization admin required'));
    const wrapper = mount(AgentGitHubInstall);
    await flushPromises();
    expect(wrapper.text()).toContain('Ask an admin of this organization');
    expect(wrapper.find('[data-testid="agent-github-install-link"]').exists()).toBe(false);
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
    // A stale install_url from an old server must not bring the link back.
    api.getGitHubAppStatus.mockResolvedValue({
      installed: false, installation_id: null, install_available: false,
      install_url: 'https://github.com/apps/x/installations/new',
    });
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


Create `packages/dashboard/src/api-github.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubInstallUrl } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub install API', () => {
  it('mints the install link with an authenticated POST', async () => {
    const response = { install_url: 'https://github.com/apps/opslane/installations/new?state=s' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubInstallUrl()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/github/install-url', expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{}',
    }));
  });
});
```

In `packages/dashboard/src/route-project.test.ts`, add to the `'allows projectless organizations to approve an agent setup'` test:

```ts
    expect(routeNeedsProject('github-install')).toBe(false);
```

In `packages/dashboard/src/router.test.ts`, add `beforeEach` to the `vitest` import if it is missing, and append:

```ts
describe('GitHub install page', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('parks /github/install for after sign-in', async () => {
    await appRouter.push('/github/install');
    expect(appRouter.currentRoute.value.name).toBe('login');
    expect(sessionStorage.getItem('opslane_post_auth_path')).toBe('/github/install');
  });

  it('keeps a signed-in user who has not finished onboarding on /github/install', async () => {
    localStorage.setItem('opslane_authed', '1');
    await appRouter.push('/github/install');
    expect(appRouter.currentRoute.value.name).toBe('github-install');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @opslane/dashboard test -- src/views/__tests__/agent-github-install.test.ts src/views/__tests__/setup-wizard.test.ts src/views/Settings.test.ts src/api-github.test.ts src/router.test.ts src/route-project.test.ts`
Expected: the new tests FAIL: the API test and component tests on the missing `githubInstallUrl`, the link tests on `href`, and the router tests on the missing route.

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

In `packages/dashboard/src/views/AgentGitHubInstall.vue`, change the import to `import { agentGitHubInstallUrl, APIError, githubInstallUrl } from '../api';`, add `const sessionId = route.params.id ? String(route.params.id) : '';` after `const route = useRoute();`, and replace the whole `onMounted` callback with:

```ts
onMounted(async () => {
  try {
    const { install_url } = sessionId
      ? await agentGitHubInstallUrl(sessionId)
      : await githubInstallUrl();
    const target = safeUrl(install_url, GITHUB_PR_URL_OPTIONS);
    if (!target) {
      phase.value = 'error';
      message.value = 'Opslane returned an unexpected install link.';
      return;
    }
    // replace, not assign: Back from GitHub must not reopen this page and mint again.
    (props.navigate ?? window.location.replace.bind(window.location))(target);
  } catch (err) {
    if (err instanceof APIError && err.status === 403 && err.code !== 'foreign_org') {
      phase.value = 'needs-admin';
      // Only a session link is safe to hand to an admin: it names its organization.
      // The organization route installs for whichever organization the opener has active.
      message.value = sessionId
        ? 'Installing the GitHub App needs an organization admin. Send an admin this link; they will be asked to sign in to Opslane first:'
        : 'Installing the GitHub App needs an organization admin. Ask an admin of this organization to install it from Settings.';
      return;
    }
    phase.value = 'error';
    message.value = (err instanceof APIError && err.code && KNOWN_ERRORS[err.code])
      || (err instanceof Error ? err.message : 'Could not start the GitHub installation.');
  }
});
```

In the template, change the copyable-link `<div>` to `v-if="phase === 'needs-admin' && sessionId"` and the Back link to `v-if="phase === 'error' || (phase === 'needs-admin' && !sessionId)"`.

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

Run: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/test-e2e typecheck`
Expected: the build succeeds, every dashboard test passes, and the e2e package typechecks.

Then run: `grep -rnw install_url packages/dashboard/src test-e2e --include=*.ts --include=*.vue | grep -v node_modules`
Expected: matches only in `api.ts`, `AgentGitHubInstall.vue`, `agent-github-install.test.ts`, `api-github.test.ts`, and the stale-field mock in `setup-wizard.test.ts`. The agent state's `github_install_url` is a different field and does not match `-w`.

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
go test -count=1 -json ./... > /tmp/claude-1000/go-all.json; echo "go test exit=$?"
jq -r 'select(.Action=="fail" and .Test!=null) | "\(.Package) \(.Test)"' /tmp/claude-1000/go-all.json
jq -r 'select(.Action=="skip" and .Test!=null) | .Package' /tmp/claude-1000/go-all.json | sort | uniq -c
```

Expected: `go test exit=0` and no failure lines. Skips may appear only in storage packages that need MinIO; none may appear in `cmd/link-installation`, `db`, or `handler`. Report any failure together with whether it also fails on `origin/main`, checked in a temporary worktree (`git worktree add /tmp/claude-1000/main-check origin/main`), never with `git stash`.

- [ ] **Step 2: Dashboard and e2e types**

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent
set -o pipefail
pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test && pnpm --filter @opslane/test-e2e typecheck && echo DASHBOARD-OK
```

Expected: the last line is `DASHBOARD-OK`.

- [ ] **Step 3: Image contains the command**

```bash
cd /home/claude-dev/orca/workspaces/opslane-oss/onboarding-agent
docker build -f packages/ingestion/Dockerfile -t opslane-ingestion:link-installation .
docker run --rm opslane-ingestion:link-installation link-installation; echo "exit=$?"
docker run --rm opslane-ingestion:link-installation link-installation -installation 1 -org 0ff3bcae-0000-4000-8000-000000000001 -expect-account acme; echo "exit=$?"
```

Expected: the first prints the usage line and `exit=2`. The second prints `DATABASE_URL, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY are required` and `exit=2`. If the build runs out of disk, run `docker builder prune -af` and retry once.

- [ ] **Step 4: Report**

Report each command's result, the skip lists, and any failure with its output. Do not push.

---

### Task 6: Link the stuck installation in production (operator only, after merge and deploy)

Not for the implementing agent. Two constraints shape this task:

- The devbox's AWS identity, `opslane-devbox-debug`, is read-only. It can run only the debug SQL task and cannot run the ingestion task definition or pass its roles. Steps 2 and 4 need a deployment-administrator identity, so the user runs them, for example by typing `! <command>` in a session whose shell has those credentials.
- Step 4 writes to production and needs the user's explicit yes after they have seen the dry-run output.

- [ ] **Step 1: Resolve the organization and project IDs (read-only, devbox)**

```bash
~/deploy/scripts/prod-sql.sh "SELECT o.id AS org_id, o.name, o.github_installation_id, p.id AS project_id, p.name AS project, p.github_repo FROM orgs o LEFT JOIN projects p ON p.org_id = o.id WHERE o.id::text LIKE '0ff3bcae%'"
```

- [ ] **Step 2: Dry run as a one-off task (deployment administrator)**

```bash
export AWS_PROFILE=<deployment-admin profile> AWS_REGION=us-west-2
test "$(aws sts get-caller-identity --query Account --output text)" = 127214199666 || echo "STOP: not the production account"
ORG=<org_id from step 1>; PROJECT=<project_id from step 1>
TD=$(aws ecs describe-services --cluster opslane --services ingestion --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --cluster opslane --services ingestion --query 'services[0].networkConfiguration' --output json)
link_task() {
  local ovr run task desc code stream logs
  ovr=$(jq -cn '{containerOverrides:[{name:"ingestion",command:$ARGS.positional}]}' --args link-installation "$@")
  run=$(aws ecs run-task --cluster opslane --launch-type FARGATE --task-definition "$TD" \
    --network-configuration "$NET" --overrides "$ovr" --output json) || return 1
  if [ "$(jq '.failures | length' <<<"$run")" -ne 0 ]; then jq '.failures' <<<"$run"; return 1; fi
  task=$(jq -er '.tasks[0].taskArn' <<<"$run") || return 1
  aws ecs wait tasks-stopped --cluster opslane --tasks "$task"
  desc=$(aws ecs describe-tasks --cluster opslane --tasks "$task" --output json)
  code=$(jq -r '.tasks[0].containers[] | select(.name=="ingestion") | .exitCode // empty' <<<"$desc")
  stream=$(jq -r '.tasks[0].containers[] | select(.name=="ingestion") | .logStreamName // empty' <<<"$desc")
  [ -n "$stream" ] || stream="ingestion/ingestion/${task##*/}"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    logs=$(aws logs get-log-events --log-group-name /ecs/opslane-ingestion --log-stream-name "$stream" \
      --start-from-head --output json 2>/dev/null) && [ "$(jq '.events | length' <<<"$logs")" -gt 0 ] && break
    sleep 3
  done
  jq -r '.events[]?.message' <<<"${logs:-{\}}"
  echo "exit code: ${code:-none}; stopped: $(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$desc")"
  [ "$code" = 0 ]
}
link_task -installation 161250809 -org "$ORG" -expect-account agentwebpro -project "$PROJECT"
```

Expected: `exit code: 0` and output ending in `Dry run: nothing written`, listing the `agentwebpro` repositories and the project. If the installation covers several repositories, choose the one the project should use and add `-repo owner/name`.

- [ ] **Step 3: Show the dry-run output to the user and get an explicit yes**

- [ ] **Step 4: Apply (deployment administrator)**

Run the same `link_task` line with `-apply` appended. Expected: `exit code: 0` and `Verified: the dashboard now reports GitHub as installed.`

- [ ] **Step 5: Confirm (read-only, devbox)**

```bash
~/deploy/scripts/prod-sql.sh "SELECT i.installation_id, i.org_id, i.github_org_name, i.suspended, jsonb_array_length(i.repos) AS repos, o.github_installation_id FROM github_app_installations i JOIN orgs o ON o.id = i.org_id WHERE i.installation_id = 161250809"
```
