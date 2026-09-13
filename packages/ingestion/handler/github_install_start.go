package handler

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

// githubInstallStateTTL covers a person choosing repositories on GitHub. The
// state stays single-use and bound to the user and organization.
const githubInstallStateTTL = 30 * time.Minute

// startGitHubInstall mints install state for orgID and the calling user, sets
// the matching __auth_state cookie, and returns GitHub's install URL. Call it
// only for an explicit user action: each call replaces the browser's state
// cookie, so a background caller breaks any GitHub tab that is already open.
func (d *Dependencies) startGitHubInstall(w http.ResponseWriter, r *http.Request, orgID string) (string, error) {
	state, err := generateOAuthState(d.JWTSecret)
	if err != nil {
		return "", fmt.Errorf("generate install state: %w", err)
	}
	if err := d.Queries.StoreOAuthLoginStateForOrg(r.Context(), auth.HashToken(state), orgID,
		UserIDFromCtx(r.Context()), time.Now().Add(githubInstallStateTTL)); err != nil {
		return "", fmt.Errorf("store install state: %w", err)
	}
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name: "__auth_state", Value: state, Path: "/auth", MaxAge: int(githubInstallStateTTL / time.Second),
		HttpOnly: true, Secure: isSecure, SameSite: http.SameSiteLaxMode,
	})
	return fmt.Sprintf("https://github.com/apps/%s/installations/new?state=%s", d.GitHubAppSlug, url.QueryEscape(state)), nil
}

// GitHubInstallURL starts a GitHub App installation for the caller's active
// organization. The dashboard calls it when the user opens the install link.
func (d *Dependencies) GitHubInstallURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	orgID := OrgIDFromCtx(r.Context())
	if orgID == "" || UserIDFromCtx(r.Context()) == "" {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if d.GitHubAppSlug == "" {
		writeJSONErrorCode(w, http.StatusBadRequest, "this Opslane has no GitHub App; connect a repository from Settings with a token", "github_app_not_configured")
		return
	}
	installURL, err := d.startGitHubInstall(w, r, orgID)
	if err != nil {
		slog.Error("start GitHub install failed", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"install_url": installURL})
}
