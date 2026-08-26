package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type setGitHubConfigRequest struct {
	GithubRepo string `json:"github_repo"`
}

type gitHubConfigResponse struct {
	GithubRepo string `json:"github_repo"`
	Connected  bool   `json:"connected"`
}

// SetGitHubConfig handles PUT /api/v1/projects/{projectID}/github
// Stores only the repo name — auth comes from the org's GitHub App installation.
func (d *Dependencies) SetGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	var req setGitHubConfigRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	// Validate repo format
	parts := strings.Split(req.GithubRepo, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeJSONError(w, http.StatusBadRequest, "github_repo must be in owner/repo format")
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	var fullName, defaultBranch string
	if d.GitHubAppSlug == "" {
		token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
		if token == "" {
			writeJSONError(w, http.StatusBadRequest, "configure GITHUB_TOKEN or install the GitHub App")
			return
		}
		repo, repoErr := gh.GetRepo(token, parts[0], parts[1])
		if errors.Is(repoErr, gh.ErrRepoNotFound) {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("%s is not reachable with the configured GITHUB_TOKEN", req.GithubRepo))
			return
		}
		if repoErr != nil {
			writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
			return
		}
		fullName, defaultBranch = repo.FullName, repo.DefaultBranch
	} else {
		installationID, err := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to load GitHub installation")
			return
		}
		if installationID == 0 {
			writeJSONError(w, http.StatusBadRequest, "GitHub App not installed for this organization")
			return
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "internal error")
			return
		}
		installationToken, err := gh.GetInstallationToken(appJWT, installationID)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
			return
		}
		repos, err := gh.ListInstallationRepos(installationToken.Token)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "could not reach GitHub, please retry")
			return
		}
		var matched *gh.Repo
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, req.GithubRepo) {
				matched = &repos[i]
				break
			}
		}
		if matched == nil {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf(
				"the Opslane GitHub App is not installed on %s — install it, then retry",
				req.GithubRepo,
			))
			return
		}
		fullName, defaultBranch = matched.FullName, matched.DefaultBranch
	}
	if err := d.Queries.SetProjectGitHubConfig(
		r.Context(),
		orgID,
		projectID,
		fullName,
		defaultBranch,
	); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to save GitHub config")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(gitHubConfigResponse{
		GithubRepo: fullName,
		Connected:  true,
	})
}

// GetGitHubConfig handles GET /api/v1/projects/{projectID}/github
func (d *Dependencies) GetGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	githubRepo, err := d.Queries.GetProjectGitHubConfig(r.Context(), orgID, projectID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to get GitHub config")
		return
	}

	resp := gitHubConfigResponse{
		Connected: githubRepo != nil && *githubRepo != "",
	}
	if githubRepo != nil {
		resp.GithubRepo = *githubRepo
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// DeleteGitHubConfig handles DELETE /api/v1/projects/{projectID}/github
func (d *Dependencies) DeleteGitHubConfig(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectID")
	if !d.verifyProjectAccess(w, r, projectID) {
		return
	}

	orgID := OrgIDFromCtx(r.Context())
	if err := d.Queries.ClearProjectGitHubConfig(r.Context(), orgID, projectID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to clear GitHub config")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
