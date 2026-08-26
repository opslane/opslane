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
}

func TestSetGitHubConfigReturnsBadGatewayWhenGitHubIsUnreachable(t *testing.T) {
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
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("code=%d, want 502; body=%s", recorder.Code, recorder.Body.String())
	}
}
