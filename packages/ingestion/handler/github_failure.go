package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// githubFailure is the response shape for every GitHub-backed route. Status is
// never 502 because edge proxies may replace an origin 502 with HTML.
type githubFailure struct {
	Status  int
	Code    string
	Message string
	Extra   map[string]string
}

func (f *githubFailure) Error() string { return f.Message }

// Machine codes clients branch on; the runbook and the dashboard read these.
const (
	codeGitHubInstallationGone      = "github_installation_gone"
	codeGitHubInstallationSuspended = "github_installation_suspended"
	codeGitHubUnreachable           = "github_unreachable"
	codeGitHubNotInstalled          = "github_not_installed"
	codeRepoNotInInstallation       = "repo_not_in_installation"
	codeIdentityProviderUnreachable = "identity_provider_unreachable"
	// githubRetryAfterSeconds is what the runbook's 503 loop sleeps on.
	githubRetryAfterSeconds = "10"
)

func githubUnreachable(message string) *githubFailure {
	return &githubFailure{Status: http.StatusServiceUnavailable, Code: codeGitHubUnreachable, Message: message}
}

func classifyGitHubError(err error) *githubFailure {
	switch {
	case errors.Is(err, gh.ErrInstallationGone):
		return &githubFailure{
			Status:  http.StatusConflict,
			Code:    codeGitHubInstallationGone,
			Message: "the Opslane GitHub App installation was removed on GitHub; install it again",
		}
	case errors.Is(err, gh.ErrInstallationSuspended):
		return &githubFailure{
			Status:  http.StatusConflict,
			Code:    codeGitHubInstallationSuspended,
			Message: "the Opslane GitHub App installation is suspended on GitHub; unsuspend it in GitHub's installation settings",
		}
	}
	return githubUnreachable("could not reach GitHub, please retry")
}

func writeGitHubFailure(w http.ResponseWriter, failure *githubFailure) {
	body := map[string]string{"error": failure.Message, "code": failure.Code}
	for key, value := range failure.Extra {
		if value != "" {
			body[key] = value
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if failure.Status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", githubRetryAfterSeconds)
	}
	w.WriteHeader(failure.Status)
	_ = json.NewEncoder(w).Encode(body)
}
