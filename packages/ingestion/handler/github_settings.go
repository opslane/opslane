package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/opslane/opslane/packages/ingestion/auth"
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

	if d.GitHubAppSlug == "" && d.cloudAuthEnabled() && !auth.RoleSatisfies(RoleFromCtx(r.Context()), "admin") {
		writeJSONError(w, http.StatusForbidden, "organization admin required")
		return
	}
	fullName, code, msg := d.attachGitHubRepo(r.Context(), OrgIDFromCtx(r.Context()), projectID, req.GithubRepo)
	if code != 0 {
		writeJSONError(w, code, msg)
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

// attachGitHubRepo verifies repository access before storing its canonical name.
func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repoName string) (canonical string, status int, msg string) {
	// Validate repo format
	parts := strings.Split(repoName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", http.StatusBadRequest, "github_repo must be in owner/repo format"
	}

	var fullName, defaultBranch string
	if d.GitHubAppSlug == "" {
		token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
		if token == "" {
			return "", http.StatusBadRequest, "configure GITHUB_TOKEN or install the GitHub App"
		}
		repo, repoErr := gh.GetRepo(token, parts[0], parts[1])
		if errors.Is(repoErr, gh.ErrRepoNotFound) {
			return "", http.StatusBadRequest, fmt.Sprintf("%s is not reachable with the configured GITHUB_TOKEN", repoName)
		}
		if repoErr != nil {
			return "", http.StatusBadGateway, "could not reach GitHub, please retry"
		}
		fullName, defaultBranch = repo.FullName, repo.DefaultBranch
	} else {
		installationID, err := d.Queries.GetOrgGitHubInstallation(ctx, orgID)
		if err != nil {
			return "", http.StatusInternalServerError, "failed to load GitHub installation"
		}
		if installationID == 0 {
			return "", http.StatusBadRequest, "GitHub App not installed for this organization"
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			return "", http.StatusInternalServerError, "internal error"
		}
		installationToken, err := gh.GetInstallationToken(appJWT, installationID)
		if err != nil {
			return "", http.StatusBadGateway, "could not reach GitHub, please retry"
		}
		repos, err := gh.ListInstallationRepos(installationToken.Token)
		if err != nil {
			return "", http.StatusBadGateway, "could not reach GitHub, please retry"
		}
		var matched *gh.Repo
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, repoName) {
				matched = &repos[i]
				break
			}
		}
		if matched == nil {
			return "", http.StatusBadRequest, fmt.Sprintf(
				"the Opslane GitHub App is not installed on %s — install it, then retry",
				repoName,
			)
		}
		fullName, defaultBranch = matched.FullName, matched.DefaultBranch
	}
	if err := d.Queries.SetProjectGitHubConfig(
		ctx,
		orgID,
		projectID,
		fullName,
		defaultBranch,
	); err != nil {
		return "", http.StatusInternalServerError, "failed to save GitHub config"
	}

	return fullName, 0, ""
}
