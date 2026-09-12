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

func classifyGitHubError(err error) *githubFailure {
	if errors.Is(err, gh.ErrInstallationGone) || errors.Is(err, gh.ErrInstallationSuspended) {
		return &githubFailure{
			Status:  http.StatusConflict,
			Code:    "github_installation_gone",
			Message: "the Opslane GitHub App installation was removed or suspended on GitHub; install it again from Settings",
		}
	}
	return &githubFailure{
		Status:  http.StatusServiceUnavailable,
		Code:    "github_unreachable",
		Message: "could not reach GitHub, please retry",
	}
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
		w.Header().Set("Retry-After", "10")
	}
	w.WriteHeader(failure.Status)
	_ = json.NewEncoder(w).Encode(body)
}
