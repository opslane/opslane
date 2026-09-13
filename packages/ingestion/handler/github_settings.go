package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
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
	RepoAccess bool   `json:"repo_access"`
	AddRepoURL string `json:"add_repo_url,omitempty"`
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
	connectURL := d.publicOrigin(r) + "/settings?project_id=" + projectID + "#github"
	fullName, failure := d.attachGitHubRepo(r.Context(), OrgIDFromCtx(r.Context()), projectID, req.GithubRepo, connectURL)
	if failure != nil {
		writeGitHubFailure(w, failure)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(gitHubConfigResponse{
		GithubRepo: fullName,
		Connected:  true,
		RepoAccess: true,
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
	if resp.Connected && d.GitHubAppSlug == "" {
		resp.RepoAccess = true
	}
	if resp.Connected && d.GitHubAppSlug != "" {
		resp.RepoAccess, err = d.Queries.RepoCoveredByActiveInstallation(r.Context(), orgID, resp.GithubRepo)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to get GitHub config")
			return
		}
		if !resp.RepoAccess {
			active, activeErr := d.Queries.OrgHasActiveGitHubInstallation(r.Context(), orgID)
			if activeErr != nil {
				writeJSONError(w, http.StatusInternalServerError, "failed to get GitHub config")
				return
			}
			if active {
				installationID, idErr := d.Queries.GetOrgGitHubInstallation(r.Context(), orgID)
				appJWT, jwtErr := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
				if idErr == nil && jwtErr == nil {
					resp.AddRepoURL = d.installationAddRepoURL(r.Context(), orgID, installationID, appJWT)
				}
			}
		}
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
func (d *Dependencies) attachGitHubRepo(ctx context.Context, orgID, projectID, repoName, connectURL string) (string, *githubFailure) {
	parts := strings.Split(repoName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", &githubFailure{Status: http.StatusBadRequest, Code: "invalid_repo", Message: "github_repo must be in owner/repo format"}
	}

	var fullName, defaultBranch string
	if d.GitHubAppSlug == "" {
		token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
		if token == "" {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: codeGitHubNotInstalled, Message: "configure GITHUB_TOKEN or install the GitHub App", Extra: map[string]string{"github_connect_url": connectURL}}
		}
		repo, repoErr := gh.GetRepo(token, parts[0], parts[1])
		if errors.Is(repoErr, gh.ErrRepoNotFound) {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: codeRepoNotInInstallation, Message: fmt.Sprintf("%s is not reachable with the configured GITHUB_TOKEN", repoName)}
		}
		if repoErr != nil {
			return "", classifyGitHubError(repoErr)
		}
		fullName, defaultBranch = repo.FullName, repo.DefaultBranch
	} else {
		installationID, err := d.Queries.GetOrgGitHubInstallation(ctx, orgID)
		if err != nil {
			return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to load GitHub installation"}
		}
		if installationID == 0 {
			return "", &githubFailure{Status: http.StatusBadRequest, Code: codeGitHubNotInstalled, Message: "GitHub App not installed for this organization", Extra: map[string]string{"github_connect_url": connectURL}}
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "internal error"}
		}
		installationToken, err := gh.GetInstallationToken(appJWT, installationID)
		if err != nil {
			return "", d.githubTokenFailure(ctx, err, installationID, orgID, connectURL)
		}
		repos, err := gh.ListInstallationRepos(installationToken.Token)
		if err != nil {
			return "", classifyGitHubError(err)
		}
		var matched *gh.Repo
		for i := range repos {
			if strings.EqualFold(repos[i].FullName, repoName) {
				matched = &repos[i]
				break
			}
		}
		if matched == nil {
			failure := &githubFailure{
				Status:  http.StatusBadRequest,
				Code:    "repo_not_in_installation",
				Message: fmt.Sprintf("the Opslane GitHub App cannot see %s; add it to the installation's repository access, then retry", repoName),
				Extra:   map[string]string{},
			}
			if u := d.installationAddRepoURL(ctx, orgID, installationID, appJWT); u != "" {
				failure.Extra["add_repo_url"] = u
			}
			return "", failure
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
		return "", &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to save GitHub config"}
	}

	return fullName, nil
}

// githubTokenFailure retires a gone installation before telling the client to
// reconnect. A failed retirement returns 500 because the record remains stale.
func (d *Dependencies) githubTokenFailure(ctx context.Context, err error, installationID int64, orgID, connectURL string) *githubFailure {
	failure := classifyGitHubError(err)
	if failure.Code != codeGitHubInstallationGone && failure.Code != codeGitHubInstallationSuspended {
		return failure
	}
	// GitHub answers 404 on an installation both when it is gone and when the
	// App JWT belongs to a different App (rotated key, wrong GITHUB_APP_ID).
	// Only the first may retire records; a credential mistake must not clear
	// every org's installation on ordinary read traffic.
	if !d.appCredentialsConfirmed() {
		slog.Error("github: refusing to retire installation because the App credentials could not be confirmed", "installation_id", installationID, "org_id", orgID, "cause", err)
		return githubUnreachable("GitHub could not confirm this Opslane's App credentials; not touching the installation record. Retry later.")
	}
	if _, retireErr := d.Queries.RetireGitHubInstallation(ctx, installationID, orgID); retireErr != nil {
		slog.Error("github: retire installation", "error", retireErr, "installation_id", installationID, "org_id", orgID)
		return &githubFailure{Status: http.StatusInternalServerError, Code: "internal_error", Message: "failed to update GitHub installation record"}
	}
	slog.Warn("github: retired installation GitHub no longer honours", "code", failure.Code, "installation_id", installationID, "org_id", orgID, "cause", err)
	failure.Extra = map[string]string{"github_connect_url": connectURL}
	return failure
}

// appCredentialsConfirmed reports whether GET /app with our JWT names the App
// this deployment is configured for.
func (d *Dependencies) appCredentialsConfirmed() bool {
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		return false
	}
	app, err := gh.GetApp(appJWT)
	if err != nil {
		return false
	}
	return strconv.FormatInt(app.ID, 10) == strings.TrimSpace(d.GitHubAppID)
}

// installationAddRepoURL returns the GitHub page where a human edits the
// installation's repository access. It is stored at install time; a row
// persisted before that column existed is filled in once from GitHub.
func (d *Dependencies) installationAddRepoURL(ctx context.Context, orgID string, installationID int64, appJWT string) string {
	stored, err := d.Queries.GetGitHubInstallationHTMLURL(ctx, orgID, installationID)
	if err == nil && stored != "" {
		return stored
	}
	info, err := gh.VerifyInstallation(appJWT, installationID)
	if err != nil || info.HTMLURL == "" {
		return ""
	}
	if err := d.Queries.SetGitHubInstallationHTMLURL(ctx, installationID, info.HTMLURL); err != nil {
		slog.Warn("github: store installation html_url", "error", err, "installation_id", installationID)
	}
	return info.HTMLURL
}
