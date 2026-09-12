package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// pullRequestEvent represents the relevant fields from a GitHub pull_request webhook payload.
type pullRequestEvent struct {
	Action      string `json:"action"`
	PullRequest struct {
		Number   int        `json:"number"`
		Merged   bool       `json:"merged"`
		ClosedAt *time.Time `json:"closed_at"`
	} `json:"pull_request"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

type pushEvent struct {
	Ref        string `json:"ref"`
	After      string `json:"after"`
	Size       int    `json:"size"`
	Repository struct {
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
	} `json:"repository"`
	Commits []struct {
		Added    []string `json:"added"`
		Modified []string `json:"modified"`
		Removed  []string `json:"removed"`
	} `json:"commits"`
}

type webhookRepo struct {
	FullName string `json:"full_name"`
}

type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID                  int64  `json:"id"`
		RepositorySelection string `json:"repository_selection"` // "all" or "selected"
	} `json:"installation"`
	Repositories        []webhookRepo `json:"repositories"`
	RepositoriesAdded   []webhookRepo `json:"repositories_added"`
	RepositoriesRemoved []webhookRepo `json:"repositories_removed"`
}

func repoNames(repos []webhookRepo) []string {
	out := make([]string, 0, len(repos))
	for _, repo := range repos {
		if repo.FullName != "" {
			out = append(out, repo.FullName)
		}
	}
	return out
}

// HandleWebhook handles POST /api/v1/github/webhook.
// Verifies the GitHub HMAC-SHA256 signature and processes pull_request and
// push events (which require X-GitHub-Delivery) plus installation and
// installation_repositories events (state-based, applied without a delivery
// receipt so a redelivery reapplies the same state).
func (d *Dependencies) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	secret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	if secret == "" {
		slog.Error("GITHUB_WEBHOOK_SECRET not configured")
		writeJSONError(w, http.StatusInternalServerError, "webhook not configured")
		return
	}

	// Read body. GitHub caps webhook payloads at 25 MB; an installation
	// event for an account with many repositories can exceed the old 1 MB
	// cap, and a truncated body can never pass signature verification.
	body, err := io.ReadAll(io.LimitReader(r.Body, 25<<20))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	// Verify HMAC-SHA256 signature
	signature := r.Header.Get("X-Hub-Signature-256")
	if !verifyWebhookSignature(body, secret, signature) {
		writeJSONError(w, http.StatusUnauthorized, "invalid signature")
		return
	}

	eventType := r.Header.Get("X-GitHub-Event")
	switch eventType {
	case "pull_request", "push":
	case "installation":
		d.handleInstallationWebhook(w, r, body)
		return
	case "installation_repositories":
		d.handleInstallationRepositoriesWebhook(w, r, body)
		return
	default:
		webhookJSON(w, map[string]string{"status": "ignored", "event": eventType})
		return
	}

	deliveryID := strings.TrimSpace(r.Header.Get("X-GitHub-Delivery"))
	if deliveryID == "" {
		writeJSONError(w, http.StatusBadRequest, "missing X-GitHub-Delivery header")
		return
	}
	if eventType == "push" {
		d.handlePushWebhook(w, r, body, deliveryID)
		return
	}

	var event pullRequestEvent
	if err := json.Unmarshal(body, &event); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	// Only handle "closed" action
	if event.Action != "closed" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ignored", "action": event.Action})
		return
	}

	repo := event.Repository.FullName
	prNumber := event.PullRequest.Number
	occurredAt := time.Now()
	if event.PullRequest.ClosedAt != nil {
		occurredAt = *event.PullRequest.ClosedAt
	}
	action := "closed"
	if event.PullRequest.Merged {
		action = "merged"
	}

	result, err := d.Queries.ProcessPRWebhook(
		r.Context(), repo, prNumber, event.PullRequest.Merged, deliveryID, occurredAt,
	)
	if err != nil {
		slog.Error("webhook: process PR event failed", "repo", repo, "pr", prNumber, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process pull_request event")
		return
	}
	if result.CleanupBranch != "" {
		if err := d.deleteDraftBranch(repo, result.CleanupBranch, result.InstallationID); err != nil {
			slog.Error("webhook: draft branch cleanup failed",
				"repo", repo, "pr", prNumber, "branch", result.CleanupBranch, "error", err)
			// The database transition and receipt are already durable. Returning an
			// error asks GitHub to redeliver; the duplicate path returns the same
			// cleanup intent, and a 404 is an idempotent success.
			writeJSONError(w, http.StatusInternalServerError, "failed to clean up pull-request branch")
			return
		}
	}
	status := "processed"
	switch {
	case result.Duplicate:
		status = "duplicate"
	case result.GroupID == "":
		status = "no_match"
	}
	slog.Info("webhook: PR "+action,
		"repo", repo,
		"pr", prNumber,
		"group_id", result.GroupID,
		"status", status,
		"delivery_id", deliveryID,
	)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": status, "action": action, "group_id": result.GroupID,
	})
}

func (d *Dependencies) handlePushWebhook(
	w http.ResponseWriter,
	r *http.Request,
	body []byte,
	deliveryID string,
) {
	var event pushEvent
	if err := json.Unmarshal(body, &event); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	defaultRef := "refs/heads/" + event.Repository.DefaultBranch
	if event.Repository.DefaultBranch == "" || event.Ref != defaultRef || strings.Trim(event.After, "0") == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ignored", "event": "push"})
		return
	}
	changedSet := make(map[string]struct{})
	for _, commit := range event.Commits {
		for _, paths := range [][]string{commit.Added, commit.Modified, commit.Removed} {
			for _, path := range paths {
				path = strings.TrimSpace(path)
				if path != "" {
					changedSet[path] = struct{}{}
				}
			}
		}
	}
	changedPaths := make([]string, 0, len(changedSet))
	for path := range changedSet {
		changedPaths = append(changedPaths, path)
	}
	slices.Sort(changedPaths)
	if event.Size > len(event.Commits) {
		// GitHub truncates large push payloads. An empty list tells the worker
		// to refresh all stale model claims rather than miss changed files.
		changedPaths = nil
	}
	queued, err := d.Queries.EnqueueProductContextPush(
		r.Context(), event.Repository.FullName, deliveryID, event.After, changedPaths,
	)
	if err != nil {
		slog.Error("webhook: enqueue product context failed", "repo", event.Repository.FullName, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to enqueue product context")
		return
	}
	status := "queued"
	if queued == 0 {
		status = "no_match"
	}
	slog.Info("webhook: default-branch push", "repo", event.Repository.FullName,
		"commit", event.After, "projects", queued, "delivery_id", deliveryID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": status, "event": "push"})
}

func (d *Dependencies) deleteDraftBranch(repo, branch string, installationID *int64) error {
	token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if token == "" {
		if installationID == nil || *installationID <= 0 {
			return &githubBranchCleanupError{message: "no GitHub token or App installation is available"}
		}
		if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
			return &githubBranchCleanupError{message: "GitHub App credentials are not configured"}
		}
		appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
		if err != nil {
			return err
		}
		installationToken, err := gh.GetInstallationToken(appJWT, *installationID)
		if err != nil {
			return err
		}
		token = installationToken.Token
	}
	return gh.DeleteBranch(token, repo, branch)
}

type githubBranchCleanupError struct{ message string }

func (e *githubBranchCleanupError) Error() string { return e.message }

func webhookJSON(w http.ResponseWriter, value map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

// knownInstallation is true for a rich row or, for orgs that predate rich
// rows, a legacy org pointer; either way Opslane mapped it to an org.
func (d *Dependencies) knownInstallation(ctx context.Context, installationID int64) (bool, error) {
	installation, err := d.Queries.GetGitHubAppInstallationByID(ctx, installationID)
	if err != nil {
		return false, err
	}
	if installation != nil {
		return true, nil
	}
	return d.Queries.AnyOrgPointsAtInstallation(ctx, installationID)
}

// refreshInstallationRepos replaces the repo list from GitHub. Used when the
// event says "all repositories", whose payload carries no list.
func (d *Dependencies) refreshInstallationRepos(ctx context.Context, installationID int64) error {
	if d.GitHubAppID == "" || len(d.GitHubAppPrivateKey) == 0 {
		return fmt.Errorf("GitHub App not configured")
	}
	appJWT, err := gh.GenerateAppJWT(d.GitHubAppID, d.GitHubAppPrivateKey)
	if err != nil {
		return err
	}
	token, err := gh.GetInstallationToken(appJWT, installationID)
	if err != nil {
		return err
	}
	repos, err := gh.ListInstallationRepos(token.Token)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(repos))
	for _, repo := range repos {
		names = append(names, repo.FullName)
	}
	_, err = d.Queries.ReplaceGitHubInstallationRepos(ctx, installationID, names)
	return err
}

func (d *Dependencies) handleInstallationWebhook(w http.ResponseWriter, r *http.Request, body []byte) {
	var event installationEvent
	if err := json.Unmarshal(body, &event); err != nil || event.Installation.ID == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	ctx := r.Context()
	installationID := event.Installation.ID
	switch event.Action {
	case "created", "deleted", "suspend", "unsuspend", "new_permissions_accepted":
	default:
		webhookJSON(w, map[string]string{"status": "ignored", "action": event.Action})
		return
	}
	known, err := d.knownInstallation(ctx, installationID)
	if err != nil {
		slog.Error("webhook: look up installation", "installation_id", installationID, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation event")
		return
	}
	if !known {
		slog.Info("webhook: installation not mapped to an org, ignored", "action", event.Action, "installation_id", installationID)
		webhookJSON(w, map[string]string{"status": "ignored", "reason": "unknown_installation", "action": event.Action})
		return
	}
	switch event.Action {
	case "deleted":
		_, err = d.Queries.RetireGitHubInstallation(ctx, installationID, "")
	case "suspend":
		// Same shape as a retire: the worker must stop minting from this
		// installation too, and unsuspend restores the pointer.
		_, err = d.Queries.RetireGitHubInstallation(ctx, installationID, "")
	case "unsuspend":
		_, err = d.Queries.ReactivateGitHubInstallation(ctx, installationID)
	case "created", "new_permissions_accepted":
		if event.Installation.RepositorySelection == "all" {
			// The payload carries no list for "all repositories"; ask GitHub.
			if refreshErr := d.refreshInstallationRepos(ctx, installationID); refreshErr != nil {
				slog.Warn("webhook: could not refresh repos for an all-repositories installation", "installation_id", installationID, "error", refreshErr)
			}
		} else if names := repoNames(event.Repositories); len(names) > 0 || event.Action == "created" {
			_, err = d.Queries.ReplaceGitHubInstallationRepos(ctx, installationID, names)
		}
	}
	if err != nil {
		slog.Error("webhook: installation event failed", "action", event.Action, "installation_id", installationID, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation event")
		return
	}
	slog.Info("webhook: installation updated", "action", event.Action, "installation_id", installationID)
	webhookJSON(w, map[string]string{"status": "applied", "action": event.Action})
}

func (d *Dependencies) handleInstallationRepositoriesWebhook(w http.ResponseWriter, r *http.Request, body []byte) {
	var event installationEvent
	if err := json.Unmarshal(body, &event); err != nil || event.Installation.ID == 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}
	ctx := r.Context()
	installationID := event.Installation.ID
	if event.Action != "added" && event.Action != "removed" {
		webhookJSON(w, map[string]string{"status": "ignored", "action": event.Action})
		return
	}
	known, err := d.knownInstallation(ctx, installationID)
	if err != nil {
		slog.Error("webhook: look up installation", "installation_id", installationID, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
		return
	}
	if !known {
		slog.Info("webhook: installation not mapped to an org, ignored", "action", event.Action, "installation_id", installationID)
		webhookJSON(w, map[string]string{"status": "ignored", "reason": "unknown_installation", "action": event.Action})
		return
	}
	if added := repoNames(event.RepositoriesAdded); len(added) > 0 {
		if _, err := d.Queries.AddGitHubInstallationRepos(ctx, installationID, added); err != nil {
			slog.Error("webhook: add installation repos failed", "installation_id", installationID, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
			return
		}
	}
	if removed := repoNames(event.RepositoriesRemoved); len(removed) > 0 {
		if _, err := d.Queries.RemoveGitHubInstallationRepos(ctx, installationID, removed); err != nil {
			slog.Error("webhook: remove installation repos failed", "installation_id", installationID, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "failed to process installation_repositories event")
			return
		}
	}
	webhookJSON(w, map[string]string{"status": "applied", "action": event.Action})
}

// verifyWebhookSignature validates the X-Hub-Signature-256 header.
func verifyWebhookSignature(payload []byte, secret, signature string) bool {
	if signature == "" {
		return false
	}
	// Signature format: "sha256=<hex>"
	prefix := "sha256="
	if !strings.HasPrefix(signature, prefix) {
		return false
	}
	sigHex := signature[len(prefix):]

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(sigHex), []byte(expected))
}
