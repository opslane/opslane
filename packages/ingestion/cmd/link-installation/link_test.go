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

// linkState is everything a link can change, including other tenants' rows
// that name the installation. Dry runs and refusals must leave it identical.
type linkState struct {
	installationRows int
	installationRow  string
	legacyPointers   int
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
		COALESCE((SELECT md5(i::text) FROM github_app_installations i WHERE i.installation_id = $1), ''),
		(SELECT count(*) FROM orgs WHERE github_installation_id = $1),
		(SELECT count(*) FROM installation_landed WHERE installation_id = $1),
		(SELECT count(*) FROM error_group_jobs WHERE project_id = $3::uuid),
		COALESCE((SELECT github_installation_id FROM orgs WHERE id = $2::uuid), 0),
		(SELECT github_repo FROM projects WHERE id = $3::uuid),
		(SELECT default_branch FROM projects WHERE id = $3::uuid)`,
		f.installationID, f.orgID, f.projectID,
	).Scan(&s.installationRows, &s.installationRow, &s.legacyPointers, &s.landedRows, &s.projectJobs,
		&s.orgPointer, &repo, &branch); err != nil {
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
	got := f.state(t)
	want := linkState{
		installationRows: 1, installationRow: got.installationRow, legacyPointers: 1, landedRows: 1,
		projectJobs: before.projectJobs + 1, orgPointer: f.installationID,
		projectRepo: "agentwebpro/agentweb", defaultBranch: "main",
	}
	if got != want || got.installationRow == "" {
		t.Fatalf("state after apply = %+v, want %+v", got, want)
	}
	// Re-running appends a second installation_landed audit row by design (spec D5).
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
	foreignProjectID := "" // set by the seed of the case that needs it; subtests run in order
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
		{name: "project in another organization", github: fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo},
			seed: func(t *testing.T, f fixture) {
				project, err := f.q.CreateProject(context.Background(), otherOrg(t, f), "foreign", nil)
				if err != nil {
					t.Fatal(err)
				}
				foreignProjectID = project.ID
			},
			mutate: func(c *config) { c.ProjectID = foreignProjectID }, wantErr: "is not in organization"},
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

func TestApplyMovesPrimaryInstallationWithWarning(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	previous := f.installationID - 1
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'agentwebpro', 77, $2, '[]')`, previous, f.orgID); err != nil {
		t.Fatal(err)
	}
	if err := f.q.SetOrgGitHubInstallation(ctx, f.orgID, previous); err != nil {
		t.Fatal(err)
	}
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo}.serve(t, f.installationID)
	before := f.state(t)
	out, err := f.run(f.config(nil))
	if err != nil || !strings.Contains(out, fmt.Sprintf("changes from %d to %d", previous, f.installationID)) {
		t.Fatalf("dry run err=%v\n%s", err, out)
	}
	if after := f.state(t); after != before {
		t.Fatalf("dry run changed state: before %+v, after %+v", before, after)
	}
	if out, err := f.run(f.config(func(c *config) { c.Apply = true })); err != nil {
		t.Fatalf("apply: %v\n%s", err, out)
	}
	if got := f.state(t); got.orgPointer != f.installationID || got.installationRows != 1 {
		t.Fatalf("state after apply = %+v", got)
	}
}

func TestReRunConnectsProjectAfterLinkOnly(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo}.serve(t, f.installationID)
	if out, err := f.run(f.config(func(c *config) { c.ProjectID = ""; c.Apply = true })); err != nil {
		t.Fatalf("link only: %v\n%s", err, out)
	}
	out, err := f.run(f.config(func(c *config) { c.Apply = true }))
	if err != nil || !strings.Contains(out, "already linked") {
		t.Fatalf("re-run: %v\n%s", err, out)
	}
	if got := f.state(t); got.installationRows != 1 || got.projectRepo != "agentwebpro/agentweb" {
		t.Fatalf("state = %+v", got)
	}
}

func TestApplyKeepsStoredRepoSpelling(t *testing.T) {
	f := newFixture(t)
	fakeGitHub{appID: 4242, login: "agentwebpro", repos: oneRepo}.serve(t, f.installationID)
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE projects SET github_repo = 'AgentWebPro/AgentWeb' WHERE id = $1`, f.projectID); err != nil {
		t.Fatal(err)
	}
	before := f.state(t)
	if out, err := f.run(f.config(func(c *config) { c.Apply = true })); err != nil {
		t.Fatalf("run: %v\n%s", err, out)
	}
	if got := f.state(t); got.projectRepo != "AgentWebPro/AgentWeb" || got.projectJobs != before.projectJobs {
		t.Fatalf("state = %+v (before %+v)", got, before)
	}
}
