package handler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

func setGitHubConfigFixture(
	t *testing.T,
) (*Dependencies, *db.Queries, string, string, int64) {
	t.Helper()
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "github-settings-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	project, err := q.CreateProject(ctx, org.ID, "settings", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM projects WHERE id = $1`, project.ID)
	})
	installationID := time.Now().UnixNano()
	if err := q.SetOrgGitHubInstallation(ctx, org.ID, installationID); err != nil {
		t.Fatal(err)
	}
	return &Dependencies{
		Queries:             q,
		GitHubAppSlug:       "opslane-test",
		GitHubAppID:         "1",
		GitHubAppPrivateKey: callbackTestKey(t),
	}, q, org.ID, project.ID, installationID
}

func TestSetGitHubConfigPATModeValidatesBeforePersisting(t *testing.T) {
	t.Run("reachable", func(t *testing.T) {
		deps, q, orgID, projectID, _ := setGitHubConfigFixture(t)
		deps.GitHubAppSlug = ""
		t.Setenv("GITHUB_TOKEN", "test-token")
		restore := gh.OverrideHTTPClientForTests(&http.Client{
			Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
				if req.URL.Path != "/repos/owner/repo" || req.Header.Get("Authorization") != "Bearer test-token" {
					t.Fatalf("unexpected request: %s %s", req.URL.Path, req.Header.Get("Authorization"))
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
					Body: io.NopCloser(strings.NewReader(`{"full_name":"Owner/Repo","default_branch":"trunk"}`))}, nil
			}),
		})
		defer restore()

		response := httptest.NewRecorder()
		deps.SetGitHubConfig(response, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
		if response.Code != http.StatusOK {
			t.Fatalf("code=%d body=%s", response.Code, response.Body.String())
		}
		project, err := q.GetProjectByOrgID(context.Background(), orgID, projectID)
		if err != nil {
			t.Fatal(err)
		}
		if project.GithubRepo == nil || *project.GithubRepo != "Owner/Repo" ||
			project.DefaultBranch == nil || *project.DefaultBranch != "trunk" {
			t.Fatalf("persisted project=%+v", project)
		}
	})

	t.Run("inaccessible", func(t *testing.T) {
		deps, q, orgID, projectID, _ := setGitHubConfigFixture(t)
		deps.GitHubAppSlug = ""
		t.Setenv("GITHUB_TOKEN", "test-token")
		restore := gh.OverrideHTTPClientForTests(&http.Client{
			Transport: handlerRoundTripperFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header),
					Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			}),
		})
		defer restore()

		response := httptest.NewRecorder()
		deps.SetGitHubConfig(response, newSetGitHubConfigRequest(orgID, projectID, "owner/missing"))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "not reachable") {
			t.Fatalf("code=%d body=%s", response.Code, response.Body.String())
		}
		project, err := q.GetProjectByOrgID(context.Background(), orgID, projectID)
		if err != nil {
			t.Fatal(err)
		}
		if project.GithubRepo != nil {
			t.Fatalf("inaccessible repo persisted: %v", *project.GithubRepo)
		}
	})

	t.Run("missing token", func(t *testing.T) {
		deps, _, orgID, projectID, _ := setGitHubConfigFixture(t)
		deps.GitHubAppSlug = ""
		t.Setenv("GITHUB_TOKEN", "")
		response := httptest.NewRecorder()
		deps.SetGitHubConfig(response, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "GITHUB_TOKEN") {
			t.Fatalf("code=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func newSetGitHubConfigRequest(
	orgID, projectID, repo string,
) *http.Request {
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/v1/projects/"+projectID+"/github",
		strings.NewReader(fmt.Sprintf(`{"github_repo":%q}`, repo)),
	)
	route := chi.NewRouteContext()
	route.URLParams.Add("projectID", projectID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, ctxOrgID, orgID)
	return req.WithContext(ctx)
}

func githubSettingsClient(
	installationID int64,
	reposJSON string,
) *http.Client {
	return &http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case req.Method == http.MethodPost &&
			req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			return &http.Response{
				StatusCode: http.StatusCreated,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`,
				)),
			}, nil
		case req.Method == http.MethodGet &&
			req.URL.Path == "/installation/repositories":
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(reposJSON)),
			}, nil
		default:
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{}`)),
			}, nil
		}
	})}
}

func TestSetGitHubConfigStoresResolvedDefaultBranch(t *testing.T) {
	for _, branch := range []string{"master", "main"} {
		t.Run(branch, func(t *testing.T) {
			deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
			restore := gh.OverrideHTTPClientForTests(githubSettingsClient(
				installationID,
				fmt.Sprintf(`{"repositories":[{"full_name":"Owner/Repo","default_branch":%q}]}`, branch),
			))
			defer restore()

			recorder := httptest.NewRecorder()
			deps.SetGitHubConfig(
				recorder,
				newSetGitHubConfigRequest(orgID, projectID, "owner/repo"),
			)
			if recorder.Code != http.StatusOK {
				t.Fatalf("code = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
			}
			project, err := q.GetProjectByOrgID(context.Background(), orgID, projectID)
			if err != nil {
				t.Fatal(err)
			}
			if project.DefaultBranch == nil || *project.DefaultBranch != branch {
				t.Fatalf("default_branch = %v, want %q", project.DefaultBranch, branch)
			}
			if project.GithubRepo == nil || *project.GithubRepo != "Owner/Repo" {
				t.Fatalf("github_repo = %v, want canonical Owner/Repo", project.GithubRepo)
			}
		})
	}
}

func TestSetGitHubConfigRejectsRepoOutsideInstallation(t *testing.T) {
	deps, _, orgID, projectID, installationID := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(githubSettingsClient(
		installationID,
		`{"repositories":[{"full_name":"owner/other","default_branch":"main"}]}`,
	))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(
		recorder,
		newSetGitHubConfigRequest(orgID, projectID, "owner/missing"),
	)
	if recorder.Code != http.StatusBadRequest ||
		!strings.Contains(recorder.Body.String(), "owner/missing") {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "add_repo_url") {
		t.Fatalf("add_repo_url must be omitted when the installation lookup fails: %s", recorder.Body.String())
	}
}

func TestSetGitHubConfigReturnsServiceUnavailableWhenGitHubIsUnreachable(t *testing.T) {
	deps, _, orgID, projectID, _ := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(&http.Client{
		Transport: handlerRoundTripperFunc(func(*http.Request) (*http.Response, error) {
			return nil, fmt.Errorf("network unavailable")
		}),
	})
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(
		recorder,
		newSetGitHubConfigRequest(orgID, projectID, "owner/repo"),
	)
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "10" {
		t.Fatalf("code=%d, want 503 with Retry-After; body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"github_unreachable"`) {
		t.Fatalf("body=%s", recorder.Body.String())
	}
}

func githubGoneOrMissingClient(installationID int64, tokenStatus int, reposJSON, htmlURL string) *http.Client {
	return &http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		respond := func(status int, body string) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
		}
		switch {
		case req.Method == http.MethodGet && req.URL.Path == "/app":
			// The fixture's GitHubAppID is "1": credentials confirmed.
			return respond(http.StatusOK, `{"id":1,"slug":"opslane-test"}`)
		case req.Method == http.MethodPost && req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			if tokenStatus == http.StatusForbidden {
				return respond(tokenStatus, `{"message":"This installation has been suspended"}`)
			}
			if tokenStatus != http.StatusCreated {
				return respond(tokenStatus, `{"message":"Not Found"}`)
			}
			return respond(http.StatusCreated, `{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case req.Method == http.MethodGet && req.URL.Path == fmt.Sprintf("/app/installations/%d", installationID):
			return respond(http.StatusOK, fmt.Sprintf(`{"id":%d,"account":{"login":"acme","id":1},"html_url":%q}`, installationID, htmlURL))
		case req.Method == http.MethodGet && req.URL.Path == "/installation/repositories":
			return respond(http.StatusOK, reposJSON)
		default:
			return respond(http.StatusNotFound, `{}`)
		}
	})}
}

func TestSetGitHubConfigRetiresGoneInstallation(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["owner/repo"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"github_installation_gone"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("org pointer must be cleared after a gone installation: %d", pointer)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("installation must read inactive")
	}
	recorder = httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"github_not_installed"`) ||
		!strings.Contains(recorder.Body.String(), `"github_connect_url"`) {
		t.Fatalf("second attempt: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSetGitHubConfigLegacyPointerWithoutRowIsAlsoRetired(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()
	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(context.Background(), orgID); pointer != 0 {
		t.Fatalf("legacy pointer must be cleared: %d", pointer)
	}
}

func TestSetGitHubConfigRepoOutsideInstallationCarriesAddRepoURL(t *testing.T) {
	deps, _, orgID, projectID, installationID := setGitHubConfigFixture(t)
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusCreated,
		`{"repositories":[{"full_name":"owner/other","default_branch":"main"}]}`,
		"https://github.com/settings/installations/"+fmt.Sprint(installationID)))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/missing"))
	body := recorder.Body.String()
	if recorder.Code != http.StatusBadRequest || !strings.Contains(body, `"code":"repo_not_in_installation"`) ||
		!strings.Contains(body, `"add_repo_url":"https://github.com/settings/installations/`) || !strings.Contains(body, "owner/missing") {
		t.Fatalf("code=%d body=%s", recorder.Code, body)
	}
}

func TestGetGitHubConfigReportsLostRepoAccess(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["owner/other"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := q.SetProjectGitHubConfig(ctx, orgID, projectID, "owner/repo", "main"); err != nil {
		t.Fatal(err)
	}
	addURL := "https://github.com/settings/installations/" + fmt.Sprint(installationID)
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusCreated, `{"repositories":[]}`, addURL))
	defer restore()

	recorder := httptest.NewRecorder()
	deps.GetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"repo_access":false`) ||
		!strings.Contains(recorder.Body.String(), `"add_repo_url":"`+addURL+`"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := q.AddGitHubInstallationRepos(ctx, installationID, []string{"owner/repo"}); err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	deps.GetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, ""))
	if !strings.Contains(recorder.Body.String(), `"repo_access":true`) || strings.Contains(recorder.Body.String(), "add_repo_url") {
		t.Fatalf("covered body=%s", recorder.Body.String())
	}
}

// wrongAppClient answers the token call with 404 but GET /app with a different
// App id: the credentials, not the installation, are wrong.
func wrongAppClient(installationID int64) *http.Client {
	return &http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		respond := func(status int, body string) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
		}
		switch {
		case req.Method == http.MethodGet && req.URL.Path == "/app":
			return respond(http.StatusOK, `{"id":999,"slug":"someone-elses-app"}`)
		case req.Method == http.MethodPost && req.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			return respond(http.StatusNotFound, `{"message":"Not Found"}`)
		default:
			return respond(http.StatusNotFound, `{}`)
		}
	})}
}

func TestSetGitHubConfigDoesNotRetireWhenAppCredentialsAreWrong(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["owner/repo"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(wrongAppClient(installationID))
	defer restore()
	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"github_unreachable"`) {
		t.Fatalf("wrong credentials must not read as a gone installation: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != installationID {
		t.Fatalf("org pointer must survive a credential problem: %d", pointer)
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); !active {
		t.Fatal("installation must stay active when credentials are unconfirmed")
	}
}

func TestSetGitHubConfigSuspendedInstallationIsItsOwnCode(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'acme', 1, $2, '["owner/repo"]')`, installationID, orgID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusForbidden, `{"repositories":[]}`, ""))
	defer restore()
	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"github_installation_suspended"`) {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if active, _ := q.OrgHasActiveGitHubInstallation(ctx, orgID); active {
		t.Fatal("suspended installation must read inactive")
	}
}

func TestSetGitHubConfigCannotRetireAnotherOrgsInstallation(t *testing.T) {
	deps, q, orgID, projectID, installationID := setGitHubConfigFixture(t)
	ctx := context.Background()
	other, err := q.CreateOrg(ctx, "other-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = q.Pool().Exec(context.Background(), `DELETE FROM github_app_installations WHERE org_id = $1`, other.ID)
		_, _ = q.Pool().Exec(context.Background(), `DELETE FROM orgs WHERE id = $1`, other.ID)
	})
	// The fixture org's pointer names an installation whose rich row belongs to another org.
	if _, err := q.Pool().Exec(ctx,
		`INSERT INTO github_app_installations (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, 'other', 2, $2, '["owner/repo"]')`, installationID, other.ID); err != nil {
		t.Fatal(err)
	}
	restore := gh.OverrideHTTPClientForTests(githubGoneOrMissingClient(installationID, http.StatusNotFound, `{"repositories":[]}`, ""))
	defer restore()
	recorder := httptest.NewRecorder()
	deps.SetGitHubConfig(recorder, newSetGitHubConfigRequest(orgID, projectID, "owner/repo"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var suspended bool
	if err := q.Pool().QueryRow(ctx, `SELECT suspended FROM github_app_installations WHERE installation_id = $1`, installationID).Scan(&suspended); err != nil || suspended {
		t.Fatalf("another org's rich row must not be suspended by this org's on-use retire: suspended=%v err=%v", suspended, err)
	}
	if pointer, _ := q.GetOrgGitHubInstallation(ctx, orgID); pointer != 0 {
		t.Fatalf("this org's own pointer must still be cleared: %d", pointer)
	}
}
