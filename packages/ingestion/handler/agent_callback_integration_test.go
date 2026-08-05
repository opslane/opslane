package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
	gh "github.com/opslane/opslane/packages/ingestion/github"
)

type handlerRoundTripperFunc func(*http.Request) (*http.Response, error)

func (f handlerRoundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func callbackTestKey(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func createCallbackSession(t *testing.T, q *db.Queries, repo string) (*db.AgentSession, string) {
	t.Helper()
	raw, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	session, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		RepoURL: repo, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session, raw
}

func cleanupCallbackTenant(t *testing.T, pool *pgxpool.Pool, sessionID string, installationID int64, orgID string) {
	t.Helper()
	ctx := context.Background()
	if sessionID != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, sessionID)
	}
	if installationID != 0 {
		_, _ = pool.Exec(ctx, `DELETE FROM installation_landed WHERE installation_id = $1`, installationID)
		_, _ = pool.Exec(ctx, `DELETE FROM github_app_installations WHERE installation_id = $1`, installationID)
	}
	if orgID == "" {
		return
	}
	queries := []string{
		`DELETE FROM pr_outcomes WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_jobs WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM error_group_affected_users WHERE error_group_id IN (SELECT id FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`,
		`DELETE FROM error_groups WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM end_users WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM project_api_keys WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`UPDATE projects SET default_environment_id = NULL WHERE org_id = $1`,
		`DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
		`DELETE FROM projects WHERE org_id = $1`,
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM memberships WHERE org_id = $1 OR user_id IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	}
	for _, query := range queries {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

func pollAgentSession(t *testing.T, deps *Dependencies, sessionID, rawToken string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/poll/"+sessionID, nil)
	req.Header.Set("X-Opslane-Poll-Token", rawToken)
	req.Header.Set("X-Forwarded-For", "203.0.113."+fmt.Sprint(time.Now().UnixNano()%200+1))
	req = req.WithContext(newChiRouteContext(map[string]string{"sessionID": sessionID}))
	w := httptest.NewRecorder()
	deps.AgentPoll(w, req)
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("poll body: %v (%q)", err, w.Body.String())
	}
	return w.Code, body
}

func TestWorkosAgentCallbackEndToEndAndFailureSemantics(t *testing.T) {
	t.Setenv("AUTH_PROVIDER", "workos")
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	privateKey := callbackTestKey(t)

	installationID := time.Now().UnixNano()%1_000_000_000 + 2_000_000_000
	userID := time.Now().UnixNano()%1_000_000_000 + 3_000_000_000
	repoFullName := "CB-Owner/CB-" + uuid.NewString()
	installVisible := true
	emailStatus := http.StatusOK
	verifiedEmails := true

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/login/oauth/access_token":
			fmt.Fprint(w, `{"access_token":"ghu_callback","token_type":"bearer"}`)
		case r.URL.Path == "/user":
			fmt.Fprintf(w, `{"id":%d,"login":"cb-user","name":"Callback User","avatar_url":"https://example.com/a.png"}`, userID)
		case r.URL.Path == "/user/emails":
			if emailStatus != http.StatusOK {
				w.WriteHeader(emailStatus)
				fmt.Fprint(w, `{}`)
			} else if verifiedEmails {
				fmt.Fprint(w, `[{"email":"cb-user@example.com","primary":true,"verified":true}]`)
			} else {
				fmt.Fprint(w, `[]`)
			}
		case r.URL.Path == "/user/installations":
			if installVisible {
				fmt.Fprintf(w, `{"installations":[{"id":%d}]}`, installationID)
			} else {
				fmt.Fprint(w, `{"installations":[]}`)
			}
		case r.URL.Path == fmt.Sprintf("/app/installations/%d", installationID):
			fmt.Fprintf(w, `{"id":%d,"account":{"login":"CB-Owner","id":444001}}`, installationID)
		case r.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", installationID):
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
		case r.URL.Path == "/installation/repositories":
			fmt.Fprintf(w, `{"repositories":[{"full_name":%q,"default_branch":"master"}]}`, repoFullName)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	restore := gh.OverrideHTTPClientForTests(&http.Client{Transport: handlerRoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "http"
		req.URL.Host = ts.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(req)
	})})
	defer restore()

	provider := &recordingProvider{}
	deps := &Dependencies{
		Queries: q, GitHubAppID: "1", GitHubAppClientID: "cid",
		GitHubAppClientSecret: "sec", GitHubAppPrivateKey: privateKey,
		AuthProvider: provider,
	}
	callback := func(sessionID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
			"/agent/auth/callback?state=%s&installation_id=%d&setup_action=install&code=x",
			sessionID, installationID), nil)
		w := httptest.NewRecorder()
		deps.AgentAuthCallback(w, req)
		return w
	}

	t.Run("happy path seals and idempotently delivers the key", func(t *testing.T) {
		installVisible, emailStatus, verifiedEmails = true, http.StatusOK, true
		repoFullName = "CB-Owner/CB-" + uuid.NewString()
		session, raw := createCallbackSession(t, q, strings.ToLower(repoFullName))
		w := callback(session.ID)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Done!") {
			t.Fatalf("callback code=%d body=%q", w.Code, w.Body.String())
		}
		after, err := q.GetAgentSession(context.Background(), session.ID)
		if err != nil || after == nil || after.OrgID == nil {
			t.Fatalf("provisioned session=%+v err=%v", after, err)
		}
		orgID := *after.OrgID
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, installationID, orgID) })
		var auditCount int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM installation_landed WHERE installation_id = $1 AND $2 = ANY(repos)`,
			installationID, repoFullName).Scan(&auditCount); err != nil || auditCount != 1 {
			t.Fatalf("landed audit count=%d err=%v", auditCount, err)
		}
		var defaultBranch *string
		if err := pool.QueryRow(context.Background(),
			`SELECT default_branch FROM projects WHERE id = $1`,
			*after.ProjectID).Scan(&defaultBranch); err != nil {
			t.Fatal(err)
		}
		if defaultBranch == nil || *defaultBranch != "master" {
			t.Fatalf("default_branch=%v, want master", defaultBranch)
		}

		code, first := pollAgentSession(t, deps, session.ID, raw)
		if code != http.StatusOK || first["status"] != "provisioned" {
			t.Fatalf("first poll code=%d body=%v", code, first)
		}
		key, _ := first["api_key"].(string)
		if !strings.HasPrefix(key, "opslane_pk_") {
			t.Fatalf("api_key=%q", key)
		}
		_, second := pollAgentSession(t, deps, session.ID, raw)
		if second["status"] != "key_ok" || second["api_key"] != key {
			t.Fatalf("second poll key=%v, want %q", second["api_key"], key)
		}

		if _, err := pool.Exec(context.Background(),
			`UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, session.ID); err != nil {
			t.Fatal(err)
		}
		_, closed := pollAgentSession(t, deps, session.ID, raw)
		if _, ok := closed["api_key"]; ok || !strings.Contains(fmt.Sprint(closed["message"]), "window closed") {
			t.Fatalf("expired delivery body=%v", closed)
		}
	})

	t.Run("installation mismatch is definitive", func(t *testing.T) {
		installVisible, emailStatus, verifiedEmails = false, http.StatusOK, true
		repoFullName = "CB-Owner/CB-" + uuid.NewString()
		session, raw := createCallbackSession(t, q, strings.ToLower(repoFullName))
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, installationID, "") })
		w := callback(session.ID)
		if w.Code != http.StatusForbidden {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		_, body := pollAgentSession(t, deps, session.ID, raw)
		if body["status"] != "failed" || body["failure_reason"] != "installation_not_yours" {
			t.Fatalf("poll body=%v", body)
		}
	})

	t.Run("email API failure is transient", func(t *testing.T) {
		installVisible, emailStatus, verifiedEmails = true, http.StatusInternalServerError, true
		repoFullName = "CB-Owner/CB-" + uuid.NewString()
		session, _ := createCallbackSession(t, q, strings.ToLower(repoFullName))
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, installationID, "") })
		w := callback(session.ID)
		if w.Code != http.StatusBadGateway {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		after, _ := q.GetAgentSession(context.Background(), session.ID)
		if after.Status != "pending" {
			t.Fatalf("status=%q, want pending", after.Status)
		}
	})

	t.Run("repo missing from the installation is definitive", func(t *testing.T) {
		installVisible, emailStatus, verifiedEmails = true, http.StatusOK, true
		userID++
		// The installation grants one repo; the session asks for a different
		// one, which is what "only select repositories" looks like on the wire.
		repoFullName = "CB-Owner/CB-granted-" + uuid.NewString()
		session, raw := createCallbackSession(t, q, strings.ToLower("CB-Owner/CB-ungranted-"+uuid.NewString()))
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, installationID, "") })
		w := callback(session.ID)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "Repository not granted") {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		_, body := pollAgentSession(t, deps, session.ID, raw)
		if body["status"] != "failed" || body["failure_reason"] != "repo_not_granted" {
			t.Fatalf("poll body=%v", body)
		}
	})

	t.Run("successful empty email list is definitive", func(t *testing.T) {
		installVisible, emailStatus, verifiedEmails = true, http.StatusOK, false
		userID++
		repoFullName = "CB-Owner/CB-" + uuid.NewString()
		session, raw := createCallbackSession(t, q, strings.ToLower(repoFullName))
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, installationID, "") })
		w := callback(session.ID)
		if w.Code != http.StatusForbidden {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		_, body := pollAgentSession(t, deps, session.ID, raw)
		if body["status"] != "failed" || body["failure_reason"] != "identity_unverified" {
			t.Fatalf("poll body=%v", body)
		}
	})
	if len(provider.exchangeCodes) != 0 {
		t.Fatalf("WorkOS exchanged GitHub codes: %v", provider.exchangeCodes)
	}
}

func TestAgentPollExpiredSessionContract(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	session, raw := createCallbackSession(t, q, "expired-owner/"+uuid.NewString())
	t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, 0, "") })
	if _, err := pool.Exec(context.Background(),
		`UPDATE agent_sessions SET status = 'completed', api_key_sealed = 'not-base64' WHERE id = $1`, session.ID); err != nil {
		t.Fatal(err)
	}
	code, body := pollAgentSession(t, &Dependencies{Queries: q}, session.ID, raw)
	if code != http.StatusInternalServerError || body["status"] != "internal_error" {
		t.Fatalf("tampered-key code=%d body=%v", code, body)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE agent_sessions SET status = 'expired' WHERE id = $1`, session.ID); err != nil {
		t.Fatal(err)
	}
	code, body = pollAgentSession(t, &Dependencies{Queries: q}, session.ID, raw)
	if code != http.StatusGone || body["status"] != "expired" || body["message"] != "session expired; re-run setup" {
		t.Fatalf("code=%d body=%v", code, body)
	}
}

// A pending session whose expires_at has lapsed must poll as expired even
// though the hourly ExpireAgentSessions sweep has not run yet. Otherwise the
// agent is told "pending" (exit 0, keep waiting) for up to an hour while the
// human opening the same auth link already gets 410.
func TestAgentPollLapsedPendingSessionIsExpiredBeforeSweep(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	session, raw := createCallbackSession(t, q, "lapsed-owner/"+uuid.NewString())
	t.Cleanup(func() { cleanupCallbackTenant(t, pool, session.ID, 0, "") })

	// Lapse the window without running the sweep — status stays 'pending'.
	if _, err := pool.Exec(context.Background(),
		`UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, session.ID); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM agent_sessions WHERE id = $1`, session.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("precondition: want status pending (unswept), got %q", status)
	}

	code, body := pollAgentSession(t, &Dependencies{Queries: q}, session.ID, raw)
	if code != http.StatusGone || body["status"] != "expired" || body["message"] != "session expired; re-run setup" {
		t.Fatalf("lapsed pending session: code=%d body=%v", code, body)
	}
}

func TestAgentSetupV2ContractAndNoTenantLeakage(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	deps := &Dependencies{Queries: q, AuthCallbackOrigin: "https://api.opslane.example"}
	ctx := context.Background()

	t.Run("new session returns split token and canonical origin", func(t *testing.T) {
		repo := "setup-owner/setup-" + uuid.NewString()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/setup",
			bytes.NewBufferString(fmt.Sprintf(`{"repo_url":%q,"agent_name":"codex"}`, repo)))
		req.Header.Set("X-Forwarded-For", "198.51.100.201")
		w := httptest.NewRecorder()
		deps.AgentSetup(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		pollID, _ := body["poll_id"].(string)
		pollToken, _ := body["poll_token"].(string)
		if body["status"] != "auth_required" || !strings.HasPrefix(pollToken, "opt_") ||
			!strings.HasPrefix(fmt.Sprint(body["auth_url"]), "https://api.opslane.example/agent/auth/") {
			t.Fatalf("body=%v", body)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, pollID) })
		session, err := q.GetAgentSession(ctx, pollID)
		if err != nil || session == nil || session.PollTokenHash == nil || *session.PollTokenHash != auth.HashToken(pollToken) {
			t.Fatalf("stored session=%+v err=%v", session, err)
		}

		wrong := "opt_" + strings.Repeat("0", 64)
		code, notFound := pollAgentSession(t, deps, pollID, wrong)
		if code != http.StatusNotFound || notFound["status"] != "not_found" {
			t.Fatalf("wrong-token poll code=%d body=%v", code, notFound)
		}
	})

	t.Run("already configured omits tenant identifiers", func(t *testing.T) {
		repo := "configured-owner/configured-" + uuid.NewString()
		org, err := q.CreateOrg(ctx, "configured-"+uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		project, err := q.CreateProject(ctx, org.ID, "configured", &repo)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cleanupCallbackTenant(t, pool, "", 0, org.ID) })

		req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/setup",
			bytes.NewBufferString(fmt.Sprintf(`{"repo_url":%q}`, repo)))
		req.Header.Set("X-Forwarded-For", "198.51.100.202")
		w := httptest.NewRecorder()
		deps.AgentSetup(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("code=%d body=%q", w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["status"] != "already_configured" {
			t.Fatalf("body=%v", body)
		}
		if _, ok := body["org_id"]; ok {
			t.Fatalf("org_id leaked: %v", body)
		}
		if _, ok := body["project_id"]; ok {
			t.Fatalf("project_id leaked (%s): %v", project.ID, body)
		}
	})
}
