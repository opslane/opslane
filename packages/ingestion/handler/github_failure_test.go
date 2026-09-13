package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

func TestClassifyGitHubError(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("wrap: %w", gh.ErrInstallationGone), http.StatusConflict, "github_installation_gone"},
		{fmt.Errorf("wrap: %w", gh.ErrInstallationSuspended), http.StatusConflict, "github_installation_suspended"},
		{errors.New("dial tcp: i/o timeout"), http.StatusServiceUnavailable, "github_unreachable"},
		{errors.New("GitHub API error (status 502): upstream"), http.StatusServiceUnavailable, "github_unreachable"},
	}
	for _, tc := range cases {
		f := classifyGitHubError(tc.err)
		if f.Status != tc.status || f.Code != tc.code {
			t.Fatalf("%v -> %d %s, want %d %s", tc.err, f.Status, f.Code, tc.status, tc.code)
		}
	}
}

func TestWriteGitHubFailure_ShapeAndRetryAfter(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeGitHubFailure(recorder, &githubFailure{
		Status: http.StatusBadRequest, Code: "repo_not_in_installation",
		Message: "the Opslane GitHub App cannot see acme/web",
		Extra:   map[string]string{"add_repo_url": "https://github.com/settings/installations/7", "empty": ""},
	})
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusBadRequest || body["error"] != "the Opslane GitHub App cannot see acme/web" ||
		body["code"] != "repo_not_in_installation" || body["add_repo_url"] != "https://github.com/settings/installations/7" {
		t.Fatalf("code=%d body=%v", recorder.Code, body)
	}
	if _, present := body["empty"]; present {
		t.Fatal("empty extras must be omitted")
	}
	if recorder.Header().Get("Content-Type") != "application/json" || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers: %v", recorder.Header())
	}

	recorder = httptest.NewRecorder()
	writeGitHubFailure(recorder, classifyGitHubError(errors.New("boom")))
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "10" {
		t.Fatalf("unreachable must be 503 with Retry-After: %d %v", recorder.Code, recorder.Header())
	}
}
