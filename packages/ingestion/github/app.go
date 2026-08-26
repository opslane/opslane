package github

import (
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// httpClient is used for all GitHub API calls. Override in tests.
var httpClient = &http.Client{Timeout: 10 * time.Second}

const githubAPIBase = "https://api.github.com"

// GitHubUser represents a GitHub user profile.
type GitHubUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
}

// GitHubEmail represents an email from the /user/emails endpoint.
type GitHubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// Repo represents a GitHub repository.
type Repo struct {
	FullName      string `json:"full_name"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
}

// UserToken is the response from GitHub's OAuth token exchange.
type UserToken struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
}

// InstallationToken is the response from creating an installation access token.
type InstallationToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type installationReposResponse struct {
	Repositories []Repo `json:"repositories"`
}

// ErrRepoNotFound reports a repository the token cannot see.
var ErrRepoNotFound = errors.New("repository not found or not accessible")

// GenerateAppJWT creates a signed RS256 JWT for GitHub App authentication.
// The JWT is valid for 10 minutes as required by GitHub.
func GenerateAppJWT(appID string, privateKeyPEM []byte) (string, error) {
	key, err := jwt.ParseRSAPrivateKeyFromPEM(privateKeyPEM)
	if err != nil {
		return "", fmt.Errorf("parse private key: %w", err)
	}
	return generateAppJWTWithKey(appID, key)
}

func generateAppJWTWithKey(appID string, key *rsa.PrivateKey) (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Issuer:    appID,
		IssuedAt:  jwt.NewNumericDate(now.Add(-60 * time.Second)), // clock skew tolerance
		ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(key)
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}
	return signed, nil
}

// GetInstallationToken exchanges an App JWT for an installation access token.
func GetInstallationToken(appJWT string, installationID int64) (*InstallationToken, error) {
	url := fmt.Sprintf("%s/app/installations/%d/access_tokens", githubAPIBase, installationID)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+appJWT)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request installation token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var token InstallationToken
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &token, nil
}

// DeleteBranch removes a repository branch. A missing branch is treated as an
// idempotent success so GitHub webhook redeliveries can safely retry cleanup.
func DeleteBranch(token, repo, branch string) error {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || branch == "" {
		return fmt.Errorf("invalid repository or branch")
	}
	reqURL := fmt.Sprintf("%s/repos/%s/%s/git/refs/heads/%s",
		githubAPIBase,
		url.PathEscape(parts[0]),
		url.PathEscape(parts[1]),
		url.PathEscape(branch),
	)
	req, err := http.NewRequest(http.MethodDelete, reqURL, nil)
	if err != nil {
		return fmt.Errorf("create delete branch request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("delete branch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return fmt.Errorf("GitHub API error deleting branch (status %d): %s", resp.StatusCode, string(body))
}

// ListInstallationRepos lists all repositories accessible to the given installation.
func ListInstallationRepos(installationToken string) ([]Repo, error) {
	var allRepos []Repo
	page := 1

	for {
		repos, linkHeader, err := fetchRepoPage(installationToken, page)
		if err != nil {
			return nil, err
		}
		allRepos = append(allRepos, repos...)

		if !hasNextPage(linkHeader) {
			break
		}
		page++
	}

	return allRepos, nil
}

// GetRepo fetches one repository using a PAT or other bearer token.
func GetRepo(token, owner, name string) (*Repo, error) {
	reqURL := githubAPIBase + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create get repo request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	response, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get repo: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrRepoNotFound
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github get repo: status %d", response.StatusCode)
	}
	var repo Repo
	if err := json.NewDecoder(response.Body).Decode(&repo); err != nil {
		return nil, fmt.Errorf("decode repo: %w", err)
	}
	return &repo, nil
}

// ListUserInstallations returns the installation IDs visible to a user access
// token. This binds an attacker-controlled installation_id to the authenticated
// human who completed the OAuth exchange.
func ListUserInstallations(userToken string) ([]int64, error) {
	var ids []int64
	for page := 1; ; page++ {
		reqURL := fmt.Sprintf("%s/user/installations?per_page=100&page=%d", githubAPIBase, page)
		req, err := http.NewRequest(http.MethodGet, reqURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+userToken)
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("list user installations: %w", err)
		}
		var body struct {
			Installations []struct {
				ID int64 `json:"id"`
			} `json:"installations"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&body)
		link := resp.Header.Get("Link")
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("list user installations: status %d", resp.StatusCode)
		}
		if decodeErr != nil {
			return nil, fmt.Errorf("list user installations decode: %w", decodeErr)
		}
		for _, installation := range body.Installations {
			ids = append(ids, installation.ID)
		}
		if !hasNextPage(link) {
			break
		}
	}
	return ids, nil
}

// OverrideHTTPClientForTests swaps the package HTTP client and returns a
// restore func. Test-only; never call from production code.
func OverrideHTTPClientForTests(c *http.Client) (restore func()) {
	orig := httpClient
	httpClient = c
	return func() { httpClient = orig }
}

// fetchRepoPage fetches a single page of repos and closes the response body.
func fetchRepoPage(installationToken string, page int) ([]Repo, string, error) {
	reqURL := fmt.Sprintf("%s/installation/repositories?per_page=100&page=%d", githubAPIBase, page)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "token "+installationToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("list repos: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, "", fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result installationReposResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, "", fmt.Errorf("decode response: %w", err)
	}
	return result.Repositories, resp.Header.Get("Link"), nil
}

// InstallationInfo contains metadata about a GitHub App installation.
type InstallationInfo struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		ID    int64  `json:"id"`
	} `json:"account"`
}

// VerifyInstallation checks that an installation_id belongs to this GitHub App
// by calling GET /app/installations/{id} with the App JWT.
// Returns the installation info if valid, or an error if not found / unauthorized.
func VerifyInstallation(appJWT string, installationID int64) (*InstallationInfo, error) {
	reqURL := fmt.Sprintf("%s/app/installations/%d", githubAPIBase, installationID)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+appJWT)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("verify installation: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("installation %d not found for this app", installationID)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var info InstallationInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &info, nil
}

// ExchangeOAuthCode exchanges an authorization code for a user access token.
func ExchangeOAuthCode(clientID, clientSecret, code string) (*UserToken, error) {
	data := url.Values{
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"code":          {code},
	}
	req, err := http.NewRequest("POST", "https://github.com/login/oauth/access_token", strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub OAuth error (status %d): %s", resp.StatusCode, string(body))
	}

	var token UserToken
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if token.AccessToken == "" {
		return nil, fmt.Errorf("GitHub OAuth returned empty access token (raw: %s)", string(body[:min(len(body), 200)]))
	}
	slog.Info("GitHub OAuth token parsed",
		"token_type", token.TokenType,
		"scope", token.Scope,
	)
	return &token, nil
}

// GetUser fetches the authenticated user's profile.
func GetUser(userToken string) (*GitHubUser, error) {
	req, err := http.NewRequest("GET", githubAPIBase+"/user", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var user GitHubUser
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &user, nil
}

// GetUserEmails fetches the authenticated user's email addresses.
// Used as a fallback when the /user endpoint returns an empty email.
func GetUserEmails(userToken string) ([]GitHubEmail, error) {
	req, err := http.NewRequest("GET", githubAPIBase+"/user/emails", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get emails: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var emails []GitHubEmail
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return emails, nil
}

// hasNextPage checks the Link header for a "next" relation.
func hasNextPage(linkHeader string) bool {
	if linkHeader == "" {
		return false
	}
	for _, part := range strings.Split(linkHeader, ",") {
		if strings.Contains(part, `rel="next"`) {
			return true
		}
	}
	return false
}
